import { computed, effect, inject, Injectable, OnDestroy, signal, untracked } from '@angular/core';
import { BoardStore } from './board-store';
import { BackupKind, OrbitBackup } from './backup-data';
import { CalendarSyncCoordinator } from './calendar-sync';
import { DriveApi } from './drive-api';
import { DriveAuth } from './drive-auth';
import type { GoogleAccount } from './google-auth';
import { backupHash, canonical, DriveCollectionDeleted, DriveDeletePlan, DriveDocument, DriveFile, DriveRuntime, syncHash, versionGraph } from './drive-data';
import { DriveEngine } from './drive-engine';
import { fileScope } from './drive-catalog';
import { IndexedDriveRepository } from './drive-repository';
import { withStorageLock } from './storage-coordinator';

const SYNC_PREFIX = 'iih-orbit-drive-sync-v1:';
export type DriveSyncResult = 'complete' | 'pending' | 'conflict' | 'failed' | 'skipped';
export interface DriveRemovalReview extends DriveDeletePlan {
  context: string; connection: number; settings: string; generation: string;
  currentCollection: boolean; pendingVersion: string;
  label: string;
  branchHeads?: string[];
}
function pendingRemoval(state: DriveRuntime, plan: DriveDeletePlan): DriveDocument | undefined {
  const pending = state.pending;
  return pending?.document.cloud.datasetId === plan.datasetId && (plan.kind === 'collection' || pending.fileId === plan.files[0]?.id) ? pending.document : undefined;
}
@Injectable({providedIn: 'root'})
export class DriveService implements OnDestroy {
  readonly store = inject(BoardStore);
  readonly auth = inject(DriveAuth);
  private readonly api = new DriveApi(this.auth);
  private readonly repository = new IndexedDriveRepository();
  readonly runtime = signal<DriveRuntime>({});
  readonly runtimeReady = signal(false);
  readonly files = signal<DriveFile[]>([]);
  readonly removals = signal<DriveFile[]>([]);
  readonly catalogState = signal<'idle' | 'loading' | 'ready' | 'error'>('idle');
  readonly catalogError = signal('');
  readonly cleanupError = signal('');
  readonly catalogCheckedAt = signal('');
  private readonly catalogConnection = signal('');
  readonly catalogFresh = computed(() => this.auth.connected() && this.catalogState() === 'ready' && this.catalogConnection() === this.catalogKey());
  private readonly missingCollection = signal('');
  readonly error = signal('');
  readonly message = signal('');
  readonly lastSyncAt = signal('');
  readonly syncing = signal(false);
  readonly active = signal(false);
  readonly online = signal(typeof navigator === 'undefined' || navigator.onLine !== false);
  private readonly localBusy = signal(false);
  readonly busy = computed(() => this.localBusy() || this.active() || this.auth.authorizing());
  readonly unavailable = computed(() => !!this.runtime().link && (this.missingCollection() === this.runtime().link!.datasetId || this.removals().some(file => file.cloud.datasetId === this.runtime().link!.datasetId)));
  readonly status = computed(() => {
    if (!this.online()) return '離線・變更已留在本機';
    if (this.busy()) return '處理中…';
    if (this.unavailable()) return '找不到雲端資料・本機資料保留';
    if (!this.auth.connected()) return '尚未連線';
    if (this.runtime().conflict) return '有不同內容・請選擇';
    if (this.runtime().pending) return '還有資料等待上傳';
    if (!this.runtime().link) return '已連線';
    if (this.store.drive().mode === 'off') return '自動儲存已暫停';
    return this.store.drive().mode === 'backup' ? '自動備份已開啟' : '自動儲存已開啟';
  });
  private context = '';
  private generation = this.store.generation();
  private epoch = 0;
  private destroyed = false;
  private suspended = false;
  private debounce?: ReturnType<typeof setTimeout>;
  private lastPoll = 0;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly coordinator: CalendarSyncCoordinator;
  private channel?: BroadcastChannel;
  private readonly wake = () => {
    const wasOnline = this.online();
    this.online.set(navigator.onLine !== false); this.coordinator.refresh();
    if (!wasOnline && this.online()) this.schedule();
    void this.loadRuntime(); this.poll();
  };
  private readonly storage = (event: StorageEvent) => { if (!event.key || event.key.startsWith(SYNC_PREFIX)) this.coordinator.refresh(); };
  private readonly hide = () => { this.suspended = true; this.epoch++; clearTimeout(this.debounce); this.coordinator.suspend(); this.auth.cancelRequests(); };
  private readonly show = (event: PageTransitionEvent) => { if (event.persisted) { this.suspended = false; this.coordinator.resume(); this.wake(); this.schedule(); } };

