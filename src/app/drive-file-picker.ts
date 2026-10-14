import {Component, computed, effect, inject, signal, untracked} from '@angular/core';
import {DIALOG_DATA, DialogRef} from '@angular/cdk/dialog';
import {DocumentPanel} from './document-panel';
import {DriveBrowser} from './drive-browser';
import type {DocumentSource} from './models';

@Component({
  selector: 'app-drive-file-picker', imports: [DocumentPanel], providers: [DriveBrowser], styleUrl: './drive-file-picker.css',
  template: `<section class="file-picker" (keydown.escape)="escape($event)">
    <header><div><h2>選擇 Drive 資訊連結</h2><p>選擇檔案或資料夾，確認後加入任務草稿。</p></div><button type="button" class="picker-cancel" (click)="cancel()">取消</button></header>
    <app-document-panel [selectionMode]="true" [selectedIds]="selectedIds()" (selectSource)="toggle($event)" />
    <footer><span role="status">已選 {{ selected().length }} 個項目@if (notice()) { · {{ notice() }}}</span><button type="button" [disabled]="browser.busy() || browser.connection.connecting()" (click)="confirm()">使用所選項目</button></footer>
  </section>`
})
export class DriveFilePicker {
  readonly browser = inject(DriveBrowser);
  private readonly ref = inject<DialogRef<DocumentSource[]>>(DialogRef);
  private readonly data = inject<{value: DocumentSource[]}>(DIALOG_DATA);
  readonly selected = signal(structuredClone(this.data.value.filter(source => source.provider === 'google-drive')));
  readonly selectedIds = computed(() => this.selected().map(source => source.id));
  readonly notice = signal('');
  private context = this.browser.connection.context();
  constructor() {
    effect(() => {const context = this.browser.connection.context(); untracked(() => {
      if (!this.context) {this.context = context; return;}
      if (context !== this.context) {this.context = context; this.selected.set(structuredClone(this.data.value.filter(source => source.provider === 'google-drive'))); this.notice.set('帳號已更新，請重新選擇。');}
    });});
  }
  toggle(source: DocumentSource): void {this.selected.update(selected => selected.some(item => item.id === source.id) ? selected.filter(item => item.id !== source.id) : [...selected, structuredClone(source)]); this.notice.set('');}
  confirm(): void {this.ref.close(structuredClone(this.selected()));}
  cancel(): void {this.ref.close();}
  escape(event: Event): void {event.preventDefault(); event.stopPropagation(); this.cancel();}
}
