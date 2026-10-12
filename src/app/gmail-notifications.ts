import { computed, effect, inject, Injectable, OnDestroy, signal, untracked } from '@angular/core';
import { GmailService } from './gmail-service';
import { GmailArrivalState, GmailArrivalTracker, readGmailArrivalState } from './gmail-arrivals';

const STORAGE_KEY = 'iih-orbit-gmail-arrivals-v1';
@Injectable({providedIn: 'root'})
export class GmailNotifications implements OnDestroy {
  readonly gmail = inject(GmailService);
  readonly state = signal<GmailArrivalState | undefined>(undefined);
  readonly count = computed(() => this.state()?.pending.length ?? 0);
  readonly checking = signal(false);
  readonly warning = signal('');
  private readonly storageWarning = signal('');
  private context = '';
  private tracker?: GmailArrivalTracker;
  private destroyed = false;
  private lastCheck = 0;
  private pending?: Promise<void>;
  private readonly wake = () => {void this.check();};
  private readonly storageChanged = (event: StorageEvent) => {if (event.key === STORAGE_KEY) this.adoptStored();};
  private readonly timer: ReturnType<typeof setInterval>;
  constructor() {
    effect(() => {const message = this.warning() || this.storageWarning(); untracked(() => this.gmail.arrivalWarning.set(message));});
    effect(() => {
      const context = JSON.stringify([this.gmail.store.generation(), this.gmail.clientId(), this.gmail.preferences().accountId]);
      const connected = this.gmail.auth.connected(), version = this.gmail.auth.connectionVersion();
      untracked(() => {
        if (context !== this.context) {
          this.context = context; this.lastCheck = 0; this.pending = undefined; this.checking.set(false); this.warning.set(''); this.storageWarning.set('');
          let initial;
          try {initial = readGmailArrivalState(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'), context);} catch { /* Begin with an empty local notification baseline. */ }
          this.state.set(initial); this.gmail.newThreadIds.set(new Set(initial?.pending.map(mail => mail.threadId)));
          this.tracker = new GmailArrivalTracker(context, (path, parameters) => this.gmail.auth.api(path, parameters), initial, state => {
            if (this.context !== context || this.destroyed) return;
            this.state.set(state); this.gmail.newThreadIds.set(new Set(state.pending.map(mail => mail.threadId)));
            try {localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); this.storageWarning.set('');} catch {this.storageWarning.set('新郵件提示無法保存，重新整理後會重新檢查。');}
          });
        }
        if (connected && version) void this.check();
      });
    });
    this.timer = setInterval(this.wake, 60000);
    window.addEventListener('online', this.wake); window.addEventListener('focus', this.wake); document.addEventListener('visibilitychange', this.wake);
    window.addEventListener('storage', this.storageChanged);
  }
  private adoptStored(): void {
    try {
      const state = readGmailArrivalState(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'), this.context);
      if (state) this.tracker?.adopt(state);
    } catch { /* Keep this page's notification and viewing state. */ }
  }
  acknowledgeCurrent(identity: string): boolean {
    if (this.destroyed || identity !== this.gmail.previewIdentity() || !this.tracker
      || this.context !== JSON.stringify([this.gmail.store.generation(), this.gmail.clientId(), this.gmail.preferences().accountId])) return false;
    this.adoptStored();
    const ids = this.state()?.pending.map(mail => mail.id) ?? [];
    if (ids.length) this.tracker.acknowledge(ids);
    return true;
  }
  check(force = false): Promise<void> {
    this.adoptStored();
    if (this.pending) return this.pending;
    if (this.destroyed || !this.tracker || !this.gmail.auth.connected() || !this.gmail.preferences().accountId || navigator.onLine === false || document.visibilityState === 'hidden' || !force && Date.now() - this.lastCheck < 60000) return Promise.resolve();
    const context = this.context, version = this.gmail.auth.connectionVersion(), tracker = this.tracker;
    const current = () => !this.destroyed && context === this.context && version === this.gmail.auth.connectionVersion() && this.gmail.auth.connected();
    this.lastCheck = Date.now(); this.checking.set(true);
    const run = tracker.check(current).then(() => {if (current()) this.warning.set('');}).catch(error => {if (current()) this.warning.set(error instanceof Error ? error.message : '暫時無法檢查新郵件。');}).finally(() => {if (this.pending === run) {this.pending = undefined; this.checking.set(false);}});
    this.pending = run; return run;
  }
  ngOnDestroy(): void {
    this.destroyed = true; clearInterval(this.timer);
    window.removeEventListener('online', this.wake); window.removeEventListener('focus', this.wake); document.removeEventListener('visibilitychange', this.wake);
    window.removeEventListener('storage', this.storageChanged);
  }
}
