import {sourceOpenUrl} from './source-file-type';
import {afterNextRender, Component, computed, DestroyRef, effect, ElementRef, inject, Injector, signal, untracked, viewChild, OnDestroy} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {DIALOG_DATA, Dialog, DialogRef} from '@angular/cdk/dialog';
import type {TaskEditContext} from './board-store';
import {COLAB_MIME_TYPE, DOCUMENT_TYPES, type DocumentDestination} from './document-create-data';
import {DocumentCreateService} from './document-create-service';
import {DocumentCreateRecovery} from './document-create-recovery';
import {documentFromUrl} from './document-data';
import type {DriveFolderPickerResult} from './drive-folder-picker';
import {SourceIcon} from './source-icon';

@Component({
  selector: 'app-document-create-dialog', imports: [FormsModule, DocumentCreateRecovery, SourceIcon], styleUrl: './document-create.css',
  template: `<section class="create-dialog" (keydown.escape)="escape($event)"><header><div><h2>建立文件並連結任務</h2><p>{{ data.context.original?.title }}</p></div><button type="button" class="create-cancel" [disabled]="creation.busy()" (click)="close()">關閉</button></header>
    <div class="create-body"><p>任務已儲存。新文件會直接保存至所選 Google 來源，建立完成後可開啟原文件編輯。</p>
      @if (creation.result()?.phase === 'linked') {@let operation = creation.result()!;<section class="completed" aria-label="已建立的文件"><h3>文件已加入任務</h3><p class="completed-file"><app-source-icon [file]="{name: operation.result?.name || operation.name, mimeType: operation.mimeType}" /><span><strong>{{ operation.result?.name }}</strong> · {{ typeLabel(operation.mimeType) }}</span></p><p>{{ operation.sourceName }} / {{ operation.folder.name }}</p></section>} @else {
      <form id="document-create-form" (ngSubmit)="create()"><label>檔案來源<select name="profile" [ngModel]="profileId()" (ngModelChange)="profileId.set($event)" [disabled]="creation.busy()">@for (source of creation.connections.sources(); track source.id) {<option [value]="source.id">{{ source.name() }}</option>}</select></label>
        @if (!connected()) {<p>此來源尚未連線，既有任務連結保留。</p><button type="button" [disabled]="creation.busy() || source()?.connecting() || source()?.auth?.authorizing() || !source()?.auth?.ready()" (click)="creation.connectSource(profileId())">連線此來源</button>@if (!source()?.auth?.ready()) {<button type="button" [disabled]="creation.busy() || source()?.auth?.preparing()" (click)="creation.prepare(profileId())">重新準備來源連線</button>}}
        @if (connected() && !ready()) {<button type="button" [disabled]="creation.busy() || creation.authorization(profileId())?.preparing()" (click)="creation.prepare(profileId())">重新準備建立授權</button>}
        <fieldset class="document-types" [disabled]="creation.busy() || choosingFolder()"><legend>文件類型</legend><div class="document-type-options">@for (type of types; track type.mimeType) {<label class="document-type-option"><input type="radio" name="type" [(ngModel)]="mimeType" [value]="type.mimeType"><app-source-icon [file]="{name: type.label, mimeType: type.mimeType}" /><span>{{ type.label }}</span></label>}</div></fieldset>
        <label>文件名稱<input name="name" [(ngModel)]="name" maxlength="300" required [disabled]="creation.busy()"></label>
        @if (mimeType === colabMimeType) {<p>建立空白 Python 筆記本，自動補上 .ipynb 副檔名；完成後可直接用 Colab 開啟。</p>}
        <section class="destination" aria-label="文件保存位置"><label>保存位置<select name="folder" [ngModel]="folderId()" (ngModelChange)="selectFolder($event)" [disabled]="creation.busy()"><option value="root">我的雲端硬碟</option>@for (folder of folders(); track folder.id) {<option [value]="folder.id">{{ folder.name }}</option>}<option value="custom">手動輸入資料夾連結</option></select></label>
          <button #folderChooser type="button" class="choose-folder" [disabled]="creation.busy() || !connected() || choosingFolder()" (click)="chooseFolder()">選擇 Drive 資料夾</button>
          <p>可瀏覽並選取資料夾，確認可建立文件後再套用。取消選擇會保留原位置。</p>
        </section>
        <button type="button" class="more-options" [attr.aria-expanded]="showMore()" aria-controls="document-destination-options" [disabled]="creation.busy() || choosingFolder()" (click)="showMore.set(!showMore())">{{ showMore() ? '收起更多選項' : '更多選項' }}</button>
        @if (showMore()) {<section id="document-destination-options" class="destination-options" aria-label="其他保存方式"><button type="button" [disabled]="creation.busy()" (click)="selectFolder('custom')">改用資料夾連結</button>
          @if (folderId() === 'custom') {<label>資料夾連結<input name="folderUrl" [(ngModel)]="folderUrl" type="url" maxlength="4096" placeholder="https://drive.google.com/drive/folders/…" [disabled]="creation.busy()"></label>}
        </section>}
        <p>{{ folderId() === 'root' ? '首次建立會請求此來源的文件建立權限。' : '建立到既有資料夾需要 Google Drive 的完整存取授權；由 Google 視窗確認，取消則保留目前內容。' }}授權只在本次頁面有效。</p>
      </form>
      <app-document-create-recovery [taskId]="data.context.original?.id || ''" />
      }
      @if (resultLink(); as result) {<p><a [href]="openUrl(result)" target="_blank" rel="noopener noreferrer">開啟 {{ result.name }} ↗</a></p>}
      @if (error()) {<p class="error" role="alert">{{ error() }}</p>}
      @if (creation.message()) {<p role="status">{{ creation.message() }}</p>}
    </div><footer><span>{{ creation.busy() ? '正在處理，請保留此頁面…' : '建立完成會直接保存任務連結。' }}</span>@if (creation.result()?.phase === 'linked') {<button type="button" class="primary" (click)="close()">完成</button>} @else {<button type="submit" class="primary" form="document-create-form" [disabled]="creation.busy() || !ready() || hasPending() || choosingFolder() || !name.trim()">{{ creation.busy() ? '處理中…' : ready() ? '建立並連結' : connected() ? '準備授權元件…' : '請先連線來源' }}</button>}</footer>
  </section>`
})
export class DocumentCreateDialog implements OnDestroy {
  readonly openUrl = sourceOpenUrl;
  readonly creation = inject(DocumentCreateService);
  readonly data = inject<{context: TaskEditContext}>(DIALOG_DATA);
  private readonly ref = inject(DialogRef);
  private readonly injector = inject(Injector);
  private readonly destroyed = inject(DestroyRef);
  private readonly folderChooser = viewChild<ElementRef<HTMLButtonElement>>('folderChooser');
  private folderDialog?: {close(): void};
  readonly types = DOCUMENT_TYPES;
  readonly colabMimeType = COLAB_MIME_TYPE;
  readonly profileId = signal(this.creation.connections.id);
  readonly folders = signal<DocumentDestination[]>([]);
  readonly folderId = signal('root');
  readonly error = signal('');
  readonly choosingFolder = signal(false);
  readonly showMore = signal(false);
  readonly source = computed(() => this.creation.connections.sources().find(source => source.id === this.profileId()));
  readonly connected = computed(() => !!this.source()?.auth.connected() && !this.source()?.connecting());
  readonly ready = computed(() => this.connected() && !!this.creation.authorization(this.profileId())?.ready());
  readonly hasPending = computed(() => this.creation.pending().some(operation => operation.generation === this.data.context.generation && operation.workspaceId === this.data.context.workspaceId && operation.taskId === this.data.context.original?.id));
  readonly resultLink = computed(() => {const result = this.creation.result()?.result; return result && !this.creation.pending().some(operation => operation.result?.id === result.id) ? result : null;});
  name = this.data.context.original?.title.slice(0, 300) ?? '';
  mimeType = DOCUMENT_TYPES[0].mimeType;
  folderUrl = '';
  typeLabel(mimeType: string): string {return this.types.find(type => type.mimeType === mimeType)?.label ?? 'Google 文件';}
  constructor() {
    this.creation.result.set(null); this.creation.message.set('');
    effect(() => {
      const id = this.profileId(), source = this.source(), connected = !!source?.auth.connected() && !source.connecting(), context = source?.context();
      if (!source && id !== this.creation.connections.id) {this.profileId.set(this.creation.connections.id); return;}
      untracked(() => {const last = this.creation.lastFolder(id); this.folders.set(last.id === 'root' ? [] : [last]); this.folderId.set(last.id); this.folderUrl = ''; this.error.set(''); this.creation.message.set(''); if (source && context && (connected || !source.auth.ready())) void this.creation.prepare(id, last.id !== 'root');});
    });
  }
  selectFolder(id: string): void {this.folderId.set(id); if (id === 'custom') this.showMore.set(true); void this.creation.prepare(this.profileId(), id !== 'root');}
  async chooseFolder(): Promise<void> {
    if (this.choosingFolder() || this.creation.busy() || !this.connected()) return;
    this.error.set(''); this.choosingFolder.set(true);
    const id = this.profileId(), source = this.source()!, context = source.context(), generation = this.creation.store.generation(), workspaceId = this.creation.store.currentWorkspace().id;
    try {
      const {DriveFolderPicker} = await import('./drive-folder-picker');
      if (this.destroyed.destroyed) return;
      if (id !== this.profileId() || context !== this.source()?.context() || generation !== this.creation.store.generation() || workspaceId !== this.creation.store.currentWorkspace().id) throw new Error('來源或工作空間已變更，請重新選擇。');
      const dialog = this.injector.get(Dialog);
      const ref = dialog.open<DriveFolderPickerResult>(DriveFolderPicker, {width: 'min(720px, calc(100vw - 32px))', maxHeight: 'calc(100dvh - 48px)', ariaLabel: '選擇保存資料夾', ariaModal: true, autoFocus: '.folder-cancel', disableClose: true, data: {profileId: id, context, generation, workspaceId, version: source.auth.connectionVersion()}});
      this.folderDialog = ref;
      ref.closed.subscribe(result => {
        this.folderDialog = undefined; this.choosingFolder.set(false);
        if (this.destroyed.destroyed) return;
        if (result?.message) this.error.set(result.message);
        else if (id === this.profileId() && context === this.source()?.context() && generation === this.creation.store.generation() && workspaceId === this.creation.store.currentWorkspace().id) {
          const folder = result?.folder;
          if (folder) {this.folders.update(items => [...items.filter(item => item.id !== folder.id), folder]); this.selectFolder(folder.id); this.creation.message.set('保存位置已改為「' + folder.name + '」。');}
          else this.creation.message.set('已取消選擇，保留原保存位置。');
        }
        afterNextRender(() => this.folderChooser()?.nativeElement.focus(), {injector: this.injector});
      });
    } catch (error) {this.choosingFolder.set(false); this.error.set(error instanceof Error ? error.message : '資料夾未能載入，請重試。');}
  }
  async create(): Promise<void> {
    if (!this.ready() || this.hasPending() || this.creation.busy() || this.choosingFolder() || !this.name.trim()) return;
    try {
      let folder = this.folderId() === 'root' ? {id: 'root', name: '我的雲端硬碟'} : this.folders().find(item => item.id === this.folderId());
      if (this.folderId() === 'custom') {
        const url = new URL(this.folderUrl), source = documentFromUrl('google-drive', this.folderUrl, '指定資料夾');
        if (url.hostname !== 'drive.google.com' || !/^\/drive(?:\/u\/\d+)?\/folders\/[A-Za-z0-9_-]+\/?$/.test(url.pathname) || !source.fileId) throw new Error('請貼上有效的 Google Drive 資料夾連結。');
        const resourceKey = url.searchParams.get('resourcekey'); folder = {id: source.fileId, name: '指定資料夾', ...(resourceKey ? {resourceKey} : {})};
      }
      if (!folder) throw new Error('請重新選擇保存位置。');
      this.error.set(''); await this.creation.create(this.data.context, this.profileId(), this.name, this.mimeType, folder);
    } catch (error) {this.error.set(error instanceof Error ? error.message : '請確認文件名稱與保存位置。');}
  }
  close(): void {if (!this.creation.busy() && !this.choosingFolder()) this.ref.close();}
  escape(event: Event): void {event.preventDefault(); event.stopPropagation(); this.close();}
  ngOnDestroy(): void {this.folderDialog?.close();}
}
