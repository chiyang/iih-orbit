import { Component, inject, input, output } from '@angular/core';
import { Icon } from './icon';
import { Reminders } from './reminders';
import type { ReminderTab } from './reminder-items';

@Component({
  selector: 'app-reminder-badge', imports: [Icon],
  template: `<button title="訊息中心" aria-controls="reminder-panel" [attr.aria-expanded]="expanded()" [attr.aria-label]="'訊息中心，' + reminders.summaryCount() + ' 項近期提醒'" (click)="openCenter.emit('today')"><app-icon name="bell" /><span>訊息</span>@if (reminders.summaryCount()) {<strong>{{ reminders.summaryCount() > 99 ? '99+' : reminders.summaryCount() }}</strong>}</button>`,
  styles: `button {display: flex; align-items: center; gap: 7px; color: var(--text); border: 1px solid var(--border); border-radius: 7px; padding: 8px 10px; background: var(--control-bg); font-size: var(--font-11); white-space: nowrap;}
    app-icon {width: 16px; height: 16px;} button:hover {background: var(--accent-soft);}
    strong {background: var(--accent-strong); color: var(--on-accent); border-radius: 12px; padding: 2px 5px; min-width: 20px; font-size: var(--font-8); text-align: center;}
    @media (max-width: 1250px) {button > span {display: none;}} @media (max-width: 700px) {button {padding: 7px;}}`
})
export class ReminderBadge {
  readonly reminders = inject(Reminders);
  readonly expanded = input(false);
  readonly openCenter = output<ReminderTab>();
}
