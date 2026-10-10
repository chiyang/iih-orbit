import { Component, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CalendarTransferService } from './calendar-transfer';
import { parseCalendarDescription, plainGoogleDescription } from './calendar-transfer-data';
import type { TaskEditContext } from './board-store';
import type { Task } from './models';
import { PRIORITIES } from './models';
import { ExternalEvent } from './google-data';
import { ThemeColor } from './theme-color';

@Component({
  selector: 'app-external-event-details', imports: [ThemeColor, FormsModule],
  template: `<article class="transfer-body"><span class="source-badge" [orbitColor]="shown().source.color">Google・{{ shown().source.name }}</span><h3>{{ shown().task.title }}</h3>
    <p>{{ schedule() }} · {{ shown().event.start?.date ? '全天活動' : timeZone }}</p>
    @if (shown().event.location) {<p>地點：{{ shown().event.location }}</p>}
    @if (shown().event.recurringEventId) {<p class="note">重複活動；複製只建立這一次的 Orbit 任務。</p>}
    @if (shown().event.description) {<p class="description">{{ description() }}</p>}
    @if (shown().event.contentComplete === false) {<p class="notice">活動內容過長，目前顯示節錄；請在 Google 查看完整內容。此活動暫時不能複製。</p>}
    @if (parsed().subtasks.length) {<ul>@for (item of parsed().subtasks; track $index) {<li>{{ item.done ? '☑' : '☐' }} {{ item.title }}</li>}</ul>}
    <p class="note">複製會建立獨立的 Orbit 任務，Google 活動仍保留。兩邊各自顯示與編輯。</p>
    @if (shown().event.htmlLink) {<a [href]="shown().event.htmlLink" target="_blank" rel="noopener noreferrer">在 Google Calendar 開啟 ↗</a>}
    <div class="transfer-actions"><button type="button" class="button secondary" [disabled]="loading() || service.busy()" (click)="reload()">{{ loading() ? '讀取最新活動…' : '重新載入最新內容' }}</button><button type="button" class="button primary" [disabled]="loading() || service.busy() || shown().event.contentComplete === false" (click)="prepareCopy()">複製為 Orbit 任務…</button></div>
    @if (draft(); as task) {<section class="copy-preview"><h3>確認 Orbit 副本</h3><p>{{ task.title }} · {{ schedule() }}<br>{{ task.subtasks.length }} 個子任務</p>
      @if (!parsed().valid) {<p class="notice">Orbit 子任務格式已變更，這次會完整保留活動描述，不自動解析子任務。</p>}
      <div class="form-grid"><label class="form-field">所屬專案<select [(ngModel)]="task.projectId"><option value="">未指定專案</option>@for (project of service.store.projects(); track project.id) {<option [value]="project.id">{{ project.name }}</option>}</select></label><label class="form-field">任務分類<select [(ngModel)]="task.categoryId"><option value="">未分類</option>@for (category of service.store.categories(); track category.id) {<option [value]="category.id">{{ category.name }}</option>}</select></label><label class="form-field">目前狀態<select [(ngModel)]="task.status">@for (status of service.store.statuses(); track status.id) {<option [value]="status.id">{{ status.label }}</option>}</select></label><label class="form-field">優先順序<select [(ngModel)]="task.priority">@for (priority of priorities; track priority.id) {<option [value]="priority.id">{{ priority.label }}</option>}</select></label></div>
      <div class="transfer-actions"><button type="button" class="button secondary" [disabled]="service.busy()" (click)="draft.set(null)">取消</button><button type="button" class="button primary" [disabled]="service.busy()" (click)="saveCopy()">{{ service.busy() ? '確認最新內容…' : '確認複製' }}</button></div></section>}
    @if (error() || service.error()) {<p class="form-error" role="alert">{{ error() || service.error() }}</p>}
    </article>`,
  styleUrls: ['./forms.css', './calendar-transfer.css'],
  styles: `.source-badge {display: inline-block; color: var(--category-text); background: var(--category-bg); border-radius: 6px; padding: 5px 9px; font-size: var(--font-10);} h3 {margin-top: 18px;} .description {white-space: pre-wrap; padding: 16px; background: var(--section-bg); border-radius: 8px;} a {color: var(--accent-text);}`
})
export class ExternalEventDetails {
  readonly service = inject(CalendarTransferService);
  readonly entry = input.required<ExternalEvent>();
  readonly openOrbit = output<Task>();
  readonly reviewed = signal<ExternalEvent | null>(null);
  readonly shown = computed(() => this.reviewed() ?? this.entry());
  readonly parsed = computed(() => parseCalendarDescription(this.shown().event.description));
  readonly draft = signal<Task | null>(null);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly priorities = PRIORITIES;
  readonly timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  private context?: TaskEditContext;
  async reload(): Promise<void> {
    if (this.loading() || this.service.busy()) return;
    this.loading.set(true); this.error.set(''); this.draft.set(null); this.service.error.set('');
    const generation = this.service.store.generation(), workspaceId = this.service.store.currentWorkspace().id;
    try {
      const entry = await this.service.latest(this.entry());
      if (generation !== this.service.store.generation() || workspaceId !== this.service.store.currentWorkspace().id) throw new Error('工作空間已變更，請重新開啟活動。');
      this.reviewed.set(entry);
    } catch (error) { this.error.set(error instanceof Error ? error.message : '無法讀取活動。'); }
    finally { this.loading.set(false); }
  }
  async prepareCopy(): Promise<void> {
    if (this.loading() || this.service.busy()) return;
    await this.reload();
    if (this.error() || !this.reviewed()) return;
    try { const task = this.service.draft(this.reviewed()!); this.context = this.service.store.taskContext(task.id); this.draft.set(task); }
    catch (error) { this.error.set(error instanceof Error ? error.message : '活動無法完整複製。'); }
  }
  async saveCopy(): Promise<void> {
    const task = this.draft(); if (!task || !this.context || !this.reviewed()) return;
    if (await this.service.copy(this.reviewed()!, task, this.context)) { this.draft.set(null); this.openOrbit.emit(task); }
  }
  schedule(): string {
    const entry = this.shown();
    if (entry.event.start?.date) return entry.task.startDate === entry.task.dueDate ? entry.task.startDate : `${entry.task.startDate} — ${entry.task.dueDate}`;
    const format = (value: string) => new Date(value).toLocaleString('zh-TW', {year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false});
    return format(entry.event.start!.dateTime!) + ' — ' + format(entry.event.end!.dateTime!);
  }
  description(): string { const parsed = this.parsed(); return parsed.metadata || !parsed.valid ? parsed.description : plainGoogleDescription(parsed.description); }
}
