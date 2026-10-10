import { effect, inject, Injectable, OnDestroy, signal, untracked } from '@angular/core';
import { BoardStore, TaskEditContext } from './board-store';
import { GoogleCalendarService } from './google-calendar';
import { CalendarWriteAuth } from './calendar-write-auth';
import { writableCalendar } from './google-api';
import { CalendarPublishedChanged, CalendarTransferApi } from './calendar-transfer-api';
import { copyEventTask, createEventBody, originKey, taskFingerprint, taskMetadata } from './calendar-transfer-data';
import type { EventBody, TransferSchedule } from './calendar-transfer-data';
import type { ExternalEvent } from './google-data';
import { externalEvent } from './google-data';
import type { CalendarTransfer, Task } from './models';
import { CalendarSyncCoordinator } from './calendar-sync';
import { withStorageLock } from './storage-coordinator';

@Injectable({providedIn: 'root'})
export class CalendarTransferService implements OnDestroy {
  readonly store = inject(BoardStore);
  readonly google = inject(GoogleCalendarService);
  readonly auth = inject(CalendarWriteAuth);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly calendars = this.google.available;
  readonly listing = this.google.listing;
  readonly writable = writableCalendar;
  private readonly api = new CalendarTransferApi((path, parameters, options) => this.auth.api(path, parameters, options));
  private coordinator?: CalendarSyncCoordinator;
  private operationVersion = 0;
  private readonly leave = () => { this.operationVersion++; this.coordinator?.close(); this.auth.cancelRequests(); };
  constructor() {
    if (typeof window !== 'undefined') window.addEventListener('pagehide', this.leave);
    effect(() => {
      const context = {generation: this.store.generation(), clientId: this.store.google().clientId, accountId: this.store.google().accountId};
      untracked(() => this.auth.useSession(context));
    });
    effect(() => {
      const connected = this.google.auth.connected();
      untracked(() => { if (!connected && this.auth.connected()) this.auth.disconnect('Google 月曆讀取連線已解除，寫入連線也已停止。'); });
    });
  }
  async connect(): Promise<void> {
    if (this.busy() || this.auth.authorizing()) return;
    this.error.set('');
    try {
      const settings = this.store.google(), generation = this.store.generation();
      if (!settings.clientId || !settings.accountId || !this.google.auth.connected()) throw new Error('請先在「設定 → Google 月曆」重新連線 Google 帳號。');
      this.auth.useSession({generation, clientId: settings.clientId, accountId: settings.accountId});
      const account = await this.auth.authorize(settings.clientId);
      if (this.store.generation() !== generation || this.store.google().clientId !== settings.clientId || this.store.google().accountId !== settings.accountId || account.id !== settings.accountId) { this.auth.disconnect(); throw new Error('請授權與已連線月曆相同的 Google 帳號。'); }
      await this.loadCalendars();
    } catch (error) { this.error.set(this.message(error)); }
  }
  async loadCalendars(force = false): Promise<void> {
    this.error.set('');
    try { await this.google.listCalendars(force); if (this.google.error()) this.error.set(this.google.error()); }
    catch (error) { this.error.set(this.message(error)); }
  }
  private writeFence(): () => void {
    const generation = this.store.generation(), clientId = this.store.google().clientId, accountId = this.store.google().accountId, connection = this.auth.connectionVersion(), operation = this.operationVersion;
    const verify = () => {
      this.store.refreshFromStorage();
      this.auth.useSession({generation: this.store.generation(), clientId: this.store.google().clientId, accountId: this.store.google().accountId});
      if (this.operationVersion !== operation || this.store.generation() !== generation || this.store.google().clientId !== clientId || this.store.google().accountId !== accountId || this.auth.account()?.id !== accountId || !this.auth.connected() || !this.google.auth.connected() || this.auth.connectionVersion() !== connection) throw new Error('Google 帳號、授權或資料已變更，Orbit 任務保留。重新連線後可確認原移轉結果。');
    };
    verify(); return verify;
  }
  async publish(task: Task, context: TaskEditContext, calendarId: string, choice: TransferSchedule): Promise<boolean> {
    if (this.busy()) return false;
    this.busy.set(true); this.error.set('');
    try {
      const fence = this.writeFence(), settings = this.store.google();
      const workspace = this.store.workspaces().find(item => item.id === context.workspaceId);
      if (!workspace || context.generation !== this.store.generation() || JSON.stringify(context.original) !== JSON.stringify(task)) throw new Error('任務或工作空間已變更，請儲存後重新開啟移轉。');
      const pending = workspace.calendarTransfers?.find(item => item.taskId === task.id && !item.published);
      if (!pending && !this.calendars().some(item => item.id === calendarId && writableCalendar(item))) throw new Error('請選擇可寫入的月曆。');
      const id = crypto.randomUUID().replaceAll('-', '');
      const transfer: CalendarTransfer = pending ?? {accountId: settings.accountId, calendarId, eventId: id, taskId: task.id, original: taskFingerprint(task), body: JSON.stringify(createEventBody(task, workspace, choice, id)), metadata: taskMetadata(task, workspace), published: false};
      if (transfer.accountId !== settings.accountId) throw new Error('待確認活動屬於另一個 Google 帳號，請切回原帳號後重試。');
      const prepared = await this.store.prepareCalendarTransfer(transfer, context, settings.clientId);
      if (!prepared.ok) throw new Error(prepared.message);
      const scope = originKey(transfer, transfer.eventId);
      const coordinator = new CalendarSyncCoordinator(localStorage, withStorageLock, () => {}, undefined, typeof navigator === 'undefined' ? undefined : navigator.locks, 120000, {storagePrefix: 'iih-orbit-calendar-transfer-run-v1:', lockPrefix: 'iih-orbit-calendar-transfer-run:', label: '活動移轉'});
      this.coordinator = coordinator;
      coordinator.activate(scope);
      try {
        const ran = await coordinator.run(scope, [transfer.eventId], async current => {
          const verify = () => { if (!current()) throw new Error('移轉已在另一分頁接續，本機任務保留。'); fence(); };
          let keepOrbit = false;
          try { await this.api.publish(transfer.calendarId, JSON.parse(transfer.body) as EventBody, verify); }
          catch (error) {
            if (!(error instanceof CalendarPublishedChanged)) throw error;
            keepOrbit = true; this.error.set(error.message);
          }
          verify();
          const finished = await this.store.finishCalendarTransfer(transfer, context, settings.clientId, keepOrbit, verify);
          if (!finished.ok) throw new Error(finished.message);
          await this.bindPublishedCalendar(transfer.calendarId, context.workspaceId);
        });
        if (!ran) throw new Error('另一個分頁正在移轉這個任務，請等候完成後再查看。');
      } finally { coordinator.close(); if (this.coordinator === coordinator) this.coordinator = undefined; }
      void this.google.refresh(true);
      return true;
    } catch (error) { this.error.set(this.message(error)); return false; }
    finally { this.busy.set(false); }
  }
  private async bindPublishedCalendar(calendarId: string, workspaceId: string): Promise<void> {
    const existing = this.store.google().sources.find(item => item.accountId === this.store.google().accountId && item.calendarId === calendarId);
    const calendar = this.calendars().find(item => item.id === calendarId);
    if (calendar) {
      const result = await this.store.bindCalendar(existing ?? {id: crypto.randomUUID(), accountId: this.store.google().accountId, calendarId, name: calendar.name, color: calendar.color, workspaceIds: [], visible: true}, workspaceId, true);
      if (!result.ok) this.error.set('活動已移轉；月曆顯示來源未能保存，請在 Google 月曆設定中勾選此工作空間。');
    }
  }
  async latest(entry: ExternalEvent): Promise<ExternalEvent> {
    const settings = this.store.google(), generation = this.store.generation(), connection = this.google.auth.connectionVersion();
    if (entry.source.accountId !== settings.accountId || !this.google.auth.connected()) throw new Error('請先重新連線 Google，才能讀取最新活動內容。');
    const event = await new CalendarTransferApi((path, parameters) => this.google.auth.request(path, parameters)).get(entry.source.calendarId, entry.event.id);
    this.store.refreshFromStorage();
    if (generation !== this.store.generation() || settings.clientId !== this.store.google().clientId || settings.accountId !== this.store.google().accountId || connection !== this.google.auth.connectionVersion()) throw new Error('Google 帳號或工作空間資料已變更，請重新開啟活動。');
    const result = externalEvent(entry.source, event);
    if (!result) throw new Error('活動已不存在。');
    return result;
  }
  draft(entry: ExternalEvent): Task { return copyEventTask(entry, this.store.currentWorkspace()); }
  async copy(reviewed: ExternalEvent, task: Task, context: TaskEditContext): Promise<boolean> {
    if (this.busy()) return false;
    this.busy.set(true); this.error.set('');
    try {
      if (context.generation !== this.store.generation() || context.workspaceId !== this.store.currentWorkspace().id) throw new Error('工作空間已變更，請重新開啟活動再複製。');
      const clientId = this.store.google().clientId, connection = this.google.auth.connectionVersion(), operation = this.operationVersion;
      const latest = await this.latest(reviewed);
      if (context.generation !== this.store.generation() || context.workspaceId !== this.store.currentWorkspace().id) throw new Error('工作空間已變更，請重新開啟活動再複製。');
      if (JSON.stringify(latest.event) !== JSON.stringify(reviewed.event)) throw new Error('Google 活動在預覽後又有更新，請重新載入最新內容再複製。');
      const result = await this.store.saveCalendarCopy(task, context, clientId, latest.source.accountId, () => {
        this.google.auth.useSession({generation: this.store.generation(), clientId: this.store.google().clientId, accountId: this.store.google().accountId});
        if (operation !== this.operationVersion || !this.google.auth.connected() || connection !== this.google.auth.connectionVersion()) throw new Error('Google 連線已變更，請重新載入後複製。');
      });
      if (!result.ok) throw new Error(result.message);
      return true;
    } catch (error) { this.error.set(this.message(error)); return false; }
    finally { this.busy.set(false); }
  }
  private message(error: unknown): string { return error instanceof Error ? error.message : '無法完成 Google 移轉，Orbit 任務仍保留。'; }
  ngOnDestroy(): void { this.leave(); if (typeof window !== 'undefined') window.removeEventListener('pagehide', this.leave); }
}
