import { DOCUMENT } from '@angular/common';
import { inject, Injectable, OnDestroy, signal } from '@angular/core';
import { CALENDAR_SCOPE } from './google-data';
import { GoogleHttpError, readGoogleHttpError } from './google-api';
import { GOOGLE_SESSION_KEY, GoogleSession, GoogleSessionBridge, GoogleSessionContext, SessionChannel, SessionOptions } from './google-session';

interface TokenResponse {access_token?: string; expires_in?: number; error?: string; scope?: string}
interface OAuthApi {
  initTokenClient(options: {client_id: string; scope: string; include_granted_scopes: boolean; callback: (response: TokenResponse) => void; error_callback: (error: {type: string}) => void}): {requestAccessToken(options: {prompt: string}): void};
  hasGrantedAllScopes(response: TokenResponse, ...scopes: string[]): boolean;
}
export interface GoogleAccount {id: string; email: string}
interface AuthorizationHistory extends GoogleSessionContext {version: 1; expiresAt: number; nonce: string}

@Injectable({providedIn: 'root'})
export class GoogleAuth implements OnDestroy {
  protected get sessionOptions(): SessionOptions { return {scope: CALENDAR_SCOPE, storageKey: GOOGLE_SESSION_KEY, controlPrefix: 'iih-orbit-google-session-control-v1:'}; }
  protected get sessionPersistence(): 'tab' | 'browser' | 'memory' { return 'browser'; }
  protected get sessionChannel(): string { return 'iih-orbit-google-session'; }
  protected get permissionMessage(): string { return '尚未取得月曆讀取權限，請重新連線並允許讀取月曆。'; }
  protected get networkMessage(): string { return '網路中斷或 Google 讀取逾時，已保留原有月曆資料。'; }
  protected get resourceName(): string { return '月曆'; }
  protected get maxResponseBytes(): number | undefined { return undefined; }
  protected get requestTimeoutMs(): number { return 20000; }
  private readonly document = inject(DOCUMENT);
  readonly ready = signal(false);
  readonly preparing = signal(false);
  readonly connected = signal(false);
  readonly expired = signal(false);
  readonly authorizing = signal(false);
  readonly connectionVersion = signal(0);
  readonly account = signal<GoogleAccount | null>(null);
  readonly message = signal('尚未連線 Google');
  readonly sessionWarning = signal('');
  readonly validUntil = signal(0);
  private oauth?: OAuthApi;
  private preparation?: Promise<void>;
  private token = '';
  private expiresAt = 0;
  private epoch = 0;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private historyTimer?: ReturnType<typeof setTimeout>;
  private historyStorage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  private history?: AuthorizationHistory;
  private pendingReject?: (reason: Error) => void;
  private readonly controllers = new Set<AbortController>();
  private session?: GoogleSession;
  private sessionContext?: GoogleSessionContext;
  private authorizationNonce = '';
  private approvedScopes = new Set<string>();
  private readonly bridge: GoogleSessionBridge;
  private readonly wake = () => {this.bridge.verify(); this.refreshHistory();};
  private readonly storageChanged = (event: StorageEvent) => { if (!event.key || event.key.startsWith(this.sessionOptions.controlPrefix) || event.key === this.sessionOptions.storageKey || event.key === this.historyKey()) this.wake(); };

  constructor() {
    const window = this.document.defaultView as (Window & {BroadcastChannel?: typeof BroadcastChannel}) | null;
    let storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined, control: Storage | undefined, channel: SessionChannel | undefined;
    try {
      control = window?.localStorage; this.historyStorage = control;
      if (this.sessionPersistence === 'browser' && control) {
        const browserStorage = control;
        storage = {
          getItem: key => { const saved = browserStorage.getItem(key); if (saved) return saved; try { return window?.sessionStorage.getItem(key) ?? null; } catch { return null; } },
          setItem: (key, value) => { browserStorage.setItem(key, value); try { window?.sessionStorage.removeItem(key); } catch { /* Validated browser storage remains available. */ } },
          removeItem: key => { browserStorage.removeItem(key); try { window?.sessionStorage.removeItem(key); } catch { /* The invalidation nonce also rejects old tab copies. */ } }
        };
      } else if (this.sessionPersistence === 'memory') storage = {getItem: () => null, setItem: () => {}, removeItem: () => {}};
      else storage = window?.sessionStorage;
    }
    catch { this.sessionWarning.set('瀏覽器不允許保存 Google 連線，重新整理後需重新連線。'); }
    try { if (window?.BroadcastChannel) channel = new window.BroadcastChannel(this.sessionChannel); }
    catch { this.sessionWarning.set('瀏覽器無法接續其他分頁的 Google 連線，仍可在此分頁連線。'); }
    this.bridge = new GoogleSessionBridge(storage, control, channel, {
      current: () => this.session, pendingNonce: () => this.authorizationNonce, busy: () => this.authorizing(),
      receive: (session, shared) => this.adopt(session, shared ? '已接續其他分頁的 Google 連線' : '已恢復 Google 連線'),
      expired: session => this.rememberHistory(session),
      clear: message => this.clearLocal(message), warning: message => this.sessionWarning.set(message)
    }, {...this.sessionOptions, sharedStorage: this.sessionPersistence === 'browser'});
    window?.addEventListener?.('focus', this.wake);
    window?.addEventListener?.('storage', this.storageChanged);
    this.document.addEventListener?.('visibilitychange', this.wake);
  }

