import { Component, computed, effect, inject, input, output } from '@angular/core';
import { ScheduleTime } from './schedule-time';
import { DatePickerTrigger, adjacentHour } from './schedule-controls';
import { FormsModule } from '@angular/forms';
import { CalendarTransferService } from './calendar-transfer';
import type { TaskEditContext } from './board-store';
import type { Task } from './models';
import { eventSchedule, RESERVE_MINUTES, taskFingerprint } from './calendar-transfer-data';
import type { TransferSchedule } from './calendar-transfer-data';

@Component({
  selector: 'app-calendar-publish', imports: [FormsModule, ScheduleTime, DatePickerTrigger],
  template: `<div class="transfer-body">
    <h3>{{ task().title }}</h3><p>移轉成功後，Orbit 任務卡片會移除，改由 Google Calendar 管理。子任務與完成狀態會記錄在活動描述中。</p>
    @if (!service.store.google().accountId) {<p class="notice">請先到「設定 → Google 月曆」連線帳號，再回來移轉任務。</p>}
    @else if (!service.auth.connected()) {<p>首次移轉需授權建立活動。請選擇已連線的帳號 {{ service.store.google().email }}。</p><button type="button" class="button primary" [disabled]="!service.auth.ready() || service.auth.authorizing()" (click)="service.connect()">{{ service.auth.authorizing() ? '授權中…' : '授權 Google Calendar 寫入' }}</button>}
    @if (service.store.google().accountId) {<label class="form-field">移至月曆<select [(ngModel)]="calendarId" [disabled]="service.busy() || !!pending()"><option value="">{{ service.listing() ? '正在載入月曆…' : '請選擇可寫入月曆' }}</option>@for (calendar of service.calendars(); track calendar.id) {<option [value]="calendar.id" [disabled]="!service.writable(calendar)">{{ calendar.name }}{{ service.writable(calendar) ? '' : calendar.accessRole === 'reader' || calendar.accessRole === 'freeBusyReader' ? '（唯讀）' : '（權限待確認）' }}</option>}</select></label><button type="button" class="text-button" [disabled]="service.listing() || service.busy()" (click)="service.loadCalendars(true)">{{ service.listing() ? '更新中…' : '更新月曆清單' }}</button>
      @if (!service.listing() && !service.calendars().some(service.writable) && service.google.auth.connected()) {<p class="notice">目前沒有可寫入的月曆，請先在 Google Calendar 取得權限。</p>}
    }
    @if (pending(); as transfer) {<p class="notice">上次移轉尚未確認。重試會檢查原活動，不會改選其他月曆或另建一份。</p><p><strong>{{ pendingTitle() }}</strong><br>{{ pendingSchedule() }}</p><details><summary>查看原移轉內容</summary><p class="pending-content">{{ pendingDescription() }}</p></details>@if (pendingEdited()) {<p class="notice">Orbit 任務已有新修改。此次只確認原本的 Google 活動，新版 Orbit 任務會保留。</p>}}
    @else {@if (completeSchedule()) {<p class="note">沿用任務已設定的起訖時間。</p>}
      @else {<fieldset [disabled]="service.busy()"><legend>活動時段</legend>
      @if (needsOptions()) {
      <label class="choice"><input type="radio" name="mode" [(ngModel)]="choice.mode" value="reserve">截止前預留時間</label>
      @if (choice.mode === 'reserve') {<label class="form-field reserve-duration">預留時間<select [(ngModel)]="choice.minutes">@for (minutes of minutes; track minutes) {<option [ngValue]="minutes">{{ minutes < 60 ? minutes + ' 分鐘' : minutes / 60 + ' 小時' }}</option>}</select></label><div class="date-time-row"><label class="form-field">截止日期<input type="date" [(ngModel)]="choice.endDate" [disabled]="!!task().dueDate"></label><label class="form-field">截止時間<app-schedule-time label="截止時間" [value]="choice.endTime" (valueChange)="timeChanged('end', $event)" [disabled]="!!task().dueTime" /></label></div>}
      <label class="choice"><input type="radio" name="mode" [(ngModel)]="choice.mode" value="all-day">當天全天截止提醒</label>
      <label class="choice"><input type="radio" name="mode" [(ngModel)]="choice.mode" value="custom">自行安排時段</label>
      } @else {<p class="note">請確認活動的起訖日期與時間。</p>}
      @if (choice.mode === 'custom') {<div class="date-time-row"><label class="form-field">開始日期<input type="date" [(ngModel)]="choice.startDate"></label><label class="form-field">開始時間<app-schedule-time label="開始時間" [value]="choice.startTime" (valueChange)="timeChanged('start', $event)" /></label><label class="form-field">結束日期<input type="date" [(ngModel)]="choice.endDate"></label><label class="form-field">結束時間<app-schedule-time label="結束時間" [value]="choice.endTime" (valueChange)="timeChanged('end', $event)" /></label></div>}
    </fieldset>}<p class="preview" aria-live="polite">{{ preview() }}</p>}
    <p class="note">時區：{{ timeZone }} · 顯示為有空，不標示忙碌。移轉失敗時 Orbit 任務保留。</p>
    @if (service.error()) {<p role="alert" class="form-error">{{ service.error() }}</p>}
    <div class="transfer-actions"><button type="button" class="button secondary" [disabled]="service.busy()" (click)="cancelled.emit()">返回任務</button><button type="button" class="button primary" [disabled]="service.busy() || !service.auth.connected() || (!pending() && (!calendarId || !validSchedule()))" (click)="publish()">{{ service.busy() ? '正在確認移轉…' : pending() ? '重試並確認移轉' : '移至 Google Calendar' }}</button></div>
    </div>`,
  styleUrls: ['./forms.css', './calendar-transfer.css']
})
export class CalendarPublish {
  readonly service = inject(CalendarTransferService);
  readonly task = input.required<Task>();
  readonly context = input.required<TaskEditContext>();
  readonly completed = output<string>();
  readonly busyChange = output<boolean>();
  readonly cancelled = output<void>();
  readonly minutes = RESERVE_MINUTES;
  readonly timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  readonly pending = computed(() => this.service.store.workspaces().find(item => item.id === this.context().workspaceId)?.calendarTransfers?.find(item => item.taskId === this.task().id && !item.published));
  readonly completeSchedule = computed(() => !!(this.task().startDate && this.task().startTime && this.task().dueDate && this.task().dueTime));
  readonly needsOptions = computed(() => !(this.task().startDate && this.task().startTime) && !!this.task().dueDate);
  calendarId = '';
  choice: TransferSchedule = {mode: 'reserve', minutes: 15, startDate: '', startTime: '', endDate: '', endTime: ''};
  constructor() {
    if (this.service.store.google().clientId) void this.service.auth.prepare().catch(error => this.service.error.set(error instanceof Error ? error.message : '無法載入 Google 授權元件。'));
    effect(() => {
      const pending = this.pending(), calendars = this.service.calendars();
      if (pending) this.calendarId = pending.calendarId;
      else if (!calendars.some(item => item.id === this.calendarId && this.service.writable(item))) this.calendarId = calendars.find(this.service.writable)?.id ?? '';
    });
  }
  ngOnInit(): void {
    const task = this.task();
    this.choice = {mode: this.needsOptions() ? 'reserve' : 'custom', minutes: 15, startDate: task.startDate || task.dueDate, startTime: task.startTime, endDate: task.dueDate || task.startDate, endTime: task.dueTime};
    if (task.startDate && task.startTime && !task.dueDate) {
      const end = new Date(task.startDate + 'T' + task.startTime); end.setHours(end.getHours() + 1);
      this.choice.endDate = [end.getFullYear(), String(end.getMonth() + 1).padStart(2, '0'), String(end.getDate()).padStart(2, '0')].join('-');
      this.choice.endTime = String(end.getHours()).padStart(2, '0') + ':' + String(end.getMinutes()).padStart(2, '0');
    }
    if (!this.choice.startTime && task.dueTime && task.dueDate) {
      const start = adjacentHour(task.dueDate, task.dueTime, -1);
      if (start) { this.choice.startDate = start.date; this.choice.startTime = start.time; }
    }
    this.calendarId = this.pending()?.calendarId ?? this.service.calendars().find(this.service.writable)?.id ?? '';
    this.service.error.set('');
    if (this.service.google.auth.connected()) void this.service.loadCalendars();
  }
  timeChanged(kind: 'start' | 'end', time: string): void {
    if (kind === 'start') {
      this.choice.startTime = time;
      if (!this.choice.endTime) { const end = adjacentHour(this.choice.startDate, time, 1); if (end) {this.choice.endDate = end.date; this.choice.endTime = end.time;} }
    } else {
      this.choice.endTime = time;
      if (!this.choice.startTime) { const start = adjacentHour(this.choice.endDate, time, -1); if (start) {this.choice.startDate = start.date; this.choice.startTime = start.time;} }
    }
  }
  preview(): string {
    try { return this.scheduleLabel(eventSchedule(this.task(), this.choice)); }
    catch (error) { return error instanceof Error ? error.message : '請選擇活動時段。'; }
  }
  validSchedule(): boolean { try { eventSchedule(this.task(), this.choice); return true; } catch { return false; } }
  pendingSchedule(): string { try { return this.scheduleLabel(JSON.parse(this.pending()!.body)); } catch { return ''; } }
  pendingTitle(): string { return JSON.parse(this.pending()!.body).summary; }
  pendingDescription(): string { return JSON.parse(this.pending()!.body).description; }
  pendingEdited(): boolean { return taskFingerprint(this.task()) !== this.pending()?.original; }
  private scheduleLabel(schedule: ReturnType<typeof eventSchedule>): string {
    const format = (value: string) => new Date(value).toLocaleString('zh-TW', {year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false});
    return schedule.start.date ? schedule.start.date + ' · 全天截止提醒' : format(schedule.start.dateTime!) + ' — ' + format(schedule.end.dateTime!);
  }
  async publish(): Promise<void> {
    this.busyChange.emit(true);
    const success = await this.service.publish(this.task(), this.context(), this.calendarId, this.choice);
    this.busyChange.emit(false);
    if (success) this.completed.emit(this.service.error());
  }
}
