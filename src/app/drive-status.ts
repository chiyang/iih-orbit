import { Component, computed, inject, input, output } from '@angular/core';
import { DriveService } from './drive-service';
import { Icon } from './icon';

@Component({
  selector: 'app-drive-status', host: {'[class.compact]': 'compact()'}, imports: [Icon],
  template: `@if (compact()) {
    <button type="button" class="compact-status" [class.needs-choice]="needsChoice()" [title]="'遠端自動同步備份：' + description() + '（開啟設定）'" [attr.aria-label]="'遠端自動同步備份，' + (enabled() ? '已啟用，' : '未啟用，') + description() + '，開啟設定'" (click)="configure.emit()"><span class="status-dot" [class.enabled]="enabled()" [class.needs-choice]="needsChoice()" aria-hidden="true"></span><span>遠端自動同步備份@if (needsChoice()) {・待選擇內容}</span></button>
  } @else {
    <div class="heading"><span>雲端備份</span>@if (drive.auth.connected() && drive.store.drive().mode !== 'off' && drive.runtime().link) {<button [disabled]="drive.busy() || !drive.online() || !!drive.runtime().conflict" aria-label="立即同步" title="立即同步" (click)="drive.sync()"><app-icon name="sync" [class.spinning]="drive.busy()" /></button>}</div><button class="entry" (click)="configure.emit()"><app-icon name="export" />管理遠端同步備份</button>@if (drive.store.drive().accountId) {<p role="status">{{ drive.status() }}</p>}@if (drive.error()) {<p class="error" role="alert">{{ drive.error() }}</p>}
  }`,
  styles: `:host.compact {display: contents;} .compact-status {font-size: var(--font-9); padding: 0; gap: var(--sp6); white-space: nowrap;}
    .status-dot {width: 5px; height: 5px; flex-shrink: 0; border-radius: 50%; background: var(--text-soft); opacity: .35;} .status-dot.enabled {background: var(--accent-strong); opacity: 1;}
    .compact-status.needs-choice {color: var(--warning-text);} .status-dot.needs-choice {background: var(--warning-text); opacity: 1;}
    :host {display: block; margin: 0 var(--sp12) var(--sp24); padding-top: var(--sp17); border-top: 1px solid var(--border);} .heading {display: flex; align-items: center; justify-content: space-between; font-size: var(--font-10); color: var(--text-muted); font-weight: 600;} button {display: inline-flex; align-items: center; gap: var(--sp7); padding: var(--sp5); background: transparent; color: var(--text-muted); border-radius: 5px; font-size: var(--font-11);} button:hover {background: var(--surface-hover); color: var(--accent-text);} button:disabled {opacity: .5;} .entry {margin-top: var(--sp7);} app-icon {width: 14px; height: 14px;} p {font-size: var(--font-9); color: var(--text-muted); line-height: 1.7; overflow-wrap: anywhere; margin: var(--sp7) 0;} .error {color: var(--danger-text);} .spinning {animation: spin 1.2s linear infinite;} @keyframes spin {to {transform: rotate(360deg);}} @media (prefers-reduced-motion: reduce) {.spinning {animation: none;}}`
})
export class DriveStatus {
  readonly drive = inject(DriveService);
  readonly compact = input(false);
  readonly needsChoice = computed(() => !!this.drive.runtime().conflict?.length);
  readonly description = computed(() => this.needsChoice() ? '有不同內容待選擇・自動同步備份已暫停' : this.drive.status());
  readonly enabled = computed(() => this.drive.store.drive().mode !== 'off' && !!this.drive.runtime().link && !this.drive.unavailable());
  readonly configure = output<void>();
}
