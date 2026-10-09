import { computed, effect, inject, Injectable, OnDestroy, signal, untracked } from '@angular/core';
import { BoardStore } from './board-store';
import { CalendarCache } from './calendar-cache';
import { AvailableCalendar, CalendarApi, CalendarSnapshot, calendarViewForRange } from './google-api';
import { GoogleAuth } from './google-auth';
import { cacheKey, calendarMonthRange, calendarRange, CalendarRange, CalendarSource, externalEvent, ExternalEvent, sourceKey } from './google-data';
import { dateKey } from './task-schedule';
import { CALENDAR_SYNC_PREFIX, CalendarSyncCoordinator, CalendarSyncTimeoutError } from './calendar-sync';
import { withStorageLock } from './storage-coordinator';

@Injectable({providedIn: 'root'})
export class GoogleCalendarService implements OnDestroy {
  readonly store = inject(BoardStore);
  readonly auth = inject(GoogleAuth);
  private readonly cache = inject(CalendarCache);
  private readonly api = new CalendarApi((path, parameters) => this.auth.request(path, parameters));
  readonly available = signal<AvailableCalendar[]>([]);
  readonly listing = signal(false);
  readonly error = signal('');
  readonly cacheWarning = signal('');
  readonly loading = signal(new Set<string>());
  readonly syncingKeys = signal(new Set<string>());
  private readonly localSyncing = signal(false);
  readonly syncing = computed(() => this.localSyncing() || this.syncingKeys().size > 0);
  readonly sourceErrors = signal<Record<string, string>>({});
  readonly snapshots = signal<Record<string, CalendarSnapshot>>({});
  readonly online = signal(typeof navigator === 'undefined' || navigator.onLine !== false);
  readonly range = signal(calendarRange(dateKey(new Date()), dateKey(new Date())));
  readonly reminderRange = signal<CalendarRange | null>(null);
  readonly requestedRanges = computed(() => {
    const ranges = [this.range(), this.reminderRange()].filter((range): range is CalendarRange => !!range);
    return ranges.filter((range, index) => !ranges.some((other, otherIndex) => otherIndex !== index && other.timeZone === range.timeZone
      && other.start <= range.start && other.end >= range.end && (other.key !== range.key || otherIndex < index)));
  });
  private readonly configuration = computed(() => JSON.stringify([this.store.generation(), this.store.google()]));
  readonly sources = computed(() => this.store.google().sources.filter(source => source.accountId === this.store.google().accountId));
  readonly visibleSources = computed(() => this.sources().filter(source => source.visible && source.workspaceIds.includes(this.store.currentWorkspace().id)));
  readonly events = computed<ExternalEvent[]>(() => this.entriesFor(this.range()));
  readonly reminderEvents = computed<ExternalEvent[]>(() => this.reminderRange() ? this.entriesFor(this.reminderRange()!) : []);
  private entriesFor(range: CalendarRange): ExternalEvent[] {
    const entries = new Map<string, ExternalEvent>();
    for (const source of this.visibleSources()) {
      const snapshot = this.snapshots()[this.key(source)];
      const view = calendarViewForRange(snapshot, range);
      for (const event of view?.events ?? []) {
        const entry = externalEvent(source, event);
        if (entry && !entries.has(entry.task.id)) entries.set(entry.task.id, entry);
      }
    }
    return [...entries.values()];
  }
  private epoch = 0;
  private identity = '';
  private keys = new Set<string>();
  private attempts = new Map<string, number>();
  private running?: Promise<void>;
  private refreshAgain = false;
  private destroyed = false;
  private suspended = false;
  private readonly loadingRuns = new Map<string, symbol>();
  private connecting = false;
  private channel?: BroadcastChannel;
  private readonly coordinator: CalendarSyncCoordinator;
  private readonly syncWake = () => this.coordinator.refresh();
  private readonly syncStorageChanged = (event: StorageEvent) => { if (!event.key || event.key.startsWith(CALENDAR_SYNC_PREFIX)) this.coordinator.refresh(); };
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly pageHide = () => {
    this.suspended = true; this.epoch++; this.refreshAgain = false;
    this.coordinator.suspend(); this.auth.cancelRequests(); this.clearLoading(); this.localSyncing.set(false);
  };
  private readonly pageShow = (event: PageTransitionEvent) => {
    if (event.persisted && !this.destroyed) { this.suspended = false; this.coordinator.resume(); void this.configure(); }
  };
  private readonly wake = () => { this.online.set(navigator.onLine !== false); if (document.visibilityState === 'visible') void this.refresh(false); };

