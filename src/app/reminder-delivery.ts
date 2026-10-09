export const REMINDER_DELIVERY_KEY = 'orbit-reminder-delivery-v1';
interface StorageLike {getItem(key: string): string | null; setItem(key: string, value: string): void}
type Lock = <T>(operation: () => T) => Promise<T>;

/** Records only delivery identities and expiry, never event descriptions or credentials. */
export class ReminderDelivery {
  private readonly storage: StorageLike;
  private readonly lock: Lock;
  constructor(storage: StorageLike, lock: Lock) { this.storage = storage; this.lock = lock; }

  claim(key: string, expires: number, now: number): Promise<boolean> {
    return this.lock(() => {
      const value = this.storage.getItem(REMINDER_DELIVERY_KEY);
      let records: {key: string; expires: number}[] = [];
      if (value) {
        try {
          const parsed: unknown = JSON.parse(value);
          if (Array.isArray(parsed)) records = parsed.filter(item => item && typeof item.key === 'string' && Number.isFinite(item.expires) && item.expires >= now);
        } catch { /* Replace an invalid delivery log without touching work data. */ }
      }
      if (records.some(record => record.key === key) || expires < now) return false;
      // Do not evict live identities: doing so could repeat a still-active reminder in another tab.
      if (records.length >= 2000) throw new Error('提醒記錄已滿，暫停自動提示；仍可使用訊息中心。');
      this.storage.setItem(REMINDER_DELIVERY_KEY, JSON.stringify([...records, {key, expires}]));
      return true;
    });
  }
}
