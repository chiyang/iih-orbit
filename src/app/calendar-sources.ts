import { Component, computed, effect, inject, output, signal, untracked } from '@angular/core';
import { GoogleCalendarService } from './google-calendar';
import { Icon } from './icon';
import { ThemeColor } from './theme-color';

@Component({
  selector: 'app-calendar-sources', imports: [Icon, ThemeColor],
  template: `<div class="sources-heading"><span>外部月曆</span>@if (clientId() && (calendar.syncing() || calendar.auth.connected()) && calendar.visibleSources().length) {<button class="sync-source" [disabled]="calendar.syncing() || !calendar.online()" [attr.aria-label]="calendar.syncing() ? '月曆同步中' : '立即同步外部月曆'" [title]="calendar.syncing() ? '同步中…' : '立即同步'" (click)="calendar.refresh()"><app-icon name="sync" [class.syncing]="calendar.syncing()" /></button>}</div>
    @if (workspaceSources().length) {
    <div class="source-actions">
      @if (!clientId()) {
        <button class="source-primary" (click)="configure.emit()"><app-icon name="calendar" />設定 Google 連線</button>
      } @else if (!calendar.syncing() && !calendar.auth.connected()) {
        <button class="source-primary" [disabled]="!calendar.auth.ready() || calendar.auth.authorizing() || !calendar.online()" (click)="connect()"><app-icon name="calendar" />{{ calendar.auth.authorizing() ? '等待 Google 授權…' : calendar.auth.preparing() ? '載入連線元件…' : '連線 Google' }}</button>
        @if (!calendar.auth.ready() && !calendar.auth.preparing()) {<button (click)="prepare()">重試載入連線元件</button>}
      }
    </div>
    @if (clientId()) {<p class="connection-status" role="status">{{ calendar.online() ? calendar.auth.message() : '離線中，顯示已保存的月曆' }}</p>}
    @if (error() || calendar.error()) {<p class="connection-error" role="alert">{{ error() || calendar.error() }}</p>}
    @if (calendar.auth.sessionWarning()) {<p class="connection-error" role="status">{{ calendar.auth.sessionWarning() }}</p>}
    @if (calendar.cacheWarning()) {<p class="connection-error" role="status">{{ calendar.cacheWarning() }}</p>}
    }
    @for (source of workspaceSources(); track source.id) {
        <label class="source-item" [title]="source.name + '・唯讀・' + calendar.status(source)"><input type="checkbox" [checked]="source.visible" (change)="calendar.store.updateCalendarSource(source.id, {visible: $any($event.target).checked})"><i [orbitColor]="source.color"></i><span>{{ source.name }}<small>Google・唯讀</small><small class="source-status">{{ source.visible ? calendar.status(source) : '已隱藏' }}</small></span></label>
    }
    <button class="configure-source" (click)="configure.emit()"><app-icon name="calendar" />管理外部月曆</button>`,
  styles: `:host {display: block; margin: 0 12px 24px; padding-top: 17px; border-top: 1px solid var(--border);}
    .sources-heading {display: flex; align-items: center; justify-content: space-between; font-size: var(--font-10); font-weight: 600; color: var(--text-muted); margin-bottom: 10px;}
    button {background: transparent; color: var(--text-muted); display: inline-flex; align-items: center; gap: 7px; padding: 4px; border-radius: 5px; font-size: var(--font-11);}
    button:hover {color: var(--accent-text); background: var(--surface-hover);}
    button:disabled {opacity: .55; cursor: default;}
    .sync-source {padding: 6px;}
    .syncing {animation: source-spin 1.2s linear infinite;}
    @keyframes source-spin {to {transform: rotate(360deg);}}
    @media (prefers-reduced-motion: reduce) {.syncing {animation: none;}}
    .source-actions:empty {display: none;}
    .source-actions {display: grid; gap: 6px; margin-bottom: 8px;}
    .source-actions button {justify-content: center; padding: 9px 7px; border: 1px solid var(--accent-border); min-width: 0; line-height: 1.5;}
    .source-primary {background: var(--accent-strong); color: var(--on-accent);}
    .source-primary:hover {background: var(--accent-strong); color: var(--on-accent); filter: brightness(.96);}
    .connection-status, .connection-error {font-size: var(--font-9); line-height: 1.65; overflow-wrap: anywhere; margin: 7px 0; color: var(--text-muted);}
    .connection-error {color: var(--danger-text);}
    app-icon {width: 14px; height: 14px; flex-shrink: 0;}
    .source-item {display: flex; align-items: center; gap: 7px; padding: 9px 0; font-size: var(--font-11); cursor: pointer;}
    input {accent-color: var(--accent-strong); width: 14px; height: 14px; margin: 0; flex-shrink: 0;}
    i {width: 7px; height: 7px; border-radius: 50%; background: var(--category-color); flex-shrink: 0;}
    .source-item > span {min-width: 0; overflow-wrap: anywhere;}
    small {display: block; font-size: var(--font-8); color: var(--text-soft); margin-top: 2px;}
    .source-status {color: var(--text-muted); line-height: 1.5;}
    .configure-source {margin-top: 7px; padding: 4px 0;}`
})
export class CalendarSources {
  readonly calendar = inject(GoogleCalendarService);
  readonly configure = output<void>();
  readonly clientId = computed(() => this.calendar.store.google().clientId);
  readonly workspaceSources = computed(() => this.calendar.sources().filter(source => source.workspaceIds.includes(this.calendar.store.currentWorkspace().id)));
  readonly error = signal('');

  constructor() {
    effect(() => {
      const clientId = this.clientId();
      untracked(() => { if (clientId) void this.prepare(); });
    });
  }
  async prepare(): Promise<void> {
    this.error.set('');
    try { await this.calendar.auth.prepare(); }
    catch (error) { this.error.set(error instanceof Error ? error.message : 'Google 連線元件無法載入，請重試。'); }
  }
  connect(): Promise<void> {
    this.error.set('');
    return this.calendar.connect();
  }
}