  constructor() {
    let syncChannel: BroadcastChannel | undefined;
    try { if (typeof window !== 'undefined') syncChannel = new BroadcastChannel('iih-orbit-calendar-sync'); } catch { /* Native storage events also share sync status. */ }
    this.coordinator = new CalendarSyncCoordinator({getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value), removeItem: key => localStorage.removeItem(key)}, withStorageLock, keys => {
      const previouslyBusy = this.syncingKeys().size > 0;
      this.syncingKeys.set(new Set(keys));
      if (previouslyBusy && !keys.length && !this.localSyncing() && !this.destroyed) void this.refresh(false);
    }, syncChannel, typeof window !== 'undefined' ? navigator.locks : undefined);
    effect(() => {
      this.configuration(); this.requestedRanges(); this.auth.connected();
      untracked(() => void this.configure());
    });
    this.timer = setInterval(() => { if (typeof document !== 'undefined' && document.visibilityState === 'visible') void this.refresh(false); }, 30000);
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.wake); window.addEventListener('offline', this.wake);
      window.addEventListener('storage', this.syncStorageChanged); window.addEventListener('focus', this.syncWake);
      window.addEventListener('pagehide', this.pageHide); window.addEventListener('pageshow', this.pageShow);
      document.addEventListener('visibilitychange', this.wake);
      try { this.channel = new BroadcastChannel('iih-orbit-calendar-cache'); this.channel.onmessage = () => void this.hydrate(this.epoch); }
      catch { /* A visible tab also reloads shared cache during its regular check. */ }
    }
  }

  key(source: CalendarSource): string { return cacheKey(this.store.generation(), this.store.google().clientId, source); }
  private syncScope(): string { return JSON.stringify([this.store.generation(), this.store.google().clientId, this.store.google().accountId]); }
  setRange(first: string, last: string): void {
    const range = calendarRange(first, last);
    if (range.key !== this.range().key) this.range.set(range);
  }
  setMonthRange(anchor: Date): void {
    const range = calendarMonthRange(anchor);
    if (range.key !== this.range().key) this.range.set(range);
  }
  setReminderMonth(anchor: Date): void {
    const range = calendarMonthRange(anchor);
    if (range.key !== this.reminderRange()?.key) this.reminderRange.set(range);
  }

  private async configure(): Promise<void> {
    if (this.destroyed || this.suspended) return;
    const epoch = ++this.epoch;
    this.attempts.clear();
    const identity = JSON.stringify([this.store.generation(), this.store.google().clientId]);
    const replaced = this.identity && this.identity !== identity;
    this.identity = identity;
    if (replaced) {
      this.auth.disconnect('資料或 Client ID 已變更，請重新連線 Google。');
      this.snapshots.set({}); this.available.set([]); this.attempts.clear();
      try { await this.cache.clear(); } catch { this.cacheWarning.set('瀏覽器無法清理月曆快取；舊資料已隔離，不會重新顯示。'); }
    }
    if (epoch !== this.epoch) return;
    this.coordinator.activate(this.syncScope());
    if (!this.connecting) this.auth.useSession({generation: this.store.generation(), clientId: this.store.google().clientId, accountId: this.store.google().accountId});
    if (!this.connecting && this.auth.account() && this.auth.account()!.id !== this.store.google().accountId) this.auth.disconnect('Google 帳號已在其他分頁切換，請重新連線。');
    const keys = new Set(this.store.google().sources.map(source => this.key(source)));
    for (const key of this.keys) if (!keys.has(key)) { this.snapshots.update(values => { const next = {...values}; delete next[key]; return next; }); void this.cache.remove(key).catch(() => {}); }
    this.keys = keys;
    await this.hydrate(epoch);
    if (epoch === this.epoch) await this.refresh(false);
  }

  private async hydrate(epoch: number): Promise<void> {
    for (const source of this.sources()) {
      const key = this.key(source);
      try {
        const snapshot = await this.cache.get(key);
        if (epoch === this.epoch && snapshot && (!this.snapshots()[key] || snapshot.updatedAt > this.snapshots()[key].updatedAt)) this.snapshots.update(values => ({...values, [key]: snapshot}));
      } catch { this.cacheWarning.set('瀏覽器無法保存月曆離線快取，資料只保留於目前分頁。'); }
    }
  }

  async connect(): Promise<void> {
    this.error.set('');
    this.connecting = true; this.available.set([]);
    try {
      this.auth.useSession({generation: this.store.generation(), clientId: this.store.google().clientId, accountId: this.store.google().accountId});
      const account = await this.auth.authorize(this.store.google().clientId);
      const result = await this.store.updateGoogle({accountId: account.id, email: account.email});
      if (!result.ok) { this.auth.disconnect(); throw new Error(result.message); }
      this.auth.useSession({generation: this.store.generation(), clientId: this.store.google().clientId, accountId: account.id});
      await this.listCalendars();
      await this.refresh(true);
    } catch (error) { this.error.set(this.message(error)); }
    finally { this.connecting = false; }
  }

  async listCalendars(): Promise<void> {
    if (!this.auth.connected()) return;
    this.listing.set(true); this.error.set('');
    const account = this.auth.account()!.id, generation = this.store.generation(), clientId = this.store.google().clientId;
    try {
      const calendars = await this.api.calendars();
      if (this.auth.account()?.id !== account || generation !== this.store.generation() || clientId !== this.store.google().clientId) return;
      this.available.set(calendars);
      for (const source of this.sources()) {
        const calendar = calendars.find(item => item.id === source.calendarId);
        if (calendar && source.name !== calendar.name) await this.store.updateCalendarSource(source.id, {name: calendar.name});
      }
    } catch (error) { this.error.set(this.message(error)); }
    finally { this.listing.set(false); }
  }

  async bind(calendar: AvailableCalendar, workspaceId: string, enabled: boolean): Promise<void> {
    this.error.set('');
    const accountId = this.auth.account()?.id;
    if (!accountId || accountId !== this.store.google().accountId) { this.error.set('請先連線 Google，再選擇月曆。'); return; }
    const result = await this.store.bindCalendar({id: crypto.randomUUID(), accountId, calendarId: calendar.id, name: calendar.name, color: calendar.color, workspaceIds: [], visible: true}, workspaceId, enabled);
    if (!result.ok) this.error.set(result.message);
  }

  refresh(force = true): Promise<void> {
    if (this.destroyed || this.suspended) return Promise.resolve();
    if (this.running) { if (!force) this.refreshAgain = true; return this.running; }
    this.coordinator.activate(this.syncScope());
    if (this.running) return this.running;
    if (this.syncing()) { this.refreshAgain ||= !force; return this.hydrate(this.epoch); }
    const epoch = this.epoch, scope = this.syncScope();
    this.running = this.prepareRefresh(force, epoch).then(async keys => {
      if (!keys.length || this.destroyed || epoch !== this.epoch) return;
      const result = await this.coordinator.run(scope, keys, current => {
        this.error.set(''); this.localSyncing.set(true);
        return this.performRefresh(force, current);
      }, () => this.prepareRefresh(force, epoch));
      if (!result) await this.hydrate(this.epoch);
    }).catch(error => {
      if (this.destroyed || this.suspended || epoch !== this.epoch) return;
      if (error instanceof CalendarSyncTimeoutError) { this.epoch++; this.auth.cancelRequests(); this.clearLoading(); }
      this.error.set(this.message(error));
    }).finally(() => {
      this.running = undefined;
      this.localSyncing.set(false);
      if (this.refreshAgain && !this.syncingKeys().size && !this.destroyed && !this.suspended) { this.refreshAgain = false; void this.refresh(false); }
    });
    return this.running;
  }
  private clearLoading(): void { this.loadingRuns.clear(); this.loading.set(new Set()); }

  /** Reading local cache is quiet; only a needed Google request may publish synchronization. */
  private async prepareRefresh(force: boolean, epoch: number): Promise<string[]> {
    await this.hydrate(epoch);
    if (this.destroyed || this.suspended || epoch !== this.epoch || !this.online() || !this.auth.connected() || this.auth.account()?.id !== this.store.google().accountId) return [];
    const unique = new Map(this.sources().filter(source => source.visible && source.workspaceIds.length).map(source => [sourceKey(source), source]));
    return [...unique.values()].filter(source => this.requestedRanges().some(range => this.needsRead(source, range, force))).map(source => this.key(source));
  }

  private needsRead(source: CalendarSource, range: ReturnType<typeof calendarRange>, force: boolean): boolean {
    if (force) return true;
    const interval = this.store.google().refreshMinutes;
    const key = this.key(source), view = calendarViewForRange(this.snapshots()[key], range);
    if ((!interval && view) || (view && !view.invalidated && Date.now() - Date.parse(view.updatedAt) < interval * 60000)) return false;
    const attempted = this.attempts.get(key + range.key);
    return attempted === undefined || Date.now() - attempted >= (interval || 1) * 60000;
  }

  private async performRefresh(force: boolean, currentRun: () => boolean): Promise<void> {
    const epoch = this.epoch;
    if (!currentRun() || !this.online() || !this.auth.connected() || this.auth.account()?.id !== this.store.google().accountId) return;
    const interval = this.store.google().refreshMinutes;
    const ranges = this.requestedRanges();
    const unique = new Map(this.sources().filter(source => source.visible && source.workspaceIds.length).map(source => [sourceKey(source), source]));
    for (const source of unique.values()) {
      for (const range of ranges) {
        const key = this.key(source), attemptKey = key + range.key;
        if (!this.needsRead(source, range, force)) continue;
        if (!currentRun() || epoch !== this.epoch || !this.auth.connected()) return;
        this.attempts.set(attemptKey, Date.now());
        const loadId = Symbol(); this.loadingRuns.set(key, loadId);
        this.loading.update(keys => new Set([...keys, key]));
        try {
          const read = async () => {
            let previous = this.snapshots()[key];
            try { const stored = await this.cache.get(key); if (stored && (!previous || stored.updatedAt > previous.updatedAt)) previous = stored; }
            catch { /* Keep the in-memory snapshot when offline storage is unavailable. */ }
            if (!currentRun() || epoch !== this.epoch || !this.auth.connected() || !this.keys.has(key)) return;
            const fresh = calendarViewForRange(previous, range);
            if (!force && fresh && ((!interval) || (!fresh.invalidated && Date.now() - Date.parse(fresh.updatedAt) < interval * 60000))) {
              this.snapshots.update(values => ({...values, [key]: previous!})); return;
            }
            const synced = await this.api.sync(source.calendarId, previous);
            if (!currentRun() || epoch !== this.epoch || !this.auth.connected()) return;
            const events = await this.api.instances(source.calendarId, range);
            if (!currentRun() || epoch !== this.epoch || key !== this.key(source) || !this.keys.has(key) || !this.auth.connected()) return;
            const updatedAt = new Date(Math.max(Date.now(), (Date.parse(previous?.updatedAt ?? '') || 0) + 1)).toISOString();
            const changed = JSON.stringify(synced.events) !== JSON.stringify(previous?.events ?? []);
            const otherViews = (previous?.views ?? []).filter(item => item.rangeKey !== range.key);
            const pinned = new Set(this.requestedRanges().map(required => calendarViewForRange(previous ? {...previous, views: otherViews} : undefined, required)?.rangeKey).filter((key): key is string => !!key));
            const views = [...otherViews.filter(item => !pinned.has(item.rangeKey)), ...otherViews.filter(item => pinned.has(item.rangeKey))]
              .slice(-5).map(item => changed ? {...item, invalidated: true} : item);
            const snapshot: CalendarSnapshot = {key, ...synced, updatedAt, views: [...views, {rangeKey: range.key, events, updatedAt}]};
            try { await this.cache.put(snapshot); }
            catch { this.cacheWarning.set('月曆已更新，但離線快取無法保存，資料只保留於目前分頁。'); }
            if (epoch !== this.epoch) { if (key !== this.key(source) || !this.keys.has(key)) await this.cache.remove(key).catch(() => {}); return; }
            this.snapshots.update(values => ({...values, [key]: snapshot}));
            this.sourceErrors.update(errors => { const next = {...errors}; delete next[key]; return next; });
            this.channel?.postMessage({key});
          };
          if (typeof navigator !== 'undefined' && navigator.locks) await navigator.locks.request('iih-orbit-calendar:' + key, read);
          else await read();
        } catch (error) { if (currentRun() && epoch === this.epoch) this.sourceErrors.update(errors => ({...errors, [key]: this.message(error)})); }
        finally { if (this.loadingRuns.get(key) === loadId) { this.loadingRuns.delete(key); this.loading.update(keys => { const next = new Set(keys); next.delete(key); return next; }); } }
      }
    }
  }

  status(source: CalendarSource, range = this.range()): string {
    const key = this.key(source);
    if (this.loading().has(key) || this.syncingKeys().has(key)) return '同步中';
    if (this.sourceErrors()[key]) return this.sourceErrors()[key];
    const view = calendarViewForRange(this.snapshots()[key], range);
    if (!view) return !this.online() ? '離線・目前日期沒有快取' : !this.auth.connected() ? '需連線以讀取目前日期' : '尚未讀取目前日期';
    return `${!this.online() ? '離線快取' : !this.auth.connected() ? '快取・需重新連線' : view.invalidated ? '快取・等待更新' : '已同步'} · ${new Date(view.updatedAt).toLocaleString('zh-TW', {month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'})}`;
  }
  private message(error: unknown): string { return error instanceof Error ? error.message : 'Google 月曆無法更新，已保留原有資料。'; }
  ngOnDestroy(): void {
    this.destroyed = true; this.pageHide(); clearInterval(this.timer); this.channel?.close(); this.coordinator.close();
    if (typeof window !== 'undefined') { window.removeEventListener('online', this.wake); window.removeEventListener('offline', this.wake); document.removeEventListener('visibilitychange', this.wake); window.removeEventListener('storage', this.syncStorageChanged); window.removeEventListener('focus', this.syncWake); window.removeEventListener('pagehide', this.pageHide); window.removeEventListener('pageshow', this.pageShow); }
  }
}
