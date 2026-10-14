import { readStoredData, type StoredWorkspaceData } from './stored-data.ts';
import type { Workspace } from './models';

const entityFields = ['tasks', 'projects', 'categories', 'statuses', 'taskConflicts', 'calendarTransfers', 'documentSources', 'documentLinks'] as const;
type RecordData = {key: string; value: unknown};
interface WorkspaceIndex {metadata: Omit<Workspace, typeof entityFields[number]>; entities: Record<string, string[]>}
interface Root {header: Omit<StoredWorkspaceData, 'state'>; activeWorkspaceId: string; workspaces: string[]}
const key = (workspace: string, field: string, id: string) => JSON.stringify([workspace, field, id]);

export function splitWorkspaceRecords(data: StoredWorkspaceData): Map<string, unknown> {
  const {state, ...header} = data, records = new Map<string, unknown>();
  records.set('root', {header, activeWorkspaceId: state.activeWorkspaceId, workspaces: state.workspaces.map(w => w.id)} satisfies Root);
  for (const workspace of state.workspaces) {
    const metadata = {...workspace}, entities: Record<string, string[]> = {};
    for (const field of entityFields) {
      const items = workspace[field]; delete metadata[field];
      if (items === undefined) continue;
      entities[field] = items.map((item, index) => 'id' in item ? item.id : String(index));
      items.forEach((item, index) => records.set(key(workspace.id, field, entities[field][index]), item));
    }
    records.set(key(workspace.id, 'workspace', ''), {metadata, entities} satisfies WorkspaceIndex);
  }
  return records;
}
export function joinWorkspaceRecords(records: Map<string, unknown>): StoredWorkspaceData | null {
  const root = records.get('root') as Root | undefined;
  if (!root) {if (records.size) throw new Error('本機資料索引遺失，原有紀錄保留。'); return null;}
  if (!root.header || !Array.isArray(root.workspaces)) throw new Error('本機資料索引不完整。');
  const workspaces = root.workspaces.map(id => {
    const index = records.get(key(id, 'workspace', '')) as WorkspaceIndex;
    if (!index?.metadata || index.metadata.id !== id || !index.entities) throw new Error('本機工作空間紀錄不完整。');
    const workspace = {...index.metadata} as Workspace;
    for (const field of entityFields) {
      const ids = index.entities[field]; if (ids === undefined) continue;
      if (!Array.isArray(ids)) throw new Error('本機資料參照不完整。');
      const values = ids.map(entity => {const recordKey = key(id, field, entity); if (!records.has(recordKey)) throw new Error('本機資料紀錄遺失，原有資料保留。'); return records.get(recordKey);});
      Object.assign(workspace, {[field]: values});
    }
    return workspace;
  });
  const data = readStoredData({...root.header, state: {version: 1, activeWorkspaceId: root.activeWorkspaceId, workspaces}});
  if (!data) throw new Error('本機資料驗證失敗，原有紀錄保留。');
  return data;
}
export function changedWorkspaceRecords(previous: Map<string, unknown>, next: Map<string, unknown>): {put: RecordData[]; remove: string[]} {
  return {put: [...next].filter(([key, value]) => !previous.has(key) || JSON.stringify(previous.get(key)) !== JSON.stringify(value)).map(([key, value]) => ({key, value})), remove: [...previous.keys()].filter(key => !next.has(key))};
}

/** A single readwrite transaction owns both the latest-state check and changed-record writes. */
export class WorkspaceRecordRepository {
  private opening?: Promise<IDBDatabase>;
  private database(): Promise<IDBDatabase> {
    if (!this.opening) this.opening = new Promise((resolve, reject) => {
      const request = indexedDB.open('iih-orbit-workspaces-v1', 1); let blocked = false;
      request.onupgradeneeded = () => request.result.createObjectStore('records', {keyPath: 'key'});
      request.onsuccess = () => {if (blocked) {request.result.close(); return;} const db = request.result; db.onversionchange = () => {db.close(); this.opening = undefined;}; resolve(db);};
      request.onerror = () => {this.opening = undefined; reject(new Error('無法開啟本機資料儲存，原有資料保留。'));};
      request.onblocked = () => {blocked = true; this.opening = undefined; reject(new Error('本機資料升級被其他分頁阻擋，請關閉舊分頁後重試。'));};
    });
    return this.opening;
  }
  async read(): Promise<StoredWorkspaceData | null> {
    const db = await this.database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('records', 'readonly'), request = tx.objectStore('records').getAll(); let result: StoredWorkspaceData | null, failure: unknown;
      request.onsuccess = () => {try {result = joinWorkspaceRecords(new Map((request.result as RecordData[]).map(r => [r.key, r.value])));} catch (error) {failure = error; tx.abort();}};
      tx.oncomplete = () => resolve(result); tx.onerror = tx.onabort = () => reject(failure ?? new Error('無法讀取本機資料。'));
    });
  }
  async update(change: (data: StoredWorkspaceData | null) => StoredWorkspaceData): Promise<StoredWorkspaceData> {
    const db = await this.database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('records', 'readwrite'), store = tx.objectStore('records'), request = store.getAll(); let result: StoredWorkspaceData, failure: unknown;
      request.onsuccess = () => {
        try {
          const previous = new Map((request.result as RecordData[]).map(r => [r.key, r.value]));
          result = change(joinWorkspaceRecords(previous));
          const valid = readStoredData(result); if (!valid) throw new Error('本機資料不合法，未保存。');
          const changes = changedWorkspaceRecords(previous, splitWorkspaceRecords(valid));
          changes.remove.forEach(key => store.delete(key)); changes.put.forEach(record => store.put(record));
        } catch (error) {failure = error; tx.abort();}
      };
      tx.oncomplete = () => resolve(result); tx.onerror = tx.onabort = () => reject(failure ?? new Error('本機資料無法保存，原有資料保留。'));
    });
  }
}
