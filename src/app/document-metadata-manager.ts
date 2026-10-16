import type {DocumentSource} from './models.ts';
import {documentLocationSnapshot} from './document-data.ts';
import {DRIVE_FOLDER_MIME, DriveBrowserApi, sourceFromDriveEntry, type DriveBrowserEntry, type DriveBrowserFolder} from './drive-browser-data.ts';
import {GoogleHttpError} from './google-api.ts';

export const DOCUMENT_METADATA_TTL = 15 * 60000;
export const DOCUMENT_METADATA_BATCH = 20;
export type DocumentCheckStatus = 'available' | 'unverified' | 'offline' | 'authorization' | 'trashed' | 'unavailable' | 'limited' | 'error' | 'unsupported';
export interface MetadataConnection {
  id: string; key: string; label: string; available: boolean; version: number;
  api: Pick<DriveBrowserApi, 'get'>;
}
interface CachedNode {file: DriveBrowserEntry; at: number; pass: number}
interface CheckedDocument {
  documentId: string; file?: DriveBrowserEntry; status: DocumentCheckStatus; checkedAt: number; nextCheckAt: number;
  ancestors: string[]; invalidated?: boolean; pathNote?: string; resourceKey: string;
}
export interface DocumentMetadataView {
  source: DocumentSource; status: DocumentCheckStatus; label: string; connectionId?: string; connectionLabel?: string;
  checkedAt?: number; partialLocation?: boolean; pathNote?: string; stale: boolean; checking: boolean; retryAt?: number; alternate?: string;
}
interface NetworkJob {
  key: string; connection: MetadataConnection; id: string; resourceKey: string; controller: AbortController;
  resolve: (file: DriveBrowserEntry) => void; reject: (error: unknown) => void;
}
interface Pass {id: number; budget: number; force: boolean; epoch: number}
const key = (connection: string, id: string) => JSON.stringify([connection, id]);
const stopped = () => new DOMException('查驗已取消', 'AbortError');
const limited = (error: GoogleHttpError) => error.retryable || /limitexceeded|quotaexceeded|resourceexhausted/.test(error.reason.replaceAll('_', '').toLowerCase());
const reason = (error: GoogleHttpError) => error.reason.replaceAll('_', '').toLowerCase();
const authorizationFailure = (error: GoogleHttpError) => error.status === 401 || error.status === 403 && ['insufficientpermissions', 'accesstokenscopeinsufficient', 'autherror'].includes(reason(error));
const serviceFailure = (error: GoogleHttpError) => error.status === 403 && ['accessnotconfigured', 'servicedisabled', 'domainpolicy'].includes(reason(error));
const statusLabel: Record<DocumentCheckStatus, string> = {
  available: '可存取', unverified: '尚未查驗', offline: '離線，保留上次資訊', authorization: '來源需要重新授權',
  trashed: '已移至垃圾桶', unavailable: '可能已刪除或權限變更', limited: '配額或服務忙碌，稍後重試', error: '查驗未完成，保留上次資訊', unsupported: '此來源尚未提供主動查驗'
};

/** Rebuildable, account-scoped display data. No workspace, history or backup writes. */
export class DocumentMetadataManager {
  private connections: MetadataConnection[] = [];
  private readonly nodes = new Map<string, CachedNode>();
  private readonly nodeErrors = new Map<string, {error: unknown; until: number}>();
  private readonly checks = new Map<string, CheckedDocument>();
  private readonly roots = new Map<string, string>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly pending = new Map<string, Promise<DriveBrowserEntry>>();
  private readonly active = new Set<NetworkJob>();
  private readonly queue: NetworkJob[] = [];
  private readonly backoff = new Map<string, {until: number; failures: number}>();
  private epoch = 0;
  private pass = 0;
  private online = true;
  private foreground = true;
  private readonly changed: () => void;
  private readonly now: () => number;
  readonly metrics = {requests: 0, hits: 0, joined: 0, peak: 0};
  constructor(changed = () => {}, now = () => Date.now()) {this.changed = changed; this.now = now;}

