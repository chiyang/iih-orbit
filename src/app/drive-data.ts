import { readBackup, type BackupKind, type OrbitBackup } from './backup-data.ts';
import { DEFAULT_APPEARANCE, sharedAppearance } from './appearance-data.ts';
export { DEFAULT_DRIVE, readDriveSettings, type DriveSettings } from './drive-settings.ts';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const DRIVE_SESSION_KEY = 'iih-orbit-drive-session-v1';
export const DRIVE_CONTROL_PREFIX = 'iih-orbit-drive-session-control-v1:';
export interface DriveVersion {
  formatVersion: 1 | 2 | 3 | 4;
  datasetId: string;
  versionId: string;
  parents: string[];
  purpose: 'manual' | 'backup' | 'sync';
  fileHash: string;
  syncHash: string;
}
export type DriveDocument = OrbitBackup & {cloud: DriveVersion};
export interface DriveFile {
  id: string; name: string; createdTime: string; size: number; cloud: DriveVersion; kind: BackupKind;
  folderIds?: string[];
  summary?: {label: string; workspaces: number; tasks: number};
  trashed?: boolean;
}
export interface DriveDeletePlan {kind: 'file' | 'collection'; datasetId: string; files: DriveFile[]}
export class DriveCollectionDeleted extends Error {
  readonly datasetId: string;
  constructor(datasetId: string) {super('這份雲端資料已刪除或缺少必要的備份。本機資料保留，請在遠端同步備份設定清除舊連結後重新開始自動儲存。'); this.datasetId = datasetId;}
}
export interface DriveLink {datasetId: string; kind: BackupKind; workspaceIds: string[]; baseVersionId: string; baseHash: string; baseHashVersion?: 1 | 2 | 3 | 4; baseBackupHash?: string}
export interface DrivePending {fileId: string; document: DriveDocument}
export interface DriveRuntime {link?: DriveLink; pending?: DrivePending; conflict?: string[]; lastSavedAt?: string; base?: DriveDocument; mergeBase?: DriveDocument}
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const validDriveId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{5,200}$/.test(value);

