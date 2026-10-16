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
    <footer><span role="status">已選 {{ selected().length }} 個項目@if (notice()) { · {{ notice() }}}</span><button type="button" [disabled]="browser.busy() || browser.selectedConnection().connecting()" (click)="confirm()">使用所選項目</button></footer>
  </section>`
})
export class DriveFilePicker {
  readonly browser = inject(DriveBrowser);
  private readonly ref = inject<DialogRef<DocumentSource[]>>(DialogRef);
  private readonly data = inject<{value: DocumentSource[]}>(DIALOG_DATA);
  readonly selected = signal(structuredClone(this.data.value.filter(source => source.provider === 'google-drive')));
  readonly selectedIds = computed(() => this.selected().map(source => source.id));
  readonly notice = signal('');
  private contexts = new Map<string, string>();
  constructor() {
    effect(() => {const contexts = this.connectionContexts(); untracked(() => this.synchronizeSelection(contexts));});
  }
  private connectionContexts(): Map<string, string> {
    return new Map(this.browser.connection.sources().map(source => [source.id, source.context()]));
  }
  private synchronizeSelection(contexts: Map<string, string>): boolean {
    const changed = [...this.contexts].some(([id, context]) => contexts.get(id) !== context);
    this.contexts = contexts;
    if (changed) {this.selected.set(structuredClone(this.data.value.filter(source => source.provider === 'google-drive'))); this.notice.set('來源或帳號已更新，請重新選擇。');}
    return changed;
  }
  toggle(source: DocumentSource): void {this.selected.update(selected => selected.some(item => item.id === source.id) ? selected.filter(item => item.id !== source.id) : [...selected, structuredClone(source)]); this.notice.set('');}
  confirm(): void {if (!this.browser.busy() && !this.browser.selectedConnection().connecting() && !this.synchronizeSelection(this.connectionContexts())) this.ref.close(structuredClone(this.selected()));}
  cancel(): void {this.ref.close();}
  escape(event: Event): void {event.preventDefault(); event.stopPropagation(); this.cancel();}
}
