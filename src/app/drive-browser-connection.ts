import {DOCUMENT} from '@angular/common';
import {effect, inject, Injectable, OnDestroy, signal, untracked} from '@angular/core';
import {BoardStore} from './board-store';
import {DriveBrowserAuth} from './drive-browser-auth';
import type {GoogleAccount} from './google-auth';

const ACCOUNT_KEY = 'iih-orbit-drive-browser-account-v1';
/** Shared authorization only. Each browser owns its own navigation and cache. */
@Injectable({providedIn: 'root'})
export class DriveBrowserConnection implements OnDestroy {
  readonly store = inject(BoardStore);
  readonly auth = inject(DriveBrowserAuth);
  private readonly document = inject(DOCUMENT);
  readonly account = signal<{id: string; email: string}>({id: '', email: ''});
  readonly context = signal('');
  readonly connecting = signal(false);
  readonly warning = signal('');
  readonly error = signal('');
  private request = 0;
  private destroyed = false;
  private readonly accountChanged = (event: StorageEvent) => {if (event.key === ACCOUNT_KEY || event.key === null) this.synchronize();};
  private readonly focused = () => this.synchronize();
  constructor() {
    effect(() => {if (this.store.storageLoading()) return; const generation = this.store.generation(), clientId = this.store.google().clientId; untracked(() => this.synchronize(generation, clientId));});
    effect(() => {
      const connected = this.auth.connected(), account = this.auth.account(), connecting = this.connecting();
      untracked(() => {if (connected && account && !connecting && account.id !== this.account().id) this.acceptAccount(account);});
    });
    this.document.defaultView?.addEventListener('storage', this.accountChanged);
    this.document.defaultView?.addEventListener('focus', this.focused);
  }
  private synchronize(generation = this.store.generation(), clientId = this.store.google().clientId): void {
    if (this.destroyed || this.store.storageLoading()) return;
    let account = this.account();
    try {
      const value = JSON.parse(this.document.defaultView?.localStorage.getItem(ACCOUNT_KEY) ?? 'null');
      account = value?.generation === generation && value.clientId === clientId && typeof value.id === 'string' && value.id.length <= 300 && typeof value.email === 'string' && value.email.length <= 320 ? {id: value.id, email: value.email} : {id: '', email: ''};
    } catch { /* A connection can still be used when persistence is unavailable. */ }
    const context = JSON.stringify([generation, clientId, account.id]);
    if (context !== this.context()) {
      if (this.context()) this.cancelAuthorization();
      this.account.set(account); this.context.set(context);
    }
    this.auth.useSession({generation, clientId, accountId: account.id});
  }
  private acceptAccount(account: {id: string; email: string}): void {
    const generation = this.store.generation(), clientId = this.store.google().clientId;
    this.account.set(account);
    try {this.document.defaultView?.localStorage.setItem(ACCOUNT_KEY, JSON.stringify({...account, generation, clientId}));}
    catch {this.warning.set('此分頁仍可連線，重新整理後可能需要重新授權。');}
    this.context.set(JSON.stringify([generation, clientId, account.id]));
    this.auth.useSession({generation, clientId, accountId: account.id});
  }
  prepare(): Promise<void> {return this.auth.prepare();}
  async connect(authorize?: () => Promise<GoogleAccount>, activate?: () => void): Promise<boolean> {
    const clientId = this.store.google().clientId, generation = this.store.generation();
    if (!clientId || !this.auth.ready() || this.connecting() || this.auth.authorizing()) return false;
    const request = ++this.request, expected = this.context(); this.connecting.set(true); this.warning.set(''); this.error.set('');
    try {
      const account = await (authorize ? authorize() : this.auth.authorize(clientId));
      if (this.destroyed || request !== this.request || expected !== this.context() || generation !== this.store.generation() || clientId !== this.store.google().clientId) return false;
      this.auth.useSession({generation, clientId, accountId: account.id});
      activate?.();
      this.acceptAccount(account); return true;
    } catch (error) {
      if (!this.destroyed && request === this.request) this.error.set(error instanceof Error ? error.message : 'Google Drive 檔案瀏覽授權未完成。');
      return false;
    } finally {this.connecting.set(false);}
  }
  cancelAuthorization(): void {this.request++; if (this.auth.authorizing()) this.auth.disconnect('資料或操作已更新，請重新連線檔案瀏覽。');}
  disconnect(): void {this.request++; this.error.set(''); this.auth.disconnect('檔案瀏覽已解除連線，任務中的資訊連結保留。');}
  ngOnDestroy(): void {this.destroyed = true; this.request++; this.document.defaultView?.removeEventListener('storage', this.accountChanged); this.document.defaultView?.removeEventListener('focus', this.focused);}
}
