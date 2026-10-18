import {validTime} from './task-schedule.ts';

export const SYSTEM_NOTIFICATION_KEY = 'iih-orbit-system-notifications-v1';
export const SYSTEM_NOTIFICATION_DELIVERY_KEY = 'iih-orbit-system-notification-delivery-v1';
export const SYSTEM_NOTIFICATION_TAG = 'iih-orbit-start:';
export const DEFAULT_SYSTEM_NOTIFICATIONS = {enabled: false, leadMinutes: 30, allDayTime: '09:00', includeGoogle: true, revision: ''};
export type SystemNotificationPreferences = typeof DEFAULT_SYSTEM_NOTIFICATIONS;
export interface NotificationTarget {version: 1; generation: string; workspaceId: string; itemId: string; sourceContext: string}
export function readSystemNotificationPreferences(value: unknown): SystemNotificationPreferences {
  const data = value as Partial<SystemNotificationPreferences> & {version?: number} | null;
  if (!data || data.version !== 1 || typeof data.enabled !== 'boolean' || ![15, 30, 60].includes(data.leadMinutes!) || typeof data.allDayTime !== 'string' || !data.allDayTime || !validTime(data.allDayTime)
    || typeof data.includeGoogle !== 'boolean' || typeof data.revision !== 'string' || !data.revision || data.revision.length > 100) return {...DEFAULT_SYSTEM_NOTIFICATIONS};
  return {enabled: data.enabled, leadMinutes: data.leadMinutes!, allDayTime: data.allDayTime, includeGoogle: data.includeGoogle, revision: data.revision};
}
export function readNotificationTarget(value: unknown): NotificationTarget | null {
  const data = value as NotificationTarget | null;
  if (!data || data.version !== 1 || !['generation', 'workspaceId', 'itemId'].every(key => typeof data[key as keyof NotificationTarget] === 'string' && String(data[key as keyof NotificationTarget]).length > 0 && String(data[key as keyof NotificationTarget]).length <= 1500)
    || typeof data.sourceContext !== 'string' || data.sourceContext.length > 3000) return null;
  return {version: 1, generation: data.generation, workspaceId: data.workspaceId, itemId: data.itemId, sourceContext: data.sourceContext};
}
interface DeliveryRecord {key: string; token: string; expires: number}
/** Reserve before sending. An interrupted attempt stays reserved to avoid repeating an uncertain result. */
export class SystemNotificationDelivery {
  private readonly storage: {getItem(key: string): string | null; setItem(key: string, value: string): void};
  private readonly lock: <T>(action: () => T) => Promise<T>;
  constructor(storage: SystemNotificationDelivery['storage'], lock: SystemNotificationDelivery['lock']) {this.storage = storage; this.lock = lock;}
  private read(now: number): DeliveryRecord[] {
    const raw = this.storage.getItem(SYSTEM_NOTIFICATION_DELIVERY_KEY);
    if (!raw) return [];
    const value = JSON.parse(raw);
    if (value.version !== 1 || !Array.isArray(value.records) || value.records.some((record: DeliveryRecord) => !record || typeof record.key !== 'string' || !record.key || typeof record.token !== 'string' || !record.token || !Number.isFinite(record.expires))) throw new Error('通知去重紀錄無法讀取');
    return value.records.filter((record: DeliveryRecord) => record.expires >= now);
  }
  reserve(key: string, expires: number, now: number, current: () => boolean): Promise<string | null> {
    return this.lock(() => {
      if (!current() || expires < now) return null;
      const records = this.read(now);
      if (records.some(record => record.key === key)) return null;
      if (records.length >= 2000) throw new Error('通知去重紀錄已滿');
      const token = crypto.randomUUID();
      this.storage.setItem(SYSTEM_NOTIFICATION_DELIVERY_KEY, JSON.stringify({version: 1, records: [...records, {key, token, expires}]}));
      return token;
    });
  }
  release(key: string, token: string, now: number): Promise<void> {
    return this.lock(() => {const records = this.read(now); this.storage.setItem(SYSTEM_NOTIFICATION_DELIVERY_KEY, JSON.stringify({version: 1, records: records.filter(record => record.key !== key || record.token !== token)}));});
  }
}
