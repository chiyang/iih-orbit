import { canonical, DriveCollectionDeleted, readDriveDocument, readDriveFile, validDriveId, versionGraph, versionProperties } from './drive-data.ts';
import type { DriveDeletePlan, DriveDocument, DriveFile } from './drive-data.ts';
import { GoogleHttpError } from './google-api.ts';
import { expiredDriveVersions } from './drive-retention.ts';

export interface DriveTransport {
  api(path: string, parameters?: Record<string, string>, options?: RequestInit): Promise<unknown>;
  upload(url: string, options: RequestInit): Promise<Response>;
}
const fields = 'id,name,mimeType,createdTime,size,parents,trashed,appProperties';
const base = 'https://www.googleapis.com/upload/drive/v3/files';
const purposeNames = {manual: '手動備份', backup: '自動備份', sync: '同步資料'};
function readableName(file: Pick<DriveFile, 'cloud' | 'kind' | 'createdTime'> & {summary?: {label: string}}): string {
  const scope = (file.summary?.label || (file.kind === 'full' ? '全部資料' : '選定工作空間')).replace(/[\\/:*?"<>|\r\n]/g, ' ');
  const time = new Date(file.createdTime).toISOString().replace(/:/g, '-');
  return purposeNames[file.cloud.purpose] + '－' + scope + '－' + time + '－' + file.cloud.versionId.slice(0, 8) + '.json';
}
export class DriveApi {
  private readonly transport: DriveTransport;
  constructor(transport: DriveTransport) { this.transport = transport; }
  async list(): Promise<DriveFile[]> {
    const [live, history] = await Promise.all([this.index('version'), this.index('deleted-version')]);
    return [...new Map([...live, ...history].map(file => [file.id, file])).values()];
  }
  removals(): Promise<DriveFile[]> {return this.index('deleted-collection');}
  private async index(type: 'version' | 'deleted-collection' | 'deleted-version'): Promise<DriveFile[]> {
    const files: DriveFile[] = []; let pageToken = '';
    const pages = new Set<string>();
    do {
      const result = await this.transport.api('files', {q: (type === 'version' ? 'trashed = false and ' : '') + "appProperties has { key='orbit' and value='v1' } and appProperties has { key='type' and value='" + type + "' }", fields: 'nextPageToken,incompleteSearch,files(' + fields + ')', pageSize: '100', orderBy: 'createdTime desc', ...(pageToken ? {pageToken} : {})}) as {files?: unknown[]; nextPageToken?: string; incompleteSearch?: boolean};
      if (!Array.isArray(result.files) || result.incompleteSearch) throw new Error('Drive 備份清單未完整取得，已停止同步。');
      files.push(...result.files.map(value => type === 'version' ? readDriveFile(value) : this.removedFile(value)));
      pageToken = result.nextPageToken ?? '';
      if (pageToken && (pages.has(pageToken) || pages.size >= 100)) throw new Error('Drive 備份清單過長或分頁異常，已停止同步。');
      pages.add(pageToken);
    } while (pageToken);
    return files;
  }
  private removedFile(value: unknown): DriveFile {
    const raw = value as {appProperties?: Record<string, string>; trashed?: boolean};
    if (!['deleted-collection', 'deleted-version'].includes(raw?.appProperties?.['type'] ?? '') || raw.trashed !== true) throw new Error('Drive 刪除紀錄不完整，已停止操作。');
    return readDriveFile({...raw, appProperties: {...raw.appProperties, type: 'version'}});
  }
  async assertAvailable(datasetId: string): Promise<void> {
    if ((await this.removals()).some(file => file.cloud.datasetId === datasetId)) throw new DriveCollectionDeleted(datasetId);
  }
  async planCollection(datasetId: string): Promise<DriveDeletePlan> {
    const [versions, removed] = await Promise.all([this.list(), this.removals()]);
    const files = new Map([...versions, ...removed].filter(file => file.cloud.datasetId === datasetId).map(file => [file.id, file]));
    return {kind: 'collection', datasetId, files: [...files.values()]};
  }
  /** Preserve one trashed file as a deletion marker so other devices cannot revive the collection. */
  async trashCollection(plan: DriveDeletePlan, current: () => boolean, beforeDelete: () => Promise<void>): Promise<number> {
    const check = () => {if (!current()) throw new Error('Drive 連線或設定已變更，刪除已停止。');};
    check();
    if (plan.kind !== 'collection' || plan.files.some(file => file.cloud.datasetId !== plan.datasetId)) throw new Error('集合刪除範圍不完整，請重新確認。');
    const fresh = await this.planCollection(plan.datasetId); check();
    const expected = new Map(plan.files.map(file => [file.id, file]));
    if (fresh.files.some(file => !expected.has(file.id) || file.kind !== expected.get(file.id)!.kind || canonical(file.cloud) !== canonical(expected.get(file.id)!.cloud))) throw new Error('確認期間雲端集合已更新，請重新載入並確認刪除範圍。');
    await beforeDelete(); check(); let count = 0, marked = false;
    const marker = fresh.files.find(file => !file.trashed && !file.cloud.parents.length) ?? fresh.files.find(file => !file.trashed) ?? fresh.files[0];
    const ordered = marker ? [marker, ...fresh.files.filter(file => file.id !== marker.id)] : [];
    for (const file of ordered) {
      check();
      let raw: {id: string; appProperties: Record<string, string>; trashed?: boolean};
      try {raw = await this.transport.api('files/' + file.id, {fields}) as typeof raw;}
      catch (error) {if (error instanceof GoogleHttpError && error.status === 404) continue; throw error;}
      check();
      const latest = raw.appProperties?.['type'] === 'version' ? readDriveFile(raw) : this.removedFile(raw);
      if (latest.id !== file.id || latest.kind !== file.kind || canonical(latest.cloud) !== canonical(file.cloud)) throw new Error('刪除期間檔案版本已變更，請重新確認後繼續。');
      if (raw.appProperties['type'] === 'deleted-collection') marked = true;
      if (raw.trashed && marked) continue;
      const response = await this.transport.api('files/' + file.id, {fields: 'id,trashed'}, {method: 'PATCH', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({trashed: true, ...(!marked ? {appProperties: {...raw.appProperties, type: 'deleted-collection'}} : {})})}) as {id?: string; trashed?: boolean};
      check();
      if (response.id !== file.id || response.trashed !== true) throw new Error('Drive 未確認檔案已移至垃圾桶，請重新載入後繼續。');
      marked = true; if (!raw.trashed) count++;
    }
    const remaining = (await this.list()).filter(file => !file.trashed && file.cloud.datasetId === plan.datasetId); check();
    if (remaining.length) throw new Error('集合仍有未刪除的雲端版本，請重新確認後繼續刪除。');
    return count;
  }
  async generateId(): Promise<string> {
    const result = await this.transport.api('files/generateIds', {count: '1', space: 'drive', type: 'files'}) as {ids?: string[]};
    if (!validDriveId(result.ids?.[0])) throw new Error('Drive 未提供可用的檔案識別碼。');
    return result.ids![0];
  }
  async read(file: DriveFile): Promise<DriveDocument> {
    const value = await this.transport.api('files/' + file.id, {alt: 'media'});
    if (new TextEncoder().encode(JSON.stringify(value)).length > 20 * 1024 * 1024) throw new Error('Drive 備份超過 20 MB。');
    const document = await readDriveDocument(value);
    if (document.cloud.fileHash !== file.cloud.fileHash || document.cloud.versionId !== file.cloud.versionId || document.cloud.datasetId !== file.cloud.datasetId
      || JSON.stringify(document.cloud.parents) !== JSON.stringify(file.cloud.parents) || document.cloud.formatVersion !== file.cloud.formatVersion || document.cloud.syncHash !== file.cloud.syncHash || document.kind !== file.kind || document.cloud.purpose !== file.cloud.purpose) throw new Error('Drive 檔案內容與版本索引不符，未套用資料。');
    return document;
  }
  private async folder(type = 'folder', name = 'IIH Orbit', parent?: string, current: () => boolean = () => true): Promise<string> {
    const check = () => {if (!current()) throw new Error('Drive 連線或設定已變更，檔案整理已停止。');};
    check();
    if (parent !== undefined && !validDriveId(parent)) throw new Error('Drive 資料夾識別碼不合法。');
    const result = await this.transport.api('files', {q: "trashed = false and mimeType = 'application/vnd.google-apps.folder' and appProperties has { key='orbit' and value='v1' } and appProperties has { key='type' and value='" + type + "' }" + (parent ? " and '" + parent + "' in parents" : ''), fields: 'nextPageToken,incompleteSearch,files(id)', orderBy: 'createdTime', pageSize: '100'}) as {files?: {id: string}[]; nextPageToken?: string; incompleteSearch?: boolean};
    if (!Array.isArray(result.files) || result.incompleteSearch || result.nextPageToken || result.files.some(f => !validDriveId(f.id))) throw new Error('Drive 資料夾清單不完整，未建立重複資料夾。');
    const id = result.files?.[0]?.id;
    check(); if (validDriveId(id)) return id;
    const generated = await this.generateId();
    check();
    const created = await this.transport.api('files', {fields: 'id'}, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({id: generated, name, mimeType: 'application/vnd.google-apps.folder', ...(parent ? {parents: [parent]} : {}), appProperties: {orbit: 'v1', type}})}) as {id?: string};
    if (created.id !== generated) throw new Error('Drive 資料夾建立失敗。');
    return created.id;
  }
  private async destination(purpose: DriveDocument['cloud']['purpose'], historical = false, cache = new Map<string, string>(), current: () => boolean = () => true): Promise<string> {
    const get = async (type: string, name: string, parent?: string): Promise<string> => {
      const key = type + ':' + (parent ?? '');
      if (!cache.has(key)) cache.set(key, await this.folder(type, name, parent, current));
      return cache.get(key)!;
    };
    const root = await get('folder', 'IIH Orbit');
    if (purpose === 'sync' && !historical) return get('sync-folder', '同步資料', root);
    const history = await get('history-folder', '歷史備份', root);
    return get(purpose + '-history-folder', purpose === 'sync' ? '同步歷史' : purposeNames[purpose], history);
  }
  /** Move metadata only. All immutable content, IDs and ancestry remain available to synchronization. */
  async organize(current: () => boolean = () => true, datasetId?: string): Promise<{files: DriveFile[]; changed: number}> {
    const files = await this.list(), groups = new Map<string, DriveFile[]>(), historical = new Set<string>();
    const check = () => {if (!current()) throw new Error('Drive 連線或設定已變更，檔案整理已停止。');};
    check(); const removed = new Set((await this.removals()).map(file => file.cloud.datasetId)); check();
    for (const file of files) {
      const group = groups.get(file.cloud.datasetId) ?? []; group.push(file); groups.set(file.cloud.datasetId, group);
    }
    // Validate all graphs before moving anything; concurrent branches must both remain visible.
    for (const group of groups.values()) {
      const heads = new Set(versionGraph(group).heads.map(f => f.cloud.versionId));
      group.filter(f => !heads.has(f.cloud.versionId)).forEach(f => historical.add(f.id));
    }
    const cache = new Map<string, string>(); let changed = 0;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.trashed || !file.size || removed.has(file.cloud.datasetId) || (datasetId && file.cloud.datasetId !== datasetId)) continue;
      check();
      const target = await this.destination(file.cloud.purpose, historical.has(file.id), cache, current); check();
      if (file.folderIds?.includes(target) && file.name === readableName(file) && (file.summary || historical.has(file.id))) continue;
      const latest = readDriveFile(await this.transport.api('files/' + file.id, {fields})); check();
      if (canonical(latest.cloud) !== canonical(file.cloud) || latest.kind !== file.kind || latest.size !== file.size) throw new Error('Drive 版本已變更，檔案整理已停止。');
      let properties: Record<string, string> | undefined;
      // Enrich just legacy collection heads, rather than downloading the entire history.
      if (!latest.summary && !historical.has(file.id)) {
        properties = versionProperties(await this.read(latest)); check();
        latest.summary = {label: properties['label'], workspaces: +properties['counts'].split('/')[0], tasks: +properties['counts'].split('/')[1]};
      }
      const name = readableName(latest), previous = latest.folderIds ?? [];
      const move = !previous.includes(target);
      if (!move && latest.name === name && !properties) {files[i] = latest; continue;}
      check();
      const updated = readDriveFile(await this.transport.api('files/' + file.id, {fields, ...(move ? {addParents: target, ...(previous.length ? {removeParents: previous.join(',')} : {})} : {})}, {method: 'PATCH', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({name, ...(properties ? {appProperties: properties} : {})})}));
      check();
      if (updated.id !== file.id || canonical(updated.cloud) !== canonical(file.cloud) || updated.kind !== file.kind || updated.size !== file.size || !updated.folderIds?.includes(target)) throw new Error('Drive 整理結果不符，請重新載入清單。');
      files[i] = updated; changed++;
    }
    check(); return {files, changed};
  }
  /** Retry a queued upload using its pre-generated file ID, never create duplicate versions. */
  async save(document: DriveDocument, id: string): Promise<DriveFile> {
    if (!validDriveId(id)) throw new Error('Drive 檔案識別碼不合法。');
    const data = JSON.stringify(await readDriveDocument(document));
    const bytes = new TextEncoder().encode(data).length;
    if (bytes > 20 * 1024 * 1024) throw new Error('備份超過 20 MB，請減少工作空間範圍。');
    await this.assertAvailable(document.cloud.datasetId);
    if (document.cloud.parents.length) {
      const versions = (await this.list()).filter(file => file.cloud.datasetId === document.cloud.datasetId);
      if (document.cloud.parents.some(parent => !versions.some(file => file.cloud.versionId === parent))) throw new DriveCollectionDeleted(document.cloud.datasetId);
    }
    const verify = (saved: DriveFile): DriveFile => {
      if (saved.id !== id || canonical(saved.cloud) !== canonical(document.cloud)) throw new Error('Drive 回傳的上傳結果不符，待上傳版本仍保留。');
      return saved;
    };
    // An interrupted resumable creation can expose an empty file. Complete only this
    // queued identity with identical version metadata; never rewrite a completed version.
    const completeEmpty = async (file: DriveFile): Promise<DriveFile> => {
      verify(file);
      const response = await this.transport.upload(base + '/' + id + '?uploadType=media&fields=' + encodeURIComponent(fields), {method: 'PATCH', headers: {'Content-Type': 'application/json'}, body: data});
      return verify(readDriveFile(await response.json()));
    };
    try {
      const existing = readDriveFile(await this.transport.api('files/' + id, {fields}));
      if (existing.trashed) throw new DriveCollectionDeleted(document.cloud.datasetId);
      if (existing.size === 0) return await completeEmpty(existing);
      const checked = await this.read(existing);
      if (canonical(checked.cloud) !== canonical(document.cloud)) throw new Error('待上傳識別碼已被其他內容使用，未覆蓋任何版本。');
      return existing;
    } catch (error) { if (!(error instanceof GoogleHttpError) || error.status !== 404) throw error; }
    const properties = versionProperties(document);
    const metadata = {id, name: readableName({cloud: document.cloud, kind: document.kind, createdTime: document.exportedAt, summary: {label: properties['label']}}), mimeType: 'application/json', parents: [await this.destination(document.cloud.purpose)], appProperties: properties};
    await this.assertAvailable(document.cloud.datasetId);
    try {
      let response: Response;
      if (bytes <= 5 * 1024 * 1024) {
        const boundary = 'orbit_' + crypto.randomUUID();
        const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${data}\r\n--${boundary}--`;
        response = await this.transport.upload(base + '?uploadType=multipart&fields=' + encodeURIComponent(fields), {method: 'POST', headers: {'Content-Type': 'multipart/related; boundary=' + boundary}, body});
      } else {
        const session = await this.transport.upload(base + '?uploadType=resumable&fields=' + encodeURIComponent(fields), {method: 'POST', headers: {'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'application/json', 'X-Upload-Content-Length': String(bytes)}, body: JSON.stringify(metadata)});
        const location = session.headers.get('Location');
        if (!location) throw new Error('Drive 未提供上傳連線，待上傳版本仍保留。');
        const target = new URL(location);
        if (target.origin !== 'https://www.googleapis.com' || target.pathname !== '/upload/drive/v3/files') throw new Error('Drive 上傳連線位址不合法。');
        response = await this.transport.upload(location, {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: data});
      }
      return verify(readDriveFile(await response.json()));
    } catch (error) {
      if (!(error instanceof GoogleHttpError) || error.status !== 409) throw error;
      const existing = readDriveFile(await this.transport.api('files/' + id, {fields}));
      if (existing.trashed) throw new DriveCollectionDeleted(document.cloud.datasetId);
      if (existing.size === 0) return completeEmpty(existing);
      const checked = await this.read(existing);
      if (canonical(checked.cloud) !== canonical(document.cloud)) throw new Error('Drive 版本已存在但內容不同，未覆蓋任何檔案。');
      return existing;
    }
  }
  async pruneHistory(current: () => boolean = () => true, protectedVersions: string[] = []): Promise<{files: DriveFile[]; removed: number}> {
    const check = () => {if (!current()) throw new Error('Drive 連線或設定已變更，自動清理已停止。');};
    check();
    const [files, removals] = await Promise.all([this.list(), this.removals()]); check();
    const expired = expiredDriveVersions(files, protectedVersions, removals.map(file => file.cloud.datasetId));
    if (!expired.length) return {files, removed: 0};
    let removed = 0;
    for (const file of expired) {if (await this.moveToTrash(file, current, undefined, protectedVersions)) removed++;}
    const remaining = await this.list(); check();
    return {files: remaining, removed};
  }
  async trash(file: DriveFile, current: () => boolean = () => true, branchHeads?: string[]): Promise<void> {await this.moveToTrash(file, current, branchHeads);}
  private async moveToTrash(file: DriveFile, current: () => boolean, branchHeads?: string[], protectedVersions?: string[]): Promise<boolean> {
    const check = () => {if (!current()) throw new Error('Drive 連線或設定已變更，刪除已停止。');};
    check();
    const raw = await this.transport.api('files/' + file.id, {fields}) as {appProperties?: Record<string, string>};
    check();
    const latest = raw.appProperties?.['type'] === 'version' ? readDriveFile(raw) : this.removedFile(raw);
    if (latest.id !== file.id || canonical(latest.cloud) !== canonical(file.cloud) || latest.kind !== file.kind) throw new Error('這份備份已變更，請重新載入後確認。');
    if (latest.trashed) return false;
    const automatic = latest.cloud.purpose !== 'manual';
    if (automatic) {
      await this.assertAvailable(latest.cloud.datasetId); check();
      const files = (await this.list()).filter(value => value.cloud.datasetId === latest.cloud.datasetId); check();
      const heads = versionGraph(files).heads;
      if (protectedVersions && !expiredDriveVersions(files, protectedVersions).some(value => value.id === latest.id)) return false;
      if (branchHeads && (heads.length < 2 || !heads.some(head => head.id === latest.id) || canonical(heads.map(head => head.cloud.versionId).sort()) !== canonical([...branchHeads].sort()))) throw new Error('確認期間待選擇的雲端內容已變更，請重新載入並確認刪除。');
      if (!files.some(value => value.id === latest.id) || !branchHeads && heads.some(head => head.id === latest.id)) throw new Error('這是目前的雲端資料。若要刪除，請選「刪除這份雲端資料」，過去的備份才可逐份刪除。');
    }
    // Keep ancestry in trashed metadata so removing a backup or branch does not
    // split synchronization history or turn older content into a new head.
    const result = await this.transport.api('files/' + file.id, {fields}, {method: 'PATCH', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({trashed: true, ...(automatic ? {appProperties: {...raw.appProperties, type: 'deleted-version'}} : {})})}) as {id?: string; trashed?: boolean; appProperties?: Record<string, string>};
    check();
    if (result.id !== file.id || result.trashed !== true) throw new Error('Drive 未確認這份備份已移至垃圾桶，請重新載入後確認。');
    if (automatic && canonical(this.removedFile(result).cloud) !== canonical(file.cloud)) throw new Error('Drive 刪除紀錄不符，請重新載入後確認。');
    return true;
  }
}