  constructor() {
    let syncChannel: BroadcastChannel | undefined;
    try {
      syncChannel = new BroadcastChannel('iih-orbit-drive-activity');
      this.channel = new BroadcastChannel('iih-orbit-drive-data'); this.channel.onmessage = event => {
        void this.loadRuntime();
        if (event.data?.kind === 'removal' && event.data?.context === this.context) {this.coordinator.refresh(); void this.list();}
      };
    } catch { /* Storage events and the polling timer remain available. */ }
    this.coordinator = new CalendarSyncCoordinator(localStorage, withStorageLock, keys => this.active.set(keys.length > 0), syncChannel, navigator.locks, 240000, {storagePrefix: SYNC_PREFIX, lockPrefix: 'iih-orbit-drive-run:', label: 'Drive'});
    effect(() => {
      const settings = this.store.drive(), clientId = this.store.google().clientId, generation = this.store.generation();
      const context = JSON.stringify([clientId, generation, settings.accountId]);
      untracked(() => {
        this.auth.useSession({clientId, generation, accountId: settings.accountId});
        if (context !== this.context) {
          const reset = generation !== this.generation; this.generation = generation;
          this.context = context; this.epoch++; this.auth.cancelRequests(); this.runtimeReady.set(false); this.runtime.set({}); this.files.set([]); this.removals.set([]); this.missingCollection.set(''); this.error.set('');
          this.catalogState.set('idle'); this.catalogConnection.set(''); this.catalogError.set(''); this.cleanupError.set(''); this.catalogCheckedAt.set('');
          this.lastSyncAt.set('');
          this.coordinator.activate(context);
          void (reset ? this.repository.clear() : Promise.resolve()).then(() => this.loadRuntime()).catch(error => this.error.set(this.describe(error)));
        }
      });
    });
    effect(() => { this.store.revision(); this.auth.connected(); untracked(() => {this.lastSyncAt.set(''); this.schedule();}); });
    this.timer = setInterval(() => { void this.loadRuntime(); this.poll(); }, 30000);
    window.addEventListener('online', this.wake); window.addEventListener('offline', this.wake); window.addEventListener('focus', this.wake);
    window.addEventListener('storage', this.storage); window.addEventListener('pagehide', this.hide); window.addEventListener('pageshow', this.show);
  }
  private async loadRuntime(): Promise<void> {
    const context = this.context, epoch = this.epoch;
    if (this.destroyed) return;
    if (!this.store.drive().accountId) {this.runtimeReady.set(true); return;}
    try { const value = await this.repository.read(context); if (context === this.context && epoch === this.epoch) {const firstLink = !this.runtime().link && !!value.link; this.runtime.set(value); this.runtimeReady.set(true); if (firstLink) this.schedule();} }
    catch (error) { if (context === this.context && epoch === this.epoch) this.error.set(this.describe(error)); }
  }
  private schedule(): void {
    clearTimeout(this.debounce);
    if (!this.autoReady()) return;
    this.debounce = setTimeout(() => { void this.sync(false); }, this.store.drive().debounceSeconds * 1000);
  }
  private autoReady(): boolean {
    return !this.destroyed && !this.suspended && this.auth.connected() && this.online() && !this.unavailable() && this.store.drive().mode !== 'off' && !this.store.hasUnsavedChanges();
  }
  private poll(): void {
    const minutes = this.store.drive().pollMinutes;
    if (this.autoReady() && minutes && document.visibilityState !== 'hidden' && Date.now() - this.lastPoll >= minutes * 60000) void this.sync(false);
  }
  async prepare(): Promise<void> { try { await this.auth.prepare(); } catch (error) { this.error.set(this.describe(error)); } }
  async connect(authorize?: () => Promise<GoogleAccount>, activate?: () => void): Promise<void> {
    this.error.set('');
    const clientId = this.store.google().clientId, generation = this.store.generation();
    try {
      const account = await (authorize ? authorize() : this.auth.authorize(clientId));
      if (generation !== this.store.generation() || clientId !== this.store.google().clientId) return;
      const previous = this.store.drive().accountId;
      const result = await this.store.updateDrive({accountId: account.id, email: account.email, ...(previous && previous !== account.id ? {mode: 'off'} : {})});
      if (!result.ok) throw new Error(result.message);
      if (generation !== this.store.generation() || clientId !== this.store.google().clientId || this.store.drive().accountId !== account.id) return;
      this.auth.useSession({clientId, generation, accountId: account.id});
      activate?.();
      this.context = JSON.stringify([clientId, generation, account.id]); this.coordinator.activate(this.context);
      await this.loadRuntime(); await this.list(); this.schedule();
    } catch (error) { this.error.set(this.describe(error)); }
  }
  disconnect(): void { clearTimeout(this.debounce); this.auth.disconnect('Drive 已解除連線，雲端備份保留。'); }
  private async run(operation: (engine: DriveEngine, current: () => boolean) => Promise<void>, notice = '', guardConfiguration = true): Promise<boolean> {
    if (this.localBusy() || this.active()) return false;
    if (!this.auth.connected() || !this.online()) { this.error.set(this.online() ? '請先連線 Google Drive，待上傳版本仍保留。' : '目前離線，待上傳版本仍保留。'); return false; }
    const key = this.context, epoch = this.epoch, settings = JSON.stringify(this.store.drive()), connection = this.auth.connectionVersion();
    this.localBusy.set(true); this.error.set(''); if (notice) this.message.set('');
    try {
      const completed = await this.coordinator.run(key, ['drive'], async owned => {
        const current = () => owned() && !this.destroyed && this.context === key && this.epoch === epoch && this.auth.connected() && this.auth.connectionVersion() === connection
          && JSON.stringify([this.store.google().clientId, this.store.generation(), this.store.drive().accountId]) === key && (!guardConfiguration || JSON.stringify(this.store.drive()) === settings);
        const engine = new DriveEngine(this.api, this.repository, {
          snapshot: (kind, ids) => this.store.driveSnapshot(kind, ids),
          apply: async (backup, revision, targets) => { if (!current()) throw new Error('Drive 設定已變更，雲端資料未套用。'); const result = await this.store.applyDriveBackup(backup, revision, targets); if (!result.ok) throw new Error(result.message); }
        }, key, current);
        await operation(engine, current);
        if (!current()) throw new Error('Drive 連線或設定已變更，本次操作已停止。');
      });
      if (completed && key === this.context && epoch === this.epoch) { await this.loadRuntime(); if (notice) this.message.set(notice); }
      return completed;
    } catch (error) {
      this.auth.cancelRequests();
      if (key === this.context && epoch === this.epoch) {
        this.error.set(this.describe(error)); await this.loadRuntime();
        if (error instanceof DriveCollectionDeleted && this.runtime().link?.datasetId === error.datasetId && connection === this.auth.connectionVersion()
          && JSON.stringify([this.store.google().clientId, this.store.generation(), this.store.drive().accountId]) === key) {
          this.missingCollection.set(error.datasetId); clearTimeout(this.debounce);
          const stopped = await this.store.stopDrive(this.store.generation(), JSON.stringify(this.store.drive()));
          if (!stopped.ok) this.error.set(error.message + ' ' + stopped.message);
        }
      }
      return false;
    }
    finally { this.localBusy.set(false); try { this.channel?.postMessage({context: key}); } catch { /* Polling also refreshes runtime state. */ } }
  }
  private catalogKey(): string {return JSON.stringify([this.store.google().clientId, this.store.generation(), this.store.drive().accountId, this.auth.connectionVersion()]);}
  private acceptCatalog(files: DriveFile[], removals: DriveFile[]): void {
    this.files.set(files); this.removals.set(removals);
    this.catalogConnection.set(this.catalogKey()); this.catalogState.set('ready'); this.catalogError.set(''); this.catalogCheckedAt.set(new Date().toISOString());
    const link = this.runtime().link;
    this.missingCollection.set(link && !files.some(file => !file.trashed && file.cloud.datasetId === link.datasetId) ? link.datasetId : '');
  }
  private async retainedCatalog(current: () => boolean): Promise<{files: DriveFile[]; removals: DriveFile[]}> {
    const state = await this.repository.read(this.context);
    if (!current()) throw new Error('Drive 連線或設定已變更，自動清理已停止。');
    const protectedVersions = [state.link?.baseVersionId, state.pending?.document.cloud.versionId, ...(state.pending?.document.cloud.parents ?? [])].filter((id): id is string => !!id);
    let files: DriveFile[];
    try {
      const result = await this.api.pruneHistory(current, protectedVersions);
      if (!current()) throw new Error('Drive 連線或設定已變更，自動清理已停止。');
      files = result.files; this.cleanupError.set('');
      if (result.removed) {try {this.channel?.postMessage({context: this.context, kind: 'removal'});} catch { /* Explicit reload also refreshes history. */ }}
    } catch (error) {
      if (!current()) throw error;
      this.cleanupError.set('過舊備份自動清理未完成，下次讀取會重試。' + this.describe(error));
      files = await this.api.list();
    }
    const removals = await this.api.removals();
    if (!current()) throw new Error('Drive 連線或設定已變更，清單未更新。');
    return {files, removals};
  }
  async list(): Promise<boolean> {
    if (this.busy()) return false;
    const key = this.catalogKey(); this.catalogState.set('loading'); this.catalogError.set('');
    const completed = await this.run(async (engine, current) => {
      const {files, removals} = await this.retainedCatalog(current);
      if (current()) {await engine.refreshConflict(files); this.acceptCatalog(files, removals);}
    });
    if (!completed && key === this.catalogKey()) {this.catalogState.set('error'); this.catalogError.set(this.error() || '雲端清單尚未讀取完成，請再試一次。');}
    return completed;
  }
  async organize(): Promise<void> {
    await this.run(async (_, current) => {
      const result = await this.api.organize(current);
      const {files, removals} = await this.retainedCatalog(current);
      if (current()) {this.acceptCatalog(files, removals); this.message.set(result.changed ? '已整理 ' + result.changed + ' 份檔案。' : '檔案已整理完成。');}
    });
  }
  private async refreshCatalog(datasetId?: string): Promise<void> {
    if (this.busy()) return;
    const key = this.catalogKey(); this.catalogState.set('loading'); this.catalogError.set('');
    await this.run(async (_, current) => {
      try {
        if (datasetId) await this.api.organize(current, datasetId);
        const {files, removals} = await this.retainedCatalog(current);
        if (current()) this.acceptCatalog(files, removals);
      } catch (error) {
        if (!current()) throw error;
        this.error.set('備份已保存，資料夾整理未完成，可在「檔案位置與整理」按「整理資料夾」重試。' + this.describe(error));
        try {const {files, removals} = await this.retainedCatalog(current); if (current()) this.acceptCatalog(files, removals);}
        catch (listError) {if (!current()) throw listError; this.error.update(message => message + ' 清單未更新，請重新載入。' + this.describe(listError));}
      }
    });
    if (key === this.catalogKey() && this.catalogState() === 'loading') {this.catalogState.set('error'); this.catalogError.set(this.error() || '雲端清單尚未更新，請重新載入。');}
  }
  async manual(kind: BackupKind, ids: string[]): Promise<void> {
    if (await this.run(engine => engine.manual(kind, ids), '已另存一份備份至 Google Drive。')) await this.list();
  }
  async retry(): Promise<void> { if (await this.run(engine => engine.flush(), '待上傳版本已完成。')) { await this.refreshCatalog(this.runtime().link?.datasetId); this.schedule(); } }
  async start(kind: BackupKind, ids: string[], mode: 'backup' | 'sync', requireEmpty = false): Promise<void> {
    if (this.busy()) return;
    // Leave auto processing off until the immutable root is safely queued and uploaded.
    const result = await this.store.updateDrive({kind, workspaceIds: kind === 'workspaces' ? ids : [], mode: 'off'});
    if (!result.ok) { this.error.set(result.message); return; }
    if (await this.run(engine => engine.start(kind, ids, mode, requireEmpty), mode === 'backup' ? '已開啟自動備份，之後的修改會自動保存到 Drive。' : '已開啟自動儲存；其他電腦也能使用這份雲端資料。')) {
      const updated = await this.store.updateDrive({mode}); if (!updated.ok) this.error.set(updated.message);
      this.missingCollection.set(''); await this.refreshCatalog(this.runtime().link?.datasetId); this.schedule();
    } else if (requireEmpty) {
      const error = this.error(); await this.list(); this.error.set(error);
    }
  }
  async join(file: DriveFile, revision: string, reviewedHeads?: string[]): Promise<boolean> {
    const completed = await this.run(engine => engine.join(file, revision, reviewedHeads), file.kind === 'full' ? '已使用雲端資料與外觀、提醒設定，自動儲存已開啟。' : '已使用這些雲端工作空間，自動儲存已開啟，整體外觀與提醒保留。', false);
    if (completed) {
      const link = this.runtime().link!;
      const result = await this.store.updateDrive({kind: link.kind, workspaceIds: link.workspaceIds, mode: 'sync'});
      if (!result.ok) { this.error.set(result.message); return false; }
      this.missingCollection.set(''); await this.refreshCatalog(link.datasetId); this.schedule();
    }
    return completed;
  }
  async sync(manual = true): Promise<DriveSyncResult> {
    if (!this.autoReady() || this.busy() || this.syncing() || (!manual && this.runtime().conflict)) return 'skipped';
    const settings = this.store.drive(), link = this.runtime().link;
    if (!link) return 'skipped';
    if (link.kind !== settings.kind || JSON.stringify([...link.workspaceIds].sort()) !== JSON.stringify([...settings.workspaceIds].sort())) { this.error.set('要儲存的工作空間已變更，請在「儲存設定與更多操作」重新設定保存範圍。'); return 'failed'; }
    this.syncing.set(true); if (manual) this.message.set('');
    try {
      clearTimeout(this.debounce);
      const context = this.context, generation = this.store.generation();
      this.lastPoll = Date.now();
      const previousVersion = this.runtime().link?.baseVersionId;
      if (await this.run(engine => engine.synchronize(settings.mode as 'backup' | 'sync'))) {
        if (previousVersion !== this.runtime().link?.baseVersionId) await this.refreshCatalog(link.datasetId);
        else if (this.runtime().conflict || manual) await this.list();
        if (context !== this.context || generation !== this.store.generation() || this.error()) return 'failed';
        if (this.runtime().conflict?.length) {if (manual) this.message.set('雲端仍有不同內容待選擇，請先處理。'); return 'conflict';}
        try {
          const saved = this.runtime().link;
          if (!saved) return 'failed';
          const snapshot = await this.store.driveSnapshot(saved.kind, saved.workspaceIds);
          const hash = settings.mode === 'backup' ? await backupHash(snapshot.backup) : await syncHash(snapshot.backup);
          if (context !== this.context || generation !== this.store.generation()) return 'failed';
          if (this.runtime().pending || hash !== (settings.mode === 'backup' ? saved.baseBackupHash : saved.baseHash) || snapshot.revision !== this.store.revision() || this.store.hasUnsavedChanges()) {
            if (manual) this.message.set('仍有新的修改等待同步，請再次同步後再斷網。');
            this.schedule(); return 'pending';
          }
          this.lastSyncAt.set(new Date().toISOString());
          if (manual) this.message.set('已完成本次雲端更新。');
          return 'complete';
        } catch (error) {if (context === this.context && generation === this.store.generation()) this.error.set(this.describe(error)); return 'failed';}
      }
      return 'failed';
    } finally {this.syncing.set(false);}
  }
  async resolve(heads: string[], choice?: DriveFile, revision?: string): Promise<void> {
    if (await this.run(engine => engine.resolve(heads, choice, revision, this.store.drive().mode === 'backup' ? 'backup' : 'sync'), '已使用選定內容並保留可安全整併的修改，之前的備份仍保留。')) await this.refreshCatalog(this.runtime().link?.datasetId);
  }
  async preview(file: DriveFile): Promise<DriveDocument | undefined> {
    let document: DriveDocument | undefined;
    await this.run(async (_, current) => { const value = await this.api.read(file); if (current()) document = value; }); return document;
  }
  async prepareRemoval(target: string | DriveFile): Promise<DriveRemovalReview | undefined> {
    if (this.busy()) return undefined;
    this.message.set(''); let review: DriveRemovalReview | undefined;
    await this.run(async (_, current) => {
      const context = this.context, state = await this.repository.read(context);
      if (!current()) throw new Error('Drive 連線或設定已變更，請重新確認。');
      const plan = await this.api.planCollection(typeof target === 'string' ? target : target.cloud.datasetId);
      let branchHeads: string[] | undefined;
      if (!current()) throw new Error('Drive 連線或設定已變更，請重新確認。');
      if (typeof target !== 'string') {
        const file = plan.files.find(file => file.id === target.id && !file.trashed && file.kind === target.kind && canonical(file.cloud) === canonical(target.cloud));
        if (!file) throw new Error('這份備份已刪除或變更，請重新載入。');
        if (file.cloud.purpose !== 'manual') {
          await this.api.assertAvailable(plan.datasetId);
          if (!current()) throw new Error('Drive 連線或設定已變更，請重新確認。');
          const heads = versionGraph(plan.files).heads;
          if (heads.some(head => head.id === file.id)) {
            if (heads.length < 2) throw new Error('這是目前的雲端資料。若要刪除，請選「刪除這份雲端資料」，過去的備份才可逐份刪除。');
            branchHeads = heads.map(head => head.cloud.versionId).sort();
          }
        }
        plan.kind = 'file'; plan.files = [file];
      }
      const currentCollection = plan.kind === 'collection' && state.link?.datasetId === plan.datasetId;
      const pending = pendingRemoval(state, plan);
      if (!plan.files.length && !currentCollection && !pending) throw new Error('這份雲端資料已不存在，請重新載入。');
      const label = plan.files[0] ? fileScope(plan.files[0]) : (pending?.kind ?? state.link?.kind) === 'full' ? '全部資料' : pending ? pending.data.workspaces.map(workspace => workspace.name).join('、') : this.store.workspaces().filter(workspace => state.link?.workspaceIds.includes(workspace.id)).map(workspace => workspace.name).join('、');
      review = {...plan, label, context, connection: this.auth.connectionVersion(), settings: JSON.stringify(this.store.drive()), generation: this.store.generation(), currentCollection, pendingVersion: pending?.cloud.versionId ?? '', ...(branchHeads ? {branchHeads} : {})};
    });
    return review;
  }
  async remove(review: DriveRemovalReview): Promise<boolean> {
    this.message.set(''); let started = false;
    const completed = await this.run(async (engine, current) => {
      let settings = review.settings;
      const guarded = () => current() && review.context === this.context && review.connection === this.auth.connectionVersion() && review.generation === this.store.generation() && settings === JSON.stringify(this.store.drive());
      const check = () => {if (!guarded()) throw new Error('確認期間 Drive 連線或設定已變更，請重新確認刪除。');};
      check();
      const detach = async () => {
        const state = await this.repository.read(review.context); check();
        const currentCollection = review.kind === 'collection' && state.link?.datasetId === review.datasetId;
        const pendingVersion = pendingRemoval(state, review)?.cloud.versionId ?? '';
        if (currentCollection !== review.currentCollection || pendingVersion !== review.pendingVersion) throw new Error('確認期間儲存的資料或待上傳內容已變更，請重新確認刪除。');
        if (currentCollection) {
          const stopped = await this.store.stopDrive(review.generation, settings);
          if (!stopped.ok) throw new Error(stopped.message);
          settings = JSON.stringify({...JSON.parse(settings), mode: 'off'}); check();
          delete state.link; delete state.conflict; delete state.lastSavedAt; delete state.base; delete state.mergeBase;
        }
        if (pendingVersion) delete state.pending;
        await this.repository.write(review.context, state, guarded); check();
        this.runtime.set(state); clearTimeout(this.debounce); started = true;
      };
      if (review.kind === 'collection') await this.api.trashCollection(review, guarded, detach);
      else {await detach(); await this.api.trash(review.files[0], guarded, review.branchHeads);}
      check();
      const [files, removals] = await Promise.all([this.api.list(), this.api.removals()]); check();
      if (review.kind === 'file') await engine.refreshConflict(files);
      check();
      this.acceptCatalog(files, removals);
      this.message.set(review.kind === 'collection' ? '這份雲端資料及歷史備份已移至 Drive 垃圾桶，本機工作資料保留。' : review.branchHeads ? '這份內容已移至 Drive 垃圾桶，其他雲端內容與本機工作資料保留。' : '這份備份已移至 Drive 垃圾桶，本機工作資料保留。');
    }, '', false);
    if (!completed && review.context === this.context && review.connection === this.auth.connectionVersion()) {
      const error = this.error(); await this.list();
      this.error.set(error + (started ? ' 刪除尚未完成，可重新確認範圍後繼續；若檔案已全部移至垃圾桶，可重新載入清單。' : ''));
    }
    if (started) {try {this.channel?.postMessage({context: review.context, kind: 'removal'});} catch { /* Explicit reload is also available. */ }}
    this.schedule();
    return completed;
  }
  private describe(error: unknown): string { return error instanceof Error ? error.message : 'Drive 操作未完成，本機資料保留。'; }
  ngOnDestroy(): void {
    this.destroyed = true; this.epoch++; clearTimeout(this.debounce); clearInterval(this.timer); this.coordinator.close(); this.channel?.close(); this.auth.cancelRequests();
    window.removeEventListener('online', this.wake); window.removeEventListener('offline', this.wake); window.removeEventListener('focus', this.wake);
    window.removeEventListener('storage', this.storage); window.removeEventListener('pagehide', this.hide); window.removeEventListener('pageshow', this.show);
  }
}