  setConnections(connections: MetadataConnection[]): void {
    const previous = this.connections;
    this.connections = connections;
    const valid = new Set(connections.map(connection => connection.key));
    for (const job of [...this.active, ...this.queue]) if (!this.current(job.connection)) this.abort(job);
    for (const cache of [this.nodes, this.checks, this.nodeErrors]) for (const item of cache.keys()) if (!valid.has(JSON.parse(item)[0])) cache.delete(item);
    for (const item of this.roots.keys()) if (!valid.has(item)) this.roots.delete(item);
    for (const item of this.backoff.keys()) if (!valid.has(item)) this.backoff.delete(item);
    for (const connection of connections) if (connection.available && previous.some(item => item.key === connection.key && item.version !== connection.version)) {
      for (const [id, record] of this.checks) if (JSON.parse(id)[0] === connection.key && record.status !== 'available' && record.status !== 'trashed') {record.nextCheckAt = 0; record.invalidated = false;}
    }
    if (JSON.stringify(previous.map(({api, ...data}) => data)) !== JSON.stringify(connections.map(({api, ...data}) => data))) this.changed();
    this.pump();
  }
  setEnvironment(online: boolean, foreground: boolean): void {
    if (this.online === online && this.foreground === foreground) return;
    this.online = online; this.foreground = foreground;
    if (!online || !foreground) {this.epoch++; for (const job of [...this.active, ...this.queue]) this.abort(job);}
    this.changed();
  }
  private current(connection: MetadataConnection): boolean {
    return this.connections.some(item => item.key === connection.key && item.version === connection.version && item.available) && this.online && this.foreground;
  }
  private supported(source: DocumentSource): boolean {return source.provider === 'google-drive' && source.sourceScope === 'drive' && !!source.fileId;}
  entry(connectionId: string, id: string): DriveBrowserEntry | undefined {
    const connection = this.connections.find(item => item.id === connectionId), file = connection && this.nodes.get(key(connection.key, id))?.file;
    return file ? structuredClone(file) : undefined;
  }
  visibleIn(connectionId: string, id: string, folder: DriveBrowserFolder): boolean {
    const connection = this.connections.find(item => item.id === connectionId), file = connection && this.nodes.get(key(connection.key, id))?.file;
    if (!file) return true;
    if (file.trashed) return false;
    const parent = folder.id === 'root' && connection ? this.roots.get(connection.key) : folder.id;
    return !!folder.shared || !parent || file.parents === undefined || file.parents.includes(parent);
  }
  private resourceKey(source: DocumentSource): string {try {return new URL(source.url).searchParams.get('resourcekey') ?? '';} catch {return '';}}
  private fresh(record: CheckedDocument | undefined, connection: MetadataConnection): boolean {
    if (!record || record.invalidated || record.nextCheckAt <= this.now()) return false;
    const ancestors = new Set(record.ancestors);
    let file = record.file && (this.nodes.get(key(connection.key, record.file.id))?.file ?? record.file);
    for (let depth = 0; file?.parents?.length && depth < 12; depth++) {
      const id = file.parents[0]; if (ancestors.has(id) && id === file.id) break;
      ancestors.add(id); file = this.nodes.get(key(connection.key, id))?.file;
    }
    return record.status !== 'available' || [...ancestors].every(id => {
      const node = this.nodes.get(key(connection.key, id)); return !!node && this.now() - node.at < DOCUMENT_METADATA_TTL && !this.nodeErrors.has(key(connection.key, JSON.stringify([id, ''])));
    });
  }
  private location(connection: MetadataConnection, file: DriveBrowserEntry): {location: string; partial: boolean} {
    const names: string[] = [], seen = new Set([file.id]);
    let current = file, complete = false;
    for (let depth = 0; depth < 12; depth++) {
      if (this.roots.get(connection.key) === current.id) {names.unshift('我的雲端硬碟'); complete = true; break;}
      if (current.driveId === current.id) {if (current !== file) names.unshift(current.name); complete = true; break;}
      if (!current.parents?.length || seen.has(current.parents[0])) break;
      const parent = this.nodes.get(key(connection.key, current.parents[0]))?.file;
      if (!parent || parent.trashed || parent.mimeType !== DRIVE_FOLDER_MIME || this.nodeErrors.has(key(connection.key, JSON.stringify([parent.id, ''])))) break;
      seen.add(parent.id); current = parent;
      if (this.roots.get(connection.key) !== parent.id && parent.driveId !== parent.id) names.unshift(parent.name);
    }
    return {location: documentLocationSnapshot(connection.label, [...(!complete ? ['部分位置'] : []), ...names].join(' / ')), partial: !complete};
  }
  view(source: DocumentSource, preferred = ''): DocumentMetadataView {
    if (!this.supported(source)) return {source, status: 'unsupported', label: source.provider === 'gmail' ? '原信連結，尚未主動查驗' : statusLabel.unsupported, stale: false, checking: false};
    const candidates = this.connections.map(connection => ({connection, record: this.checks.get(key(connection.key, source.id))}));
    const available = candidates.filter(item => item.connection.available && item.record?.status === 'available');
    available.sort((a, b) => Number(this.fresh(b.record, b.connection)) - Number(this.fresh(a.record, a.connection)) || Number(b.connection.id === preferred) - Number(a.connection.id === preferred) || (b.record?.checkedAt ?? 0) - (a.record?.checkedAt ?? 0));
    const chosen = available[0] ?? candidates.find(item => item.connection.id === preferred && item.record) ?? candidates.filter(item => item.record).sort((a, b) => b.record!.checkedAt - a.record!.checkedAt)[0]
      ?? candidates.find(item => item.connection.id === preferred) ?? candidates.find(item => item.connection.available) ?? candidates[0];
    const connection = chosen?.connection, record = chosen?.record;
    const file = connection && (this.nodes.get(key(connection.key, source.fileId!))?.file ?? record?.file);
    const location = connection && file ? this.location(connection, file) : undefined;
    const display = file ? {...source, name: file.name, url: file.url, mimeType: file.mimeType, ...(location ? {location: location.location} : {})} : source;
    const status = !this.online ? 'offline' : !connection?.available ? 'authorization' : record?.status ?? 'unverified';
    const stale = !!record && !!connection && !this.fresh(record, connection);
    const other = preferred && preferred !== connection?.id ? candidates.find(item => item.connection.id === preferred)?.record : undefined;
    return {source: display, status, label: status === 'available' && stale ? '資訊已過期，等待查驗' : statusLabel[status], stale,
      checking: candidates.some(item => this.running.has(key(item.connection.key, source.id))),
      ...(connection ? {connectionId: connection.id, connectionLabel: connection.label} : {}), ...(record ? {checkedAt: record.checkedAt, retryAt: record.nextCheckAt} : {}),
      ...(location ? {partialLocation: location.partial} : {}), ...(file?.shortcut ? {pathNote: '捷徑所在位置；目標位置尚未查驗'} : record?.pathNote ? {pathNote: record.pathNote} : {}),
      ...(other && other.status !== 'available' ? {alternate: '所選來源：' + statusLabel[other.status] + '；保留可用來源資訊'} : {})};
  }

