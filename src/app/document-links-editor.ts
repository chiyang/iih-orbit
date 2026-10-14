import { Component, DestroyRef, inject, Injector, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { DocumentSource } from './models';
import { documentFromUrl, documentProviderLabel } from './document-data';
import type {DialogRef} from '@angular/cdk/dialog';
import type {DriveFilePicker} from './drive-file-picker';
import {Icon} from './icon';
import {SourceIcon} from './source-icon';

@Component({
  selector: 'app-document-links-editor', imports: [FormsModule, Icon, SourceIcon], styleUrl: './document-links.css',
  template: `<section class="document-editor" aria-label="任務資訊連結">
    <div class="document-heading"><div><app-icon name="link" /><strong>資訊連結</strong></div><span>{{ value().length }} 項</span></div>
    <p class="document-help">可連結檔案、資料夾與郵件；移除只解除任務中的關聯。</p>
    <!-- Previously saved preview sources stay readable without opening synthetic IDs. -->
    @for (source of value(); track source.id) {
      <div class="document-link-row"><app-source-icon [file]="source" /><div>@if (source.sourceScope === 'demo-drive') {<strong>{{ display(source).name }}</strong>} @else {<a [href]="source.url" target="_blank" rel="noopener noreferrer">{{ display(source).name }}</a>}<small>{{ providerLabel(source.provider) }}@if (display(source).location) { · {{ display(source).location }}}</small></div><button type="button" [attr.aria-label]="'移除資訊連結 ' + source.name" (click)="remove(source.id)">移除</button></div>
    }
    <div class="document-add-actions"><button type="button" (click)="openPicker()">＋ 瀏覽 Drive 加入連結</button><button type="button" (click)="adding.set(!adding()); error.set('')">貼上 Drive 連結</button></div>
    @if (adding()) {
      <div class="document-add-fields">
        <label>文件名稱<input aria-label="文件名稱" [(ngModel)]="name" [ngModelOptions]="{standalone: true}" maxlength="300" (keydown.enter)="$event.preventDefault(); add()"></label>
        <label>Drive 連結<input aria-label="文件連結" type="url" [(ngModel)]="url" [ngModelOptions]="{standalone: true}" maxlength="4096" placeholder="https://drive.google.com/…" (keydown.enter)="$event.preventDefault(); add()"></label>
        <div><button type="button" (click)="add()">加入連結</button><button type="button" (click)="adding.set(false); error.set('')">取消加入</button></div>
      </div>
    }
    @if (error()) {<p class="document-error" role="alert">{{ error() }}</p>}
    @if (notice()) {<p class="document-help" role="status">{{ notice() }}</p>}
  </section>`
})
export class DocumentLinksEditor {
  private readonly injector = inject(Injector);
  private pickerRef?: DialogRef<DocumentSource[], DriveFilePicker>;
  private pickerRequest = 0;
  private destroyed = false;
  readonly value = input<DocumentSource[]>([]);
  readonly known = input<DocumentSource[]>([]);
  readonly valueChange = output<DocumentSource[]>();
  readonly providerLabel = documentProviderLabel;
  readonly adding = signal(false);
  readonly pickerOpen = signal(false);
  readonly error = signal('');
  readonly notice = signal('');
  name = '';
  url = '';
  constructor() {inject(DestroyRef).onDestroy(() => {this.destroyed = true; this.cancelPicker();});}
  display(source: DocumentSource) {return source;}
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
        this.valueChange.emit([...this.value().filter(source => source.provider !== 'google-drive'), ...value]); this.notice.set('選擇已加入草稿，儲存任務後生效。');
      });
    } catch {if (!this.destroyed && request === this.pickerRequest) {this.pickerOpen.set(false); this.notice.set(''); this.error.set('無法開啟選檔視窗，請再試一次。');}}
  }
  cancelPicker(): void {this.pickerRequest++; this.pickerRef?.close(); this.pickerOpen.set(false); this.notice.set('已取消選檔，原有草稿保留。');}
  hasDraft(): boolean {return this.adding() && (!!this.name.trim() || !!this.url.trim());}
  select(source: DocumentSource): void {
    const duplicate = this.value().some(item => item.id === source.id);
    if (!duplicate) this.valueChange.emit([...this.value(), source]);
    this.notice.set(duplicate ? '這個項目已在任務中。' : '已加入草稿，儲存任務後生效。');
  }
  add(): boolean {
    try {
      this.select(documentFromUrl('google-drive', this.url, this.name, [...this.known(), ...this.value()]));
      this.name = ''; this.url = ''; this.adding.set(false); this.error.set(''); return true;
    } catch (error) {this.error.set(error instanceof Error ? error.message : '無法加入文件，請確認連結。'); return false;}
  }
  remove(id: string): void {this.valueChange.emit(this.value().filter(source => source.id !== id)); this.notice.set('儲存任務後解除關聯，來源項目保留。');}
}
