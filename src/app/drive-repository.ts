import { readDriveRuntime } from './drive-data.ts';
import type { DriveRuntime } from './drive-data.ts';

export interface DriveRepository {read(key: string): Promise<DriveRuntime>; write(key: string, value: DriveRuntime, current?: () => boolean): Promise<void>}
/** Queued backups include exported settings. Credentials never enter this database. */
export class IndexedDriveRepository implements DriveRepository {
  private opening?: Promise<IDBDatabase>;
  private database(): Promise<IDBDatabase> {
    if (typeof indexedDB === 'undefined') return Promise.reject(new Error('瀏覽器不支援 Drive 待上傳資料保存，請更新瀏覽器後重試。'));
    if (!this.opening) this.opening = new Promise((resolve, reject) => {
      const request = indexedDB.open('iih-orbit-drive-v1', 1);
      let blocked = false;
      request.onupgradeneeded = () => request.result.createObjectStore('runtime');
      request.onsuccess = () => { if (blocked) {request.result.close(); return;} request.result.onversionchange = () => { request.result.close(); this.opening = undefined; }; resolve(request.result); };
      request.onerror = () => { this.opening = undefined; reject(new Error('瀏覽器無法保存 Drive 待上傳資料，自動同步未啟用。')); };
      request.onblocked = () => {blocked = true; this.opening = undefined; reject(new Error('Drive 儲存空間被其他分頁阻擋，請關閉舊分頁後重試。'));};
    });
    return this.opening;
  }
  async read(key: string): Promise<DriveRuntime> {
    const db = await this.database();
    const value = await new Promise<DriveRuntime | undefined>((resolve, reject) => {
      const request = db.transaction('runtime', 'readonly').objectStore('runtime').get(key);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error('無法讀取 Drive 待上傳資料。'));
    });
    return value ? readDriveRuntime(value) : {};
  }
  async write(key: string, value: DriveRuntime, current?: () => boolean): Promise<void> {
    const db = await this.database();
    if (current && !current()) throw new Error('Drive 資料世代已變更，待上傳版本未重新寫入。');
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('runtime', 'readwrite');
      transaction.objectStore('runtime').put(structuredClone(value), key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = transaction.onabort = () => reject(new Error('無法保存 Drive 待上傳版本，原有資料保留。'));
    });
  }
  async clear(): Promise<void> {
    const db = await this.database();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('runtime', 'readwrite'); transaction.objectStore('runtime').clear();
      transaction.oncomplete = () => resolve(); transaction.onerror = transaction.onabort = () => reject(new Error('Drive 本機快取清理未完成。'));
    });
  }
}