export function readVersion(value: unknown): DriveVersion {
  const v = value as DriveVersion;
  if (!v || ![1, 2, 3, 4].includes(v.formatVersion) || !uuid(v.datasetId) || !uuid(v.versionId) || !Array.isArray(v.parents) || v.parents.length > 20
    || v.parents.some(id => !uuid(id) || id === v.versionId) || new Set(v.parents).size !== v.parents.length
    || !['manual', 'backup', 'sync'].includes(v.purpose) || !hash(v.fileHash) || !hash(v.syncHash)) throw new Error('Drive 版本資料不完整，原有資料保留。');
  return {formatVersion: v.formatVersion, datasetId: v.datasetId, versionId: v.versionId, parents: [...v.parents], purpose: v.purpose, fileHash: v.fileHash, syncHash: v.syncHash};
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}
export async function checksum(value: unknown): Promise<string> {
  const result = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return [...new Uint8Array(result)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
/** Backup changes include all exported settings, but not timestamps or per-tab selection. */
export async function backupHash(input: OrbitBackup): Promise<string> {
  const backup = readBackup(input);
  const {appVersion, exportedAt, data, ...content} = backup;
  return checksum({...content, ...(backup.preferences ? {preferences: sharedAppearance(backup.preferences)} : {}), data: {version: data.version, workspaces: data.workspaces}});
}
/** Keep legacy checksums unchanged; version 4 excludes theme and font size. */
export async function syncHash(backup: OrbitBackup, formatVersion: 1 | 2 | 3 | 4 = 4): Promise<string> {
  const sources = backup.kind === 'full' ? backup.google?.sources ?? [] : backup.calendarSources ?? [];
  if (formatVersion >= 2) {
    const calendars = new Map<string, Omit<(typeof sources)[number], 'id'>>();
    for (const source of sources) {
      if (!source.workspaceIds.length) continue;
      const {id, ...calendar} = source, key = JSON.stringify([source.accountId, source.calendarId]);
      const previous = calendars.get(key);
      calendars.set(key, {...calendar, workspaceIds: [...new Set([...(previous?.workspaceIds ?? []), ...source.workspaceIds])].sort()});
    }
    const preferences = backup.preferences && (formatVersion === 4 ? sharedAppearance(backup.preferences)
      : formatVersion === 3 ? {theme: backup.preferences.theme ?? DEFAULT_APPEARANCE.theme, accent: backup.preferences.accent} : backup.preferences);
    return checksum({kind: backup.kind, workspaces: backup.data.workspaces,
      sources: [...calendars].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, source]) => source),
      ...(backup.kind === 'full' ? {preferences, reminders: backup.reminders, refreshMinutes: backup.google?.refreshMinutes} : {})});
  }
  const groups = new Map<string, Set<string>>();
  for (const source of sources) {
    const key = JSON.stringify([source.accountId, source.calendarId]);
    const ids = groups.get(key) ?? new Set<string>();
    source.workspaceIds.forEach(id => ids.add(id)); groups.set(key, ids);
  }
  const bindings = [...groups].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([calendar, ids]) => ({calendar, workspaceIds: [...ids].sort()}));
  return checksum({kind: backup.kind, workspaces: backup.data.workspaces, bindings});
}
export async function createDriveDocument(input: OrbitBackup, datasetId: string = crypto.randomUUID(), parents: string[] = [], purpose: DriveVersion['purpose'] = 'manual'): Promise<DriveDocument> {
  const backup = readBackup(input);
  const content = {...backup, ...(backup.preferences ? {preferences: sharedAppearance(backup.preferences)} : {})};
  const cloud = readVersion({formatVersion: 4, datasetId, versionId: crypto.randomUUID(), parents, purpose, fileHash: await checksum(content), syncHash: await syncHash(content)});
  return {...content, cloud};
}
export async function readDriveDocument(value: unknown): Promise<DriveDocument> {
  const backup = readBackup(value), cloud = readVersion((value as DriveDocument).cloud);
  if (await checksum(backup) !== cloud.fileHash || await syncHash(backup, cloud.formatVersion) !== cloud.syncHash) throw new Error('Drive 備份校驗不符，未套用這份資料。');
  return {...backup, cloud};
}
export function versionProperties(document: DriveDocument): Record<string, string> {
  const v = document.cloud;
  const summary = driveSummary(document);
  // Eight identity properties + two summaries + at most twenty parents fit Drive's 30-property limit.
  return {orbit: 'v1', type: 'version', dataset: v.datasetId, version: v.versionId, hash: v.fileHash, syncHash: v.formatVersion >= 2 ? 'v' + v.formatVersion + ':' + v.syncHash : v.syncHash, purpose: v.purpose, kind: document.kind, label: summary.label, counts: summary.workspaces + '/' + summary.tasks, ...Object.fromEntries(v.parents.map((id, i) => ['p' + i, id]))};
}
export function driveSummary(document: DriveDocument): NonNullable<DriveFile['summary']> {
  const workspaces = document.data.workspaces;
  const name = document.kind === 'full' ? '全部資料' : workspaces.map(w => w.name).join('、');
  const encoder = new TextEncoder(); let label = '', bytes = 0;
  for (const character of name) {
    const size = encoder.encode(character).length;
    if (bytes + size > 116) {label += '…'; break;}
    label += character; bytes += size;
  }
  return {label, workspaces: workspaces.length, tasks: workspaces.reduce((sum, w) => sum + w.tasks.length, 0)};
}
export function readDriveFile(value: unknown): DriveFile {
  const f = value as {id: string; name: string; mimeType: string; createdTime: string; size?: string; parents?: string[]; trashed?: boolean; appProperties: Record<string, string>};
  const p = f?.appProperties;
  if (!validDriveId(f?.id) || typeof f.name !== 'string' || f.mimeType !== 'application/json' || !Number.isFinite(Date.parse(f.createdTime))
    || !p || p['orbit'] !== 'v1' || p['type'] !== 'version' || !['full', 'workspaces'].includes(p['kind'])) throw new Error('無法辨識這份 Drive 備份。');
  const parents: string[] = [];
  for (let i = 0; i < 20; i++) if (p['p' + i]) parents.push(p['p' + i]);
  const formatVersion = p['syncHash']?.startsWith('v4:') ? 4 : p['syncHash']?.startsWith('v3:') ? 3 : p['syncHash']?.startsWith('v2:') ? 2 : 1;
  const cloud = readVersion({formatVersion, datasetId: p['dataset'], versionId: p['version'], parents, purpose: p['purpose'], fileHash: p['hash'], syncHash: formatVersion >= 2 ? p['syncHash'].slice(3) : p['syncHash']});
  const size = Number(f.size ?? 0);
  if (!Number.isSafeInteger(size) || size < 0 || size > 20 * 1024 * 1024) throw new Error('Drive 備份超過 20 MB，請使用較小的工作空間集合。');
  if (f.parents !== undefined && (!Array.isArray(f.parents) || f.parents.some(id => !validDriveId(id)))) throw new Error('Drive 檔案資料夾索引不完整。');
  if (f.trashed !== undefined && typeof f.trashed !== 'boolean') throw new Error('Drive 檔案刪除狀態不完整。');
  const counts = /^(\d+)\/(\d+)$/.exec(p['counts'] ?? '');
  const summary = typeof p['label'] === 'string' && p['label'].trim() && new TextEncoder().encode('label' + p['label']).length <= 124 && counts
    && Number.isSafeInteger(+counts[1]) && Number.isSafeInteger(+counts[2]) ? {label: p['label'], workspaces: +counts[1], tasks: +counts[2]} : undefined;
  return {id: f.id, name: f.name, createdTime: f.createdTime, size, cloud, kind: p['kind'] as BackupKind, ...(f.parents ? {folderIds: [...f.parents]} : {}), ...(summary ? {summary} : {}), ...(f.trashed ? {trashed: true} : {})};
}
/** File dates cannot establish ancestry: use immutable parent identifiers. */
export function versionGraph(files: DriveFile[]): {heads: DriveFile[]; descendant: (child: string, ancestor: string) => boolean} {
  const versions = new Map<string, DriveFile>();
  for (const f of files) {
    const existing = versions.get(f.cloud.versionId);
    if (existing && canonical(existing.cloud) !== canonical(f.cloud)) throw new Error('Drive 中有互相矛盾的版本識別碼，已停止同步。');
    versions.set(f.cloud.versionId, f);
  }
  const complete = new Set<string>();
  for (const root of versions.keys()) {
    const active = new Set<string>(), stack: {id: string; exit: boolean}[] = [{id: root, exit: false}];
    while (stack.length) {
      const item = stack.pop()!;
      if (item.exit) {active.delete(item.id); complete.add(item.id); continue;}
      if (active.has(item.id)) throw new Error('Drive 版本關係有循環，已停止同步。');
      if (complete.has(item.id)) continue;
      active.add(item.id); stack.push({id: item.id, exit: true});
      for (const parent of versions.get(item.id)?.cloud.parents ?? []) stack.push({id: parent, exit: false});
    }
  }
  const descendant = (child: string, ancestor: string): boolean => {
    const visited = new Set<string>(), stack = [child];
    while (stack.length) { const id = stack.pop()!; if (id === ancestor) return true; if (visited.has(id)) continue; visited.add(id); stack.push(...versions.get(id)?.cloud.parents ?? []); }
    return false;
  };
  const parents = new Set(files.flatMap(f => f.cloud.parents));
  return {heads: [...versions.values()].filter(f => !f.trashed && !parents.has(f.cloud.versionId)), descendant};
}

