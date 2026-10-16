import { computed, effect, inject, Injectable, Injector, OnDestroy, signal, untracked } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { BoardStore } from './board-store';
import { GoogleCalendarService } from './google-calendar';
import { CalendarWriteAuth, CALENDAR_WRITE_SCOPE } from './calendar-write-auth';
import { GmailService } from './gmail-service';
import { DriveService } from './drive-service';
import { CALENDAR_SCOPE } from './google-data';
import { GMAIL_SCOPE } from './gmail-data';
import { DRIVE_SCOPE, type DriveFile, syncHash, versionGraph } from './drive-data';
import { COLUMNS } from './models';
import { CalendarCache } from './calendar-cache';
import { clearLogoutStorage } from './logout-storage';
import { loadDeviceIdentity } from './device-data';
import { GoogleCombinedAuth } from './google-combined-auth';
import type { GoogleAuth } from './google-auth';
import { DriveBrowserConnection } from './drive-browser-connection';
import { DRIVE_BROWSER_SCOPE } from './drive-browser-data';

/** Shared consent and connection state for settings and the direct renewal button. */
@Injectable({providedIn: 'root'})
export class GoogleConnections implements OnDestroy {
  readonly store = inject(BoardStore);
  readonly calendar = inject(GoogleCalendarService);
  readonly writeAuth = inject(CalendarWriteAuth);
  readonly gmail = inject(GmailService);
  readonly drive = inject(DriveService);
  readonly combined = inject(GoogleCombinedAuth);
  readonly files = inject(DriveBrowserConnection);
  private readonly injector = inject(Injector);
  private readonly document = inject(DOCUMENT);
  readonly preparing = signal(false);
  readonly connectingAll = signal(false);
  readonly loggingOut = signal(false);
  readonly cleaning = signal(false);
  readonly cleanupError = signal('');
  readonly resuming = signal(false);
  readonly resumeChoices = signal<DriveFile[]>([]);
  private resumeHeads: string[] = [];
  readonly error = signal('');
  readonly message = signal('');
  private destroyed = false;
  private requestVersion = 0;
  readonly busy = computed(() => this.connectingAll() || this.loggingOut() || this.cleaning() || this.resuming() || this.store.pendingWrites() > 0 || this.calendar.auth.authorizing() || this.writeAuth.authorizing() || this.gmail.auth.authorizing() || this.drive.busy() || this.drive.syncing() || this.files.anyConnecting());
  readonly allConnected = computed(() => !!this.store.google().clientId && [this.calendar.auth, this.gmail.auth, this.drive.auth, this.writeAuth, this.files.auth].every(auth => auth.connected()));
  readonly renewalNeeded = computed(() => !!this.store.google().clientId && [this.calendar.auth, this.gmail.auth, this.drive.auth, this.writeAuth, this.files.auth].some(auth => auth.expired()));
  readonly authorizationNeeded = computed(() => this.renewalNeeded() || !!this.store.cloudResume());
  readonly renewalVisible = computed(() => this.authorizationNeeded() || this.connectingAll() || this.resuming());
  readonly canConnect = computed(() => !!this.store.google().clientId && this.combined.ready() && this.drive.online() && !this.busy() && !this.cleanupError() && (!this.drive.runtime().pending || !!this.store.cloudResume()));
  constructor() {
    effect(() => {const id = this.store.google().clientId; untracked(() => {if (id) void this.prepare();});});
    effect(() => {
      if (this.store.storageLoading?.()) return;
      const context = {generation: this.store.generation(), clientId: this.store.google().clientId, accountId: this.store.google().accountId};
      const connecting = this.connectingAll();
      untracked(() => {if (!this.writeAuth.authorizing() && !connecting) this.writeAuth.useSession(context);});
    });
    let startupChecked = false;
    effect(() => {
      if (this.store.storageLoading?.()) return;
      const pending = this.store.cloudResume()?.cleanupPending;
      untracked(() => {if (!startupChecked) {startupChecked = true; if (pending) void this.cleanupLogout();}});
    });
  }
  async prepare(): Promise<void> {
    if (this.preparing()) return;
    this.preparing.set(true); this.error.set('');
    try {await Promise.all([this.calendar.auth, this.gmail.auth, this.drive.auth, this.files.auth, this.combined].map(auth => auth.prepare()));}
    catch (error) {this.error.set(error instanceof Error ? error.message : '無法載入 Google 授權元件。');}
    finally {this.preparing.set(false);}
  }
  private accountConfiguration(): string {
    return JSON.stringify([this.store.generation(), this.store.google().clientId, this.store.google().accountId, this.store.drive().accountId, this.gmail.preferences().accountId, this.files.context()]);
  }
  async connectAll(renewExisting = false): Promise<void> {
    const clientId = this.store.google().clientId, generation = this.store.generation();
    if (this.busy() || !clientId || !this.combined.ready() || !this.drive.online()) return;
    if (this.drive.runtime().pending && !this.store.cloudResume()) {this.error.set('請先完成 Drive 等待上傳的資料，再一次授權全部服務。'); return;}
    const configuration = this.accountConfiguration();
    const request = ++this.requestVersion;
    const targets = [this.calendar.auth, this.gmail.auth, this.drive.auth, this.writeAuth, this.files.auth];
    const accounts = [this.store.google().accountId, this.gmail.preferences().accountId, this.store.drive().accountId, this.store.google().accountId, this.files.account().id];
    const knownAccounts = [...new Set(accounts.filter(Boolean))];
    if (renewExisting && knownAccounts.length > 1) {this.error.set('目前各服務使用不同帳號，請在設定中分別重新授權，以保留各自的來源。'); return;}
    const markers = new Map<GoogleAuth, string>();
    targets.forEach((auth, index) => {auth.useSession({clientId, generation, accountId: accounts[index]}); markers.set(auth, auth.authorizationMarker());});
    this.combined.useSession({clientId, generation, accountId: ''});
    this.connectingAll.set(true); this.error.set(''); this.message.set('');
    this.resumeChoices.set([]); this.resumeHeads = [];
    let resumeApproved = false;
    try {
      const expectedAccountId = renewExisting ? knownAccounts[0] : undefined;
      const account = await this.combined.authorize(clientId, expectedAccountId ? {selectAccount: false, expectedAccountId, loginHint: expectedAccountId} : {});
      if (this.destroyed || request !== this.requestVersion || configuration !== this.accountConfiguration() || targets.some(auth => !auth.authorizationIsCurrent(markers.get(auth)!))) throw new Error('帳號或設定已變更，請重新授權。');
      const context = {clientId, generation, accountId: account.id};
      this.combined.useSession(context);
      const activate = (auth: GoogleAuth) => () => {
        if (this.destroyed || request !== this.requestVersion || generation !== this.store.generation() || clientId !== this.store.google().clientId) throw new Error('資料或 Client ID 已變更，請重新授權。');
        this.combined.copyAuthorizationTo(auth, context, markers.get(auth)!);
      };
      const services = [
        {name: 'Calendar', scope: CALENDAR_SCOPE, auth: this.calendar.auth, connect: () => this.calendar.connect(async () => account, activate(this.calendar.auth))},
        {name: 'Gmail', scope: GMAIL_SCOPE, auth: this.gmail.auth, connect: () => this.gmail.connect(async () => account, activate(this.gmail.auth))},
        {name: 'Drive', scope: DRIVE_SCOPE, auth: this.drive.auth, connect: () => this.drive.connect(async () => account, activate(this.drive.auth))},
        {name: 'Drive 檔案瀏覽', scope: DRIVE_BROWSER_SCOPE, auth: this.files.auth, connect: () => this.files.connect(async () => account, activate(this.files.auth))}
      ];
      const approved = services.filter(service => this.combined.hasScope(service.scope));
      if (this.combined.hasScope(CALENDAR_SCOPE)) this.writeAuth.useSession(context);
      await Promise.all(approved.map(service => service.connect()));
      if (this.destroyed || request !== this.requestVersion || generation !== this.store.generation() || clientId !== this.store.google().clientId) return;
      if (this.combined.hasScope(CALENDAR_WRITE_SCOPE) && this.calendar.auth.connected() && this.store.google().accountId === account.id) {
        this.writeAuth.useSession(context); activate(this.writeAuth)();
      }
      const connected = approved.filter(service => service.auth.connected() && service.auth.account()?.id === account.id).map(service => service.name);
      resumeApproved = this.combined.hasScope(DRIVE_SCOPE) && this.drive.auth.connected() && this.drive.auth.account()?.id === account.id;
      const missing = services.filter(service => !this.combined.hasScope(service.scope)).map(service => service.name);
      if (this.combined.hasScope(CALENDAR_SCOPE) && !this.combined.hasScope(CALENDAR_WRITE_SCOPE)) missing.push('Calendar 寫入');
      if (connected.length) this.message.set(`已連線：${connected.join('、')}（${account.email}）。`);
      if (missing.length) this.error.set(`本次尚未取得 ${missing.join('、')} 權限，可到 Google 連線設定分別授權。`);
      else if (connected.length !== services.length) this.error.set('部分服務尚未完成連線，請查看 Google 連線設定中的訊息。');
    } catch (error) {if (!this.destroyed && request === this.requestVersion) this.error.set(error instanceof Error ? error.message : 'Google 授權未完成，可分別連線所需服務。');}
    finally {this.combined.disconnect(); this.connectingAll.set(false);}
    if (resumeApproved && !this.destroyed && request === this.requestVersion && generation === this.store.generation() && this.store.cloudResume()) await this.resumeCloud();
  }
  async resumeCloud(choice?: DriveFile): Promise<void> {
    const resume = this.store.cloudResume(), generation = this.store.generation(), clientId = this.store.google().clientId;
    if (!resume || this.busy() || !this.drive.auth.connected() || !this.drive.online() || this.cleanupError()) return;
    const accountId = this.store.drive().accountId, connection = this.drive.auth.connectionVersion();
    this.resuming.set(true); this.error.set(''); this.message.set('正在取回雲端資料…');
    const current = () => !this.destroyed && generation === this.store.generation() && clientId === this.store.google().clientId && resume.datasetId === this.store.cloudResume()?.datasetId
      && this.drive.auth.connected() && connection === this.drive.auth.connectionVersion() && accountId === this.store.drive().accountId;
    try {
      const reviewedHeads = [...this.resumeHeads];
      const local = await this.store.driveSnapshot('full', []);
      if (!current()) return;
      const workspaces = local.backup.data.workspaces;
      const hasLocalWork = workspaces.length !== 1 || workspaces.some(workspace => workspace.tasks.length || workspace.projects.some(project => workspace.projects.length !== 1 || project.name !== workspace.name) || workspace.categories.length || workspace.calendarTransfers?.length || workspace.taskConflicts?.length
        || !['空白工作空間', '我的工作空間'].includes(workspace.name) || workspace.statuses.length !== COLUMNS.length || workspace.statuses.some((status, index) => {
          const initial = COLUMNS[index];
          return status.id !== initial.id || status.label !== initial.label || status.subtitle !== initial.subtitle || status.kind !== initial.kind || status.color !== initial.color || !!status.hidden !== !!initial.hidden;
        })) || !!local.backup.google?.sources.length;
      const link = this.drive.runtime().link;
      if (hasLocalWork && (link?.datasetId !== resume.datasetId || await syncHash(local.backup) !== link.baseHash)) throw new Error('本機已有新建立或修改的資料，尚未覆蓋。請先備份，再到遠端同步設定查看並使用雲端內容。');
      if (this.drive.runtime().pending) {
        await this.drive.retry();
        if (!current()) return;
        if (this.drive.runtime().pending) throw new Error(this.drive.error() || '上傳尚未完成，請再試一次。');
      }
      await this.drive.list();
      if (!current()) return;
      if (!this.drive.catalogFresh()) throw new Error(this.drive.error() || '無法讀取雲端資料，請確認網路後再登入。');
      if (this.drive.removals().some(file => file.cloud.datasetId === resume.datasetId)) throw new Error('原本的雲端集合已被刪除，尚未登入。');
      const heads = versionGraph(this.drive.files().filter(file => file.cloud.datasetId === resume.datasetId)).heads;
      if (!heads.length) throw new Error('這個 Google 帳號找不到原本的雲端集合，請按 G 改用原本的帳號登入。');
      if (heads.some(file => file.kind !== 'full' || file.cloud.purpose === 'manual')) throw new Error('原本的雲端集合已改變保存範圍，尚未登入，請先在原裝置檢查。');
      this.resumeHeads = heads.map(file => file.cloud.versionId).sort();
      if (choice && (JSON.stringify(reviewedHeads) !== JSON.stringify(this.resumeHeads) || !heads.some(file => file.id === choice.id))) {
        this.resumeChoices.set(heads); throw new Error('雲端內容又有更新，請重新選擇要使用的內容。');
      }
      if (heads.length > 1 && !choice) {this.resumeChoices.set(heads); this.message.set('原本的雲端集合有多份不同內容，請選擇要使用的版本。'); return;}
      const file = choice ? heads.find(file => file.id === choice.id)! : heads[0];
      if (!await this.drive.join(file, local.revision, this.resumeHeads)) throw new Error(this.drive.error() || '雲端資料尚未取回，請再試一次。');
      if (!current()) return;
      if (this.drive.runtime().pending || this.drive.runtime().conflict?.length) throw new Error('登入期間雲端又有更新，請重新取回並選擇內容。');
      const result = await this.store.finishCloudLogin(resume.datasetId, generation);
      if (!result.ok) throw new Error(result.message);
      this.resumeChoices.set([]); this.message.set('已登入並同步原本的雲端資料。');
    } catch (error) {if (current()) this.error.set(error instanceof Error ? error.message : '登入與同步尚未完成，請再試一次。');}
    finally {
      if (!current() && generation === this.store.generation() && this.store.cloudResume()?.datasetId === resume.datasetId) {this.message.set(''); this.error.set('Google 連線或設定已變更，請再按 G 登入。');}
      this.resuming.set(false);
    }
  }
  async logout(): Promise<void> {
    if (this.busy() || this.store.cloudResume()) return;
    const clientId = this.store.google().clientId, generation = this.store.generation();
    this.loggingOut.set(true); this.error.set(''); this.message.set('正在同步並備份全部工作空間…');
    try {
      const checkpoint = await this.drive.checkpointForLogout();
      if (!checkpoint) throw new Error(this.drive.error() || '同步備份尚未完成，本機資料保留。');
      if (this.destroyed || generation !== this.store.generation() || clientId !== this.store.google().clientId) throw new Error('資料或 Client ID 已變更，尚未登出。');
      const result = await this.store.logoutToCloud(clientId, checkpoint.datasetId, checkpoint.revision, generation);
      if (!result.ok) throw new Error(result.message);
      const loggedOutGeneration = this.store.generation();
      await this.cleanupLogout();
      if (this.cleanupError() || loggedOutGeneration !== this.store.generation() || this.store.cloudResume()?.datasetId !== checkpoint.datasetId) return;
      this.message.set('已完成雲端備份並登出，只保留 Client ID 與雲端集合識別。');
      this.document.defaultView?.location?.reload();
    } catch (error) {this.error.set(error instanceof Error ? error.message : '同步並登出尚未完成，本機資料保留。');}
    finally {this.loggingOut.set(false);}
  }
  async cleanupLogout(): Promise<void> {
    if (!this.store.cloudResume() || this.cleaning() || this.resuming() || this.connectingAll()) return;
    const generation = this.store.generation();
    this.cleaning.set(true); this.cleanupError.set('');
    try {
      this.cancelAll();
      this.files.disconnectAll();
      for (const auth of [this.calendar.auth, this.gmail.auth, this.drive.auth, this.writeAuth]) auth.disconnect();
      const cleaned = await Promise.allSettled([this.injector.get(CalendarCache).clear(), this.drive.clearLocalData()]);
      if (generation !== this.store.generation() || !this.store.cloudResume()) return;
      if (cleaned.some(result => result.status === 'rejected')) throw new Error('瀏覽器無法完成快取清理，請重試清理後再登入。');
      clearLogoutStorage(localStorage, true);
      const storage = this.document.defaultView?.sessionStorage;
      if (storage) clearLogoutStorage(storage);
      this.store.device.set(loadDeviceIdentity());
      const result = await this.store.finishLogoutCleanup(this.store.cloudResume()!.datasetId, generation);
      if (!result.ok) throw new Error(result.message);
    } catch (error) {this.cleanupError.set(error instanceof Error ? error.message : '本機資料清理未完成，請重試。');}
    finally {this.cleaning.set(false);}
  }
  cancelAll(): void {this.requestVersion++; this.combined.disconnect(); this.files.cancelAllSources();}
  ngOnDestroy(): void {this.destroyed = true; this.cancelAll();}
}
