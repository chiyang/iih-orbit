import { CALENDAR_SCOPE, validClientId } from './google-data.ts';

export const GOOGLE_SESSION_KEY = 'iih-orbit-google-session-v1';
const CONTROL_PREFIX = 'iih-orbit-google-session-control-v1:';
export interface GoogleSessionContext {clientId: string; generation: string; accountId: string}
export interface GoogleSession {
  version: 1;
  id: string;
  clientId: string;
  generation: string;
  account: {id: string; email: string};
  scope: string;
  token: string;
  expiresAt: number;
  nonce: string;
}
type SessionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export interface SessionChannel {onmessage: ((event: MessageEvent) => void) | null; postMessage(value: unknown): void; close(): void}
interface SessionCallbacks {
  current(): GoogleSession | undefined;
  pendingNonce(): string;
  busy(): boolean;
  receive(session: GoogleSession, shared: boolean): void;
  clear(message: string): void;
  warning(message: string): void;
}
const sameScope = (left: GoogleSessionContext, right: GoogleSessionContext) => left.clientId === right.clientId && left.generation === right.generation;
const sameContext = (left: GoogleSessionContext, right: GoogleSessionContext) => sameScope(left, right) && left.accountId === right.accountId;
const contextOf = (session: GoogleSession): GoogleSessionContext => ({clientId: session.clientId, generation: session.generation, accountId: session.account.id});
export interface SessionOptions {scope: string; storageKey: string; controlPrefix: string}

export function readGoogleSession(value: unknown, context: GoogleSessionContext, nonce: string, now = Date.now(), scope = CALENDAR_SCOPE): GoogleSession | undefined {
  if (!value || typeof value !== 'object' || !nonce || !context.accountId) return undefined;
  const session = value as GoogleSession;
  if (session.version !== 1 || typeof session.id !== 'string' || !session.id || session.id.length > 100
    || session.clientId !== context.clientId || session.generation !== context.generation || session.nonce !== nonce
    || !session.account || session.account.id !== context.accountId || typeof session.account.email !== 'string' || !session.account.email || session.account.email.length > 320
    || session.scope !== scope || typeof session.token !== 'string' || !session.token || session.token.length > 8192 || /\s/.test(session.token)
    || !Number.isSafeInteger(session.expiresAt) || session.expiresAt <= now || session.expiresAt > now + 86400000) return undefined;
  return {version: 1, id: session.id, clientId: session.clientId, generation: session.generation, account: {id: session.account.id, email: session.account.email}, scope: session.scope, token: session.token, expiresAt: session.expiresAt, nonce: session.nonce};
}

/** Credentials remain in tab storage; localStorage contains only a public invalidation nonce. */
export class GoogleSessionBridge {
  private context?: GoogleSessionContext;
  private readonly tabId = crypto.randomUUID();
  private requestId = '';
  private closed = false;
  private readonly storage: SessionStorage | undefined;
  private readonly control: SessionStorage | undefined;
  private readonly channel: SessionChannel | undefined;
  private readonly callbacks: SessionCallbacks;
  private readonly options: SessionOptions;
  constructor(storage: SessionStorage | undefined, control: SessionStorage | undefined, channel: SessionChannel | undefined, callbacks: SessionCallbacks, options: SessionOptions = {scope: CALENDAR_SCOPE, storageKey: GOOGLE_SESSION_KEY, controlPrefix: CONTROL_PREFIX}) {
    this.options = options;
    this.storage = storage; this.control = control; this.channel = channel; this.callbacks = callbacks;
    if (channel) channel.onmessage = event => this.receive(event.data);
  }

  activate(context: GoogleSessionContext): void {
    if (this.closed) return;
    const changed = !this.context || !sameContext(this.context, context);
    const previous = this.context;
    this.context = {...context};
    if (!changed) { this.verify(false); return; }
    this.requestId = '';
    if (previous && !sameScope(previous, context)) {
      try { this.control?.removeItem(this.controlKey(previous)); } catch { /* Old scopes cannot match the new context. */ }
    }
    const current = this.callbacks.current();
    if (current && sameContext(contextOf(current), context) && !current.nonce) { this.warn(); return; }
    if (current && this.valid(current)) { this.remember(current); return; }
    if (current) this.callbacks.clear('Google 連線設定已變更，請重新連線。');
    let stored;
    try { const raw = this.storage?.getItem(this.options.storageKey); stored = raw ? JSON.parse(raw) : undefined; }
    catch { this.warn(); }
    const restored = this.valid(stored);
    if (restored) { this.callbacks.receive(restored, false); this.remember(restored, false); return; }
    this.forget();
    this.requestPeers();
  }

