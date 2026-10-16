import {sourceOpenUrl} from './source-file-type';
import { Component, DestroyRef, effect, inject, Injector, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CdkDrag, CdkDragHandle, CdkDropList, type CdkDragDrop } from '@angular/cdk/drag-drop';
import type { DocumentDescription, DocumentSource } from './models';
import { DOCUMENT_DESCRIPTION_LIMIT, documentFromUrl, documentLocationLabel } from './document-data';
import type {DialogRef} from '@angular/cdk/dialog';
import type {DriveFilePicker} from './drive-file-picker';
import {Icon} from './icon';
import {SourceIcon} from './source-icon';
import {DocumentMetadataService} from './document-metadata-service';
import {DocumentLinkStatus} from './document-link-status';

@Component({
  selector: 'app-document-links-editor', imports: [FormsModule, Icon, SourceIcon, CdkDrag, CdkDragHandle, CdkDropList, DocumentLinkStatus], styleUrl: './document-links.css',
  template: `<section #editor class="document-editor" aria-label="任務資訊連結">
    <div class="document-heading"><div><app-icon name="link" /><strong>資訊連結</strong></div><span>{{ value().length }} 項</span></div>
    <p class="document-help">拖曳或用箭頭排序，為這個任務補充用途說明。儲存任務後生效；移除只解除關聯。</p>
    @if (hasDrive()) {<div class="document-metadata-actions"><label>查驗來源<select [ngModel]="metadataSource()" (ngModelChange)="metadataSource.set($event)" [ngModelOptions]="{standalone: true}" aria-label="連結資訊查驗來源"><option value="">自動選擇可用來源</option>@for (source of metadata.connections.sources(); track source.id) {<option [value]="source.id">{{ source.name() }}</option>}</select></label><button type="button" [disabled]="metadata.manualBusy()" title="更新目前可見的 Drive 連結；捲動後可查驗更多項目" (click)="refreshMetadata(editor)">{{ metadata.manualBusy() ? '查驗中…' : '更新連結資訊' }}</button>@if (metadataSource() && !metadata.connections.source(metadataSource()).auth.connected()) {<button type="button" (click)="metadata.reconnect(metadataSource())">連線此查驗來源</button>}</div>}
    <!-- Previously saved preview sources stay readable without opening synthetic IDs. -->
    <div class="document-link-list" cdkDropList [cdkDropListData]="value()" (cdkDropListDropped)="drop($event)">
      @for (source of value(); track source.id; let index = $index) {
        <article class="document-link-row" cdkDrag cdkDragLockAxis="y">
          @let shown = display(source);
          <div class="document-link-summary"><span class="document-drag-handle" cdkDragHandle aria-hidden="true" title="拖曳調整順序"><app-icon name="grip" /></span><app-source-icon [file]="shown" /><div>@if (source.sourceScope === 'demo-drive') {<strong>{{ shown.name }}</strong>} @else {<a [href]="openUrl(shown)" target="_blank" rel="noopener noreferrer" [attr.aria-label]="'在新分頁開啟 ' + shown.name" title="在新分頁開啟">{{ shown.name }}<span class="document-external-icon" aria-hidden="true"><app-icon name="external" /></span></a>}<small>{{ locationLabel(shown) }}</small><app-document-link-status [source]="source" [preferred]="metadataSource()" /></div></div>
          @if (editingNote() === source.id) {
            <label class="document-description-field">在這個任務中的用途<textarea [attr.aria-label]="'用途說明：' + shown.name" [ngModel]="description(source.id)" (ngModelChange)="describe(source.id, $event)" [ngModelOptions]="{standalone: true}" [maxlength]="descriptionLimit" rows="3" placeholder="例如：會議前閱讀第 2 節，確認研究方法。"></textarea></label>
            <small class="document-description-count">{{ description(source.id).length }} / {{ descriptionLimit }} 字</small>
          } @else if (description(source.id).trim()) {<p class="document-description">{{ description(source.id) }}</p>}
          <div class="document-link-actions"><button type="button" class="document-order-button document-order-up" [disabled]="index === 0" [attr.aria-label]="'將 ' + shown.name + ' 上移'" title="上移" (click)="move(index, index - 1)"><app-icon name="down" /></button><button type="button" class="document-order-button" [disabled]="index === value().length - 1" [attr.aria-label]="'將 ' + shown.name + ' 下移'" title="下移" (click)="move(index, index + 1)"><app-icon name="down" /></button><button type="button" [attr.aria-expanded]="editingNote() === source.id" (click)="editingNote.set(editingNote() === source.id ? '' : source.id)">{{ editingNote() === source.id ? '完成說明' : description(source.id).trim() ? '編輯用途' : '新增用途說明' }}</button><button type="button" class="document-remove" [attr.aria-label]="'移除資訊連結 ' + shown.name" (click)="remove(source.id)">移除</button></div>
        </article>
      }
    </div>
    <div class="document-add-actions"><button type="button" (click)="createDocument.emit()">建立文件</button><button type="button" (click)="openPicker()">＋ 瀏覽 Drive 加入連結</button><button type="button" (click)="adding.set(!adding()); error.set('')">貼上 Drive 連結</button></div>
    @if (adding()) {
      <div class="document-add-fields">
        <label>文件名稱<input aria-label="文件名稱" [(ngModel)]="name" [ngModelOptions]="{standalone: true}" maxlength="300" (keydown.enter)="$event.preventDefault(); add()"></label>
        <label>Drive 連結<input aria-label="文件連結" type="url" [(ngModel)]="url" [ngModelOptions]="{standalone: true}" maxlength="4096" placeholder="https://drive.google.com/…" (keydown.enter)="$event.preventDefault(); add()"></label>
        <div><button type="button" (click)="add()">加入連結</button><button type="button" (click)="adding.set(false); error.set('')">取消加入</button></div>
      </div>
    }
    @if (error()) {<p class="document-error" role="alert">{{ error() }}</p>}
    @if (notice()) {<p class="document-help" role="status">{{ notice() }}</p>}
    @if (metadata.notice()) {<p class="document-help" role="status">{{ metadata.notice() }}</p>}
  </section>`
})
export class DocumentLinksEditor {
  readonly openUrl = sourceOpenUrl;
  private readonly injector = inject(Injector);
  readonly metadata = inject(DocumentMetadataService);
  readonly metadataSource = signal('');
  private pickerRef?: DialogRef<DocumentSource[], DriveFilePicker>;
  private pickerRequest = 0;
  private destroyed = false;
  readonly value = input<DocumentSource[]>([]);
  readonly known = input<DocumentSource[]>([]);
  readonly valueChange = output<DocumentSource[]>();
  readonly createDocument = output<void>();
  readonly descriptions = input<DocumentDescription[]>([]);
  readonly descriptionsChange = output<DocumentDescription[]>();
  readonly descriptionLimit = DOCUMENT_DESCRIPTION_LIMIT;
  readonly editingNote = signal('');
  readonly locationLabel = documentLocationLabel;
  readonly adding = signal(false);
  readonly pickerOpen = signal(false);
  readonly error = signal('');
  readonly notice = signal('');
  name = '';
  url = '';
  constructor() {
    effect(() => {const id = this.metadataSource(); if (id && !this.metadata.connections.sources().some(source => source.id === id)) this.metadataSource.set('');});
    inject(DestroyRef).onDestroy(() => {this.destroyed = true; this.cancelPicker();});
  }
  display(source: DocumentSource) {return this.metadata.display(source, this.metadataSource());}
  hasDrive(): boolean {return this.value().some(source => source.provider === 'google-drive' && source.sourceScope === 'drive' && !!source.fileId);}
  refreshMetadata(element: HTMLElement): void {void this.metadata.refreshVisible(element, this.metadataSource());}
  description(id: string): string {return this.descriptions().find(item => item.documentId === id)?.description ?? '';}
  describe(id: string, description: string): void {
    if (!this.value().some(source => source.id === id)) return;
    this.descriptionsChange.emit(this.value().map(source => ({documentId: source.id, description: source.id === id ? description.slice(0, this.descriptionLimit) : this.description(source.id)})));
  }
  move(from: number, to: number): void {
    if (from === to || from < 0 || to < 0 || from >= this.value().length || to >= this.value().length) return;
    const sources = [...this.value()], [source] = sources.splice(from, 1); sources.splice(to, 0, source);
    this.updateSources(sources); this.notice.set('已調整草稿順序，儲存任務後生效。');
  }
  drop(event: CdkDragDrop<DocumentSource[]>): void {this.move(event.previousIndex, event.currentIndex);}
  private updateSources(sources: DocumentSource[]): void {
    const notes = new Map(this.descriptions().map(item => [item.documentId, item.description]));
    this.valueChange.emit(sources);
    this.descriptionsChange.emit(sources.map(source => ({documentId: source.id, description: notes.get(source.id) ?? ''})));
  }
  async openPicker(): Promise<void> {
    if (this.pickerOpen()) return;
    const request = ++this.pickerRequest;
    this.notice.set('正在開啟選檔視窗…'); this.error.set(''); this.pickerOpen.set(true);
    try {
      const [{Dialog}, {DriveFilePicker}] = await Promise.all([import('@angular/cdk/dialog'), import('./drive-file-picker')]);
      if (this.destroyed || request !== this.pickerRequest) return;
      const ref = this.injector.get(Dialog).open<DocumentSource[], {value: DocumentSource[]}, DriveFilePicker>(DriveFilePicker, {data: {value: structuredClone(this.value())}, injector: this.injector, width: 'min(780px, calc(100vw - 32px))', maxHeight: 'calc(100dvh - 40px)', panelClass: 'information-picker-dialog', ariaLabel: '選擇 Drive 資訊連結', ariaModal: true, autoFocus: '.picker-cancel', disableClose: true});
      this.pickerRef = ref; this.notice.set('');
      ref.backdropClick.subscribe(() => ref.close());
      ref.closed.subscribe(value => {
        this.pickerRef = undefined; this.pickerOpen.set(false);
        if (value === undefined) {this.notice.set('已取消選檔，原有草稿保留。'); return;}
        const selected = new Set(value.map(source => source.id)), previous = new Set(this.value().map(source => source.id));
        this.updateSources(structuredClone([...this.value().filter(source => source.provider !== 'google-drive' || selected.has(source.id)), ...value.filter(source => !previous.has(source.id))])); this.notice.set('選擇已加入草稿，儲存任務後生效。');
      });
    } catch {if (!this.destroyed && request === this.pickerRequest) {this.pickerOpen.set(false); this.notice.set(''); this.error.set('無法開啟選檔視窗，請再試一次。');}}
  }
  cancelPicker(): void {this.pickerRequest++; this.pickerRef?.close(); this.pickerOpen.set(false); this.notice.set('已取消選檔，原有草稿保留。');}
  hasDraft(): boolean {return this.adding() && (!!this.name.trim() || !!this.url.trim());}
  select(source: DocumentSource): void {
    const duplicate = this.value().some(item => item.id === source.id);
    if (!duplicate) this.updateSources([...this.value(), source]);
    this.notice.set(duplicate ? '這個項目已在任務中。' : '已加入草稿，儲存任務後生效。');
  }
  add(): boolean {
    try {
      this.select(documentFromUrl('google-drive', this.url, this.name, [...this.known(), ...this.value()]));
      this.name = ''; this.url = ''; this.adding.set(false); this.error.set(''); return true;
    } catch (error) {this.error.set(error instanceof Error ? error.message : '無法加入文件，請確認連結。'); return false;}
  }
  remove(id: string): void {this.updateSources(this.value().filter(source => source.id !== id)); if (this.editingNote() === id) this.editingNote.set(''); this.notice.set('儲存任務後解除關聯，來源項目保留。');}
}
