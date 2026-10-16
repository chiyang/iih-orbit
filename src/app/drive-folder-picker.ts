import {Component, computed, effect, inject, OnDestroy, signal, untracked} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {DIALOG_DATA, DialogRef} from '@angular/cdk/dialog';
import {DriveBrowser, DRIVE_FOLDERS_ONLY} from './drive-browser';
import {DRIVE_FOLDER_MIME, type DriveBrowserEntry, type DriveBrowserFolder} from './drive-browser-data';
import {DocumentCreateService} from './document-create-service';
import type {DocumentDestination} from './document-create-data';

export interface DriveFolderPickerData {profileId: string; context: string; generation: string; workspaceId: string; version: number}
export interface DriveFolderPickerResult {folder?: DocumentDestination; message?: string}

@Component({
  selector: 'app-drive-folder-picker', imports: [FormsModule], providers: [DriveBrowser, {provide: DRIVE_FOLDERS_ONLY, useValue: true}], styleUrl: './drive-folder-picker.css',
  template: `<section class="folder-picker" (keydown.escape)="escape($event)">
    <header><div><h2>選擇保存資料夾</h2><p>{{ source()?.name() }} · 使用目前 Google 連線讀取資料夾</p></div><button type="button" class="folder-cancel" (click)="cancel()">取消</button></header>
    <div class="folder-body">
      <nav class="roots" aria-label="Drive 位置"><button type="button" [disabled]="validating() || !valid()" (click)="root()">我的雲端硬碟</button><button type="button" [disabled]="validating() || !valid()" (click)="root(true)">與我共用</button><button type="button" [disabled]="browser.busy() || validating() || !valid()" (click)="browser.refresh()">重新整理</button></nav>
      <nav class="breadcrumbs" aria-label="目前資料夾路徑">@for (folder of browser.path(); track $index) {<button type="button" [attr.aria-current]="$last ? 'location' : null" [disabled]="validating() || !valid()" (click)="back($index)">{{ folder.name }}</button>@if (!$last) {<span aria-hidden="true">/</span>}}</nav>
      <form class="folder-search" (ngSubmit)="browser.search(search)"><label>搜尋目前位置的資料夾<input name="folderSearch" [(ngModel)]="search" maxlength="300" [disabled]="validating() || !valid()"></label><button type="submit" [disabled]="validating() || !valid()">搜尋</button></form>
      @if (error()) {<p class="error" role="alert">{{ error() }}</p>}
      @if (browser.error()) {<p class="error" role="alert">{{ browser.error() }}</p>}
      @if (browser.busy() || validating()) {<p role="status">{{ validating() ? '正在確認資料夾權限…' : '讀取資料夾中…' }}</p>}
      @if (valid()) {<ul aria-label="可選資料夾">@for (file of folders(); track file.id) {<li><button type="button" class="folder-open" [disabled]="browser.busy() || validating()" (click)="open(file)" [attr.aria-label]="'開啟資料夾 ' + file.name"><span aria-hidden="true">▱</span><span>{{ file.name }}</span><span aria-hidden="true">›</span></button><button type="button" [disabled]="browser.busy() || validating()" (click)="select(file)" [attr.aria-label]="'選取資料夾 ' + file.name">選取</button></li>} @empty {@if (!browser.busy()) {<li class="empty">{{ browser.query() ? '沒有符合搜尋的資料夾。' : '此位置目前沒有子資料夾。' }}</li>}}</ul>}
      @if (browser.nextPageToken()) {<button type="button" [disabled]="browser.busy() || validating() || !valid()" (click)="browser.more()">載入更多資料夾</button>}
      <p>選取只會指定保存位置。按「建立並連結」後才建立文件；Orbit 備份資料夾不可選用。</p>
    </div><footer><span>{{ current().shared ? '請開啟或選取一個共用資料夾。' : '目前位置：' + current().name }}</span><button type="button" class="primary" [disabled]="browser.busy() || validating() || !valid() || !!current().shared" (click)="selectCurrent()">使用目前資料夾</button></footer>
  </section>`
})
export class DriveFolderPicker implements OnDestroy {
  readonly browser = inject(DriveBrowser);
  readonly creation = inject(DocumentCreateService);
  readonly data = inject<DriveFolderPickerData>(DIALOG_DATA);
  private readonly ref = inject<DialogRef<DriveFolderPickerResult>>(DialogRef);
  readonly source = computed(() => this.creation.connections.sources().find(item => item.id === this.data.profileId));
  readonly valid = computed(() => {const source = this.source(); return this.creation.store.generation() === this.data.generation && this.creation.store.currentWorkspace().id === this.data.workspaceId && !!source?.auth.connected() && !source.connecting() && source.context() === this.data.context && source.auth.connectionVersion() === this.data.version;});
  readonly current = computed(() => this.browser.path().at(-1)!);
  readonly folders = computed(() => this.browser.visibleFiles().filter(file => file.mimeType === DRIVE_FOLDER_MIME && !file.trashed));
  readonly validating = signal(false);
  readonly error = signal('');
  search = '';
  private controller?: AbortController;
  private closed = false;
  constructor() {
    effect(() => {if (!this.valid()) untracked(() => this.close({message: '來源、帳號或工作空間已變更，請重新選擇資料夾。'}));});
    void this.browser.selectSource(this.data.profileId);
  }
  async open(file: DriveBrowserEntry): Promise<void> {if (!this.validating() && this.valid()) {this.search = ''; this.error.set(''); await this.browser.open(file);}}
  async root(shared = false): Promise<void> {if (!this.validating() && this.valid()) {this.search = ''; this.error.set(''); await this.browser.root(shared);}}
  async back(index: number): Promise<void> {if (!this.validating() && this.valid()) {this.search = ''; this.error.set(''); await this.browser.back(index);}}
  async select(file: DriveBrowserEntry): Promise<void> {if (this.browser.isListed(file) && file.mimeType === DRIVE_FOLDER_MIME) await this.use(file);}
  async selectCurrent(): Promise<void> {const folder = this.current(); if (!folder.shared) await this.use(folder);}
  private async use(folder: DriveBrowserFolder): Promise<void> {
    if (!this.valid() || this.browser.busy() || this.validating() || this.closed) return;
    const controller = new AbortController(); this.controller = controller; this.validating.set(true); this.error.set('');
    try {
      const selected = await this.creation.validateFolder(this.data.profileId, {id: folder.id, name: folder.name, ...(folder.resourceKey ? {resourceKey: folder.resourceKey} : {}), ...(folder.driveId ? {driveId: folder.driveId} : {})}, controller.signal);
      if (this.valid() && !this.closed && !controller.signal.aborted) this.close({folder: selected});
    } catch (error) {if (!this.closed && !controller.signal.aborted) this.error.set(error instanceof Error ? error.message : '無法使用此資料夾，請重新選擇。');}
    finally {this.validating.set(false); if (this.controller === controller) this.controller = undefined;}
  }
  private close(result?: DriveFolderPickerResult): void {if (this.closed) return; this.closed = true; this.controller?.abort(); this.ref.close(result);}
  cancel(): void {this.close();}
  escape(event: Event): void {event.preventDefault(); event.stopPropagation(); this.cancel();}
  ngOnDestroy(): void {this.closed = true; this.controller?.abort();}
}
