import { DOCUMENT } from '@angular/common';
import { inject, Injectable, OnDestroy, signal } from '@angular/core';
import { CALENDAR_SCOPE } from './google-data';
import { GoogleHttpError } from './google-api';
import { GoogleSession, GoogleSessionBridge, GoogleSessionContext, SessionChannel } from './google-session';

interface TokenResponse {access_token?: string; expires_in?: number; error?: string; scope?: string}
interface OAuthApi {
  initTokenClient(options: {client_id: string; scope: string; include_granted_scopes: boolean; callback: (response: TokenResponse) => void; error_callback: (error: {type: string}) => void}): {requestAccessToken(options: {prompt: string}): void};
  hasGrantedAllScopes(response: TokenResponse, ...scopes: string[]): boolean;
}
export interface GoogleAccount {id: string; email: string}

@Injectable({providedIn: 'root'})
export class GoogleAuth implements OnDestroy {
  private readonly document = inject(DOCUMENT);
  readonly ready = signal(false);
  readonly preparing = signal(false);
  readonly connected = signal(false);
  readonly authorizing = signal(false);
  readonly account = signal<GoogleAccount | null>(null);
  readonly message = signal('尚未連線 Google');
  readonly sessionWarning = signal('');
  private oauth?: OAuthApi;
  private preparation?: Promise<void>;
  private token = '';
  private expiresAt = 0;
  private epoch = 0;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private pendingReject?: (reason: Error) => void;
  private readonly controllers = new Set<AbortController>();
  private session?: GoogleSession;
  private sessionContext?: GoogleSessionContext;
  private authorizationNonce = '';
  private readonly bridge: GoogleSessionBridge;
  private readonly wake = () => this.bridge.verify();
  private readonly storageChanged = (event: StorageEvent) => { if (!event.key || event.key.startsWith('iih-orbit-google-session-control-v1:')) this.bridge.verify(); };

  constructor() {
    const window = this.document.defaultView as (Window & {BroadcastChannel?: typeof BroadcastChannel}) | null;
    let storage: Storage | undefined, control: Storage | undefined, channel: SessionChannel | undefined;
    try { storage = window?.sessionStorage; control = window?.localStorage; }
    catch { this.sessionWarning.set('瀏覽器不允許保存 Google 連線，重新整理後需重新連線。'); }
    try { if (window?.BroadcastChannel) channel = new window.BroadcastChannel('iih-orbit-google-session'); }
    catch { this.sessionWarning.set('瀏覽器無法接續其他分頁的 Google 連線，仍可在此分頁連線。'); }
    this.bridge = new GoogleSessionBridge(storage, control, channel, {
      current: () => this.session, pendingNonce: () => this.authorizationNonce, busy: () => this.authorizing(),
      receive: (session, shared) => this.adopt(session, shared ? '已接續其他分頁的 Google 連線' : '已恢復 Google 連線'),
      clear: message => this.clearLocal(message), warning: message => this.sessionWarning.set(message)
    });
    window?.addEventListener?.('focus', this.wake);
    window?.addEventListener?.('storage', this.storageChanged);
    this.document.addEventListener?.('visibilitychange', this.wake);
  }

  useSession(context: GoogleSessionContext): void {
    this.sessionContext = {...context};
    this.bridge.activate(context);
  }

