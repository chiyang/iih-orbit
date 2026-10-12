import { Component, computed, inject, output } from '@angular/core';
import { DriveService } from './drive-service';
import { Icon } from './icon';

@Component({
  selector: 'app-drive-sync-button', imports: [Icon], styleUrl: './toolbar-icon-button.css',
  template: `@if (visible()) {
    <button type="button" [disabled]="busy() || drive.store.pendingWrites() > 0 || (!drive.online() && !needsSettings())" [attr.aria-busy]="busy()" [attr.aria-label]="description()" [title]="description()" (click)="sync()"><app-icon [name]="drive.lastSyncAt() && !attention() && !busy() ? 'circleCheck' : 'sync'" [class.spinning]="busy()" />@if (attention()) {<span class="dot" aria-hidden="true"></span>}</button>
  }`
})
export class DriveSyncButton {
  readonly drive = inject(DriveService);
  readonly configure = output<void>();
  readonly result = output<string>();
  readonly busy = computed(() => this.drive.busy() || this.drive.syncing());
  readonly visible = computed(() => !!this.drive.store.drive().accountId && !!this.drive.runtime().link);
  readonly needsSettings = computed(() => !this.drive.auth.connected() || !!this.drive.runtime().conflict?.length || this.drive.unavailable() || this.drive.store.drive().mode === 'off');
  readonly attention = computed(() => this.needsSettings() || !!this.drive.error() || !!this.drive.runtime().pending || this.drive.store.hasUnsavedChanges() || this.drive.store.taskConflicts().length > 0);
  readonly description = computed(() => {
    if (this.busy()) return '正在同步或處理雲端資料，請等候完成';
    if (!this.drive.auth.connected()) return 'Google Drive 授權已到期或尚未連線，開啟連線設定';
    if (this.drive.runtime().conflict?.length) return '雲端有不同內容待選擇，開啟同步設定';
    if (this.drive.unavailable() || this.drive.store.drive().mode === 'off') return '遠端同步需要設定，開啟同步設定';
    if (!this.drive.online()) return '目前離線，修改已保存在本機；連線後可立即同步';
    if (this.drive.error()) return '上次同步未完成，按一下重試：' + this.drive.error();
    if (this.drive.store.taskConflicts().length) return '立即同步；另有 ' + this.drive.store.taskConflicts().length + ' 個衝突任務待處理，各份內容仍會一起保存';
    return '立即同步' + (this.drive.lastSyncAt() ? '；最近完成於 ' + new Date(this.drive.lastSyncAt()).toLocaleTimeString('zh-TW', {hour12: false}) : '');
  });
  async sync(): Promise<void> {
    if (this.busy() || this.drive.store.pendingWrites()) return;
    if (this.needsSettings()) {this.configure.emit(); return;}
    if (!this.drive.online()) return;
    if (this.drive.store.hasUnsavedChanges()) {this.result.emit('本機儲存尚未完成，請先處理儲存提示，再確認同步。'); return;}
    const status = await this.drive.sync();
    if (status === 'conflict' || status === 'failed' && !this.drive.auth.connected()) this.configure.emit();
    if (status === 'complete') this.result.emit('同步已完成，可以離線使用。' + (this.drive.store.taskConflicts().length ? ' 衝突任務的各份內容也已保存，可稍後處理。' : ''));
    else if (status !== 'skipped') this.result.emit(this.drive.error() || this.drive.message() || '同步尚未完成，請稍後重試。');
  }
}
