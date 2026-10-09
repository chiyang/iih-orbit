let coordinatorDatabase: Promise<IDBDatabase> | undefined;

/** The operation must stay synchronous so the fallback transaction retains its lock. */
export async function withStorageLock<T>(operation: () => T): Promise<T> {
  if (typeof window === 'undefined') return operation();
  if (navigator.locks) return navigator.locks.request('iih-orbit-data-write', operation);
  if (typeof indexedDB === 'undefined') throw new Error('瀏覽器不支援安全的資料保存，請更新瀏覽器後重試。');
  coordinatorDatabase ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('iih-orbit-coordinator', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('write-lock');
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => { database.close(); coordinatorDatabase = undefined; };
      resolve(database);
    };
    request.onerror = () => { coordinatorDatabase = undefined; reject(request.error); };
    request.onblocked = () => { coordinatorDatabase = undefined; reject(new Error('資料保存被其他分頁阻擋，請關閉舊分頁後重試。')); };
  });
  const database = await coordinatorDatabase;
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction('write-lock', 'readwrite');
    const request = transaction.objectStore('write-lock').get('current');
    let result: T;
    let failure: unknown;
    request.onsuccess = () => {
      try { result = operation(); }
      catch (error) { failure = error; transaction.abort(); }
    };
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('無法取得資料保存鎖。'));
    transaction.onerror = () => reject(transaction.error);
  });
}