  private adopt(session: GoogleSession, message: string): void {
    this.epoch++; clearTimeout(this.expiryTimer);
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.session = session; this.token = session.token; this.expiresAt = session.expiresAt; this.authorizationNonce = '';
    this.account.set(session.account); this.connected.set(true); this.authorizing.set(false); this.message.set(message);
    this.expiryTimer = setTimeout(() => { if (this.session?.id === session.id) this.disconnect('Google 授權已到期，請重新連線。'); }, Math.max(0, session.expiresAt - Date.now()));
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
    this.disconnect();
    const epoch = this.epoch;
    const nonce = this.bridge.currentNonce();
    this.authorizationNonce = nonce;
    this.authorizing.set(true);
    return new Promise<GoogleAccount>((resolve, reject) => {
      this.pendingReject = reject;
      const finishError = (message: string) => { if (epoch !== this.epoch) return; this.authorizationNonce = ''; this.authorizing.set(false); this.pendingReject = undefined; this.message.set(message); reject(new Error(message)); };
      const options: Parameters<OAuthApi['initTokenClient']>[0] = {
        client_id: clientId, scope: CALENDAR_SCOPE + ' openid https://www.googleapis.com/auth/userinfo.email', include_granted_scopes: false,
        error_callback: error => finishError(error.type === 'popup_closed' ? 'Google 授權視窗已關閉。' : '無法開啟 Google 授權視窗，請允許此網站的彈出視窗。'),
        callback: async response => {
          if (epoch !== this.epoch) return;
          if (nonce && !this.bridge.isCurrent(nonce)) { this.clearLocal('Google 授權已在其他分頁取消或更新。'); return; }
          if (response.error || !response.access_token || !Number.isFinite(Number(response.expires_in)) || !this.oauth!.hasGrantedAllScopes(response, CALENDAR_SCOPE)) { finishError('尚未取得月曆讀取權限，請重新連線並允許讀取月曆。'); return; }
          this.token = response.access_token;
          this.expiresAt = Date.now() + Math.max(0, Number(response.expires_in) - 30) * 1000;
          try {
            const identity = await this.fetchJson('https://openidconnect.googleapis.com/v1/userinfo') as {sub?: string; email?: string};
            if (epoch !== this.epoch) return;
            if (nonce && !this.bridge.isCurrent(nonce)) { this.clearLocal('Google 授權已在其他分頁取消或更新。'); return; }
            if (!identity.sub || !identity.email) throw new Error('無法確認 Google 帳號，請重新授權帳號識別權限。');
            const account = {id: identity.sub, email: identity.email};
            const session: GoogleSession = {version: 1, id: crypto.randomUUID(), clientId, generation: this.sessionContext?.generation ?? '', account, scope: CALENDAR_SCOPE, token: this.token, expiresAt: this.expiresAt, nonce};
            this.pendingReject = undefined;
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

  private async fetchJson(url: string): Promise<unknown> {
    this.bridge.verify(false);
    if (!this.token) throw new GoogleHttpError(401);
    if (Date.now() >= this.expiresAt) { this.disconnect('Google 授權已到期，請重新連線。'); throw new GoogleHttpError(401); }
    const epoch = this.epoch;
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(url, {method: 'GET', headers: {Authorization: 'Bearer ' + this.token}, signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer'});
      if (!response.ok) {
        if (response.status === 401 && epoch === this.epoch && !controller.signal.aborted) this.disconnect('Google 授權已到期，請重新連線。');
        throw new GoogleHttpError(response.status);
      }
      return await response.json();
    } catch (error) {
      if (error instanceof GoogleHttpError) throw error;
      throw new Error('網路中斷或 Google 讀取逾時，已保留原有月曆資料。');
    } finally { clearTimeout(timer); this.controllers.delete(controller); }
  }

  disconnect(message = '尚未連線 Google'): void {
    this.bridge.invalidate(message, this.session?.nonce || this.authorizationNonce || undefined);
    this.clearLocal(message);
  }
  private clearLocal(message: string): void {
    this.epoch++; this.token = ''; this.expiresAt = 0;
    this.session = undefined; this.authorizationNonce = '';
    clearTimeout(this.expiryTimer);
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.pendingReject?.(new Error('Google 連線已取消。')); this.pendingReject = undefined;
    this.connected.set(false); this.authorizing.set(false); this.account.set(null); this.message.set(message);
  }
  ngOnDestroy(): void {
    this.bridge.close();
    this.document.defaultView?.removeEventListener?.('focus', this.wake);
    this.document.defaultView?.removeEventListener?.('storage', this.storageChanged);
    this.document.removeEventListener?.('visibilitychange', this.wake);
    this.clearLocal('Google 連線已關閉');
  }
}