export async function readDriveRuntime(value: unknown): Promise<DriveRuntime> {
  if (!value || typeof value !== 'object') throw new Error('Drive 本機狀態不完整。');
  const s = value as DriveRuntime, link = s.link;
  if (link && (!uuid(link.datasetId) || !['full', 'workspaces'].includes(link.kind) || !Array.isArray(link.workspaceIds)
    || link.workspaceIds.some(id => typeof id !== 'string' || !id || id.length > 200) || new Set(link.workspaceIds).size !== link.workspaceIds.length
    || (link.kind === 'full' && link.workspaceIds.length) || (link.kind === 'workspaces' && !link.workspaceIds.length)
    || (link.baseVersionId !== '' && !uuid(link.baseVersionId)) || (link.baseHash !== '' && !hash(link.baseHash))
    || (link.baseBackupHash !== undefined && !hash(link.baseBackupHash)) || (link.baseHashVersion !== undefined && ![1, 2, 3, 4].includes(link.baseHashVersion)))) throw new Error('Drive 同步基準不完整，請先保存本機備份。');
  if (s.conflict && (!link || !Array.isArray(s.conflict) || !s.conflict.length || s.conflict.length > 10000 || s.conflict.some(id => !uuid(id)) || new Set(s.conflict).size !== s.conflict.length)) throw new Error('Drive 分歧狀態不完整，請重新載入版本。');
  if (s.lastSavedAt !== undefined && (typeof s.lastSavedAt !== 'string' || !Number.isFinite(Date.parse(s.lastSavedAt)))) throw new Error('Drive 保存時間不完整。');
  if (s.pending && (typeof s.pending.fileId !== 'string' || (s.pending.fileId !== '' && !validDriveId(s.pending.fileId)))) throw new Error('Drive 待上傳識別碼不完整。');
  const cached: Pick<DriveRuntime, 'base' | 'mergeBase'> = {};
  for (const key of ['base', 'mergeBase'] as const) {
    if (!s[key]) continue;
    const document = await readDriveDocument(s[key]);
    if (!link || document.cloud.datasetId !== link.datasetId || document.kind !== link.kind
      || (link.kind === 'workspaces' && (document.data.workspaces.length !== link.workspaceIds.length || document.data.workspaces.some(workspace => !link.workspaceIds.includes(workspace.id))))
      || (key === 'base' && document.cloud.versionId !== link.baseVersionId)) throw new Error('Drive 整併基準不完整，原有資料保留。');
    if (key === 'base' && await syncHash(document, link.baseHashVersion ?? document.cloud.formatVersion) !== link.baseHash) throw new Error('Drive 整併基準校驗不符，原有資料保留。');
    cached[key] = document;
  }
  return {
    ...(link ? {link: {datasetId: link.datasetId, kind: link.kind, workspaceIds: [...link.workspaceIds], baseVersionId: link.baseVersionId, baseHash: link.baseHash, ...(link.baseHashVersion === undefined ? {} : {baseHashVersion: link.baseHashVersion}), ...(link.baseBackupHash === undefined ? {} : {baseBackupHash: link.baseBackupHash})}} : {}),
    ...(s.pending ? {pending: {fileId: s.pending.fileId, document: await readDriveDocument(s.pending.document)}} : {}),
    ...(s.conflict ? {conflict: [...s.conflict]} : {}), ...(s.lastSavedAt ? {lastSavedAt: s.lastSavedAt} : {}), ...cached
  };
}
