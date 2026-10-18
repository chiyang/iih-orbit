import { Component, effect, inject, input, output } from '@angular/core';
import { Icon } from './icon';
import { Reminders } from './reminders';
import type { ReminderItem, ReminderTab } from './reminder-items';

@Component({selector: 'app-reminder-popups', imports: [Icon], templateUrl: './reminder-popups.html', styleUrl: './reminder-popups.css'})
export class ReminderPopups {
  readonly reminders = inject(Reminders);
  readonly blocked = input(false);
  readonly openItem = output<ReminderItem>();
  readonly openCenter = output<ReminderTab>();
  constructor() { effect(() => this.reminders.blocked.set(this.blocked())); }
  open(item: ReminderItem, key: string): void {
    if (this.blocked()) return;
    const current = this.reminders.resolve(item);
    this.reminders.dismiss(key);
    if (current) {this.reminders.markViewed([current]); this.openItem.emit(current);}
  }
  popupLabel(item: ReminderItem): string {
    if (item.allDay) return '今天的全天安排';
    const minutes = Math.ceil((item.start! - this.reminders.now().getTime()) / 60000);
    return minutes > 0 ? `${minutes} 分鐘後開始` : '剛剛開始';
  }
  googleStatus(item: ReminderItem): string {
    return item.external ? this.reminders.google.status(item.external.source, this.reminders.google.reminderRange() ?? this.reminders.google.range()) : '';
  }
}