  useSession(context: GoogleSessionContext): void {
    this.sessionContext = {...context};
    this.bridge.activate(context);
    this.refreshHistory();
  }

  authorizationMarker(): string { return this.bridge.currentNonce(); }
  authorizationIsCurrent(nonce: string): boolean { return !nonce || this.bridge.isCurrent(nonce); }
  hasScope(scope: string): boolean { return scope.split(' ').every(value => this.approvedScopes.has(value)); }
  protected acceptsScopes(scopes: string[]): boolean { return this.sessionOptions.scope.split(' ').every(scope => scopes.includes(scope)); }

  /** Copy a newly approved grant into an independently managed service session. */
  copyAuthorizationTo(target: GoogleAuth, context: GoogleSessionContext, nonce: string): void {
    this.bridge.verify(false);
    const source = this.session;
    if (!source || !this.connected() || source.expiresAt <= Date.now() || !this.hasScope(target.sessionOptions.scope)
      || source.clientId !== context.clientId || source.generation !== context.generation || source.account.id !== context.accountId
      || target.sessionContext?.clientId !== context.clientId || target.sessionContext.generation !== context.generation
      || target.sessionContext.accountId !== context.accountId || nonce && !target.bridge.isCurrent(nonce)) {
      throw new Error('Google 授權或連線設定已變更，請重新連線。');
    }
    target.disconnect(undefined, 'renew');
    const session = {...source, id: crypto.randomUUID(), scope: target.sessionOptions.scope, nonce: target.bridge.currentNonce()};
    target.approvedScopes = new Set(target.sessionOptions.scope.split(' '));
    target.adopt(session, 'Google 已連線'); target.bridge.remember(session);
  }

  private adopt(session: GoogleSession, message: string): void {
    this.connectionVersion.update(version => version + 1);
    this.epoch++; clearTimeout(this.expiryTimer);
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.session = session; this.token = session.token; this.expiresAt = session.expiresAt; this.authorizationNonce = '';
    this.validUntil.set(session.expiresAt);
    this.account.set(session.account); this.connected.set(true); this.authorizing.set(false); this.message.set(message);
    this.rememberHistory(session);
    this.expiryTimer = setTimeout(() => { if (this.session?.id === session.id) this.disconnect('Google 授權已到期，請重新連線。', 'expired'); }, Math.max(0, session.expiresAt - Date.now()));
  }

  private historyKey(): string {return this.sessionOptions.storageKey + ':authorization-history';}
  private historyMatches(history: AuthorizationHistory | undefined): boolean {
    const context = this.sessionContext;
    return !!history && !!context?.accountId && history.version === 1 && history.clientId === context.clientId && history.generation === context.generation
      && history.accountId === context.accountId && Number.isSafeInteger(history.expiresAt) && history.expiresAt >= 0 && history.expiresAt <= Date.now() + 86400000 && typeof history.nonce === 'string';
  }
  private refreshHistory(): void {
    clearTimeout(this.historyTimer);
    if (this.sessionPersistence === 'memory') return;
    try {if (this.historyStorage) this.history = JSON.parse(this.historyStorage.getItem(this.historyKey()) ?? 'null') ?? undefined;}
    catch { /* Keep the in-memory indication when browser storage is unavailable. */ }
    const history = this.historyMatches(this.history) ? this.history : undefined;
    this.expired.set(!this.connected() && !!history && history.expiresAt <= Date.now());
    if (!this.connected() && history && history.expiresAt > Date.now()) this.historyTimer = setTimeout(() => this.refreshHistory(), history.expiresAt - Date.now());
  }
  private rememberHistory(session: GoogleSession, expiresAt = session.expiresAt): void {
    if (this.sessionPersistence === 'memory') return;
    this.history = {version: 1, clientId: session.clientId, generation: session.generation, accountId: session.account.id, expiresAt, nonce: session.nonce};
    try {this.historyStorage?.setItem(this.historyKey(), JSON.stringify(this.history));}
    catch { /* Expiry is a local UI hint, not a saved credential. */ }
    this.refreshHistory();
  }

