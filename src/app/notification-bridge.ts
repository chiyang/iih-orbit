import {Component, effect, inject, input, output, untracked} from '@angular/core';
import {SystemNotifications} from './system-notifications';
import type {ReminderItem} from './reminder-items';

@Component({selector: 'app-notification-bridge', template: ''})
export class NotificationBridge {
  readonly notifications = inject(SystemNotifications);
  readonly blocked = input(false);
  readonly openItem = output<ReminderItem>();
  readonly notice = output<string>();
  private deferred = '';
  constructor() {
    effect(() => this.notifications.blocked.set(this.blocked()));
    effect(() => {
      const target = this.notifications.openRequest(), loading = this.notifications.store.storageLoading(), blocked = this.blocked(); this.notifications.reminders.items();
      if (!target || loading) return;
      untracked(() => {
        if (blocked) {const key = JSON.stringify(target); if (this.deferred !== key) {this.deferred = key; this.notice.emit('請先完成或取消目前的操作，再開啟通知中的任務。');} return;}
        this.notifications.openRequest.set(null); this.deferred = '';
        const item = this.notifications.resolve(target);
        if (item) {this.notifications.reminders.markViewed([item]); this.openItem.emit(item);}
        else this.notice.emit('原提醒已移除或目前無法讀取，請查看提醒歷史。');
      });
    });
  }
}
