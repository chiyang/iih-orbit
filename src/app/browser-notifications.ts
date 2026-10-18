import {DOCUMENT} from '@angular/common';
import {inject, Injectable} from '@angular/core';
import {SYSTEM_NOTIFICATION_TAG, type NotificationTarget} from './system-notification-data';

@Injectable({providedIn: 'root'})
export class BrowserNotifications {
  private readonly document = inject(DOCUMENT);
  private readonly view = this.document.defaultView as (Window & typeof globalThis) | null;
  private readonly shown = new Set<Notification>();
  permission(): NotificationPermission | 'unsupported' {return this.view?.isSecureContext && typeof this.view.Notification === 'function' ? this.view.Notification.permission : 'unsupported';}
  requestPermission(): Promise<NotificationPermission> {return this.view!.Notification.requestPermission();}
  private async registration(): Promise<ServiceWorkerRegistration | undefined> {
    const workers = this.view?.navigator.serviceWorker;
    if (!workers?.getRegistration) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {return await Promise.race([workers.getRegistration(this.document.baseURI), new Promise<undefined>(resolve => {timer = setTimeout(() => resolve(undefined), 2000);})]);}
    catch {return undefined;}
    finally {clearTimeout(timer);}
  }
  async show(title: string, body: string, tag: string, target: NotificationTarget | null, open: (target: NotificationTarget) => void): Promise<() => void> {
    if (this.permission() !== 'granted') throw new Error('尚未允許系統通知');
    const options: NotificationOptions = {body, tag, icon: new URL('icons/app-icon-192.png', this.document.baseURI).href, data: {orbitReminder: target}};
    const registration = await this.registration();
    if (this.permission() !== 'granted') throw new Error('通知權限已變更');
    if (registration?.active && registration.showNotification) {
      await registration.showNotification(title, options);
      return () => {void registration.getNotifications({tag}).then(items => items.forEach(item => item.close())).catch(() => {});};
    }
    const notification = new this.view!.Notification(title, options); this.shown.add(notification);
    notification.onclose = () => this.shown.delete(notification);
    notification.onclick = () => {notification.close(); this.view?.focus(); if (target) open(target);};
    return () => {notification.close(); this.shown.delete(notification);};
  }
  async reconcile(live: () => ReadonlySet<string>): Promise<void> {
    const closeOld = (item: Notification) => {if (item.tag.startsWith(SYSTEM_NOTIFICATION_TAG) && !live().has(item.tag)) {item.close(); this.shown.delete(item);}};
    for (const item of this.shown) closeOld(item);
    try {const registration = await this.registration(); if (registration?.getNotifications) for (const item of await registration.getNotifications()) closeOld(item);} catch { /* A closed browser may leave notifications under system control. */ }
  }
}