  private marker(create = false): string {
    if (!this.context?.clientId || !validClientId(this.context.clientId) || !this.control) return '';
    try {
      const key = this.controlKey(this.context);
      const saved = this.control.getItem(key);
      if (saved && /^[a-f0-9-]{36}$/.test(saved)) return saved;
      if (create) { const nonce = crypto.randomUUID(); this.control.setItem(key, nonce); return nonce; }
    } catch { this.warn(); }
    return '';
  }
  private valid(value: unknown): GoogleSession | undefined {
    return this.context ? readGoogleSession(value, this.context, this.marker(), Date.now(), this.options.scope) : undefined;
  }
  currentNonce(): string { return this.marker(true); }
  isCurrent(nonce: string): boolean { return !!nonce && this.marker() === nonce; }

  invalidate(message: string, expectedNonce?: string): string {
    this.requestId = '';
    this.forget();
    if (!this.context?.clientId || !this.control) return '';
    if (expectedNonce && this.marker() !== expectedNonce) return this.marker();
    const nonce = crypto.randomUUID();
    try { this.control.setItem(this.controlKey(this.context), nonce); }
    catch { this.warn(); return ''; }
    this.send({type: 'clear', context: this.context, nonce, message});
    return nonce;
  }
  remember(session: GoogleSession, announce = true): void {
    const saved = this.valid(session);
    if (!saved) return;
    try { if (!this.storage) throw new Error('unavailable'); this.storage.setItem(this.options.storageKey, JSON.stringify(saved)); }
    catch { this.warn(); }
    if (announce) this.send({type: 'available', context: contextOf(saved)});
  }
  forget(): void { try { this.storage?.removeItem(this.options.storageKey); } catch { this.warn(); } }
  private controlKey(context: GoogleSessionContext): string { return this.options.controlPrefix + JSON.stringify([context.generation, context.clientId]); }

  verify(request = true): void {
    if (this.closed) return;
    const current = this.callbacks.current(), pending = this.callbacks.pendingNonce();
    if (current && current.nonce && !this.valid(current)) {
      this.forget(); this.requestId = '';
      this.callbacks.clear(current.expiresAt <= Date.now() ? 'Google 授權已到期，請重新連線。' : 'Google 已在其他分頁解除或更新連線。');
    } else if (pending && !this.isCurrent(pending)) {
      this.forget(); this.requestId = ''; this.callbacks.clear('Google 授權已在其他分頁取消或更新。');
    }
    if (request && !this.callbacks.current()) this.requestPeers();
  }
  private requestPeers(): void {
    if (!this.channel || !this.context?.clientId || !this.context.accountId || this.callbacks.busy() || this.closed) return;
    this.requestId = crypto.randomUUID();
    this.send({type: 'request', context: this.context, requestId: this.requestId, sender: this.tabId});
  }
  private receive(value: unknown): void {
    if (this.closed || !this.context || !value || typeof value !== 'object') return;
    const message = value as {type?: string; context?: GoogleSessionContext; nonce?: string; message?: string; sender?: string; requestId?: string; target?: string; session?: unknown};
    if (!message.context || !sameScope(this.context, message.context)) return;
    if (message.type === 'clear' && message.nonce && message.nonce === this.marker()) {
      this.forget(); this.requestId = ''; this.callbacks.clear(message.message || 'Google 已在其他分頁解除連線。');
    } else if (sameContext(this.context, message.context)) {
      if (message.type === 'request' && message.sender !== this.tabId && typeof message.sender === 'string' && typeof message.requestId === 'string') {
        const session = this.valid(this.callbacks.current());
        if (session && !this.callbacks.busy()) this.send({type: 'session', context: this.context, session, target: message.sender, requestId: message.requestId});
      } else if (message.type === 'session' && message.target === this.tabId && this.requestId && message.requestId === this.requestId && !this.callbacks.busy()) {
        const session = this.valid(message.session);
        if (session) { this.requestId = ''; this.callbacks.receive(session, true); this.remember(session, false); }
      } else if (message.type === 'available' && !this.valid(this.callbacks.current())) this.requestPeers();
    }
  }
  private send(message: unknown): void { try { this.channel?.postMessage(message); } catch { /* Reload restoration still works without tab messaging. */ } }
  private warn(): void { this.callbacks.warning('瀏覽器無法保存 Google 連線，重新整理後可能需要重新連線。'); }
  close(): void { this.closed = true; this.requestId = ''; if (this.channel) { this.channel.onmessage = null; this.channel.close(); } }
}
