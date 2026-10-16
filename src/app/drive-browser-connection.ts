import {DOCUMENT} from '@angular/common';
import {computed, effect, inject, Injectable, Injector, OnDestroy, signal, untracked} from '@angular/core';
import {BoardStore} from './board-store';
import {DriveBrowserAuth} from './drive-browser-auth';
import {GOOGLE_AUTH_SESSION, type GoogleAccount} from './google-auth';
import {DRIVE_BROWSER_SCOPE} from './drive-browser-data';
import {DEFAULT_DRIVE_SOURCE, DRIVE_SOURCE_KEY, defaultDriveSources, readDriveSources, type DriveSourceSettings} from './drive-source-data';
import {DriveSourceConnection} from './drive-source-connection';
import {validClientId} from './google-data';

const ACCOUNT_KEY = 'iih-orbit-drive-browser-account-v1';
/** Shared authorization only. Each browser owns its own navigation and cache. */
@Injectable({providedIn: 'root'})
export class DriveBrowserConnection implements OnDestroy {
  readonly id = DEFAULT_DRIVE_SOURCE;
  readonly name = signal('主要來源');
  readonly store = inject(BoardStore);
  readonly auth = inject(DriveBrowserAuth);
  private readonly document = inject(DOCUMENT);
  private readonly injector = inject(Injector);
  readonly sources = signal<(DriveBrowserConnection | DriveSourceConnection)[]>([this]);
  readonly sourceError = signal('');
  readonly sourceNotice = signal('');
  readonly clock = signal(Date.now());
  readonly anyConnecting = computed(() => this.sources().some(source => source.connecting() || source.auth.authorizing()));
  private readonly extras = new Map<string, {source: DriveSourceConnection; injector: ReturnType<typeof Injector.create>}>();
  private readonly clockTimer = setInterval(() => this.clock.set(Date.now()), 30000);
  readonly account = signal<{id: string; email: string}>({id: '', email: ''});
  readonly context = signal('');
  readonly connecting = signal(false);
  readonly warning = signal('');
  readonly error = signal('');
  private request = 0;
  private destroyed = false;
  private readonly accountChanged = (event: StorageEvent) => {if (event.key === ACCOUNT_KEY || event.key === DRIVE_SOURCE_KEY || event.key === null) {this.synchronize(); this.synchronizeSources();}};
  private readonly focused = () => {this.clock.set(Date.now()); this.synchronize(); this.synchronizeSources();};
  constructor() {
    effect(() => {if (this.store.storageLoading()) return; const generation = this.store.generation(), clientId = this.store.google().clientId; untracked(() => {this.synchronize(generation, clientId); this.synchronizeSources();});});
    effect(() => {
      const connected = this.auth.connected(), account = this.auth.account(), connecting = this.connecting();
      untracked(() => {if (connected && account && !connecting && account.id !== this.account().id) this.acceptAccount(account);});
    });
    this.document.defaultView?.addEventListener('storage', this.accountChanged);
    this.document.defaultView?.addEventListener('focus', this.focused);
  }
  clientId(): string {return this.store.google().clientId;}
  source(id: string): DriveBrowserConnection | DriveSourceConnection {return this.sources().find(source => source.id === id) ?? this;}
  status(source: DriveBrowserConnection | DriveSourceConnection): string {
    const now = this.clock();
    return source.connecting() || source.auth.authorizing() ? '等待授權…' : source.auth.connected()
      ? source.auth.validUntil?.() && source.auth.validUntil() - now <= 5 * 60000 ? '即將到期' : '已連線'
      : source.auth.expired?.() ? '授權已到期' : '尚未連線';
  }
  private readSettings(): DriveSourceSettings {
    const raw = this.document.defaultView?.localStorage.getItem(DRIVE_SOURCE_KEY);
    if (!raw) return defaultDriveSources();
    const settings = readDriveSources(JSON.parse(raw));
    if (!settings) throw new Error('檔案來源設定無法讀取，請保留原設定並重試。');
    return settings;
  }
  private synchronizeSources(): void {
    if (this.destroyed || this.store.storageLoading()) return;
    try {
      const settings = this.readSettings(); this.name.set(settings.defaultName);
      for (const [id, entry] of this.extras) if (!settings.sources.some(source => source.id === id)) {entry.source.disconnect(); entry.source.destroy(); entry.injector.destroy(); this.extras.delete(id);}
      for (const profile of settings.sources) {
        let entry = this.extras.get(profile.id);
        if (!entry) {
          const prefix = 'iih-orbit-drive-source-' + profile.id;
          const injector = Injector.create({parent: this.injector, providers: [DriveBrowserAuth, {provide: GOOGLE_AUTH_SESSION, useValue: {options: {scope: DRIVE_BROWSER_SCOPE, storageKey: prefix + '-session-v1', controlPrefix: prefix + '-control-v1:'}, channel: prefix + '-session'}}]});
          const auth = injector.get(DriveBrowserAuth);
          const source = new DriveSourceConnection(profile, auth, () => this.store.generation(), (id, account) => {
            const generation = this.store.generation(), context = source.context();
            return this.updateSettings(settings => {
              const saved = settings.sources.find(item => item.id === id);
              if (!saved || generation !== this.store.generation() || context !== source.context() || saved.clientId !== source.clientId() || saved.accountId !== source.account().id) throw new Error('來源設定已更新，請重新連線。');
              saved.accountId = account.id; saved.email = account.email;
            });
          });
          entry = {source, injector}; this.extras.set(profile.id, entry);
        }
        entry.source.synchronize(profile);
      }
      this.sources.set([this, ...settings.sources.map(profile => this.extras.get(profile.id)!.source)]);
    } catch (error) {this.sourceError.set(error instanceof Error ? error.message : '無法讀取檔案來源設定。');}
  }
  private async updateSettings(change: (settings: DriveSourceSettings) => void): Promise<boolean> {
    const generation = this.store.generation();
    const write = () => {
      if (this.destroyed || generation !== this.store.generation()) throw new Error('工作資料已更新，請重試來源設定。');
      const settings = this.readSettings(); change(settings);
      const safe = readDriveSources(settings);
      if (!safe) throw new Error('請填寫來源名稱與有效的 Google Client ID；最多可新增 20 個來源。');
      const storage = this.document.defaultView?.localStorage;
      if (!storage) throw new Error('瀏覽器無法保存來源設定，原設定保留。');
      storage.setItem(DRIVE_SOURCE_KEY, JSON.stringify(safe)); this.synchronizeSources();
    };
    try {
      const locks = this.document.defaultView?.navigator?.locks;
      if (locks) await locks.request(DRIVE_SOURCE_KEY, write); else write();
      this.sourceError.set(''); return true;
    } catch (error) {this.sourceError.set(error instanceof Error ? error.message : '來源設定未保存，請重試。'); return false;}
  }
  async addSource(name: string, clientId = this.clientId()): Promise<string | undefined> {
    const id = crypto.randomUUID();
    return await this.updateSettings(settings => settings.sources.push({id, provider: 'google-drive', name: name.trim(), clientId: clientId.trim(), accountId: '', email: ''})) ? id : undefined;
  }
  async saveSource(id: string, name: string, clientId: string): Promise<boolean> {
    if (id !== this.id && (!clientId || !validClientId(clientId))) {this.sourceError.set('請填寫有效的 Google Client ID。'); return false;}
    const saved = await this.updateSettings(settings => {
      if (id === this.id) settings.defaultName = name.trim();
      else {
        const profile = settings.sources.find(source => source.id === id);
        if (!profile) throw new Error('來源已移除，請重新選擇。');
        if (profile.clientId !== clientId) {profile.accountId = ''; profile.email = '';}
        profile.name = name.trim(); profile.clientId = clientId.trim();
      }
    });
    if (saved) this.sourceNotice.set('來源設定已保存。');
    return saved;
  }
  async removeSource(id: string): Promise<boolean> {
    if (id === this.id) return false;
    const saved = await this.updateSettings(settings => {
      if (!settings.sources.some(profile => profile.id === id)) throw new Error('來源已移除，請重新選擇。');
      settings.sources = settings.sources.filter(profile => profile.id !== id);
    });
    if (saved) this.sourceNotice.set('來源已移除，任務中的資訊連結保留。');
    return saved;
  }
  cancelAllSources(): void {this.cancelAuthorization(); for (const {source} of this.extras.values()) source.cancelAuthorization();}
  disconnectAll(): void {this.disconnect(); for (const {source} of this.extras.values()) source.disconnect();}
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
  async connect(authorize?: () => Promise<GoogleAccount>, activate?: () => void, selectAccount = false): Promise<boolean> {
    const clientId = this.store.google().clientId, generation = this.store.generation();
    if (!clientId || !this.auth.ready() || this.connecting() || this.auth.authorizing()) return false;
    const request = ++this.request, expected = this.context(); this.connecting.set(true); this.warning.set(''); this.error.set('');
    try {
      const accountId = this.account().id;
      const account = await (authorize ? authorize() : this.auth.authorize(clientId, {selectAccount: selectAccount || !accountId, ...(!selectAccount && accountId ? {expectedAccountId: accountId, loginHint: accountId} : {})}));
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
  ngOnDestroy(): void {this.destroyed = true; this.request++; clearInterval(this.clockTimer); for (const {source, injector} of this.extras.values()) {source.destroy(); injector.destroy();} this.extras.clear(); this.document.defaultView?.removeEventListener('storage', this.accountChanged); this.document.defaultView?.removeEventListener('focus', this.focused);}
}
