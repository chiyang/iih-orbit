import { DatePipe, DecimalPipe, NgTemplateOutlet } from '@angular/common';
import { Component, computed, effect, ElementRef, inject, output, signal, untracked, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { BackupKind, readBackup } from './backup-data';
import { downloadBackup } from './backup-file';
import { DriveDocument, DriveFile, DriveSettings } from './drive-data';
import { DriveService, type DriveRemovalReview } from './drive-service';
import { driveCatalog, fileScope } from './drive-catalog';
import { Icon } from './icon';
import { TEXT_SIZES } from './ui-preferences';
import { GoogleServiceHeader } from './google-service-header';

@Component({selector: 'app-drive-panel', imports: [FormsModule, Icon, DatePipe, DecimalPipe, NgTemplateOutlet, GoogleServiceHeader], templateUrl: './drive-panel.html', styleUrl: './drive-panel.css'})
export class DrivePanel {
  readonly drive = inject(DriveService);
  readonly store = this.drive.store;
  readonly restored = output<void>();
  readonly configure = output<void>();
  readonly kind = signal<BackupKind>('full');
  readonly ids = signal<string[]>([this.store.currentWorkspace().id]);
  readonly mode = signal<'backup' | 'sync'>('sync');
  readonly editing = signal(false);
  readonly creating = signal(false);
  readonly saving = signal(false);
  readonly preview = signal<DriveDocument | null>(null);
  readonly previewFile = signal<DriveFile | null>(null);
  readonly action = signal<'restore' | 'join' | 'cloud' | null>(null);
  readonly useLabel = '使用這份雲端資料';
  readonly confirmationPhrase = computed(() => this.useLabel);
  readonly error = signal('');
  readonly importing = signal(false);
  readonly removal = signal<DriveRemovalReview | null>(null);
  readonly removing = signal(false);
  readonly removalPhrase = computed(() => this.removal()?.kind === 'collection' ? '刪除這份雲端資料' : this.removal()?.branchHeads ? '刪除這份內容' : '刪除這份備份');
  readonly removalCount = computed(() => this.removal()?.files.filter(file => !file.trashed).length ?? 0);
  readonly removalStale = computed(() => {
    const review = this.removal();
    return !!review && (review.context !== JSON.stringify([this.store.google().clientId, this.store.generation(), this.store.drive().accountId]) || review.connection !== this.drive.auth.connectionVersion() || review.settings !== JSON.stringify(this.store.drive()));
  });
  readonly heads = computed(() => this.drive.files().filter(f => !f.trashed && this.drive.runtime().link?.datasetId === f.cloud.datasetId && this.drive.runtime().conflict?.includes(f.cloud.versionId)));
  readonly bytes = computed(() => this.drive.files().reduce((sum, f) => sum + (f.trashed ? 0 : f.size), 0));
  readonly hasFiles = computed(() => this.drive.files().some(file => !file.trashed));
  readonly catalog = computed(() => driveCatalog(this.drive.files(), this.drive.runtime().link?.datasetId, this.drive.removals().map(file => file.cloud.datasetId)));
  readonly currentCollection = computed(() => this.catalog().collections.find(group => group.current));
  readonly cloudCount = computed(() => this.catalog().collections.length + this.catalog().manual.length);
  readonly canCreate = computed(() => this.drive.runtimeReady() && this.drive.catalogFresh() && !this.drive.runtime().link && !this.drive.unavailable());
  readonly showCreateForm = computed(() => this.editing() && !!this.drive.runtime().link || this.canCreate() && (!this.hasFiles() || this.creating()));
  private readonly lastActiveMode = signal<'backup' | 'sync' | null>(null);
  readonly resumeMode = computed(() => this.lastActiveMode() ?? (this.currentCollection()?.heads[0]?.cloud.purpose === 'backup' ? 'backup' : 'sync'));
  readonly otherCollections = computed(() => this.catalog().collections.filter(group => !group.current));
  readonly sameScope = computed(() => {
    const link = this.drive.runtime().link;
    return !!link && link.kind === this.kind() && (link.kind === 'full' || JSON.stringify([...link.workspaceIds].sort()) === JSON.stringify([...this.ids()].sort()));
  });
  readonly currentWorkspaces = computed(() => {
    const link = this.drive.runtime().link;
    return this.store.workspaces().filter(workspace => link?.kind === 'full' || link?.workspaceIds.includes(workspace.id));
  });
  readonly currentScope = computed(() => this.drive.runtime().link?.kind === 'full' ? `所有工作空間（${this.currentWorkspaces().length} 個）` : this.currentWorkspaces().map(workspace => workspace.name).join('、') || '選定的工作空間');
  readonly currentNames = computed(() => {
    const names = this.currentWorkspaces().map(workspace => workspace.name);
    return names.slice(0, 3).join('、') + (names.length > 3 ? `，另有 ${names.length - 3} 個` : '');
  });
  readonly currentSavedAt = computed(() => this.currentCollection()?.updatedAt ?? this.drive.runtime().lastSavedAt);
  readonly canBackup = computed(() => this.drive.runtimeReady() && !this.drive.busy() && !this.saving() && !this.importing() && !this.removing() && this.drive.auth.connected() && this.drive.online() && !this.drive.runtime().pending && !this.store.pendingWrites() && (this.kind() === 'full' || !!this.ids().length && this.ids().every(id => this.store.workspaces().some(workspace => workspace.id === id))));
  readonly canSave = computed(() => this.canBackup() && !this.drive.runtime().conflict && (this.sameScope() && !this.drive.unavailable() || this.drive.catalogFresh() && (this.editing() || this.creating() || this.canCreate() && !this.hasFiles())));
  readonly startLabel = computed(() => this.drive.runtime().link && this.sameScope() && !this.drive.unavailable() ? '儲存設定' : this.drive.runtime().link || this.creating() ? '另建一份自動儲存' : '建立自動儲存');
  readonly fileScope = fileScope;
  readonly canJoin = computed(() => {
    const file = this.previewFile();
    const group = this.catalog().collections.find(g => g.id === file?.cloud.datasetId);
    return !!file && this.drive.catalogFresh() && !this.drive.runtime().conflict && !group?.warning && !group?.deleting && !!group?.heads.length && group.heads.length <= 20 && group.heads.some(head => head.id === file.id) && file.size > 0;
  });
  readonly previewCurrent = computed(() => !!this.previewFile() && this.previewFile()!.cloud.datasetId === this.drive.runtime().link?.datasetId && this.previewFile()!.cloud.versionId === this.drive.runtime().link?.baseVersionId && !this.drive.runtime().conflict);
  readonly useAction = computed<'restore' | 'join' | 'cloud' | null>(() => {
    const preview = this.preview(), file = this.previewFile();
    if (!this.drive.catalogFresh() || !preview || !file || file.trashed || !this.drive.files().some(live => live.id === file.id && !live.trashed) || this.drive.removals().some(removed => removed.cloud.datasetId === file.cloud.datasetId)) return null;
    if (this.drive.runtime().conflict?.includes(file.cloud.versionId)) return 'cloud';
    if (this.previewCurrent() && this.currentCollection()?.heads.length === 1) return null;
    if (this.canJoin()) return 'join';
    return !this.drive.runtime().conflict && preview.kind === 'full' ? 'restore' : null;
  });
  readonly useStale = computed(() => {
    const action = this.action();
    if (!action) return false;
    const heads = action === 'cloud' ? this.drive.runtime().conflict ?? [] : this.catalog().collections.find(group => group.id === this.previewFile()?.cloud.datasetId)?.heads.map(file => file.cloud.versionId) ?? [];
    return !this.drive.catalogFresh() || action !== this.useAction() || this.store.revision() !== this.revision() || this.useConnection() !== this.drive.auth.connectionVersion() || action !== 'restore' && JSON.stringify([...heads].sort()) !== JSON.stringify(this.reviewedHeads());
  });
  readonly useDescription = computed(() => this.useAction() === 'restore'
    ? '使用備份當時的全部工作空間與設定。自動同步會暫停，Google 需要重新連線。'
    : `${this.preview()?.kind === 'full' ? '使用所有工作空間與設定' : '使用這些工作空間'}，並繼續${this.useAction() === 'cloud' && this.store.drive().mode === 'backup' ? '自動備份' : '跨裝置同步'}。`);
  readonly pendingTasks = computed(() => this.preview()?.data.workspaces.reduce((sum, w) => sum + w.tasks.length, 0) ?? 0);
  readonly savedAppearance = computed(() => {
    const preferences = this.preview()?.preferences;
    return preferences ? {...preferences, themeLabel: {light: '淺色', dark: '深色', system: '跟隨系統'}[preferences.theme], fontLabel: TEXT_SIZES.find(item => item.id === preferences.textSize)?.label} : null;
  });
  confirmation = '';
  removalConfirmation = '';
  private modeContext = '';
  private loadedConnection = '';
  private readonly revision = signal('');
  private readonly useConnection = signal(-1);
  private readonly reviewedHeads = signal<string[]>([]);
  reviewedBranchCount(): number {return this.reviewedHeads().length;}
  private previewRequest = 0;
  private removalRequest = 0;
  private readonly removalPanel = viewChild<ElementRef<HTMLElement>>('removalPanel');
  private readonly previewPanel = viewChild<ElementRef<HTMLElement>>('previewPanel');
  private readonly cloudList = viewChild<ElementRef<HTMLElement>>('cloudList');
  constructor() {
    effect(() => { const clientId = this.store.google().clientId; untracked(() => { if (clientId) void this.drive.prepare(); }); });
    effect(() => {
      const key = JSON.stringify([this.store.google().clientId, this.store.generation(), this.store.drive().accountId, this.drive.auth.connectionVersion()]);
      if (this.drive.runtimeReady() && this.drive.auth.connected() && this.drive.online() && !this.drive.busy() && this.loadedConnection !== key) {
        untracked(() => {this.loadedConnection = key; if (!this.drive.catalogFresh()) void this.drive.list();});
      }
    });
    effect(() => {
      const settings = this.store.drive(), link = this.drive.runtime().link, editing = this.editing(), saving = this.saving();
      const context = JSON.stringify([this.store.google().clientId, this.store.generation(), settings.accountId]);
      const changed = context !== this.modeContext;
      if (changed) {this.modeContext = context; this.lastActiveMode.set(null); this.editing.set(false); this.creating.set(false);}
      if (settings.mode !== 'off') this.lastActiveMode.set(settings.mode);
      if (!saving && (changed || link && !editing)) {
        this.kind.set(link?.kind ?? settings.kind);
        this.ids.set(link?.workspaceIds.length ? [...link.workspaceIds] : settings.workspaceIds.length ? [...settings.workspaceIds] : [this.store.currentWorkspace().id]);
        this.mode.set(settings.mode === 'off' ? this.resumeMode() : settings.mode);
      }
    });
    effect(() => {
      const panel = this.removalPanel();
      if (this.removal() && panel) {
        panel.nativeElement.scrollIntoView({block: 'nearest', behavior: 'smooth'});
        (panel.nativeElement.querySelector<HTMLInputElement>('input') ?? panel.nativeElement).focus({preventScroll: true});
      }
    });
    effect(() => {
      const panel = this.previewPanel();
      if (this.preview() && panel) {
        panel.nativeElement.scrollIntoView({block: 'nearest', behavior: 'smooth'});
        panel.nativeElement.focus({preventScroll: true});
      }
    });
  }
  scopeLabel(file: DriveFile): string {
    return file.kind === 'full' ? `所有工作空間${file.summary ? `（${file.summary.workspaces} 個）` : ''}` : file.summary?.label || '選定的工作空間（預覽可查看名稱）';
  }
  isCurrentCopy(file: DriveFile): boolean {
    const link = this.drive.runtime().link;
    return !file.trashed && link?.datasetId === file.cloud.datasetId && link.baseVersionId === file.cloud.versionId;
  }
  selectCloudContent(card: HTMLElement): void {
    const choices = card.querySelector<HTMLElement>('.cloud-choices, .cloud-choice-entry');
    choices?.scrollIntoView({block: 'nearest', behavior: 'smooth'});
    choices?.focus({preventScroll: true});
  }
  canRemoveBranch(file: DriveFile): boolean {
    const group = this.catalog().collections.find(collection => collection.id === file.cloud.datasetId);
    return !!group && !group.warning && !group.deleting && group.heads.length > 1 && group.heads.some(head => head.id === file.id);
  }
  canRemoveFile(file: DriveFile): boolean {
    if (file.trashed) return false;
    if (file.cloud.purpose === 'manual') return true;
    const group = this.catalog().collections.find(collection => collection.id === file.cloud.datasetId);
    return !!group && !group.warning && !group.deleting && (!group.heads.some(head => head.id === file.id) || group.heads.length > 1);
  }
  showCloudData(): void {this.cloudList()?.nativeElement.scrollIntoView({block: 'start', behavior: 'smooth'}); this.cloudList()?.nativeElement.focus({preventScroll: true});}
  beginCreate(): void {
    if (!this.canCreate() || this.drive.busy()) return;
    this.kind.set('full'); this.ids.set([this.store.currentWorkspace().id]); this.mode.set('sync'); this.creating.set(true); this.clearPreview();
  }
  async saveAutomatic(): Promise<void> {
    if (!this.canSave()) return;
    const kind = this.kind(), ids = [...this.ids()], mode = this.mode();
    this.saving.set(true); this.error.set('');
    try {
      if (this.sameScope() && !this.drive.unavailable()) {
        const result = await this.store.updateDrive({mode});
        if (!result.ok) {this.error.set(result.message); return;}
        await this.drive.sync();
      } else await this.drive.start(kind, ids, mode, !this.creating() && !this.editing() && !this.drive.runtime().link);
      if (!this.drive.error() && this.drive.runtime().link && this.sameScope()) {this.editing.set(false); this.creating.set(false);}
    } finally {this.saving.set(false);}
  }
  async resume(): Promise<void> {
    if (this.drive.unavailable()) return;
    this.mode.set(this.resumeMode());
    await this.saveAutomatic();
  }
  async saveCopy(): Promise<void> {
    if (!this.canBackup()) return;
    this.saving.set(true);
    try {await this.drive.manual(this.kind(), this.ids());} finally {this.saving.set(false);}
  }
  toggle(id: string, selected: boolean): void { this.ids.update(ids => selected ? [...new Set([...ids, id])] : ids.filter(value => value !== id)); }
  async options(patch: Partial<DriveSettings>): Promise<void> {
    this.error.set(''); const result = await this.store.updateDrive(patch); if (!result.ok) this.error.set(result.message);
  }
  async requestRemoval(target: string | DriveFile): Promise<void> {
    if (this.drive.busy() || this.importing() || this.removing()) return;
    const request = ++this.removalRequest;
    this.removal.set(null); this.removalConfirmation = ''; this.action.set(null); this.error.set('');
    const review = await this.drive.prepareRemoval(target);
    if (review && request === this.removalRequest) this.removal.set(review);
  }
  cancelRemoval(): void {if (!this.removing()) {this.removalRequest++; this.removal.set(null); this.removalConfirmation = '';}}
  async acceptRemoval(): Promise<void> {this.removalConfirmation = this.removalPhrase(); await this.confirmRemoval();}
  async confirmRemoval(): Promise<void> {
    const review = this.removal();
    if (!review || (review.kind === 'collection' && this.removalConfirmation !== this.removalPhrase()) || this.removalStale() || this.drive.busy() || this.importing() || this.removing()) return;
    this.removing.set(true);
    try {
      if (await this.drive.remove(review)) {
        if (this.previewFile()?.cloud.datasetId === review.datasetId && (review.kind === 'collection' || this.previewFile()?.id === review.files[0].id)) this.clearPreview();
        this.removal.set(null); this.removalConfirmation = '';
      }
    } finally {this.removing.set(false);}
  }
  async inspect(file: DriveFile, use = false): Promise<void> {
    const request = ++this.previewRequest;
    this.preview.set(null); this.previewFile.set(null); this.action.set(null); this.error.set('');
    const document = await this.drive.preview(file);
    if (document && request === this.previewRequest) {
      this.preview.set(document); this.previewFile.set(file);
      const action = this.useAction(); if (use && action) this.prepare(action);
    }
  }
  prepare(action: 'restore' | 'join' | 'cloud'): void {
    if (action !== this.useAction()) return;
    this.store.refreshFromStorage(); this.revision.set(this.store.revision()); this.useConnection.set(this.drive.auth.connectionVersion()); this.confirmation = ''; this.error.set(''); this.action.set(action);
    this.reviewedHeads.set(action === 'cloud' ? [...this.drive.runtime().conflict ?? []].sort() : this.catalog().collections.find(group => group.id === this.previewFile()?.cloud.datasetId)?.heads.map(file => file.cloud.versionId).sort() ?? []);
  }
  async confirmUse(): Promise<void> {
    if (!this.action()) return;
    if (this.useStale()) {this.error.set('資料或連線已更新，請重新確認後再使用。'); return;}
    this.confirmation = this.confirmationPhrase(); await this.execute();
  }
  async execute(): Promise<void> {
    const preview = this.preview(), file = this.previewFile(), action = this.action();
    if (!preview || !file || !action || this.useStale() || this.confirmation !== this.confirmationPhrase() || this.drive.busy() || this.importing() || this.store.pendingWrites()) return;
    this.importing.set(true); this.error.set('');
    try {
      if (action === 'join') {
        if (await this.drive.join(file, this.revision(), this.reviewedHeads())) {this.clearPreview(); this.drive.message.set('已使用這份雲端資料，自動儲存已開啟。');}
      } else if (action === 'cloud') {
        if (this.store.revision() !== this.revision()) throw new Error('確認期間本機資料已更新，請重新檢查後再選擇。');
        await this.drive.resolve(this.reviewedHeads(), file, this.revision());
        if (!this.drive.error()) {this.clearPreview(); this.drive.message.set(`已使用這份雲端資料，${this.store.drive().mode === 'backup' ? '自動備份' : '跨裝置同步'}已繼續。`);}
      } else {
        const result = await this.store.importBackup(preview, this.revision());
        if (!result.ok) throw new Error(result.message);
        this.clearPreview(); this.restored.emit(); this.drive.message.set('已使用這份雲端資料。自動同步已暫停，Google 需要重新連線。');
      }
    } catch (error) { this.error.set(error instanceof Error ? error.message : '無法套用備份，原有資料保留。'); }
    finally { this.importing.set(false); }
  }
  async copy(): Promise<void> {
    const preview = this.preview();
    if (!preview || this.importing() || this.drive.busy() || this.store.pendingWrites()) return;
    this.importing.set(true); this.error.set('');
    try {
      const backup = readBackup({...preview, kind: 'workspaces', google: undefined, calendarSources: preview.kind === 'full' ? preview.google?.sources ?? [] : preview.calendarSources ?? []});
      const result = await this.store.importBackup(backup);
      if (!result.ok) throw new Error(result.message);
      this.clearPreview(); this.restored.emit(); this.drive.message.set('已加入工作空間，原有資料保留。');
    } catch (error) { this.error.set(error instanceof Error ? error.message : '無法加入工作空間。'); }
    finally { this.importing.set(false); }
  }
  download(): void { const preview = this.preview(); if (preview) downloadBackup(preview); }
  async downloadLocal(): Promise<void> {
    try {downloadBackup(await this.store.backupForExport('full'));}
    catch (error) {this.error.set(error instanceof Error ? error.message : '無法下載目前資料。');}
  }
  clearPreview(): void { this.previewRequest++; this.preview.set(null); this.previewFile.set(null); this.action.set(null); }
}
