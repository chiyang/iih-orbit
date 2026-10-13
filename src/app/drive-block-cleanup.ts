import { canonical, readDriveFile, validDriveId, type DriveFile, type DriveVersion } from './drive-data.ts';
import { readManifest, type BackupManifest } from './backup-blocks.ts';
import type { DriveTransport } from './drive-api.ts';

export const BLOCK_OBSERVATION_MS = 30 * 24 * 60 * 60 * 1000;
export const BLOCK_CLEANUP_BATCH = 20;
export const BLOCK_FIELDS = 'id,name,mimeType,createdTime,modifiedTime,size,trashed,appProperties,sha256Checksum';
export interface CloudBlockFile {
  id: string; name: string; mimeType: string; createdTime: string; modifiedTime: string; size: string;
  trashed?: boolean; appProperties: Record<string, string>; sha256Checksum?: string;
}
export interface UploadIntent {application: 'iih-orbit-upload'; formatVersion: 1; cloud: DriveVersion; blocks: string[]; attempt: string}
export interface BlockCleanupResult {observed: number; removed: number; remaining: boolean}
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const token = (value: unknown): boolean => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
export const blockKey = (dataset: string, id: string): string => dataset + ':' + id;
export function manifestReferences(manifest: BackupManifest): {id: string; hash: string}[] {
  return manifest.state.workspaces.flatMap(workspace => [workspace.metadata, ...workspace.tasks]);
}
export function readCloudBlock(value: unknown): CloudBlockFile {
  const file = value as CloudBlockFile, p = file?.appProperties;
  if (!file || !validDriveId(file.id) || file.mimeType !== 'application/json' || !p || p['orbit'] !== 'v1'
    || !['block', 'orphan-block'].includes(p['type']) || !token(p['dataset']) || !hash(p['hash'])
    || !Number.isSafeInteger(Number(file.size)) || Number(file.size) < 0 || Number(file.size) > 20 * 1024 * 1024
    || typeof file.createdTime !== 'string' || typeof file.modifiedTime !== 'string' || !Number.isFinite(Date.parse(file.createdTime)) || !Number.isFinite(Date.parse(file.modifiedTime))
    || p['type'] === 'orphan-block' && (!token(p['gcToken']) || typeof p['gcSince'] !== 'string' || !Number.isFinite(Date.parse(p['gcSince'])) || p['gcReferenced'] !== undefined && p['gcReferenced'] !== '1')) throw new Error('雲端區塊清單不完整，回收已停止。');
  return file;
}

