import {type DriveBrowserApi, type DriveFileChange, validChangeToken} from './drive-browser-data.ts';
import {GoogleHttpError} from './google-api.ts';

const STORAGE_KEY = 'iih-orbit-drive-changes-v1', MAX_SOURCES = 21;
export const DRIVE_CHANGES_INTERVAL = 5 * 60000;
export const DRIVE_CHANGES_PAGE_LIMIT = 3;
export interface DriveChangesConnection {
  id: string; key: string; version: number; available: boolean;
  api: Pick<DriveBrowserApi, 'startPageToken' | 'changes'>;
}
interface ChangesState {token: string; nextAt: number; failures: number}
interface ChangesOptions {
  apply(connectionId: string, changes: readonly DriveFileChange[]): void | Promise<void>;
  reset(connectionId: string): void;
  warning?(message: string): void;
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  now?: () => number;
}

/** Account-scoped read cursors. A page is acknowledged only after its cache updates finish. */
export class DriveChangesTracker {
  private connections: DriveChangesConnection[] = [];
  private readonly states = new Map<string, ChangesState>();
  private readonly active = new Map<string, {connection: DriveChangesConnection; controller: AbortController}>();
  private readonly warnings = new Map<string, string>();
  private persistenceWarning = '';
  private online = true;
  private foreground = true;
  private destroyed = false;
  private pending?: Promise<void>;
  private readonly now: () => number;
  private readonly options: ChangesOptions;
  constructor(options: ChangesOptions) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    try {
      const content = options.storage?.getItem(STORAGE_KEY) ?? 'null';
      if (content.length > 256 * 1024) return;
      const saved = JSON.parse(content);
      if (saved?.version !== 1 || !Array.isArray(saved.cursors) || saved.cursors.length > MAX_SOURCES) return;
      for (const cursor of saved.cursors) if (typeof cursor?.key === 'string' && cursor.key.length <= 8000 && validChangeToken(cursor.token)) this.states.set(cursor.key, {token: cursor.token, nextAt: 0, failures: 0});
    } catch { /* Cursors are optional; metadata can be rechecked from a fresh baseline. */ }
  }
  setConnections(connections: DriveChangesConnection[]): void {
    const previous = this.connections; this.connections = connections.slice(0, MAX_SOURCES);
    for (const [key, job] of this.active) if (!this.current(job.connection)) {job.controller.abort(); this.active.delete(key);}
    const valid = new Set(this.connections.map(connection => connection.key));
    let removed = false;
    for (const key of this.states.keys()) if (!valid.has(key)) {this.states.delete(key); removed = true;}
    for (const key of this.warnings.keys()) if (!valid.has(key)) this.warnings.delete(key);
    for (const connection of this.connections) if (connection.available && previous.some(item => item.key === connection.key && (!item.available || item.version !== connection.version))) {
      const state = this.states.get(connection.key); if (state) {state.nextAt = 0; state.failures = 0;}
      this.warnings.delete(connection.key);
    }
    if (removed) this.persist();
    this.report();
  }
  setEnvironment(online: boolean, foreground: boolean): void {
    this.online = online; this.foreground = foreground;
    if (!online || !foreground) for (const job of this.active.values()) job.controller.abort();
  }
  private current(connection: DriveChangesConnection): boolean {
    return !this.destroyed && this.online && this.foreground && this.connections.some(item => item.key === connection.key && item.version === connection.version && item.available);
  }
  poll(): Promise<void> {
    if (this.pending) return this.pending;
    const connections = this.connections.filter(connection => this.current(connection) && (this.states.get(connection.key)?.nextAt ?? 0) <= this.now());
    if (!connections.length) return Promise.resolve();
    let index = 0;
    const work = Promise.all(Array.from({length: Math.min(2, connections.length)}, async () => {
      while (index < connections.length) await this.read(connections[index++]);
    })).then(() => {}).finally(() => {if (this.pending === work) this.pending = undefined;});
    this.pending = work; return work;
  }
  private async read(connection: DriveChangesConnection): Promise<void> {
    if (!this.current(connection)) return;
    const controller = new AbortController(); this.active.set(connection.key, {connection, controller});
    const current = () => this.current(connection) && !controller.signal.aborted;
    let state = this.states.get(connection.key);
    if (!state) {state = {token: '', nextAt: 0, failures: 0}; this.states.set(connection.key, state);}
    try {
      if (!state.token) {
        this.options.reset(connection.id);
        const token = await connection.api.startPageToken(controller.signal);
        if (!current()) return;
        state.token = token; this.persist();
      }
      const seen = new Set([state.token]);
      for (let page = 0; page < DRIVE_CHANGES_PAGE_LIMIT && current(); page++) {
        const result = await connection.api.changes(state.token, controller.signal);
        if (!current()) return;
        const token = result.nextPageToken || result.newStartPageToken;
        if (!validChangeToken(token) || result.nextPageToken && seen.has(result.nextPageToken)) throw new Error('Drive 變更追蹤未能前進，稍後重試。');
        await this.options.apply(connection.id, result.changes);
        if (!current()) return;
        state.token = token; seen.add(token); this.persist();
        state.nextAt = this.now() + (result.nextPageToken ? 60000 : DRIVE_CHANGES_INTERVAL); state.failures = 0;
        if (!result.nextPageToken) break;
      }
      if (current()) this.warnings.delete(connection.key);
    } catch (error) {
      if (!current() || error instanceof DOMException && error.name === 'AbortError') return;
      if (error instanceof GoogleHttpError && [400, 410].includes(error.status)) {state.token = ''; this.options.reset(connection.id); this.persist();}
      state.failures = Math.min(7, state.failures + 1);
      const minimum = error instanceof GoogleHttpError && /daily.?limit/i.test(error.reason) ? 15 * 60000 : 0;
      state.nextAt = this.now() + Math.max(minimum, error instanceof GoogleHttpError ? error.retryAfterMs : 0, Math.min(3600000, 30000 * 2 ** state.failures));
      this.warnings.set(connection.key, '檔案變更檢查暫時未完成，已保留追蹤位置；可繼續瀏覽或手動更新連結資訊。');
    } finally {
      if (this.active.get(connection.key)?.controller === controller) this.active.delete(connection.key);
      this.report();
    }
  }
  private persist(): void {
    try {
      this.options.storage?.setItem(STORAGE_KEY, JSON.stringify({version: 1, cursors: [...this.states].filter(([, state]) => state.token).map(([key, state]) => ({key, token: state.token}))}));
      this.persistenceWarning = '';
    } catch {this.persistenceWarning = '檔案變更追蹤位置無法保存，重新開啟後會重新建立追蹤。';}
  }
  private report(): void {this.options.warning?.([...new Set([...this.warnings.values(), this.persistenceWarning])].filter(Boolean).join(' '));}
  destroy(): void {this.destroyed = true; for (const job of this.active.values()) job.controller.abort(); this.connections = [];}
}