  async refresh(sources: readonly DocumentSource[], preferred = '', force = false): Promise<void> {
    if (!this.online || !this.foreground) {this.changed(); return;}
    const pass: Pass = {id: ++this.pass, budget: 40, force, epoch: this.epoch};
    const unique = [...new Map(sources.filter(source => this.supported(source)).map(source => [source.id, source])).values()];
    for (let offset = 0; offset < unique.length && pass.epoch === this.epoch; offset += DOCUMENT_METADATA_BATCH) {
      await Promise.all(unique.slice(offset, offset + DOCUMENT_METADATA_BATCH).map(async source => {
        const connections = this.connections.filter(connection => connection.available && (!preferred || connection.id === preferred));
        const successful = this.view(source, preferred).connectionId;
        connections.sort((a, b) => Number(b.id === successful) - Number(a.id === successful));
        for (const connection of connections.slice(0, 3)) {
          if (!this.current(connection) || pass.epoch !== this.epoch) break;
          const record = this.checks.get(key(connection.key, source.id));
          if (!force && this.fresh(record, connection) && record?.resourceKey === this.resourceKey(source)) {
            this.metrics.hits++; if (record.status === 'available' || record.status === 'trashed') break; continue;
          }
          await this.check(source, connection, pass);
          const result = this.checks.get(key(connection.key, source.id));
          if (result?.status === 'available' || result?.status === 'trashed') break;
        }
      }));
    }
  }
  private check(source: DocumentSource, connection: MetadataConnection, pass: Pass): Promise<void> {
    const identity = key(connection.key, source.id), previous = this.running.get(identity);
    if (previous) {this.metrics.joined++; return previous;}
    const work = this.read(source, connection, pass).finally(() => {if (this.running.get(identity) === work) this.running.delete(identity); this.changed();});
    this.running.set(identity, work); this.changed(); return work;
  }
  private async read(source: DocumentSource, connection: MetadataConnection, pass: Pass): Promise<void> {
    const identity = key(connection.key, source.id), previous = this.checks.get(identity), resourceKey = this.resourceKey(source);
    const valid = () => pass.epoch === this.epoch && this.current(connection);
    let file: DriveBrowserEntry | undefined, ancestors: string[] = [], pathNote = '';
    try {
      file = await this.node(connection, source.fileId!, resourceKey, previous && !['available', 'trashed'].includes(previous.status) ? {...pass, force: true} : pass);
      if (!valid()) return;
      if (!file.trashed) {
        let cursor = file;
        const seen = new Set([file.id]);
        for (let depth = 0; depth < 12; depth++) {
          if (cursor.id === this.roots.get(connection.key) || cursor.driveId === cursor.id) break;
          const id = cursor.parents?.[0];
          if (!id) {
            try {const root = await this.node(connection, 'root', '', pass, true); if (root.id === cursor.id) this.roots.set(connection.key, root.id);}
            catch {pathNote = '無法確認完整位置';}
            break;
          }
          if (seen.has(id)) {pathNote = '上層位置資料異常，僅顯示部分位置'; break;}
          seen.add(id); ancestors.push(id);
          try {cursor = await this.node(connection, id, '', pass, true); if (cursor.trashed || cursor.mimeType !== DRIVE_FOLDER_MIME) {pathNote = '上層位置無法確認'; break;}}
          catch {pathNote = '無法取得完整路徑，保留可確認的位置'; break;}
        }
      }
      if (!valid()) return;
      this.checks.set(identity, {documentId: source.id, file, status: file.trashed ? 'trashed' : 'available', checkedAt: this.now(), nextCheckAt: this.now() + DOCUMENT_METADATA_TTL, ancestors, resourceKey, ...(pathNote ? {pathNote} : {})});
    } catch (error) {
      if (!valid() || error instanceof DOMException && error.name === 'AbortError') return;
      if (this.checks.get(identity) !== previous && this.checks.get(identity)?.status === 'available') return;
      const status: DocumentCheckStatus = error instanceof GoogleHttpError ? authorizationFailure(error) ? 'authorization'
        : limited(error) ? 'limited' : serviceFailure(error) ? 'error' : [403, 404].includes(error.status) ? 'unavailable' : 'error' : 'error';
      this.checks.set(identity, {...previous, documentId: source.id, ...(file ? {file} : {}), status, checkedAt: this.now(),
        nextCheckAt: Math.max(this.backoff.get(connection.key)?.until ?? 0, this.now() + (status === 'unavailable' ? 5 * 60000 : 60000)), invalidated: false, ancestors: previous?.ancestors ?? ancestors, resourceKey,
        pathNote: error instanceof GoogleHttpError && serviceFailure(error) ? '此來源的服務尚未啟用或受管理員限制，請檢查 Google Drive 設定。' : undefined});
    }
    this.bound();
  }