  prepare(): Promise<void> {
    if (this.ready()) return Promise.resolve();
    if (this.preparation) return this.preparation;
    this.preparing.set(true);
    this.preparation = new Promise<void>((resolve, reject) => {
      const window = this.document.defaultView as (Window & {google?: {accounts?: {oauth2?: OAuthApi}}}) | null;
      const loaded = () => {
        const oauth = window?.google?.accounts?.oauth2;
        if (!oauth) { reject(new Error('Google 授權元件無法載入，請確認網路後重試。')); return; }
        this.oauth = oauth; this.ready.set(true); resolve();
      };
      if (window?.google?.accounts?.oauth2) { loaded(); return; }
      const script = this.document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client'; script.async = true;
      const timer = setTimeout(() => { script.remove(); reject(new Error('Google 授權元件載入逾時，請稍後重試。')); }, 20000);
      script.onload = () => { clearTimeout(timer); loaded(); };
      script.onerror = () => { clearTimeout(timer); script.remove(); reject(new Error('Google 授權元件載入失敗，請確認網路後重試。')); };
      this.document.head.appendChild(script);
    }).finally(() => { this.preparing.set(false); this.preparation = undefined; });
    return this.preparation;
  }

  /** Called directly by a click after the library is ready, preserving the popup user gesture. */
  authorize(clientId: string): Promise<GoogleAccount> {
    if (!this.oauth || this.authorizing()) return Promise.reject(new Error('請等待 Google 授權元件載入完成。'));
    if (this.sessionContext && clientId !== this.sessionContext.clientId) return Promise.reject(new Error('Client ID 已變更，請使用目前設定重新連線。'));
    this.disconnect(undefined, 'renew');
    const epoch = this.epoch;
    const nonce = this.bridge.currentNonce();
    this.authorizationNonce = nonce;
    this.authorizing.set(true);
    return new Promise<GoogleAccount>((resolve, reject) => {
      this.pendingReject = reject;
      const finishError = (message: string) => { if (epoch !== this.epoch) return; this.authorizationNonce = ''; this.authorizing.set(false); this.pendingReject = undefined; this.message.set(message); reject(new Error(message)); };
      const options: Parameters<OAuthApi['initTokenClient']>[0] = {
        client_id: clientId, scope: this.sessionOptions.scope + ' openid https://www.googleapis.com/auth/userinfo.email', include_granted_scopes: false,
        error_callback: error => finishError(error.type === 'popup_closed' ? 'Google 授權視窗已關閉。' : '無法開啟 Google 授權視窗，請允許此網站的彈出視窗。'),
        callback: async response => {
          if (epoch !== this.epoch) return;
          if (nonce && !this.bridge.isCurrent(nonce)) { this.clearLocal('Google 授權已在其他分頁取消或更新。'); return; }
          if (response.error || !response.access_token || !Number.isFinite(Number(response.expires_in))) { finishError(this.permissionMessage); return; }
          const scopes = this.sessionOptions.scope.split(' ').filter(scope => this.oauth!.hasGrantedAllScopes(response, scope));
          if (!this.acceptsScopes(scopes)) { finishError(this.permissionMessage); return; }
          this.token = response.access_token;
          this.expiresAt = Date.now() + Math.max(0, Number(response.expires_in) - 30) * 1000;
          try {
            const identity = await this.fetchJson('https://openidconnect.googleapis.com/v1/userinfo') as {sub?: string; email?: string};
            if (epoch !== this.epoch) return;
            if (nonce && !this.bridge.isCurrent(nonce)) { this.clearLocal('Google 授權已在其他分頁取消或更新。'); return; }
            if (!identity.sub || !identity.email) throw new Error('無法確認 Google 帳號，請重新授權帳號識別權限。');
            const account = {id: identity.sub, email: identity.email};
            const session: GoogleSession = {version: 1, id: crypto.randomUUID(), clientId, generation: this.sessionContext?.generation ?? '', account, scope: this.sessionOptions.scope, token: this.token, expiresAt: this.expiresAt, nonce};
            this.pendingReject = undefined;
            this.approvedScopes = new Set(scopes);
            this.adopt(session, 'Google 已連線');
            this.bridge.remember(session);
            resolve(account);
          } catch (error) {
            if (epoch !== this.epoch) return;
            const message = error instanceof Error ? error.message : '無法確認 Google 帳號。';
            this.token = ''; this.expiresAt = 0; finishError(message);
          }
        }
      };
      try { this.oauth!.initTokenClient(options).requestAccessToken({prompt: 'select_account'}); }
      catch { finishError('無法啟動 Google 授權，請重新嘗試。'); }
    });
  }

