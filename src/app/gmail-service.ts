import { computed, effect, inject, Injectable, OnDestroy, signal, untracked } from '@angular/core';
import { BoardStore } from './board-store';
import { GmailAuth } from './gmail-auth';
import { GmailApi, MailCursor, mailHasMore, mapMailRequests, newMailCursor } from './gmail-api';
import { mailLabelName, MailLabel, MailPreview, MailThreadSummary } from './gmail-data';
import { GmailPreviewCache, MAIL_CACHE_TTL } from './gmail-cache';
import { validClientId } from './google-data';
import type { GoogleAccount } from './google-auth';

const PREFERENCES = 'iih-orbit-gmail-preferences-v1', TTL = MAIL_CACHE_TTL;
interface MailPreferences {generation: string; clientId: string; accountId: string; email: string; selected: string[]}
type ThreadSummary = MailThreadSummary;
@Injectable({providedIn: 'root'})
export class GmailService implements OnDestroy {
  readonly store = inject(BoardStore);
  readonly auth = inject(GmailAuth);
  readonly preferences = signal<MailPreferences>(this.readPreferences());
  readonly clientId = computed(() => this.store.google().clientId || this.preferences().clientId);
  readonly labels = signal<MailLabel[]>([]);
  readonly selected = computed(() => this.preferences().selected);
  readonly labelIndex = computed(() => new Map(this.labels().map(label => [label.id, label])));
  readonly selectedNames = computed(() => this.selected().map(id => { const label = this.labelIndex().get(id); return label ? mailLabelName(label) : id === 'INBOX' ? '收件匣' : '暫不可用的標籤'; }));
  readonly messages = signal<MailPreview[]>([]);
  private readonly summaries = signal<ThreadSummary[]>([]);
  readonly expandedMessages = signal<MailPreview[]>([]);
  readonly query = signal('');
  readonly newThreadIds = signal(new Set<string>());
  readonly arrivalWarning = signal('');
  readonly threads = computed(() => {
    const groups = new Map<string, MailPreview[]>();
    for (const mail of this.messages()) { const group = groups.get(mail.threadId) ?? []; group.push(mail); groups.set(mail.threadId, group); }
    const summaries = new Map(this.summaries().map(summary => [summary.mail.threadId, summary]));
    return [...groups.entries()].map(([id, messages]) => {
      messages.sort((a, b) => a.receivedAt - b.receivedAt || a.id.localeCompare(b.id));
      const summary = summaries.get(id);
      return {mail: summary?.mail ?? messages[0], messages, count: summary?.count ?? messages.length, unread: summary?.unread ?? messages.some(mail => mail.labelIds.includes('UNREAD'))};
    });
  });
  readonly busy = signal(false);
  readonly error = signal('');
  readonly warning = signal('');
  readonly updatedAt = signal(0);
  readonly showingPrevious = signal(false);
  readonly hasMore = signal(false);
  readonly active = signal(false);
  readonly online = signal(navigator.onLine !== false);
  private readonly api = new GmailApi((path, parameters, signal) => this.auth.api(path, parameters, signal));
  private cursor?: MailCursor;
  private epoch = 0;
  private identity = '';
  private pending?: Promise<void>;
  private listController?: AbortController;
  private destroyed = false;
  private configuration = '';
  private readonly cache = new GmailPreviewCache();
  private readonly failedLoads = new Map<string, {retryAt: number; message: string}>();
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private readonly refreshListeners = new Set<() => Promise<void>>();
  private readonly threadCache = new Map<string, {updatedAt: number; messages: MailPreview[]}>();
  private readonly threadPending = new Map<string, Promise<MailPreview[]>>();
  private threadIdentity = '';
  private readonly wake = () => { this.online.set(navigator.onLine !== false); if (this.active() && document.visibilityState === 'visible' && this.online()) void this.load(); };
  private readonly changed = (event: StorageEvent) => { if (event.key === PREFERENCES) this.preferences.set(this.readPreferences()); };
  constructor() {
    effect(() => {
      if (this.store.storageLoading?.()) return;
      const generation = this.store.generation(), preferences = this.preferences(), clientId = this.clientId();
      untracked(() => {
        if (preferences.generation !== generation) {
          this.auth.disconnect(); this.clearCache();
          this.preferences.set({generation, clientId: '', accountId: '', email: '', selected: ['INBOX']}); this.savePreferences(); return;
        }
        if (preferences.clientId && preferences.clientId !== clientId) {
          this.auth.useSession({generation, clientId: preferences.clientId, accountId: preferences.accountId});
          this.auth.disconnect(); this.clearCache(); this.query.set('');
          this.preferences.set({generation, clientId, accountId: '', email: '', selected: ['INBOX']}); this.savePreferences();
          this.auth.useSession({generation, clientId, accountId: ''}); return;
        }
        this.auth.useSession({generation, clientId, accountId: preferences.accountId});
      });
    });
    effect(() => {
      if (this.store.storageLoading?.()) return;
      const identity = JSON.stringify([this.store.generation(), this.clientId(), this.preferences().accountId, this.preferences().email, this.selected(), this.query(), this.auth.connectionVersion()]);
      const connected = this.auth.connected(), active = this.active();
      untracked(() => {
        if (identity !== this.identity) {
          this.listController?.abort();
          const configuration = JSON.stringify([this.store.generation(), this.clientId(), this.preferences().accountId]);
          const sameAccount = this.configuration === configuration;
          if (!sameAccount) {
            if (this.configuration) this.clearCache();
            else this.api.clearCache();
          }
          this.configuration = configuration;
          this.identity = identity; this.epoch++; this.pending = undefined; this.busy.set(false); this.error.set(''); this.cursor = undefined; this.hasMore.set(false);
          if (!sameAccount) {this.labels.set([]); this.messages.set([]); this.summaries.set([]);}
          this.showingPrevious.set(sameAccount && this.messages().length > 0);
          this.expandedMessages.set([]); this.updatedAt.set(0); this.hydrate();
          const failure = this.failedLoads.get(this.scope());
          if (failure && failure.retryAt > Date.now()) this.error.set(failure.message);
        }
        clearTimeout(this.refreshTimer);
        if (active && connected && !this.auth.authorizing()) this.refreshTimer = setTimeout(() => void this.load(), 400);
      });
    });
    effect(() => { const identity = this.previewIdentity(); untracked(() => this.useThreadIdentity(identity)); });
    window.addEventListener('online', this.wake); window.addEventListener('offline', this.wake); window.addEventListener('storage', this.changed); document.addEventListener('visibilitychange', this.wake);
  }
  private readPreferences(): MailPreferences {
    const fallback = {generation: this.store.generation(), clientId: '', accountId: '', email: '', selected: ['INBOX']};
    try {
      const saved = JSON.parse(localStorage.getItem(PREFERENCES) ?? 'null') as MailPreferences;
      if (!saved || typeof saved.generation !== 'string' || typeof saved.clientId !== 'string' || saved.clientId && !validClientId(saved.clientId) || typeof saved.accountId !== 'string' || typeof saved.email !== 'string' || saved.email.length > 320 || !Array.isArray(saved.selected) || !saved.selected.every(id => typeof id === 'string' && id.length <= 300)) return fallback;
      return {generation: saved.generation, clientId: saved.clientId, accountId: saved.accountId, email: saved.email, selected: [...new Set(saved.selected)]};
    } catch { return fallback; }
  }
  private savePreferences(): void {
    try { localStorage.setItem(PREFERENCES, JSON.stringify(this.preferences())); }
    catch { this.warning.set('Gmail 設定無法保存，重新整理後需重新設定。'); }
  }
  async prepare(): Promise<void> { try { await this.auth.prepare(); } catch (error) { this.error.set(error instanceof Error ? error.message : '無法載入 Google 授權元件。'); } }
  async connect(authorize?: () => Promise<GoogleAccount>, activate?: () => void): Promise<void> {
    if (!validClientId(this.clientId()) || this.auth.authorizing()) return;
    this.error.set('');
    this.auth.useSession({clientId: this.clientId(), generation: this.store.generation(), accountId: this.preferences().accountId});
    const generation = this.store.generation(), clientId = this.clientId();
    try {
      const account = await (authorize ? authorize() : this.auth.authorize(clientId));
      if (this.destroyed || generation !== this.store.generation() || clientId !== this.clientId()) return;
      const changedAccount = account.id !== this.preferences().accountId;
      if (changedAccount) this.clearCache();
      this.preferences.set({...this.preferences(), clientId, accountId: account.id, email: account.email, selected: changedAccount ? ['INBOX'] : this.selected()}); this.savePreferences();
      this.auth.useSession({clientId, generation, accountId: account.id});
      activate?.();
    } catch (error) { if (generation === this.store.generation() && clientId === this.clientId()) this.error.set(error instanceof Error ? error.message : 'Gmail 授權失敗。'); }
  }
  disconnect(): void {
    this.auth.disconnect(); this.clearCache(); this.preferences.set({...this.preferences(), accountId: '', email: '', selected: ['INBOX']}); this.savePreferences();
  }
  applyLabels(ids: string[]): void {
    const selected = [...new Set(ids)];
    if (JSON.stringify([...selected].sort()) === JSON.stringify([...this.selected()].sort())) return;
    this.listController?.abort(); this.preferences.set({...this.preferences(), selected}); this.savePreferences();
  }
  search(value: string): void { const query = value.trim().slice(0, 500); if (query !== this.query()) {this.listController?.abort(); this.query.set(query);} }
  previewIdentity(): string { return JSON.stringify([this.store.generation(), this.clientId(), this.preferences().accountId, this.preferences().email, this.auth.connectionVersion()]); }
  isListed(mail: MailPreview): boolean {
    const ids = new Set(this.threads().map(thread => thread.mail.threadId));
    return [...this.messages(), ...this.threads().map(thread => thread.mail), ...this.expandedMessages().filter(mail => ids.has(mail.threadId))].some(item => JSON.stringify(item) === JSON.stringify(mail));
  }
  private useThreadIdentity(identity: string): void {
    if (identity === this.threadIdentity) return;
    this.threadIdentity = identity; this.threadCache.clear(); this.threadPending.clear(); this.expandedMessages.set([]);
  }
  async readThread(mail: MailPreview, identity: string, force = false): Promise<MailPreview[]> {
    const current = () => !this.destroyed && identity === this.previewIdentity() && !!this.preferences().accountId && this.auth.account()?.id === this.preferences().accountId;
    if (!current()) throw new Error('Gmail 帳號已變更，請重新選擇郵件。');
    this.useThreadIdentity(identity);
    const cached = this.threadCache.get(mail.threadId);
    if (!force && cached && Date.now() - cached.updatedAt < TTL) return structuredClone(cached.messages);
    const pending = this.threadPending.get(mail.threadId);
    if (pending) { const messages = await pending; if (!current()) throw new Error('Gmail 帳號已變更，請重新選擇郵件。'); return structuredClone(messages); }
    if (!this.auth.connected()) throw new Error('請重新連線原 Gmail 帳號。');
    if (navigator.onLine === false) throw new Error('目前離線，無法更新討論串。');
    const run = (async () => {
      const messages = await this.api.thread(mail.threadId);
      if (!current()) throw new Error('Gmail 帳號已變更，請重新選擇郵件。');
      if (messages.length <= 400) {
        this.threadCache.delete(mail.threadId); this.threadCache.set(mail.threadId, {updatedAt: Date.now(), messages});
        while (this.threadCache.size > 8 || [...this.threadCache.values()].reduce((sum, entry) => sum + entry.messages.length, 0) > 400) this.threadCache.delete(this.threadCache.keys().next().value!);
      }
      this.summaries.update(entries => entries.map(entry => entry.mail.threadId === mail.threadId ? {mail: messages[0], count: messages.length, unread: messages.some(mail => mail.labelIds.includes('UNREAD'))} : entry));
      if (this.updatedAt() && !this.showingPrevious()) this.persistCache();
      return messages;
    })();
    this.threadPending.set(mail.threadId, run);
    try { return structuredClone(await run); }
    finally { if (this.threadPending.get(mail.threadId) === run) this.threadPending.delete(mail.threadId); }
  }
  onRefreshed(listener: () => Promise<void>): () => void {
    this.refreshListeners.add(listener);
    return () => {this.refreshListeners.delete(listener);};
  }
  async load(force = false, more = false): Promise<void> {
    if (!this.auth.connected() || navigator.onLine === false) return;
    if (this.pending) return this.pending;
    if (!force && !more && (this.failedLoads.get(this.scope())?.retryAt ?? 0) > Date.now()) return;
    if (!force && !more && this.updatedAt() && Date.now() - this.updatedAt() < TTL) return;
    const epoch = this.epoch, scope = this.scope(), selected = [...this.selected()], accountId = this.preferences().accountId;
    if (!accountId || this.auth.account()?.id !== accountId) return;
    const controller = new AbortController(), identity = this.previewIdentity(); this.listController = controller;
    const current = () => epoch === this.epoch && scope === this.scope() && identity === this.previewIdentity() && !this.destroyed && this.auth.account()?.id === accountId;
    this.busy.set(true); this.error.set('');
    const run = (async () => {
      try {
        const labels = force || !this.labels().length ? await this.api.labels(controller.signal) : this.labels();
        if (!current() || controller.signal.aborted) return;
        const allowed = selected.filter(id => labels.some(label => label.id === id));
        // Removed labels must never widen the filter into all mail without an explicit selection.
        if (allowed.length !== selected.length) {
          this.labels.set(labels); this.error.set('部分已選標籤已不存在，請重新選擇標籤或切換收件匣。'); return;
        }
        // Persisted previews have no cursor. Rebuild their prefix before requesting the next page.
        let cursor = more && !this.showingPrevious() ? this.cursor : undefined;
        let prefix: MailPreview[] = [];
        if (more && !cursor && this.updatedAt() && !this.showingPrevious()) {
          const rebuilt = await this.api.page(newMailCursor(allowed, this.query()), Math.max(25, this.messages().length), controller.signal);
          cursor = rebuilt.cursor; prefix = rebuilt.messages;
        }
        if (!current() || controller.signal.aborted) return;
        const page = await this.api.page(cursor ?? newMailCursor(allowed, this.query()), 25, controller.signal, force);
        if (!current() || controller.signal.aborted) return;
        if (prefix.length) page.messages = [...prefix, ...page.messages];
        const append = more && !!this.cursor && !this.showingPrevious();
        const summaries = new Map((append ? this.summaries() : []).map(summary => [summary.mail.threadId, summary]));
        // A matching reply may be on the first page while the original is outside the filter.
        // Read the minimal index and first preview; reply previews are loaded only on expansion.
        const ids = [...new Set(page.messages.map(mail => mail.threadId))].filter(id => !summaries.has(id));
        const resolved = await mapMailRequests(ids, async (id, signal) => {
          try {
            return await this.api.summary(id, page.messages, signal, force);
          } catch (error) { if ((error as {status?: number})?.status === 404) return null; throw error; }
        }, controller.signal);
        if (!current() || controller.signal.aborted) return;
        for (const summary of resolved) if (summary) summaries.set(summary.mail.threadId, summary);
        const messages = page.messages.filter(mail => summaries.has(mail.threadId));
        if (force) this.threadCache.clear();
        this.labels.set(labels); this.cursor = page.cursor; this.hasMore.set(mailHasMore(page.cursor));
        this.summaries.set([...summaries.values()]);
        this.messages.set(append ? [...this.messages(), ...messages.filter(mail => !this.messages().some(old => old.id === mail.id))] : messages);
        this.showingPrevious.set(false); this.updatedAt.set(Date.now()); this.failedLoads.delete(scope); this.persistCache();
        // Finish arrival checks before a newly opened panel acknowledges this batch.
        if (!more) await Promise.all([...this.refreshListeners].map(listener => listener()));
      } catch (error) {
        if (current() && !controller.signal.aborted) {
          const message = error instanceof Error ? error.message : '無法讀取 Gmail 郵件，請重試。';
          this.error.set(message); this.failedLoads.set(scope, {retryAt: Date.now() + 30000, message});
          while (this.failedLoads.size > 6) this.failedLoads.delete(this.failedLoads.keys().next().value!);
        }
      }
    })(); this.pending = run;
    try { await run; }
    finally { if (this.pending === run) { this.busy.set(false); this.pending = undefined; } if (this.listController === controller) this.listController = undefined; }
  }
  private scope(): string { return JSON.stringify([this.store.generation(), this.clientId(), this.preferences().accountId, [...this.selected()].sort(), this.query()]); }
  private hydrate(): void {
    if (!this.preferences().accountId) return;
    const saved = this.cache.get(this.scope());
    if (!saved) return;
    if (!this.labels().length) this.labels.set(saved.labels);
    this.summaries.set(saved.summaries); this.messages.set(saved.messages);
    this.cursor = saved.cursor; this.hasMore.set(saved.hasMore); this.showingPrevious.set(false);
    // A reload must preserve the successful read time instead of making fresh previews stale.
    this.updatedAt.set(saved.updatedAt);
  }
  private persistCache(): void {
    if (this.showingPrevious()) return;
    try { this.cache.put({scope: this.scope(), labels: this.labels(), messages: this.messages(), summaries: this.summaries(), updatedAt: this.updatedAt(), cursor: this.cursor, hasMore: this.hasMore()}); }
    catch { this.warning.set('郵件已讀取，但無法保存離線預覽；重新整理後會重新讀取。'); }
  }
  private clearCache(): void { this.api.clearCache(); this.failedLoads.clear(); try { this.cache.clear(); } catch { this.warning.set('無法清理郵件預覽快取。'); } }
  ngOnDestroy(): void { this.destroyed = true; this.epoch++; this.listController?.abort(); this.refreshListeners.clear(); this.threadCache.clear(); this.threadPending.clear(); this.expandedMessages.set([]); clearTimeout(this.refreshTimer); window.removeEventListener('online', this.wake); window.removeEventListener('offline', this.wake); window.removeEventListener('storage', this.changed); document.removeEventListener('visibilitychange', this.wake); }
}