  private async node(connection: MetadataConnection, id: string, resourceKey: string, pass: Pass, ancestor = false): Promise<DriveBrowserEntry> {
    if (pass.epoch !== this.epoch || !this.current(connection)) throw stopped();
    const identity = key(connection.key, id), saved = this.nodes.get(identity);
    const startedAt = this.now();
    const failed = this.nodeErrors.get(key(connection.key, JSON.stringify([id, resourceKey])));
    if (!pass.force && failed && failed.until > this.now()) {this.metrics.hits++; throw failed.error;}
    if (saved && !failed && (pass.force ? saved.pass === pass.id : this.now() - saved.at < DOCUMENT_METADATA_TTL)) {this.metrics.hits++; return saved.file;}
    const networkKey = JSON.stringify([connection.key, connection.version, id, resourceKey]), pending = this.pending.get(networkKey);
    if (pending) {this.metrics.joined++; return pending;}
    const delay = this.backoff.get(connection.key);
    if (delay && delay.until > this.now()) throw new GoogleHttpError(429, 'Drive 檔案資訊', {retryAfterMs: delay.until - this.now()});
    if (ancestor && pass.budget-- <= 0) throw new Error('本批路徑查驗額度已用完');
    let job!: NetworkJob;
    const result = new Promise<DriveBrowserEntry>((resolve, reject) => {job = {key: networkKey, connection, id, resourceKey, controller: new AbortController(), resolve, reject};});
    const work = result.then(file => {
      if (pass.epoch !== this.epoch || !this.current(connection)) throw stopped();
      this.nodeErrors.delete(key(connection.key, JSON.stringify([id, resourceKey])));
      const newer = this.nodes.get(identity);
      if (newer && newer !== saved && newer.at >= startedAt) return newer.file;
      this.observeNode(connection, file, this.now(), pass.id);
      if (id === 'root') {this.nodes.set(key(connection.key, 'root'), {file: structuredClone(file), at: this.now(), pass: pass.id}); if (file.mimeType === DRIVE_FOLDER_MIME) this.roots.set(connection.key, file.id);}
      return file;
    }).catch(error => {
      if (pass.epoch === this.epoch && this.current(connection) && !(error instanceof DOMException && error.name === 'AbortError')) this.nodeErrors.set(key(connection.key, JSON.stringify([id, resourceKey])), {error, until: this.now() + (error instanceof GoogleHttpError && [403, 404].includes(error.status) ? 5 * 60000 : 60000)});
      throw error;
    }).finally(() => {if (this.pending.get(networkKey) === work) this.pending.delete(networkKey);});
    this.pending.set(networkKey, work); this.queue.push(job); this.pump(); return work;
  }
  private pump(): void {
    while (this.active.size < 4) {
      const index = this.queue.findIndex(job => !this.current(job.connection) || [...this.active].filter(active => active.connection.id === job.connection.id).length < 2);
      if (index < 0) return;
      const [job] = this.queue.splice(index, 1);
      if (!this.current(job.connection)) {job.reject(stopped()); continue;}
      const delay = this.backoff.get(job.connection.key);
      if (delay && delay.until > this.now()) {job.reject(new GoogleHttpError(429, 'Drive 檔案資訊', {retryAfterMs: delay.until - this.now()})); continue;}
      this.active.add(job); this.metrics.requests++; this.metrics.peak = Math.max(this.metrics.peak, this.active.size);
      job.connection.api.get(job.id, job.resourceKey, job.controller.signal).then(job.resolve, error => {
        if (error instanceof GoogleHttpError && limited(error)) {
          const failures = Math.min(7, (this.backoff.get(job.connection.key)?.failures ?? 0) + 1);
          const minimum = error.reason.replaceAll('_', '').toLowerCase().includes('dailylimit') ? 15 * 60000 : 0;
          this.backoff.set(job.connection.key, {failures, until: this.now() + Math.max(error.retryAfterMs, minimum, Math.min(3600000, 30000 * 2 ** failures))});
        }
        job.reject(error);
      }).finally(() => {this.active.delete(job); this.pump();});
    }
  }
  private abort(job: NetworkJob): void {
    job.controller.abort(); job.reject(stopped());
    this.active.delete(job);
    const index = this.queue.indexOf(job); if (index >= 0) this.queue.splice(index, 1);
  }
  private observeNode(connection: MetadataConnection, file: DriveBrowserEntry, at: number, pass = 0): void {
    const identity = key(connection.key, file.id), previous = this.nodes.get(identity)?.file;
    if (previous && JSON.stringify([previous.name, previous.parents, previous.trashed]) !== JSON.stringify([file.name, file.parents, file.trashed])) {
      for (const [id, record] of this.checks) if (JSON.parse(id)[0] === connection.key && record.ancestors.includes(file.id)) record.invalidated = true;
    }
    this.nodes.delete(identity); this.nodes.set(identity, {file: structuredClone(file), at, pass});
    this.nodeErrors.delete(key(connection.key, JSON.stringify([file.id, file.resourceKey ?? ''])));
    this.nodeErrors.delete(key(connection.key, JSON.stringify([file.id, ''])));
  }
  observeList(connectionId: string, files: readonly DriveBrowserEntry[], folder: DriveBrowserFolder, at: number, cached = false): void {
    const connection = this.connections.find(item => item.id === connectionId);
    if (!connection || !this.current(connection)) return;
    if (folder.id === 'root' && !folder.shared) {
      const id = files.find(file => file.parents?.length === 1)?.parents?.[0];
      if (id) {this.roots.set(connection.key, id); this.observeNode(connection, {id, name: '我的雲端硬碟', mimeType: DRIVE_FOLDER_MIME, url: 'https://drive.google.com/drive/my-drive', parents: []}, at);}
    }
    for (const file of files) {
      const previous = this.checks.get(key(connection.key, sourceFromDriveEntry(file).id));
      if (previous && (previous.checkedAt > at || cached && previous.checkedAt >= at)) continue;
      this.observeNode(connection, file, at);
      const source = sourceFromDriveEntry(file);
      this.checks.set(key(connection.key, source.id), {documentId: source.id, file: structuredClone(file), status: file.trashed ? 'trashed' : 'available', checkedAt: at,
        nextCheckAt: at + DOCUMENT_METADATA_TTL, ancestors: previous?.ancestors ?? file.parents ?? [], resourceKey: file.resourceKey ?? ''});
    }
    this.bound(); this.changed();
  }
  private bound(): void {
    while (this.nodes.size > 2000) this.nodes.delete(this.nodes.keys().next().value!);
    while (this.checks.size > 1000) this.checks.delete(this.checks.keys().next().value!);
    while (this.nodeErrors.size > 1000) this.nodeErrors.delete(this.nodeErrors.keys().next().value!);
  }
  stats(): {checked: number; nodes: number; expired: number} {
    return {checked: this.checks.size, nodes: this.nodes.size, expired: [...this.checks.values()].filter(record => record.invalidated || record.nextCheckAt <= this.now()).length + [...this.nodes.values()].filter(node => node.at + DOCUMENT_METADATA_TTL <= this.now()).length + [...this.nodeErrors.values()].filter(error => error.until <= this.now()).length};
  }
  clear(expiredOnly = false): number {
    this.epoch++; for (const job of [...this.active, ...this.queue]) this.abort(job);
    let removed = 0;
    for (const [id, record] of this.checks) if (!expiredOnly || record.invalidated || record.nextCheckAt <= this.now()) {this.checks.delete(id); removed++;}
    for (const [id, node] of this.nodes) if (!expiredOnly || node.at + DOCUMENT_METADATA_TTL <= this.now()) {this.nodes.delete(id); removed++;}
    for (const [id, error] of this.nodeErrors) if (!expiredOnly || error.until <= this.now()) {this.nodeErrors.delete(id); removed++;}
    if (!expiredOnly) this.roots.clear();
    this.changed(); return removed;
  }
  destroy(): void {this.epoch++; this.connections = []; for (const job of [...this.active, ...this.queue]) this.abort(job);}
}