  async request(path: string, parameters: Record<string, string>): Promise<unknown> {
    return this.fetchJson('https://www.googleapis.com/calendar/v3/' + path + '?' + new URLSearchParams(parameters));
  }
  cancelRequests(): void { for (const controller of this.controllers) controller.abort(); this.controllers.clear(); }

  protected async fetchJson(url: string, options: RequestInit = {}): Promise<unknown> {
    return this.fetchResource(url, options, async response => {
      const limit = this.maxResponseBytes;
      if (!limit || !response.body) return response.json();
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let size = 0, content = '';
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > limit) { await reader.cancel(); throw new Error('Google 回傳檔案超過大小限制。'); }
          content += decoder.decode(part.value, {stream: true});
        }
        return JSON.parse(content + decoder.decode());
      } finally { reader.releaseLock(); }
    });
  }
  protected async fetchResponse(url: string, options: RequestInit = {}): Promise<Response> {
    return this.fetchResource(url, options, async response => new Response([204, 205, 304].includes(response.status) ? null : await response.arrayBuffer(), {status: response.status, statusText: response.statusText, headers: response.headers}));
  }
  private async fetchResource<T>(url: string, options: RequestInit, consume: (response: Response) => Promise<T>): Promise<T> {
    const target = new URL(url);
    if (!['https://www.googleapis.com', 'https://openidconnect.googleapis.com'].includes(target.origin) || target.username || target.password) throw new Error('Google API 位址不合法。');
    this.bridge.verify(false);
    if (!this.token) throw new GoogleHttpError(401);
    if (Date.now() >= this.expiresAt) { this.disconnect('Google 授權已到期，請重新連線。', 'expired'); throw new GoogleHttpError(401); }
    const epoch = this.epoch;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (options.signal?.aborted) throw new DOMException('Google 讀取已取消。', 'AbortError');
    options.signal?.addEventListener('abort', cancel, {once: true});
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const headers = new Headers(options.headers); headers.delete('Authorization');
      const response = await fetch(url, {...options, method: options.method ?? 'GET', headers: {...Object.fromEntries(headers), Authorization: 'Bearer ' + this.token}, signal: controller.signal, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer'});
      if (!response.ok) {
        const error = await readGoogleHttpError(response, this.resourceName);
        if (response.status === 401 && epoch === this.epoch && !controller.signal.aborted) this.disconnect('Google 授權已到期，請重新連線。', 'expired');
        throw error;
      }
      if (epoch !== this.epoch || controller.signal.aborted) throw new Error('Google 連線已變更，已取消這次操作。');
      const value = await consume(response);
      if (epoch !== this.epoch || controller.signal.aborted) throw new Error('Google 連線已變更，已取消這次操作。');
      return value;
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason instanceof Error ? options.signal.reason : new DOMException('Google 讀取已取消。', 'AbortError');
      if (error instanceof GoogleHttpError) throw error;
      throw new Error(this.networkMessage);
    } finally { clearTimeout(timer); this.controllers.delete(controller); options.signal?.removeEventListener('abort', cancel); }
  }

  disconnect(message = '尚未連線 Google', reason: 'manual' | 'expired' | 'renew' = 'manual'): void {
    this.refreshHistory();
    if (reason === 'expired' && this.session && (!this.history || this.history.nonce === this.session.nonce)) this.rememberHistory(this.session, 0);
    else if (reason === 'manual' && this.historyMatches(this.history)) {
      this.history = undefined;
      try {this.historyStorage?.removeItem(this.historyKey());} catch { /* Keep manual disconnection in this page. */ }
    }
    this.bridge.invalidate(message, this.session?.nonce || this.authorizationNonce || undefined);
    this.clearLocal(message);
  }
  private clearLocal(message: string): void {
    this.connectionVersion.update(version => version + 1);
    this.epoch++; this.token = ''; this.expiresAt = 0;
    this.approvedScopes.clear();
    this.session = undefined; this.authorizationNonce = '';
    this.validUntil.set(0);
    clearTimeout(this.expiryTimer);
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.pendingReject?.(new Error('Google 連線已取消。')); this.pendingReject = undefined;
    this.connected.set(false); this.authorizing.set(false); this.account.set(null); this.message.set(message);
    this.refreshHistory();
  }
  ngOnDestroy(): void {
    this.bridge.close();
    this.document.defaultView?.removeEventListener?.('focus', this.wake);
    this.document.defaultView?.removeEventListener?.('storage', this.storageChanged);
    this.document.removeEventListener?.('visibilitychange', this.wake);
    this.clearLocal('Google 連線已關閉');
    clearTimeout(this.historyTimer);
  }
}