/** Quarantine removes blocks from reuse before the 30-day clock starts. Contents stay immutable. */
export class DriveBlockCleanup {
  private readonly transport: DriveTransport;
  private readonly versions: () => Promise<DriveFile[]>;
  private readonly serverTime: (check: () => void) => Promise<number>;
  constructor(transport: DriveTransport, versions: () => Promise<DriveFile[]>, serverTime: (check: () => void) => Promise<number>) {this.transport = transport; this.versions = versions; this.serverTime = serverTime;}
  async entries(type: 'block' | 'orphan-block' | 'pending-version', check: () => void): Promise<CloudBlockFile[]> {
    const files: CloudBlockFile[] = [], pages = new Set<string>(); let pageToken = '';
    do {
      check();
      const result = await this.transport.api('files', {q: "trashed = false and appProperties has { key='orbit' and value='v1' } and appProperties has { key='type' and value='" + type + "' }", fields: 'nextPageToken,incompleteSearch,files(' + BLOCK_FIELDS + ')', pageSize: '1000', ...(pageToken ? {pageToken} : {})}) as {files?: CloudBlockFile[]; nextPageToken?: string; incompleteSearch?: boolean};
      check();
      if (!Array.isArray(result.files) || result.incompleteSearch) throw new Error('雲端區塊清單未完整取得，回收已停止。');
      for (const raw of result.files) {
        if (raw?.trashed || raw?.appProperties?.['type'] !== type) throw new Error('雲端回收索引不符，未移除任何區塊。');
        if (type === 'pending-version') {
          readDriveFile({...raw, appProperties: {...raw.appProperties, type: 'version'}});
          if (!Number.isFinite(Date.parse(raw.modifiedTime))) throw new Error('待上傳版本的時間不完整，回收已停止。');
          files.push(raw);
        } else files.push(readCloudBlock(raw));
      }
      pageToken = result.nextPageToken ?? '';
      if (pageToken && (pages.has(pageToken) || pages.size >= 100)) throw new Error('區塊回收分頁異常，未移除任何區塊。');
      pages.add(pageToken);
    } while (pageToken);
    return files;
  }
  private async references(check: () => void, now: number): Promise<{ids: Set<string>; hashes: Set<string>; datasets: Set<string>}> {
    const [versions, pending] = await Promise.all([this.versions(), this.entries('pending-version', check)]); check();
    const ids = new Set<string>(), hashes = new Set<string>(), datasets = new Set<string>();
    for (const file of versions) {
      if (file.cloud.formatVersion !== 5) continue;
      if (!file.size) {if (now - Date.parse(file.createdTime) < BLOCK_OBSERVATION_MS) datasets.add(file.cloud.datasetId); continue;}
      const manifest = readManifest(await this.transport.api('files/' + file.id, {alt: 'media'}), file.cloud); check();
      for (const ref of manifestReferences(manifest)) ids.add(blockKey(file.cloud.datasetId, ref.id));
    }
    for (const raw of pending) {
      if (now - Date.parse(raw.modifiedTime) >= BLOCK_OBSERVATION_MS) continue;
      const file = readDriveFile({...raw, appProperties: {...raw.appProperties, type: 'version'}});
      if (!file.size) {datasets.add(file.cloud.datasetId); continue;}
      const body = await this.transport.api('files/' + raw.id, {alt: 'media'}) as UploadIntent | BackupManifest; check();
      if (body?.application === 'iih-orbit-chunked') {
        for (const ref of manifestReferences(readManifest(body, file.cloud))) hashes.add(blockKey(file.cloud.datasetId, ref.hash));
      } else {
        if (!body || body.application !== 'iih-orbit-upload' || body.formatVersion !== 1 || canonical(body.cloud) !== canonical(file.cloud)
          || !Array.isArray(body.blocks) || body.blocks.length > 650000 || !body.blocks.every(hash)) throw new Error('待上傳區塊保護名單不完整，回收已停止。');
        for (const value of body.blocks) hashes.add(blockKey(file.cloud.datasetId, value));
      }
    }
    return {ids, hashes, datasets};
  }
  async collect(current: () => boolean = () => true, time?: number): Promise<BlockCleanupResult> {
    const check = () => {if (!current()) throw new Error('Drive 連線或設定已變更，區塊回收已停止。');};
    check();
    let now = time ?? await this.serverTime(check); check();
    if (!Number.isFinite(now)) throw new Error('Drive 觀察時間不完整，區塊回收已停止。');
    const [active, orphans] = await Promise.all([this.entries('block', check), this.entries('orphan-block', check)]);
    let usage = await this.references(check, now), observed = 0, removed = 0, remaining = false;
    if (time === undefined) {now = await this.serverTime(check); check();}
    const protectedBlock = (file: CloudBlockFile): boolean => usage.datasets.has(file.appProperties['dataset'])
      || usage.ids.has(blockKey(file.appProperties['dataset'], file.id)) || usage.hashes.has(blockKey(file.appProperties['dataset'], file.appProperties['hash']));
    const changed = async (file: CloudBlockFile, referenced: boolean): Promise<void> => {
      check();
      const latest = readCloudBlock(await this.transport.api('files/' + file.id, {fields: BLOCK_FIELDS})); check();
      if (latest.trashed || latest.appProperties['type'] !== file.appProperties['type'] || latest.appProperties['hash'] !== file.appProperties['hash']
        || latest.appProperties['dataset'] !== file.appProperties['dataset'] || latest.appProperties['gcToken'] !== file.appProperties['gcToken']) return;
      const properties = {...latest.appProperties, type: 'orphan-block', gcToken: crypto.randomUUID(), gcSince: new Date(now).toISOString(), gcReferenced: referenced ? '1' : null};
      const saved = readCloudBlock(await this.transport.api('files/' + file.id, {fields: BLOCK_FIELDS}, {method: 'PATCH', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({appProperties: properties})})); check();
      if (saved.id !== file.id || saved.trashed || saved.appProperties['gcToken'] !== properties.gcToken || saved.appProperties['gcSince'] !== properties.gcSince || saved.appProperties['gcReferenced'] !== (referenced ? '1' : undefined)) throw new Error('區塊觀察記錄未確認，下次閒置時重試。');
      observed++;
    };
    // Bound metadata mutations as well as trash moves, keeping maintenance interruptible.
    for (const file of [...active, ...orphans]) {
      check(); const referenced = protectedBlock(file), p = file.appProperties;
      if (p['type'] === 'block' ? !referenced : referenced ? p['gcReferenced'] !== '1' : p['gcReferenced'] === '1') {
        if (observed >= 100) {remaining = true; continue;}
        await changed(file, referenced);
      }
    }
    const expired = orphans.filter(file => !protectedBlock(file) && file.appProperties['gcReferenced'] !== '1' && now - Date.parse(file.appProperties['gcSince']) >= BLOCK_OBSERVATION_MS);
    if (expired.length) usage = await this.references(check, now);
    for (const file of expired) {
      check();
      if (protectedBlock(file)) {if (observed >= 100) remaining = true; else await changed(file, true); continue;}
      if (removed >= BLOCK_CLEANUP_BATCH) {remaining = true; break;}
      const latest = readCloudBlock(await this.transport.api('files/' + file.id, {fields: BLOCK_FIELDS})); check();
      if (latest.trashed || latest.appProperties['type'] !== 'orphan-block' || latest.appProperties['gcReferenced'] === '1'
        || latest.appProperties['gcToken'] !== file.appProperties['gcToken'] || latest.appProperties['dataset'] !== file.appProperties['dataset']
        || latest.appProperties['hash'] !== file.appProperties['hash'] || now - Date.parse(latest.appProperties['gcSince']) < BLOCK_OBSERVATION_MS) continue;
      const result = await this.transport.api('files/' + file.id, {fields: 'id,trashed'}, {method: 'PATCH', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({trashed: true})}) as {id?: string; trashed?: boolean}; check();
      if (result.id !== file.id || result.trashed !== true) throw new Error('Drive 未確認區塊已移至垃圾桶，下次閒置時重試。');
      removed++;
    }
    return {observed, removed, remaining};
  }
}
