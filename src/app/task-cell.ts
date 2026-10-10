import { afterNextRender, ChangeDetectionStrategy, Component, computed, DestroyRef, Directive, ElementRef, inject, input, output, signal } from '@angular/core';
import { ScheduleTime } from './schedule-time';
import { DatePickerTrigger, adjacentHour } from './schedule-controls';
import { FormsModule } from '@angular/forms';
import { BoardStore, TaskEditContext } from './board-store';
import { Icon } from './icon';
import { PRIORITIES, Task } from './models';
import { isTaskOverdue, scheduleError } from './task-schedule';
import { ThemeColor } from './theme-color';

export type TaskCellField = 'title' | 'projectId' | 'categoryId' | 'status' | 'priority' | 'startDate' | 'dueDate';

@Directive({selector: '[appCellFocus]'})
export class CellFocus {
  private readonly element = inject<ElementRef<HTMLInputElement | HTMLSelectElement>>(ElementRef);
  constructor() { afterNextRender(() => this.element.nativeElement.focus()); }
}

@Component({
  selector: 'app-task-cell', imports: [ScheduleTime, DatePickerTrigger, FormsModule, Icon, ThemeColor, CellFocus],
  templateUrl: './task-cell.html', styleUrl: './task-cell.css', changeDetection: ChangeDetectionStrategy.OnPush
})
export class TaskCell {
  readonly store = inject(BoardStore);
  private readonly destroyRef = inject(DestroyRef);
  readonly task = input.required<Task>();
  readonly field = input.required<TaskCellField>();
  readonly now = input(new Date());
  readonly saved = output<string>();
  readonly editing = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly priorities = PRIORITIES;
  readonly label = computed(() => ({title: '任務名稱', projectId: '專案', categoryId: '分類', status: '狀態', priority: '優先順序', startDate: '開始日期', dueDate: '截止日期'}[this.field()]));
  readonly dateField = computed(() => this.field() === 'startDate' || this.field() === 'dueDate');
  readonly category = computed(() => this.store.categories().find(item => item.id === this.task().categoryId));
  readonly status = computed(() => this.store.statuses().find(item => item.id === this.task().status));
  readonly overdue = computed(() => this.field() === 'dueDate' && isTaskOverdue(this.task(), this.now(), this.store.statuses()));
  readonly display = computed(() => {
    const task = this.task();
    switch (this.field()) {
      case 'title': return task.title;
      case 'projectId': return this.store.projects().find(item => item.id === task.projectId)?.name ?? '未指定專案';
      case 'categoryId': return this.category()?.name ?? '未分類';
      case 'status': return this.status()?.label ?? '未設定';
      case 'priority': return this.priorities.find(item => item.id === task.priority)?.label ?? '未設定';
      default: {
        const date = this.field() === 'startDate' ? task.startDate : task.dueDate;
        const time = this.field() === 'startDate' ? task.startTime : task.dueTime;
        return date ? date.replaceAll('-', '/') + (time ? ' ' + time : '') : '未設定';
      }
    }
  });
  value = '';
  time = '';
  includeTime = false;
  private context: TaskEditContext | null = null;

  begin(): void {
    if (this.busy()) return;
    this.context = {...this.store.taskContext(this.task().id), original: structuredClone(this.task())};
    this.value = this.task()[this.field()];
    this.time = this.field() === 'startDate' ? this.task().startTime : this.field() === 'dueDate' ? this.task().dueTime : '';
    this.includeTime = !!this.time;
    this.error.set(''); this.editing.set(true);
  }
  reload(): void {
    if (this.busy()) return;
    this.store.refreshFromStorage();
    if (!this.context || this.context.workspaceId !== this.store.currentWorkspace().id || this.context.generation !== this.store.generation()) {
      this.error.set('工作空間或資料已變更，請取消後重新編輯。'); return;
    }
    const current = this.store.tasks().find(task => task.id === this.task().id);
    if (!current) { this.error.set('任務已刪除，請取消編輯。'); return; }
    this.context = this.store.taskContext(current.id);
    this.value = current[this.field()];
    this.time = this.field() === 'startDate' ? current.startTime : this.field() === 'dueDate' ? current.dueTime : '';
    this.includeTime = !!this.time; this.error.set('');
  }
  cancel(event?: Event): void {
    event?.stopPropagation();
    if (this.busy()) return;
    this.editing.set(false); this.error.set(''); this.context = null;
  }
  toggleTime(enabled: boolean): void {
    this.includeTime = enabled;
    if (enabled && !this.time) {
      const task = this.context?.original ?? this.task();
      const other = this.field() === 'startDate' ? adjacentHour(task.dueDate, task.dueTime, -1) : adjacentHour(task.startDate, task.startTime, 1);
      if (other && (!this.value || this.value === (this.field() === 'startDate' ? task.dueDate : task.startDate))) this.value = other.date;
      this.time = other?.time ?? (this.field() === 'startDate' ? '09:00' : '17:00');
    }
  }
  async selectStatus(value: string): Promise<void> {
    if (!this.editing()) this.begin();
    this.value = value; await this.save();
  }
  async save(): Promise<void> {
    if (!this.context?.original || this.busy() || this.store.pendingWrites()) return;
    const draft = structuredClone(this.context.original);
    const field = this.field();
    const value = field === 'title' ? this.value.trim() : this.value;
    if (field === 'title' && (!value || value.length > 100)) { this.error.set('請輸入 1 到 100 字的任務名稱。'); return; }
    if (field === 'priority' && !this.priorities.some(item => item.id === value)) { this.error.set('請選擇有效的優先順序。'); return; }
    Object.assign(draft, {[field]: value});
    if (this.dateField()) {
      if (value && this.includeTime && !this.time) { this.error.set('請選擇時間，或取消加入時間。'); return; }
      draft[field === 'startDate' ? 'startTime' : 'dueTime'] = value && this.includeTime ? this.time : '';
    }
    const invalid = scheduleError(draft);
    if (invalid) { this.error.set(invalid); return; }
    if (JSON.stringify(draft) === JSON.stringify(this.context.original)) { this.cancel(); return; }
    this.busy.set(true); this.error.set('');
    try {
      const result = await this.store.saveTask(draft, this.context);
      if (!result.ok) { this.error.set(result.message); return; }
      this.editing.set(false); this.context = null;
      if (!this.destroyRef.destroyed) this.saved.emit(result.persisted ? `已更新${this.label()}` : '變更只暫存在此分頁，請匯出備份。');
    } catch (error) { this.error.set(error instanceof Error ? error.message : '無法儲存，編輯內容已保留。'); }
    finally { this.busy.set(false); }
  }
}
