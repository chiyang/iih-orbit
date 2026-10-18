import { DOCUMENT } from '@angular/common';
import { computed, effect, inject, Injectable, OnDestroy, signal, untracked } from '@angular/core';
import { BoardStore } from './board-store';
import { GoogleCalendarService } from './google-calendar';
import { ReminderDelivery } from './reminder-delivery';
import { allReminderItems, inReminderWorkspace, itemsForReminderTab, reminderItemKey, startPopupCandidates } from './reminder-items';
import type { PopupCandidate, ReminderItem, ReminderTab } from './reminder-items';
import { withStorageLock } from './storage-coordinator';
import { MAX_SEEN_REMINDERS, REMINDER_SEEN_KEY, readSeenReminders, reminderNoticeKey, reminderStage } from './reminder-attention';
import {ReminderHistory, REMINDER_HISTORY_KEY, REMINDER_HISTORY_AGE, type ReminderHistoryEntry, type ReminderHistoryUpdate} from './reminder-history';

@Injectable({providedIn: 'root'})
export class Reminders implements OnDestroy {
  readonly store = inject(BoardStore);
  readonly google = inject(GoogleCalendarService);
  private readonly document = inject(DOCUMENT);
  readonly now = signal(new Date());
  readonly active = signal(this.isActive());
  readonly blocked = signal(false);
  readonly warning = signal('');
  readonly items = computed(() => allReminderItems(this.store.workspaces(), this.store.generation(), this.google.reminderEvents()));
  readonly summaryItems = computed(() => [...new Map((['today', 'tomorrow', 'this-week', 'next-week', 'due-soon', 'overdue'] as const).flatMap(tab =>
    this.entries(tab).map(item => [reminderItemKey(item), item] as const))).values()]);
  readonly summaryCount = computed(() => this.summaryItems().length);
  private readonly seen = signal(this.loadSeen());
  readonly attentionWarning = signal('');
  readonly summaryNotices = computed(() => this.summaryItems().map(item => ({item, key: this.noticeKey(item)})));
  readonly unseenNotices = computed(() => this.summaryNotices().filter(notice => !this.seen().has(notice.key)));
  readonly unseenItems = computed(() => this.unseenNotices().map(notice => notice.item));
  readonly unseenCount = computed(() => this.unseenItems().length);
  readonly candidates = computed(() => startPopupCandidates(this.items(), this.now(), this.store.reminders()));
  readonly popups = signal<PopupCandidate[]>([]);
  private readonly delivery = new ReminderDelivery({getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value)}, withStorageLock);
  private readonly historyStorage = new ReminderHistory({getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value)}, withStorageLock);
  readonly historyWarning = signal('');
  private readonly savedHistory = signal<ReminderHistoryEntry[]>(this.loadHistory());
  readonly history = computed(() => this.savedHistory().filter(entry => entry.generation === this.store.generation() && entry.at >= this.now().getTime() - REMINDER_HISTORY_AGE).sort((a, b) => b.at - a.at || a.key.localeCompare(b.key)));
  private readonly recorded = new Set<string>();
  private readonly recordedPopups = new Set<string>();
  private readonly checked = new Set<string>();
  private running = false;
  private destroyed = false;
  private context = '';
  private readonly wake = () => { this.now.set(new Date()); this.active.set(this.isActive()); this.refreshSeen(); this.refreshHistory(); };
  private readonly seenChanged = (event: StorageEvent) => {if (!event.key || event.key === REMINDER_SEEN_KEY) this.refreshSeen(); if (!event.key || event.key === REMINDER_HISTORY_KEY) this.refreshHistory();};
  private readonly timer: ReturnType<typeof setInterval>;

  constructor() {
    effect(() => { const now = this.now(); untracked(() => this.google.setReminderMonth(now)); });
    effect(() => {
      const context = JSON.stringify([this.store.generation(), this.store.google().clientId, this.store.google().accountId]);
      const candidates = this.candidates(), active = this.active(), blocked = this.blocked();
      untracked(() => {
        if (context !== this.context) { this.context = context; this.checked.clear(); this.warning.set(''); }
        const current = new Map(candidates.map(item => [item.key, item]));
        this.popups.update(items => items.flatMap(item => current.has(item.key) ? [current.get(item.key)!] : []));
        if (active && !blocked) queueMicrotask(() => void this.deliver());
      });
    });
    effect(() => {
      const notices = this.unseenNotices(), popups = this.popups(), active = this.active(), blocked = this.blocked(), loading = this.store.storageLoading();
      untracked(() => {
        if (!active || loading) return;
        this.remember(notices.map(notice => notice.item));
        if (!blocked) for (const popup of popups) {
          const key = this.noticeKey(popup.item);
          if (!this.recordedPopups.has(key)) {this.recordedPopups.add(key); this.remember([popup.item], {popupAt: this.now().getTime()});}
        }
      });
    });
    this.timer = setInterval(this.wake, 10000);
    this.document.addEventListener('visibilitychange', this.wake);
    this.document.defaultView?.addEventListener('focus', this.wake);
    this.document.defaultView?.addEventListener('blur', this.wake);
    this.document.defaultView?.addEventListener('storage', this.seenChanged);
  }

  private loadSeen(): Set<string> {
    try {return readSeenReminders(JSON.parse(localStorage.getItem(REMINDER_SEEN_KEY) ?? 'null'));}
    catch {return new Set();}
  }
  private refreshSeen(): void {
    const saved = this.loadSeen();
    this.seen.update(current => new Set([...current, ...saved].slice(-MAX_SEEN_REMINDERS)));
  }
  entries(tab: ReminderTab, scope: 'all' | 'current' = 'all', days = this.store.reminders().dueSoonDays): ReminderItem[] {
    return itemsForReminderTab(this.items().filter(item => scope === 'all' || inReminderWorkspace(item, this.store.currentWorkspace().id)), tab, this.now(), days, this.store.workspaces());
  }
  noticeKey(item: ReminderItem): string {return reminderNoticeKey(item, this.now(), this.store.reminders().dueSoonDays, this.store.workspaces().find(workspace => workspace.id === item.workspaceId)!);}
  workspaceLabel(item: ReminderItem): string {return (item.workspaceIds ?? [item.workspaceId]).map(id => this.store.workspaces().find(workspace => workspace.id === id)?.name).filter(Boolean).join('、');}
  private loadHistory(): ReminderHistoryEntry[] {try {return this.historyStorage.read(this.now().getTime());} catch {this.historyWarning.set('無法讀取提醒歷史，仍可使用近期提醒。'); return [];}}
  private refreshHistory(): void {try {this.savedHistory.set(this.historyStorage.read(this.now().getTime()));} catch {this.historyWarning.set('無法讀取提醒歷史，仍可使用近期提醒。');}}
  private snapshot(item: ReminderItem): ReminderHistoryEntry {
    const workspace = this.store.workspaces().find(workspace => workspace.id === item.workspaceId)!, task = item.task;
    return {key: this.noticeKey(item), generation: item.generation, workspaceId: item.workspaceId, workspaceIds: item.workspaceIds ?? [item.workspaceId], workspaceName: this.workspaceLabel(item).slice(0, 1000),
      itemId: item.id, taskId: task.id, title: task.title.slice(0, 1000), source: item.external ? 'google' : 'orbit', sourceId: item.external?.source.id ?? '', sourceName: item.external?.source.name.slice(0, 1000) ?? '',
      stage: reminderStage(item, this.now(), this.store.reminders().dueSoonDays, workspace), startDate: task.startDate, startTime: task.startTime, dueDate: task.dueDate, dueTime: task.dueTime, at: this.now().getTime()};
  }
  private remember(items: readonly ReminderItem[], update: ReminderHistoryUpdate = {}): void {
    const current = items.filter(item => item.generation === this.store.generation() && this.store.workspaces().some(workspace => workspace.id === item.workspaceId));
    const additions = current.filter(item => !this.recorded.has(this.noticeKey(item))).map(item => this.snapshot(item)), keys = current.map(item => this.noticeKey(item));
    if (!additions.length && !Object.keys(update).length) return;
    for (const entry of additions) this.recorded.add(entry.key);
    this.saveHistory(additions, keys, update);
  }
  private saveHistory(additions: ReminderHistoryEntry[], keys: string[], update: ReminderHistoryUpdate): void {
    const generation = this.store.generation(), current = () => !this.destroyed && generation === this.store.generation();
    void this.historyStorage.save(additions, keys, update, this.now().getTime(), current).then(entries => {if (current()) {this.savedHistory.set(entries); this.historyWarning.set('');}})
      .catch(() => {for (const entry of additions) this.recorded.delete(entry.key); for (const key of keys) this.recordedPopups.delete(key); if (!this.destroyed) this.historyWarning.set('提醒仍可查看，但瀏覽器無法保存這次提醒歷史。');});
  }
  markHistoryRead(entries: readonly ReminderHistoryEntry[]): void {
    const keys = entries.filter(entry => entry.generation === this.store.generation()).map(entry => entry.key);
    this.saveHistory([], keys, {readAt: this.now().getTime()}); this.markKeysViewed(keys);
  }
  markViewed(items: readonly ReminderItem[] = this.summaryItems()): void {
    const identities = new Set(items.map(reminderItemKey)), notices = this.summaryNotices().filter(notice => identities.has(reminderItemKey(notice.item)));
    const fresh = notices.filter(notice => !this.seen().has(notice.key));
    if (fresh.length) this.remember(fresh.map(notice => notice.item), {readAt: this.now().getTime()});
    this.markKeysViewed(notices.map(notice => notice.key));
  }
  private markKeysViewed(keys: string[]): void {
    if (keys.every(key => this.seen().has(key))) return;
    this.seen.update(current => new Set([...current, ...keys].slice(-MAX_SEEN_REMINDERS)));
    void withStorageLock(() => {
      if (this.destroyed) return;
      const merged = new Set([...this.loadSeen(), ...this.seen()].slice(-MAX_SEEN_REMINDERS));
      localStorage.setItem(REMINDER_SEEN_KEY, JSON.stringify({version: 1, keys: [...merged]}));
      this.seen.set(merged); this.attentionWarning.set('');
    }).catch(() => this.attentionWarning.set('已在此分頁收起提醒徽章，但瀏覽器無法保存查看紀錄。'));
  }

  private isActive(): boolean { return this.document.visibilityState === 'visible' && this.document.hasFocus(); }
  resolve(item: ReminderItem): ReminderItem | undefined {
    return this.items().find(current => current.id === item.id && current.generation === item.generation && current.workspaceId === item.workspaceId);
  }
  resolveHistory(entry: ReminderHistoryEntry): ReminderItem | undefined {
    if (entry.generation !== this.store.generation()) return;
    if (entry.source === 'google') return this.items().find(item => item.external && item.id === entry.itemId && item.external.source.id === entry.sourceId);
    const workspace = this.store.workspaces().find(workspace => workspace.id === entry.workspaceId), task = workspace?.tasks.find(task => task.id === entry.taskId && !task.deletedAt);
    return task && workspace ? {id: entry.itemId, generation: entry.generation, workspaceId: workspace.id, task, start: null, allDay: !task.startTime, historical: true} : undefined;
  }
  dismiss(key: string): void {
    const popup = this.popups().find(popup => popup.key === key);
    if (popup) this.remember([popup.item], {dismissedAt: this.now().getTime()});
    this.popups.update(items => items.filter(item => item.key !== key)); queueMicrotask(() => void this.deliver());
  }

  private async deliver(): Promise<void> {
    if (this.running || this.destroyed) return;
    this.running = true;
    try {
      while (!this.destroyed && this.active() && !this.blocked() && this.popups().length < 3) {
        const candidate = this.candidates().find(item => !this.checked.has(item.key));
        if (!candidate) break;
        const context = this.context;
        this.checked.add(candidate.key);
        const claimed = await this.delivery.claim(candidate.key, candidate.expires, this.now().getTime());
        if (context !== this.context || this.destroyed) continue;
        if (claimed) {
          const current = this.candidates().find(item => item.key === candidate.key);
          if (current) this.popups.update(items => [...items, current]);
        }
      }
    } catch (error) {
      this.warning.set(error instanceof Error && error.message.includes('提醒記錄已滿') ? error.message : '無法保存跨分頁提醒記錄，已暫停自動提示；仍可使用訊息提醒。');
    } finally { this.running = false; }
  }

  ngOnDestroy(): void {
    this.destroyed = true; clearInterval(this.timer);
    this.document.removeEventListener('visibilitychange', this.wake);
    this.document.defaultView?.removeEventListener('focus', this.wake);
    this.document.defaultView?.removeEventListener('blur', this.wake);
    this.document.defaultView?.removeEventListener('storage', this.seenChanged);
  }
}
