import type { SessionChannel } from './google-session.ts';

export const CALENDAR_SYNC_PREFIX = 'iih-orbit-calendar-sync-v1:';
export const SYNC_LEASE_MS = 90000;
export const SYNC_RUN_TIMEOUT_MS = 120000;
export class CalendarSyncTimeoutError extends Error {
  constructor() { super('月曆同步逾時，已停止本次同步，可重新嘗試。'); }
}
type SyncStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type Atomic = <T>(operation: () => T) => Promise<T>;
interface SyncRun {id: string; keys: string[]; expiresAt: number; lockProtected?: boolean}

/** Public activity metadata only. Credentials and calendar events never enter this record. */
export class CalendarSyncCoordinator {
  private scope = '';
  private owned?: {scope: string; run: SyncRun};
  private closed = false;
  private suspended = false;
  private recovery?: Promise<void>;
  private cancelCurrent?: (error: Error) => void;
  private readonly timeoutMs: number;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly storage: SyncStorage;
  private readonly atomic: Atomic;
  private readonly channel?: SessionChannel;
  private readonly locks?: Pick<LockManager, 'request'>;
  private readonly changed: (keys: string[]) => void;
  private readonly namespace: {storagePrefix: string; lockPrefix: string; label: string};

  constructor(storage: SyncStorage, atomic: Atomic, changed: (keys: string[]) => void, channel?: SessionChannel, locks?: Pick<LockManager, 'request'>, timeoutMs = SYNC_RUN_TIMEOUT_MS, namespace = {storagePrefix: CALENDAR_SYNC_PREFIX, lockPrefix: 'iih-orbit-calendar-run:', label: '月曆'}) {
    this.namespace = namespace;
    this.storage = storage; this.atomic = atomic; this.changed = changed; this.channel = channel; this.locks = locks;
    this.timeoutMs = timeoutMs;
    if (channel) channel.onmessage = () => this.refresh();
    this.timer = setInterval(() => { void this.heartbeat(); this.refresh(); }, 5000);
  }

  activate(scope: string): void { this.scope = scope; this.refresh(); }
  private key(scope: string): string { return this.namespace.storagePrefix + scope; }
  private read(scope: string): SyncRun | undefined {
    const value = this.storage.getItem(this.key(scope));
    if (!value) return undefined;
    try {
      const run = JSON.parse(value) as SyncRun;
      if (typeof run.id === 'string' && run.id.length <= 100 && Array.isArray(run.keys) && run.keys.length <= 1000
        && run.keys.every(key => typeof key === 'string') && Number.isSafeInteger(run.expiresAt)) return run;
    } catch { /* A malformed public record cannot block synchronization. */ }
    return undefined;
  }
  refresh(): void {
    if (this.closed || this.suspended) return;
    try {
      const run = this.read(this.scope), nativeRecord = run && this.locks && run.lockProtected !== false;
      this.changed(run && (run.expiresAt > Date.now() || nativeRecord) ? run.keys : []);
      if (nativeRecord && this.owned?.run.id !== run.id) this.recoverAbandoned(this.scope, run.id);
    }
    catch { /* The caller reports storage failures when synchronization is requested. */ }
  }
  private notify(): void { this.refresh(); try { this.channel?.postMessage({scope: this.scope}); } catch { /* Storage events and periodic checks also update peers. */ } }

  private recoverAbandoned(scope: string, id: string): void {
    if (!this.locks || this.recovery) return;
    this.recovery = this.locks.request(this.namespace.lockPrefix + scope, {ifAvailable: true}, async lock => {
      if (!lock || this.closed || this.suspended || this.scope !== scope) return false;
      return this.atomic(() => {
        if (this.closed || this.suspended || this.scope !== scope || this.read(scope)?.id !== id) return false;
        this.storage.removeItem(this.key(scope)); return true;
      });
    }).then(removed => { if (removed && !this.closed && !this.suspended && this.scope === scope) this.notify(); })
      .catch(() => { /* The lease remains a fallback when lock inspection or storage fails. */ })
      .finally(() => { this.recovery = undefined; });
  }

  async run(scope: string, keys: string[], operation: (current: () => boolean) => Promise<void>, prepare?: () => Promise<string[]>): Promise<boolean> {
    if (this.closed || this.suspended || this.owned) return false;
    const execute = async (): Promise<boolean> => {
      const needed = prepare ? await prepare() : keys;
      if (!needed.length || this.closed || this.suspended) return false;
      const run: SyncRun = {id: crypto.randomUUID(), keys: [...new Set(needed)], expiresAt: Date.now() + SYNC_LEASE_MS, lockProtected: !!this.locks};
      const claimed = await this.atomic(() => {
        if (this.closed || this.suspended) return false;
        const previous = this.read(scope);
        if (previous && previous.expiresAt > Date.now()) return false;
        this.storage.setItem(this.key(scope), JSON.stringify(run));
        return true;
      });
      if (!claimed) { this.refresh(); return false; }
      this.owned = {scope, run}; this.notify();
      let cancelled = false, timer: ReturnType<typeof setTimeout> | undefined;
      const current = () => !cancelled && !this.closed && !this.suspended && this.scope === scope && this.read(scope)?.id === run.id;
      const interrupted = new Promise<never>((_, reject) => {
        this.cancelCurrent = error => { cancelled = true; reject(error); };
        timer = setTimeout(() => this.cancelCurrent?.(this.namespace.label === '月曆' ? new CalendarSyncTimeoutError() : new Error(this.namespace.label + '同步逾時，待上傳版本仍保留。')), this.timeoutMs);
      });
      try { if (current()) await Promise.race([Promise.resolve().then(() => current() ? operation(current) : undefined), interrupted]); return true; }
      finally {
        cancelled = true; clearTimeout(timer); this.cancelCurrent = undefined;
        try { await this.atomic(() => { if (this.read(scope)?.id === run.id) this.storage.removeItem(this.key(scope)); }); }
        finally { if (this.owned?.run.id === run.id) this.owned = undefined; this.notify(); }
      }
    };
    if (this.locks) return this.locks.request(this.namespace.lockPrefix + scope, {ifAvailable: true}, lock => {
      if (!lock) { this.refresh(); return false; }
      return execute();
    });
    return execute();
  }

  private async heartbeat(): Promise<void> {
    const owned = this.owned;
    if (!owned || this.closed || this.suspended) return;
    try {
      await this.atomic(() => {
        if (this.closed || this.suspended || this.read(owned.scope)?.id !== owned.run.id) return;
        owned.run.expiresAt = Date.now() + SYNC_LEASE_MS;
        this.storage.setItem(this.key(owned.scope), JSON.stringify(owned.run));
      });
    } catch { /* Ownership is checked again before requests and cache writes. */ }
  }
  suspend(): void {
    if (this.closed || this.suspended) return;
    this.suspended = true;
    this.cancelCurrent?.(new Error('頁面已離開，本次' + this.namespace.label + '同步已停止。'));
    const owned = this.owned;
    try { if (owned && this.read(owned.scope)?.id === owned.run.id) this.storage.removeItem(this.key(owned.scope)); } catch { /* An interrupted owner expires automatically. */ }
    this.changed([]);
    try { this.channel?.postMessage({scope: this.scope}); } catch { /* A closed tab's public lease eventually expires. */ }
  }
  resume(): void { if (!this.closed) { this.suspended = false; this.refresh(); } }
  close(): void {
    if (this.closed) return;
    this.suspend(); this.closed = true; clearInterval(this.timer);
    if (this.channel) { this.channel.onmessage = null; this.channel.close(); }
  }
}
