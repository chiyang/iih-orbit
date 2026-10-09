import { DOCUMENT } from '@angular/common';
import { computed, effect, inject, Injectable, OnDestroy, signal, untracked } from '@angular/core';
import { BoardStore } from './board-store';
import { GoogleCalendarService } from './google-calendar';
import { ReminderDelivery } from './reminder-delivery';
import { itemsForReminderTab, reminderItems, startPopupCandidates } from './reminder-items';
import type { PopupCandidate, ReminderItem } from './reminder-items';
import { withStorageLock } from './storage-coordinator';

@Injectable({providedIn: 'root'})
export class Reminders implements OnDestroy {
  readonly store = inject(BoardStore);
  readonly google = inject(GoogleCalendarService);
  private readonly document = inject(DOCUMENT);
  readonly now = signal(new Date());
  readonly active = signal(this.isActive());
  readonly blocked = signal(false);
  readonly warning = signal('');
  readonly items = computed(() => reminderItems(this.store.currentWorkspace(), this.store.generation(), this.google.reminderEvents()));
  readonly summaryCount = computed(() => new Set((['today', 'tomorrow', 'next-week', 'due-soon', 'overdue'] as const).flatMap(tab =>
    itemsForReminderTab(this.items(), tab, this.now(), this.store.reminders().dueSoonDays, this.store.currentWorkspace()).map(item => item.id))).size);
  readonly candidates = computed(() => startPopupCandidates(this.items(), this.now(), this.store.reminders()));
  readonly popups = signal<PopupCandidate[]>([]);
  private readonly delivery = new ReminderDelivery({getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value)}, withStorageLock);
  private readonly checked = new Set<string>();
  private running = false;
  private destroyed = false;
  private context = '';
  private readonly wake = () => { this.now.set(new Date()); this.active.set(this.isActive()); };
  private readonly timer: ReturnType<typeof setInterval>;

  constructor() {
    effect(() => { const now = this.now(); untracked(() => this.google.setReminderMonth(now)); });
    effect(() => {
      const context = JSON.stringify([this.store.generation(), this.store.currentWorkspace().id, this.store.google().clientId, this.store.google().accountId]);
      const candidates = this.candidates(), active = this.active(), blocked = this.blocked();
      untracked(() => {
        if (context !== this.context) { this.context = context; this.checked.clear(); this.warning.set(''); }
        const current = new Map(candidates.map(item => [item.key, item]));
        this.popups.update(items => items.flatMap(item => current.has(item.key) ? [current.get(item.key)!] : []));
        if (active && !blocked) queueMicrotask(() => void this.deliver());
      });
    });
    this.timer = setInterval(this.wake, 10000);
    this.document.addEventListener('visibilitychange', this.wake);
    this.document.defaultView?.addEventListener('focus', this.wake);
    this.document.defaultView?.addEventListener('blur', this.wake);
  }

  private isActive(): boolean { return this.document.visibilityState === 'visible' && this.document.hasFocus(); }
  resolve(item: ReminderItem): ReminderItem | undefined {
    return this.items().find(current => current.id === item.id && current.generation === item.generation && current.workspaceId === item.workspaceId);
  }
  dismiss(key: string): void { this.popups.update(items => items.filter(item => item.key !== key)); queueMicrotask(() => void this.deliver()); }

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
      this.warning.set(error instanceof Error && error.message.includes('提醒記錄已滿') ? error.message : '無法保存跨分頁提醒記錄，已暫停自動提示；仍可使用訊息中心。');
    } finally { this.running = false; }
  }

  ngOnDestroy(): void {
    this.destroyed = true; clearInterval(this.timer);
    this.document.removeEventListener('visibilitychange', this.wake);
    this.document.defaultView?.removeEventListener('focus', this.wake);
    this.document.defaultView?.removeEventListener('blur', this.wake);
  }
}
