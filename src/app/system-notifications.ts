import {DOCUMENT} from '@angular/common';
import {computed, effect, inject, Injectable, OnDestroy, signal, untracked} from '@angular/core';
import {BoardStore} from './board-store';
import {Reminders} from './reminders';
import {startPopupCandidates, type PopupCandidate, type ReminderItem} from './reminder-items';
import {BrowserNotifications} from './browser-notifications';
import {withStorageLock} from './storage-coordinator';
import {DEFAULT_SYSTEM_NOTIFICATIONS, readNotificationTarget, readSystemNotificationPreferences, SYSTEM_NOTIFICATION_KEY, SYSTEM_NOTIFICATION_TAG, SystemNotificationDelivery, type NotificationTarget, type SystemNotificationPreferences} from './system-notification-data';

@Injectable({providedIn: 'root'})
export class SystemNotifications implements OnDestroy {
  readonly store = inject(BoardStore);
  readonly reminders = inject(Reminders);
  readonly browser = inject(BrowserNotifications);
  private readonly document = inject(DOCUMENT);
  readonly warning = signal('');
  readonly message = signal('');
  readonly preferences = signal(this.load());
  readonly permission = signal(this.browser.permission());
  readonly busy = signal(false);
  readonly blocked = signal(false);
  readonly openRequest = signal<NotificationTarget | null>(null);
  readonly candidates = computed(() => startPopupCandidates(this.reminders.items(), this.reminders.now(), {...this.preferences(), popupEnabled: true, dueSoonDays: this.store.reminders().dueSoonDays}));
  private readonly delivery = new SystemNotificationDelivery({getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value)}, withStorageLock);
  private generation = this.store.generation();
  private running = false;
  private destroyed = false;
  private retryAfter = 0;
  private readonly visible = new Map<string, {close: () => void; target: NotificationTarget}>();
  private readonly checked = new Set<string>();
  private readonly received = (event: MessageEvent) => {if (event.data?.type === 'iih-orbit-notification-open') {const target = readNotificationTarget(event.data.target); if (target) this.openRequest.set(target);}};
  private readonly refresh = () => {this.preferences.set(this.load()); this.permission.set(this.browser.permission()); this.reminders.now.set(new Date());};
  private readonly storageChanged = (event: StorageEvent) => {if (!event.key || event.key === SYSTEM_NOTIFICATION_KEY) this.refresh();};
  constructor() {
    effect(() => {
      const generation = this.store.generation(), loading = this.store.storageLoading(), prefs = this.preferences(), candidates = this.candidates(), blocked = this.blocked(); this.reminders.now();
      untracked(() => {
        this.permission.set(this.browser.permission());
        if (generation !== this.generation) {this.generation = generation; this.checked.clear(); this.preferences.set(this.load()); if (this.openRequest()?.generation !== generation) this.openRequest.set(null);}
        if (loading) return;
        this.reconcile();
        const live = new Set(candidates.map(item => this.key(item)));
        for (const [key, shown] of this.visible) if (!live.has(key) || !prefs.enabled || this.permission() !== 'granted' || shown.target.generation !== generation) {shown.close(); this.visible.delete(key);}
        if (!loading && !blocked && prefs.enabled && this.permission() === 'granted') queueMicrotask(() => void this.deliver());
      });
    });
    const view = this.document.defaultView;
    view?.addEventListener('focus', this.refresh); view?.addEventListener('storage', this.storageChanged); this.document.addEventListener('visibilitychange', this.refresh);
    view?.navigator.serviceWorker?.addEventListener('message', this.received);
    try {
      if (view?.location.hash.startsWith('#orbit-notification=')) {const raw = view.location.hash.slice(20); if (raw.length <= 14000) this.openRequest.set(readNotificationTarget(JSON.parse(decodeURIComponent(raw)))); view.history.replaceState(null, '', view.location.pathname + view.location.search);}
    } catch {this.message.set('通知內容無法讀取，請查看提醒歷史。');}
  }
  private load(): SystemNotificationPreferences {
    try {return readSystemNotificationPreferences(JSON.parse(localStorage.getItem(SYSTEM_NOTIFICATION_KEY) ?? 'null'));}
    catch {this.warning.set('無法讀取通知偏好，系統通知已暫停。'); return {...DEFAULT_SYSTEM_NOTIFICATIONS};}
  }
  setOptions(patch: Partial<Omit<SystemNotificationPreferences, 'revision'>>): boolean {
    const next = {...this.preferences(), ...patch, revision: crypto.randomUUID()}, parsed = readSystemNotificationPreferences({version: 1, ...next});
    if (parsed.revision !== next.revision) {this.warning.set('請確認通知時間與選項。'); return false;}
    try {localStorage.setItem(SYSTEM_NOTIFICATION_KEY, JSON.stringify({version: 1, ...next})); this.preferences.set(next); this.warning.set(''); this.retryAfter = 0; if (!next.enabled) this.reconcile(); return true;}
    catch {if (patch.enabled === false) {this.preferences.update(value => ({...value, enabled: false})); this.reconcile();} this.warning.set('無法儲存通知偏好；若已停用，本分頁會先停止通知，其他分頁請另行確認。'); return false;}
  }
  async enable(): Promise<void> {
    if (this.busy()) return;
    this.message.set(''); this.warning.set(''); const permission = this.browser.permission(); this.permission.set(permission);
    if (permission === 'unsupported') {this.warning.set('此瀏覽環境無法使用系統通知，仍可查看程式內提醒。'); return;}
    if (permission === 'denied') {this.warning.set('瀏覽器已封鎖通知，請在網站設定允許後再啟用。'); return;}
    this.busy.set(true); const generation = this.store.generation(), revision = this.preferences().revision;
    try {
      const allowed = permission === 'granted' ? permission : await this.browser.requestPermission(); this.permission.set(allowed);
      if (generation !== this.store.generation() || this.destroyed || this.load().revision !== revision) return;
      if (allowed === 'granted') {if (this.setOptions({enabled: true})) this.message.set('已啟用此瀏覽器的系統通知。');}
      else this.message.set(allowed === 'denied' ? '未允許系統通知；程式內提醒仍可使用。' : '尚未允許通知，可以稍後再啟用。');
    } catch {this.warning.set('無法啟用系統通知，請確認瀏覽器的網站通知設定。');}
    finally {this.busy.set(false);}
  }
  disable(): void {if (this.setOptions({enabled: false})) this.message.set('已停用此瀏覽器的系統通知。');}
  async test(): Promise<void> {
    if (this.busy() || !this.preferences().enabled || this.browser.permission() !== 'granted') return;
    this.busy.set(true); this.message.set('正在發送測試通知…'); this.warning.set('');
    try {await this.browser.show('iih Orbit 測試通知', '程式保持開啟期間，會依你設定的開始時間提醒。', 'iih-orbit-test:' + crypto.randomUUID(), null, () => {}); this.message.set('測試通知已交給瀏覽器；顯示與聲音依系統設定。');}
    catch {this.message.set(''); this.warning.set('測試通知未送出，請確認系統通知權限；手機可能需要先安裝並開啟 PWA。');}
    finally {this.busy.set(false);}
  }
  private sourceContext(item: ReminderItem): string {return item.external ? JSON.stringify([this.store.google().clientId, this.store.google().accountId]) : '';}
  private key(candidate: PopupCandidate): string {return JSON.stringify([candidate.key, this.sourceContext(candidate.item)]);}
  private target(item: ReminderItem): NotificationTarget {return {version: 1, generation: item.generation, workspaceId: item.workspaceId, itemId: item.id, sourceContext: this.sourceContext(item)};}
  resolve(target: NotificationTarget): ReminderItem | undefined {
    if (target.generation !== this.store.generation()) return;
    const current = this.reminders.items().find(item => item.workspaceId === target.workspaceId && item.id === target.itemId && this.sourceContext(item) === target.sourceContext);
    if (current) return current;
    if (target.sourceContext || !target.itemId.startsWith('orbit:')) return;
    const workspace = this.store.workspaces().find(item => item.id === target.workspaceId), task = workspace?.tasks.find(item => 'orbit:' + item.id === target.itemId && !item.deletedAt);
    return task ? {id: target.itemId, generation: target.generation, workspaceId: target.workspaceId, task, allDay: !task.startTime, start: null, historical: true} : undefined;
  }
  private reconcile(): void {void this.browser.reconcile(() => new Set(this.preferences().enabled && this.load().enabled && this.browser.permission() === 'granted' ? this.candidates().map(item => SYSTEM_NOTIFICATION_TAG + this.key(item)) : []));}
  private valid(candidate: PopupCandidate, revision: string): boolean {
    const stored = this.load();
    return !this.destroyed && !this.blocked() && !this.store.storageLoading() && this.preferences().enabled && stored.enabled && stored.revision === revision && this.browser.permission() === 'granted'
      && candidate.item.generation === this.store.generation() && this.candidates().some(current => this.key(current) === this.key(candidate) && JSON.stringify(current.item.task) === JSON.stringify(candidate.item.task));
  }
  private async deliver(): Promise<void> {
    if (this.running || this.destroyed || Date.now() < this.retryAfter) return;
    this.running = true;
    try {
      const revision = this.preferences().revision;
      let sent = 0, attempts = 0;
      for (const candidate of this.candidates()) {
        const candidateKey = this.key(candidate); if (this.checked.has(candidateKey)) continue;
        if (++attempts > 10 || sent >= 3) break;
        if (!this.valid(candidate, revision)) break;
        const key = this.key(candidate), now = this.reminders.now().getTime(), token = await this.delivery.reserve(key, candidate.expires, now, () => this.valid(candidate, revision));
        if (!token) {if (this.valid(candidate, revision)) this.checked.add(key); continue;}
        if (!this.valid(candidate, revision)) {await this.delivery.release(key, token, now); continue;}
        let close: () => void;
        try {
          const item = candidate.item, minutes = Math.ceil((item.start! - now) / 60000), label = item.allDay ? '今天的全天安排' : minutes > 0 ? minutes + ' 分鐘後開始' : '剛剛開始';
          close = await this.browser.show(item.task.title, `${label} · ${this.reminders.workspaceLabel(item)}`, SYSTEM_NOTIFICATION_TAG + key, this.target(item), target => this.openRequest.set(target));
        } catch (error) {await this.delivery.release(key, token, now); throw error;}
        this.checked.add(key); sent++; if (this.checked.size > 5000) this.checked.clear();
        if (!this.valid(candidate, revision)) {close(); continue;}
        this.visible.set(key, {close, target: this.target(candidate.item)}); this.reminders.recordSystemNotification(candidate.item, now); this.warning.set('');
      }
    } catch {this.warning.set('系統通知暫時無法送出，將稍後重試；程式內提醒仍可查看。'); this.retryAfter = Date.now() + 60000;}
    finally {this.running = false;}
  }
  ngOnDestroy(): void {
    this.destroyed = true;
    const view = this.document.defaultView; view?.removeEventListener('focus', this.refresh); view?.removeEventListener('storage', this.storageChanged); this.document.removeEventListener('visibilitychange', this.refresh); view?.navigator.serviceWorker?.removeEventListener('message', this.received);
  }
}
