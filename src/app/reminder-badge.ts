import { Component, inject, input, output } from '@angular/core';
import { Icon } from './icon';
import { Reminders } from './reminders';
import type { ReminderTab } from './reminder-items';

@Component({
  selector: 'app-reminder-badge', imports: [Icon],
  template: `<button type="button" title="訊息提醒" aria-controls="right-panel" [attr.aria-expanded]="expanded()" [attr.aria-label]="'訊息提醒，' + reminders.summaryCount() + ' 項近期提醒'" (click)="openCenter.emit('today')"><app-icon name="bell" />@if (reminders.summaryCount()) {<strong>{{ reminders.summaryCount() > 99 ? '99+' : reminders.summaryCount() }}</strong>}</button>`,
  styles: `button {height: max(28px, calc(36px * var(--font-scale))); min-width: max(28px, calc(36px * var(--font-scale))); box-sizing: border-box; display: flex; align-items: center; justify-content: center; gap: var(--sp7); color: var(--text); border: 1px solid var(--border); border-radius: 7px; padding: var(--sp8) var(--sp10); background: var(--control-bg); font-size: var(--font-11); white-space: nowrap;}
    app-icon {width: 16px; height: 16px;} button:hover {background: var(--accent-soft);}
    strong {background: var(--accent-strong); color: var(--on-accent); border-radius: 12px; padding: var(--sp2) var(--sp5); min-width: 20px; font-size: var(--font-8); text-align: center;}
    @media (max-width: 700px) {button {padding: var(--sp7);}}`
})
export class ReminderBadge {
  readonly reminders = inject(Reminders);
  readonly expanded = input(false);
  readonly openCenter = output<ReminderTab>();
}
