import { Component, computed, inject, input, output } from '@angular/core';
import { DriveService } from './drive-service';
import { Icon } from './icon';

@Component({selector: 'app-drive-status', host: {'[class.compact]': 'compact()'}, imports: [Icon], template: `@if (compact()) {@if (drive.store.drive().accountId) {<button class="compact-status" [title]="drive.status()" (click)="configure.emit()"><app-icon name="sync" />Google Drive · {{ compactLabel() }}</button>}} @else {<div class="heading"><span>雲端備份</span>@if (drive.auth.connected() && drive.store.drive().mode !== 'off' && drive.runtime().link) {<button [disabled]="drive.busy() || !drive.online() || !!drive.runtime().conflict" aria-label="立即更新雲端資料" (click)="drive.sync()"><app-icon name="sync" [class.spinning]="drive.busy()" /></button>}</div><button class="entry" (click)="configure.emit()"><app-icon name="export" />管理 Google Drive</button>@if (drive.store.drive().accountId) {<p role="status">{{ drive.status() }}</p>}@if (drive.error()) {<p class="error" role="alert">{{ drive.error() }}</p>}}`, styles: `:host.compact {display: contents;} .compact-status {font-size: var(--font-9); padding: 0;} :host {display: block; margin: 0 var(--sp12) var(--sp24); padding-top: var(--sp17); border-top: 1px solid var(--border);} .heading {display: flex; align-items: center; justify-content: space-between; font-size: var(--font-10); color: var(--text-muted); font-weight: 600;} button {display: inline-flex; align-items: center; gap: var(--sp7); padding: var(--sp5); background: transparent; color: var(--text-muted); border-radius: 5px; font-size: var(--font-11);} button:hover {background: var(--surface-hover); color: var(--accent-text);} button:disabled {opacity: .5;} .entry {margin-top: var(--sp7);} app-icon {width: 14px; height: 14px;} p {font-size: var(--font-9); color: var(--text-muted); line-height: 1.7; overflow-wrap: anywhere; margin: var(--sp7) 0;} .error {color: var(--danger-text);} .spinning {animation: spin 1.2s linear infinite;} @keyframes spin {to {transform: rotate(360deg);}} @media (prefers-reduced-motion: reduce) {.spinning {animation: none;}}`})
export class DriveStatus {
  readonly drive = inject(DriveService);
  readonly compact = input(false);
  readonly compactLabel = computed(() => {
    if (this.drive.busy()) return '同步中';
    if (!this.drive.auth.connected()) return '尚未連線';
    if (this.drive.store.drive().mode === 'off' || !this.drive.runtime().link) return '尚未啟用';
    if (!this.drive.online()) return '離線';
    if (this.drive.runtime().conflict) return '需要選擇內容';
    if (this.drive.error() || this.drive.unavailable()) return '需要處理';
    return this.drive.runtime().pending ? '等待同步' : '已啟用';
  });
  readonly configure = output<void>();
}
