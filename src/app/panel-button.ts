import { Component, computed, inject, input, output } from '@angular/core';
import { BoardStore } from './board-store';
import { Reminders } from './reminders';
import { GmailNotifications } from './gmail-notifications';
import { itemsForReminderTab, type ReminderTab } from './reminder-items';
import { panelAttention } from './panel-attention';
import { Icon } from './icon';

export interface PanelActivation {target: 'tasks' | 'reminders' | 'gmail' | 'toggle'; tab?: ReminderTab}
@Component({
  selector: 'app-panel-button', imports: [Icon], styleUrl: './toolbar-icon-button.css',
  template: `<button type="button" [class.selected]="opened()" aria-controls="right-panel" [attr.aria-expanded]="opened()" [attr.aria-label]="label()" [title]="label()" (click)="activate.emit({target: attention().target, tab: reminderTab()})"><app-icon [name]="attention().icon" />@if (attention().count) {<span class="badge" aria-hidden="true">{{ attention().count > 99 ? '99+' : attention().count }}</span>}</button>`
})
export class PanelButton {
  readonly store = inject(BoardStore);
  readonly reminders = inject(Reminders);
  readonly mail = inject(GmailNotifications);
  readonly opened = input(false);
  readonly activeTab = input('tasks');
  readonly activate = output<PanelActivation>();
  readonly attention = computed(() => panelAttention(this.store.taskConflicts().length, this.reminders.unseenCount(), this.mail.count()));
  readonly label = computed(() => this.attention().target === 'toggle' ? (this.opened() ? '關閉右側欄' : '開啟右側欄')
    : this.opened() && this.activeTab() === 'gmail' && this.attention().target === 'gmail' ? '查看 ' + this.attention().count + ' 封新郵件通知'
    : this.opened() && this.activeTab() === this.attention().target ? '關閉右側欄；' + this.attention().label.split('，')[0] : this.attention().label);
  readonly reminderTab = computed(() => {
    const unseen = new Set(this.reminders.unseenItems().map(item => item.id));
    return (['today', 'overdue', 'due-soon', 'tomorrow', 'this-week', 'next-week'] as const).find(tab =>
      itemsForReminderTab(this.reminders.items(), tab, this.reminders.now(), this.store.reminders().dueSoonDays, this.store.currentWorkspace()).some(item => unseen.has(item.id))) ?? 'today';
  });
}
