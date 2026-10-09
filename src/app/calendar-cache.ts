import { Injectable } from '@angular/core';
import type { CalendarSnapshot } from './google-api';

/** Calendar data lives in IndexedDB; no access tokens are accepted by this interface. */
@Injectable({providedIn: 'root'})
export class CalendarCache {
  private database?: Promise<IDBDatabase>;
  private open(): Promise<IDBDatabase> {
    return this.database ??= new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('無法保存月曆離線快取。')); return; }
      const request = indexedDB.open('iih-orbit-calendar-v1', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('sources', {keyPath: 'key'});
      request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); this.database = undefined; }; resolve(request.result); };
      request.onerror = () => { this.database = undefined; reject(new Error('無法開啟月曆離線快取。')); };
    });
  }
  private async transaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('sources', mode);
      const request = action(transaction.objectStore('sources'));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = transaction.onabort = () => reject(new Error('無法保存月曆離線快取，資料只保留於目前分頁。'));
    });
  }
  async get(key: string): Promise<CalendarSnapshot | undefined> { return this.transaction('readonly', store => store.get(key)); }
  async put(snapshot: CalendarSnapshot): Promise<void> { await this.transaction('readwrite', store => store.put(snapshot)); }
  async remove(key: string): Promise<void> { await this.transaction('readwrite', store => store.delete(key)); }
  async clear(): Promise<void> { await this.transaction('readwrite', store => store.clear()); }
}
