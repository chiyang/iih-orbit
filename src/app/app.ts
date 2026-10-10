import { A11yModule } from '@angular/cdk/a11y';
import { CdkDrag, CdkDragDrop, CdkDropList, CdkDropListGroup } from '@angular/cdk/drag-drop';
import { CdkScrollable } from '@angular/cdk/scrolling';
import { Component, computed, DestroyRef, HostListener, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { BoardStore, StoreResult, TaskEditContext } from './board-store';
import { Calendar } from './calendar';
import type { CalendarCreate } from './calendar';
import { Icon } from './icon';
import { BrandMark } from './brand-mark';
import { ThemeColor } from './theme-color';
import { Settings } from './settings';
import type { SettingsTab } from './settings';
import { colorHex, validHex } from './appearance-data';
import { BoardStatus, Category, CategoryColor, CATEGORY_COLORS, PRIORITIES, Priority, Project, StatusKind, Task, TaskScope, TaskStatus, Workspace } from './models';
import { dateKey, isTaskOverdue, parseDate, scheduleError, SortDirection, SortKey, sortTasks } from './task-schedule';
import { minuteLabel, timeMinutes } from './week-layout';
import { UiPreferences } from './ui-preferences';
import { boardStatusesForScope } from './workspace-data';
import { projectProgress, projectSummaries, tasksForProject } from './project-data';
import { CalendarSources } from './calendar-sources';
import { DriveStatus } from './drive-status';
import { ExternalEventDetails } from './external-event-details';
import { ExternalEvent } from './google-data';
import { DeadlineFilter, deadlineState, DUE_DAY_PRESETS } from './reminder-data';
import { ReminderCenter } from './reminder-center';
import { ReminderBadge } from './reminder-badge';
import { ReminderPopups } from './reminder-popups';
import type { ReminderItem, ReminderTab } from './reminder-items';
import { TaskCell } from './task-cell';
import type { TaskCellField } from './task-cell';
import { WorkspaceTemplatePicker } from './workspace-template-picker';
import type { WorkspaceTemplateId } from './workspace-templates';
import { CalendarPublish } from './calendar-publish';

type Modal = 'task' | 'calendar-publish' | 'categories' | 'projects' | 'delete' | 'statuses' | 'workspaces' | 'settings' | 'external-event' | null;
type BoardColumn = BoardStatus & {tasks: Task[]};

@Component({
  selector: 'app-root',
  imports: [FormsModule, A11yModule, CdkDrag, CdkDropList, CdkDropListGroup, CdkScrollable, Icon, BrandMark, Calendar, ThemeColor, Settings, CalendarSources, DriveStatus, ExternalEventDetails, ReminderCenter, ReminderBadge, ReminderPopups, TaskCell, WorkspaceTemplatePicker, CalendarPublish],
  templateUrl: './app.html',
  styleUrls: ['./app.css', './forms.css']
})
export class App {
  readonly store = inject(BoardStore);
  readonly calendarPublishing = signal(false);
  calendarPublished(warning = ''): void {
    const retained = this.store.tasks().some(task => task.id === this.draft.id);
    this.closeModal();
    this.notify(warning || (retained ? 'Google 活動已建立；Orbit 任務在移轉期間有更新，因此仍保留。' : '已移至 Google Calendar，Orbit 任務卡片已移除。'));
  }
  returnCalendarTask(): void { this.formError.set(''); this.modal.set('task'); }
  readonly externalEntry = signal<ExternalEvent | null>(null);
  openExternalEvent(entry: ExternalEvent): void { this.externalEntry.set(entry); this.modal.set('external-event'); }
  readonly preferences = inject(UiPreferences);
  private readonly workspaceNameSegmenter = new Intl.Segmenter('zh-TW', {granularity: 'grapheme'});
  readonly currentWorkspaceInitial = computed(() => this.workspaceInitial(this.store.currentWorkspace().name));
  readonly statuses = this.store.statuses;
  readonly priorities = PRIORITIES;
  readonly listFields: TaskCellField[] = ['title', 'projectId', 'categoryId', 'status', 'priority', 'startDate', 'dueDate'];
  readonly colors = CATEGORY_COLORS;
  readonly query = signal('');
  readonly categoryFilter = signal('all');
  readonly projectFilter = signal('all');
  readonly progressExpanded = signal(false);
  readonly selectedProjectId = computed(() => {
    const id = this.projectFilter();
    return id === '' || this.store.projects().some(project => project.id === id) ? id : 'all';
  });
  readonly activeProjectCount = computed(() => this.store.projects().filter(project => !project.archived).length);
  readonly progressRows = computed(() => projectSummaries(this.store.tasks(), this.statuses(), this.store.projects().filter(project => !project.archived)));
  readonly archivedProgressRows = computed(() => this.store.projects().filter(project => project.archived).map(project => projectProgress(this.store.tasks(), this.statuses(), project.id, project.name)));
  readonly selectedProjectArchived = computed(() => !!this.store.projects().find(project => project.id === this.selectedProjectId())?.archived);
  readonly selectedProgress = computed(() => projectProgress(this.store.tasks(), this.statuses(), this.selectedProjectId(), this.selectedProjectId() === 'all' ? '所有專案' : this.projectName(this.selectedProjectId()), this.store.projects()));
  readonly overallProgress = computed(() => projectProgress(this.store.tasks(), this.statuses(), 'all', '所有專案', this.store.projects()));
  readonly selectedPendingCount = computed(() => tasksForProject(this.store.tasks(), this.selectedProjectId()).filter(task => !this.store.isDone(task) && !this.store.isArchived(task)).length);
  readonly projectEditing = signal<Project | null>(null);
  readonly projectToDelete = signal<Project | null>(null);
  readonly priorityFilter = signal('all');
  readonly deadlineFilter = signal<DeadlineFilter>('all');
  readonly deadlineDays = signal<number | null>(null);
  readonly effectiveDeadlineDays = computed(() => this.deadlineDays() ?? this.store.reminders().dueSoonDays);
  readonly deadlineSelection = computed(() => this.deadlineFilter() === 'due-soon' && this.deadlineDays() !== null ? 'due-' + this.deadlineDays() : this.deadlineFilter());
  readonly reminderTab = signal<ReminderTab>('today');
  readonly remindersOpen = signal(false);
  readonly now = signal(new Date());
  readonly settingsTab = signal<SettingsTab>('appearance');
  readonly scope = signal<TaskScope>('all');
  readonly view = signal<'board' | 'list' | 'month' | 'week'>('board');
  readonly calendarShowOrbit = signal(true);
  readonly calendarShowGoogle = signal(true);
  readonly sortKey = signal<SortKey | null>(null);
  readonly sortDirection = signal<SortDirection>('asc');
  readonly sortHeaders: {key: SortKey; label: string}[] = [
    {key: 'title', label: '任務名稱'},
    {key: 'project', label: '專案'},
    {key: 'category', label: '分類'},
    {key: 'status', label: '狀態'},
    {key: 'priority', label: '優先順序'},
    {key: 'startDate', label: '開始日期'},
    {key: 'dueDate', label: '截止日期'}
  ];
  readonly sidebarOpen = signal(false);
  readonly mobileViewport = signal(window.innerWidth <= 700);
  readonly modal = signal<Modal>(null);
  readonly editing = signal(false);
  readonly formError = signal('');
  readonly categoryError = signal('');
  readonly categoryEditingId = signal('');
  readonly categoryToDelete = signal<Category | null>(null);
  readonly taskToDelete = signal<Task | null>(null);
  readonly statusEditingId = signal('');
  readonly statusToDelete = signal<BoardStatus | null>(null);
  readonly workspaceEditingId = signal('');
  readonly workspaceToDelete = signal<Workspace | null>(null);
  readonly statusKinds: {id: StatusKind; label: string}[] = [
    {id: 'active', label: '一般任務'},
    {id: 'done', label: '已完成'},
    {id: 'archived', label: '封存'}
  ];
  readonly toast = signal('');
  readonly taskEditContext = signal<TaskEditContext | null>(null);
  readonly taskDraftConflict = computed(() => {
    const context = this.taskEditContext();
    if (this.modal() !== 'task' || !context) return false;
    const workspace = this.store.workspaces().find(item => item.id === context.workspaceId);
    const current = context.original ? workspace?.tasks.find(task => task.id === context.original!.id) ?? null : null;
    return this.store.generation() !== context.generation || !workspace || JSON.stringify(current) !== JSON.stringify(context.original);
  });
  readonly projectDescription = '把計畫排進日程，讓每一步都清楚可見。';
  draft: Task = this.emptyTask('todo');
  categoryDraft: {name: string; color: CategoryColor} = {name: '', color: 'violet'};
  categoryHexDraft = '#9b83c8';
  statusHexDraft = '#929992';
  readonly categoryColorInvalid = signal(false);
  readonly statusColorInvalid = signal(false);
  projectDraft = '';
  statusDraft: Omit<BoardStatus, 'id'> = {label: '', subtitle: '', color: 'gray', kind: 'active', hidden: false};
  statusDestination = '';
  workspaceDraft = '';
  readonly workspaceTemplateId = signal<WorkspaceTemplateId>('blank');
  readonly workspaceSaving = signal(false);
  workspaceExamples = true;
  private workspaceTemplateName = '';
  workspaceDeleteName = '';
  subtaskDraft = '';
  hasStartTime = false;
  hasDueTime = false;
  private formWorkspaceId = '';
  private formGeneration = '';
  private deletionContext?: TaskEditContext;
  private toastTimer?: ReturnType<typeof setTimeout>;
  private dragEndedAt = 0;

  readonly visibleTasks = computed(() => {
    const search = this.query().trim().toLocaleLowerCase();
    return tasksForProject(this.store.tasks(), this.selectedProjectId()).filter(task => {
      const matchesQuery = !search || `${task.title} ${task.description} ${this.category(task.categoryId).name} ${this.projectName(task.projectId)}`.toLocaleLowerCase().includes(search);
      return matchesQuery && (this.categoryFilter() === 'all' || task.categoryId === this.categoryFilter())
        && (this.deadlineFilter() === 'all' || deadlineState(task, this.now(), this.effectiveDeadlineDays(), this.statuses()) === this.deadlineFilter())
        && (this.priorityFilter() === 'all' || task.priority === this.priorityFilter())
        && (this.scope() !== 'active' || (!this.store.isDone(task) && !this.store.isArchived(task)))
        && (this.scope() !== 'done' || this.store.isDone(task))
        && (this.scope() !== 'archived' || this.store.isArchived(task));
    });
  });
  readonly columns = computed(() => boardStatusesForScope(this.statuses(), this.scope()).map(column => ({...column, tasks: this.visibleTasks().filter(task => task.status === column.id)})));
  readonly navigationTitle = computed(() => {
    const labels = {all: '專案看板', active: '待完成任務', done: '已完成任務', archived: '封存任務'};
    return this.scope() === 'all' && this.categoryFilter() !== 'all' ? this.category(this.categoryFilter()).name : labels[this.scope()];
  });
  readonly activeTaskCount = computed(() => this.store.activeTasks().filter(task => !this.store.isDone(task)).length);
  readonly archivedTaskCount = computed(() => this.store.tasks().filter(task => this.store.isArchived(task)).length);
  readonly calendarTasks = computed(() => this.visibleTasks().filter(task => !this.store.isArchived(task)));
  readonly effectiveSortKey = computed(() => this.sortKey() ?? (this.deadlineFilter() === 'all' ? null : 'dueDate'));
  readonly sortedTasks = computed(() => sortTasks(this.visibleTasks(), this.store.categories(), this.effectiveSortKey(), this.sortKey() ? this.sortDirection() : 'asc', this.statuses(), this.store.projects()));
  readonly hasFilters = computed(() => !!this.query() || this.selectedProjectId() !== 'all' || this.categoryFilter() !== 'all' || this.priorityFilter() !== 'all' || this.scope() !== 'all' || this.deadlineFilter() !== 'all');
  readonly deadlineCounts = computed(() => this.store.tasks().reduce((counts, task) => {
    const state = deadlineState(task, this.now(), this.effectiveDeadlineDays(), this.statuses());
    if (state) counts[state]++;
    return counts;
  }, {'overdue': 0, 'due-soon': 0}));
  readonly deadlinePresets = computed(() => DUE_DAY_PRESETS.map(days => ({days, count: this.store.tasks().filter(task => deadlineState(task, this.now(), days, this.statuses()) === 'due-soon').length})));

  constructor() {
    const timer = setInterval(() => this.now.set(new Date()), 30000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  @HostListener('window:focus')
  updateNow(): void { this.now.set(new Date()); }

  openSettings(tab: SettingsTab = 'appearance'): void {
    this.settingsTab.set(tab); this.sidebarOpen.set(false); this.modal.set('settings');
  }

  selectDeadline(value: DeadlineFilter): void {
    if (!['all', 'overdue', 'due-soon'].includes(value)) return;
    this.deadlineFilter.set(value);
    if (value === 'all') this.deadlineDays.set(null);
    if (value !== 'all') { this.scope.set('active'); this.sortKey.set(null); }
  }

  selectDueSoonDays(days: number): void {
    if (!Number.isInteger(days) || days < 1 || days > 30) return;
    this.deadlineDays.set(days); this.selectDeadline('due-soon');
  }
  selectDeadlineOption(value: string): void {
    if (value.startsWith('due-') && value !== 'due-soon') { const days = Number(value.slice(4)); if (DUE_DAY_PRESETS.includes(days)) this.selectDueSoonDays(days); }
    else if (['all', 'overdue', 'due-soon'].includes(value)) { this.deadlineDays.set(null); this.selectDeadline(value as DeadlineFilter); }
  }
  openReminders(tab: ReminderTab = 'today'): void {
    if (this.modal()) return;
    this.reminderTab.set(tab); this.sidebarOpen.set(false); this.remindersOpen.set(true);
  }
  toggleReminders(): void {
    if (this.modal()) return;
    if (this.remindersOpen()) this.remindersOpen.set(false);
    else this.openReminders();
  }
  openReminder(item: ReminderItem): void {
    if (this.modal()) return;
    if (item.generation !== this.store.generation() || item.workspaceId !== this.store.currentWorkspace().id) return;
    if (item.external) {
      const source = this.store.google().sources.find(source => source.id === item.external!.source.id);
      if (!source?.visible || !source.workspaceIds.includes(item.workspaceId) || source.accountId !== this.store.google().accountId) return;
      this.openExternalEvent(item.external);
    } else {
      const task = this.store.tasks().find(task => task.id === item.task.id);
      if (task && !this.store.isDone(task) && !this.store.isArchived(task)) this.openTask(task.status, task);
    }
  }
  showReminderDeadline(days: number): void {
    this.clearFilters(); this.selectDueSoonDays(days); this.view.set('list');
  }

  @HostListener('document:keydown.escape')
  escape(): void {
    if (this.projectToDelete()) this.projectToDelete.set(null);
    else if (this.statusToDelete()) this.statusToDelete.set(null);
    else if (this.workspaceToDelete()) this.workspaceToDelete.set(null);
    else if (this.categoryToDelete()) this.categoryToDelete.set(null);
    else if (this.modal()) this.closeModal();
    else if (this.remindersOpen()) this.remindersOpen.set(false);
    else this.sidebarOpen.set(false);
  }

  @HostListener('window:resize')
  resize(): void {
    this.mobileViewport.set(window.innerWidth <= 700);
  }

  category(id: string): Category {
    return this.store.categories().find(category => category.id === id) ?? {id: '', name: '未分類', color: 'gray'};
  }

  workspaceInitial(name: string): string {
    for (const character of this.workspaceNameSegmenter.segment(name.trim())) return character.segment;
    return '空';
  }

  projectName(id: string): string {
    return this.store.projects().find(project => project.id === id)?.name ?? '未指定專案';
  }

  projectTaskCount(id: string): number {
    return this.store.tasks().filter(task => task.projectId === id).length;
  }

  selectProject(id: string): void {
    this.clearFilters();
    this.projectFilter.set(id);
  }

  priorityLabel(priority: Priority): string {
    return PRIORITIES.find(item => item.id === priority)?.label ?? '';
  }

  statusLabel(status: TaskStatus): string {
    return this.statuses().find(column => column.id === status)?.label ?? '';
  }

  statusColor(status: TaskStatus): CategoryColor {
    return this.statuses().find(column => column.id === status)?.color ?? 'gray';
  }

  categoryCount(id: string): number {
    return this.store.tasks().filter(task => task.categoryId === id).length;
  }

  completedSubtasks(task: Task): number {
    return task.subtasks.filter(subtask => subtask.done).length;
  }

  formatDate(date: string, time = '', withYear = false): string {
    if (!date) return '未設定日期';
    const [year, month, day] = date.split('-');
    const dateLabel = withYear ? `${year}/${month}/${day}` : `${Number(month)} 月 ${Number(day)} 日`;
    return `${dateLabel}${time ? ' ' + time : ''}`;
  }

  isOverdue(task: Task): boolean {
    return isTaskOverdue(task, this.now(), this.statuses());
  }

  toggleSort(key: SortKey): void {
    if (this.effectiveSortKey() === key) {
      const direction = this.sortState(key) === 'ascending' ? 'desc' : 'asc';
      this.sortKey.set(key); this.sortDirection.set(direction);
    }
    else {
      this.sortKey.set(key);
      this.sortDirection.set('asc');
    }
  }

  sortState(key: SortKey): 'ascending' | 'descending' | 'none' {
    return this.effectiveSortKey() === key ? !this.sortKey() || this.sortDirection() === 'asc' ? 'ascending' : 'descending' : 'none';
  }

  sortDescription(): string {
    const key = this.effectiveSortKey();
    const label = this.sortHeaders.find(header => header.key === key)?.label ?? '';
    const order = key === 'priority' ? this.sortDirection() === 'asc' ? '高至低' : '低至高'
      : key === 'startDate' || key === 'dueDate' ? !this.sortKey() || this.sortDirection() === 'asc' ? '由早到晚' : '由晚到早'
      : this.sortDirection() === 'asc' ? '升冪' : '降冪';
    return `${label} · ${order}`;
  }

  selectScope(scope: TaskScope): void {
    if (scope === 'all') this.projectFilter.set('all');
    this.scope.set(scope);
    this.deadlineFilter.set('all');
    this.deadlineDays.set(null);
    this.categoryFilter.set('all');
    this.sidebarOpen.set(false);
    if (scope === 'archived' && (this.view() === 'month' || this.view() === 'week')) this.view.set('list');
  }

  selectCategory(id: string): void {
    this.categoryFilter.set(id);
    this.scope.set('all');
    this.deadlineFilter.set('all');
    this.deadlineDays.set(null);
    this.sidebarOpen.set(false);
  }

  clearFilters(): void {
    this.query.set('');
    this.categoryFilter.set('all');
    this.projectFilter.set('all');
    this.priorityFilter.set('all');
    this.deadlineFilter.set('all');
    this.deadlineDays.set(null);
    this.scope.set('all');
  }

  openTask(status: TaskStatus = 'todo', task?: Task, date = ''): void {
    if (Date.now() - this.dragEndedAt < 200) return;
    const initialStatus = this.statuses().some(item => item.id === status) ? status : this.statuses().find(item => item.kind === 'active')?.id ?? this.statuses()[0].id;
    this.draft = task ? structuredClone(task) : this.emptyTask(initialStatus);
    this.taskEditContext.set(this.store.taskContext(this.draft.id));
    if (!task && this.categoryFilter() !== 'all') this.draft.categoryId = this.categoryFilter();
    this.editing.set(!!task);
    this.formError.set('');
    this.subtaskDraft = '';
    this.hasStartTime = !!this.draft.startTime;
    this.hasDueTime = !!this.draft.dueTime;
    if (!task && date) {
      this.draft.startDate = date;
      this.draft.dueDate = date;
    }
    this.modal.set('task');
  }

  async saveTask(publish = false): Promise<void> {
    if (this.store.pendingWrites()) return;
    const title = this.draft.title.trim();
    if (!title) {
      this.formError.set('請輸入任務名稱。');
      return;
    }
    if (!this.hasStartTime) this.draft.startTime = '';
    if (!this.hasDueTime) this.draft.dueTime = '';
    if ((this.hasStartTime && !this.draft.startTime) || (this.hasDueTime && !this.draft.dueTime)) {
      this.formError.set('請選擇時間，或取消「加入時間」。');
      return;
    }
    const dateError = scheduleError(this.draft);
    if (dateError) {
      this.formError.set(dateError);
      return;
    }
    if (this.subtaskDraft.trim()) this.addSubtask();
    const saved = {...this.draft, title, description: this.draft.description.trim()};
    if (publish && JSON.stringify(saved) === JSON.stringify(this.taskEditContext()?.original) && !this.store.hasUnsavedChanges()) {
      this.store.refreshFromStorage();
      if (this.taskDraftConflict()) { this.formError.set('任務已更新，請載入最新版本再移轉。'); return; }
      this.draft = structuredClone(saved); this.modal.set('calendar-publish'); return;
    }
    const result = await this.store.saveTask(saved, this.taskEditContext()!);
    if (!this.handleResult(result)) return;
    const hidden = !this.visibleTasks().some(task => task.id === this.draft.id);
    const message = this.editing() ? '任務已更新' : '新任務已建立';
    if (publish && result.persisted) {
      this.draft = structuredClone(this.store.tasks().find(task => task.id === this.draft.id)!);
      this.taskEditContext.set(this.store.taskContext(this.draft.id));
      this.modal.set('calendar-publish');
      return;
    }
    this.closeModal();
    this.notify(result.persisted ? hidden ? `${message}，可清除篩選查看。` : message : '任務只暫存在此分頁，請匯出備份。');
  }

  reloadTaskDraft(): void {
    const context = this.taskEditContext();
    const task = this.store.workspaces().find(workspace => workspace.id === context?.workspaceId)?.tasks.find(task => task.id === context?.original?.id);
    if (!task || !context) { this.formError.set('原任務已不存在，可以將草稿另存為新任務。'); return; }
    this.store.switchWorkspace(context.workspaceId);
    this.openTask(task.status, task);
  }

  async saveTaskDraftAsNew(): Promise<void> {
    if (this.store.pendingWrites()) return;
    this.draft = {...this.draft, id: crypto.randomUUID(), subtasks: this.draft.subtasks.map(subtask => ({...subtask, id: crypto.randomUUID()}))};
    if (!this.statuses().some(status => status.id === this.draft.status)) this.draft.status = this.statuses().find(status => status.kind === 'active')?.id ?? this.statuses()[0].id;
    if (!this.store.categories().some(category => category.id === this.draft.categoryId)) this.draft.categoryId = '';
    if (!this.store.projects().some(project => project.id === this.draft.projectId)) this.draft.projectId = '';
    this.taskEditContext.set(this.store.taskContext(this.draft.id));
    this.editing.set(false);
    await this.saveTask();
  }

  openCalendarTask(schedule: CalendarCreate): void {
    this.openTask('todo', undefined, schedule.date);
    if (!schedule.time) return;
    this.draft.startTime = schedule.time;
    const endMinute = timeMinutes(schedule.time) + 60;
    const endDate = parseDate(schedule.date);
    if (endMinute >= 1440) endDate.setDate(endDate.getDate() + 1);
    this.draft.dueDate = dateKey(endDate);
    this.draft.dueTime = minuteLabel(endMinute % 1440);
    this.hasStartTime = true;
    this.hasDueTime = true;
  }

  dateChanged(kind: 'start' | 'due', date: string): void {
    if (kind === 'start') {
      this.draft.startDate = date;
      if (!date) {
        this.hasStartTime = false;
        this.draft.startTime = '';
      }
    } else {
      this.draft.dueDate = date;
      if (!date) {
        this.hasDueTime = false;
        this.draft.dueTime = '';
      }
    }
  }

  timeToggled(kind: 'start' | 'due', enabled: boolean): void {
    if (kind === 'start') {
      this.hasStartTime = enabled;
      this.draft.startTime = enabled ? this.draft.startTime || '09:00' : '';
    } else {
      this.hasDueTime = enabled;
      this.draft.dueTime = enabled ? this.draft.dueTime || '18:00' : '';
    }
  }

  addSubtask(): void {
    if (!this.subtaskDraft.trim()) return;
    this.draft.subtasks.push({id: crypto.randomUUID(), title: this.subtaskDraft.trim(), done: false});
    this.subtaskDraft = '';
  }

  removeSubtask(id: string): void {
    this.draft.subtasks = this.draft.subtasks.filter(subtask => subtask.id !== id);
  }

  requestDeleteTask(task: Task): void {
    this.deletionContext = this.taskEditContext()?.original?.id === task.id ? this.taskEditContext()! : this.store.taskContext(task.id);
    this.taskToDelete.set(task);
    this.modal.set('delete');
    setTimeout(() => document.getElementById('keep-task')?.focus(), 0);
  }

  async deleteTask(): Promise<void> {
    if (this.store.pendingWrites()) return;
    const task = this.taskToDelete();
    if (!task) return;
    if (!this.handleResult(await this.store.deleteTask(task.id, this.deletionContext))) return;
    this.closeModal();
    this.notifySaved('任務已刪除');
  }

  async drop(event: CdkDragDrop<BoardColumn, BoardColumn, Task>): Promise<void> {
    if (!event.isPointerOverContainer) return;
    const task = event.item.data;
    const destination = event.container.data;
    const remaining = destination.tasks.filter(item => item.id !== task.id);
    if (!this.handleResult(await this.store.moveTask(task.id, destination.id, remaining[event.currentIndex]?.id))) return;
    if (event.previousContainer !== event.container) this.notifySaved(`「${task.title}」已移至${this.statusLabel(destination.id)}`);
  }

  dragEnded(): void {
    this.dragEndedAt = Date.now();
  }

  async changeStatus(task: Task, status: TaskStatus): Promise<void> {
    if (!this.handleResult(await this.store.moveTask(task.id, status))) return;
    this.notifySaved(`已移至${this.statusLabel(status)}`);
  }

  openListTask(event: Event, task: Task): void {
    const target = event.target as HTMLElement | null;
    if (target?.closest('button, input, select, textarea, a, form')) return;
    if (event.type === 'keydown' && event.target !== event.currentTarget) return;
    if (event.type === 'keydown') event.preventDefault();
    this.openTask(task.status, task);
  }
  inlineSaved(message: string): void { this.notify(message); }

  openCategories(): void {
    this.rememberFormContext();
    this.resetCategoryDraft();
    this.categoryToDelete.set(null);
    this.modal.set('categories');
  }

  editCategory(category: Category): void {
    this.categoryEditingId.set(category.id);
    this.categoryDraft = {name: category.name, color: category.color};
    this.categoryHexDraft = colorHex(category.color);
    this.categoryColorInvalid.set(false);
    this.categoryError.set('');
  }

  async saveCategory(): Promise<void> {
    if (this.store.pendingWrites() || this.categoryColorInvalid() || !this.formContextValid()) return;
    const name = this.categoryDraft.name.trim();
    if (!name) {
      this.categoryError.set('請輸入分類名稱。');
      return;
    }
    if (this.store.categories().some(category => category.name.toLocaleLowerCase() === name.toLocaleLowerCase() && category.id !== this.categoryEditingId())) {
      this.categoryError.set('此分類名稱已存在，請使用不同名稱。');
      return;
    }
    if (!this.handleResult(await this.store.saveCategory({id: this.categoryEditingId() || crypto.randomUUID(), name, color: this.categoryDraft.color}), true)) return;
    this.notifySaved(this.categoryEditingId() ? '分類已更新' : '分類已新增');
    this.resetCategoryDraft();
  }

  async deleteCategory(): Promise<void> {
    if (this.store.pendingWrites() || !this.formContextValid()) return;
    const category = this.categoryToDelete();
    if (!category) return;
    if (!this.handleResult(await this.store.deleteCategory(category.id), true)) return;
    if (this.categoryFilter() === category.id) this.categoryFilter.set('all');
    if (this.categoryEditingId() === category.id) this.resetCategoryDraft();
    this.categoryToDelete.set(null);
    this.notifySaved('分類已刪除，原有任務已移至「未分類」');
  }

  resetCategoryDraft(): void {
    this.categoryEditingId.set('');
    this.categoryDraft = {name: '', color: 'violet'};
    this.categoryHexDraft = colorHex('violet');
    this.categoryColorInvalid.set(false);
    this.categoryError.set('');
  }

  async reorderCategory(id: string, direction: -1 | 1): Promise<void> {
    if (this.store.pendingWrites() || !this.formContextValid()) return;
    if (this.handleResult(await this.store.reorderCategory(id, direction), true)) this.notifySaved('分類順序已更新');
  }

  readonly colorHex = colorHex;

  setDraftColor(kind: 'category' | 'status', value: string): void {
    if (kind === 'category') this.categoryHexDraft = value;
    else this.statusHexDraft = value;
    (kind === 'category' ? this.categoryColorInvalid : this.statusColorInvalid).set(!validHex(value));
    if (!validHex(value)) {
      if (kind === 'category') this.categoryError.set('請輸入 # 加上六位英數字的 HEX 色碼。');
      else this.formError.set('請輸入 # 加上六位英數字的 HEX 色碼。');
      return;
    }
    if (kind === 'category') { this.categoryDraft.color = value.toLowerCase() as CategoryColor; this.categoryError.set(''); }
    else { this.statusDraft.color = value.toLowerCase() as CategoryColor; this.formError.set(''); }
  }

  statusCount(id: string): number {
    return this.store.tasks().filter(task => task.status === id).length;
  }

  kindLabel(kind: StatusKind): string {
    return this.statusKinds.find(item => item.id === kind)?.label ?? '';
  }

  openStatuses(): void {
    this.rememberFormContext();
    this.resetStatusDraft();
    this.modal.set('statuses');
  }

  editStatus(status: BoardStatus): void {
    this.statusEditingId.set(status.id);
    this.statusDraft = {label: status.label, subtitle: status.subtitle, color: status.color, kind: status.kind, hidden: status.hidden ?? status.kind === 'archived'};
    this.statusHexDraft = colorHex(status.color);
    this.statusColorInvalid.set(false);
    this.formError.set('');
    this.statusToDelete.set(null);
  }

  resetStatusDraft(): void {
    this.statusEditingId.set('');
    this.statusDraft = {label: '', subtitle: '', color: 'gray', kind: 'active', hidden: false};
    this.statusHexDraft = colorHex('gray');
    this.statusColorInvalid.set(false);
    this.formError.set('');
    this.statusToDelete.set(null);
  }

  async saveStatus(): Promise<void> {
    if (this.store.pendingWrites() || this.statusColorInvalid() || !this.formContextValid()) return;
    const label = this.statusDraft.label.trim();
    if (!label) { this.formError.set('請輸入狀態名稱。'); return; }
    if (this.statuses().some(status => status.id !== this.statusEditingId() && status.label.toLocaleLowerCase() === label.toLocaleLowerCase())) {
      this.formError.set('此狀態名稱已存在。');
      return;
    }
    if (!this.handleResult(await this.store.saveStatus({id: this.statusEditingId() || crypto.randomUUID(), ...this.statusDraft, label, subtitle: this.statusDraft.subtitle.trim()}))) return;
    this.notifySaved(this.statusEditingId() ? '狀態已更新' : '狀態已新增');
    this.resetStatusDraft();
  }

  async setStatusVisible(status: BoardStatus, visible: boolean): Promise<void> {
    if (!this.formContextValid() || !this.handleResult(await this.store.saveStatus({...status, hidden: !visible}))) return;
    if (this.statusEditingId() === status.id) this.statusDraft.hidden = !visible;
  }

  statusKindChanged(kind: StatusKind): void {
    this.statusDraft.kind = kind;
    if (!this.statusEditingId()) this.statusDraft.hidden = kind === 'archived';
  }

  async reorderStatus(id: string, direction: number): Promise<void> {
    if (this.formContextValid()) this.handleResult(await this.store.reorderStatus(id, direction));
  }

  requestDeleteStatus(status: BoardStatus): void {
    this.statusToDelete.set(status);
    this.statusDestination = this.statuses().find(item => item.id !== status.id)?.id ?? '';
  }

  async deleteStatus(): Promise<void> {
    if (this.store.pendingWrites() || !this.formContextValid()) return;
    const status = this.statusToDelete();
    if (!status || !this.statusDestination || status.id === this.statusDestination) return;
    if (!this.handleResult(await this.store.deleteStatus(status.id, this.statusDestination))) return;
    this.resetStatusDraft();
    this.notifySaved('狀態已刪除，任務已移至指定狀態');
  }

  openWorkspaces(): void {
    this.rememberFormContext();
    this.workspaceDraft = '';
    this.workspaceTemplateId.set('blank');
    this.workspaceTemplateName = '';
    this.workspaceExamples = true;
    this.workspaceEditingId.set('');
    this.workspaceToDelete.set(null);
    this.formError.set('');
    this.modal.set('workspaces');
  }

  selectWorkspace(id: string): void {
    this.store.switchWorkspace(id);
    this.clearFilters();
    this.sortKey.set(null);
    this.progressExpanded.set(false);
    this.sidebarOpen.set(false);
    this.closeModal();
  }

  editWorkspace(workspace: Workspace): void {
    this.workspaceEditingId.set(workspace.id);
    this.workspaceDraft = workspace.name;
    this.workspaceToDelete.set(null);
    this.formError.set('');
  }

  chooseWorkspaceTemplate(selection: {id: WorkspaceTemplateId; name: string}): void {
    if (this.store.pendingWrites() || this.workspaceSaving() || this.workspaceEditingId()) return;
    if (!this.workspaceDraft.trim() || this.workspaceDraft === this.workspaceTemplateName) this.workspaceDraft = selection.name;
    this.workspaceTemplateId.set(selection.id);
    this.workspaceTemplateName = selection.name;
    this.formError.set('');
  }

  cancelWorkspaceEdit(): void {
    this.workspaceEditingId.set('');
    this.workspaceDraft = '';
    this.workspaceTemplateId.set('blank');
    this.workspaceTemplateName = '';
    this.formError.set('');
  }

  async saveWorkspace(): Promise<void> {
    if (this.store.pendingWrites() || this.workspaceSaving() || !this.formContextValid(false)) return;
    const name = this.workspaceDraft.trim();
    if (!name) { this.formError.set('請輸入工作空間名稱。'); return; }
    if (this.store.workspaces().some(workspace => workspace.id !== this.workspaceEditingId() && workspace.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      this.formError.set('此工作空間名稱已存在。');
      return;
    }
    const editing = !!this.workspaceEditingId();
    this.workspaceSaving.set(true);
    let saved: StoreResult;
    try { saved = await this.store.saveWorkspace(this.workspaceEditingId(), name, {templateId: this.workspaceTemplateId(), includeExamples: this.workspaceExamples}); }
    finally { this.workspaceSaving.set(false); }
    if (!this.handleResult(saved)) return;
    if (!editing) { this.clearFilters(); this.sortKey.set(null); }
    this.sidebarOpen.set(false);
    this.closeModal();
    this.notifySaved(editing ? '工作空間已改名' : '工作空間已建立，並已加入同名專案');
  }

  requestDeleteWorkspace(workspace: Workspace): void {
    this.workspaceToDelete.set(workspace);
    this.workspaceDeleteName = '';
  }

  async deleteWorkspace(): Promise<void> {
    if (this.store.pendingWrites() || !this.formContextValid(false)) return;
    const workspace = this.workspaceToDelete();
    if (!workspace || this.workspaceDeleteName !== workspace.name || this.store.workspaces().length <= 1) return;
    if (!this.handleResult(await this.store.deleteWorkspace(workspace.id))) return;
    this.clearFilters();
    this.sortKey.set(null);
    this.workspaceToDelete.set(null);
    this.workspaceEditingId.set('');
    this.workspaceDraft = '';
    this.formError.set('');
    this.notifySaved('工作空間已刪除');
  }

  openProjects(): void {
    this.rememberFormContext();
    this.resetProjectDraft();
    this.modal.set('projects');
  }

  openWorkspaceName(): void {
    this.openWorkspaces();
    this.editWorkspace(this.store.currentWorkspace());
  }

  editProject(project: Project): void {
    this.projectEditing.set({...project});
    this.projectDraft = project.name;
    this.formError.set('');
    this.projectToDelete.set(null);
  }

  resetProjectDraft(): void {
    this.projectEditing.set(null);
    this.projectDraft = '';
    this.projectToDelete.set(null);
    this.formError.set('');
  }

  async saveProject(): Promise<void> {
    if (this.store.pendingWrites() || !this.formContextValid()) return;
    if (!this.projectDraft.trim()) {
      this.formError.set('請輸入專案名稱。');
      return;
    }
    const original = this.projectEditing();
    if (!this.handleResult(await this.store.saveProject({...original, id: original?.id ?? crypto.randomUUID(), name: this.projectDraft}, original))) return;
    this.resetProjectDraft();
    this.progressExpanded.set(true);
    this.notifySaved(original ? '專案名稱已更新' : '專案已新增，可在任務中設定所屬專案');
  }

  async deleteProject(): Promise<void> {
    const project = this.projectToDelete();
    if (!project || this.store.pendingWrites() || !this.formContextValid()) return;
    if (!this.handleResult(await this.store.deleteProject(project))) return;
    if (this.projectFilter() === project.id) this.projectFilter.set('all');
    this.resetProjectDraft();
    this.notifySaved('專案已移除，任務保留並改為未指定專案');
  }

  async toggleProjectArchived(project: Project): Promise<void> {
    if (this.store.pendingWrites() || !this.formContextValid()) return;
    if (!this.handleResult(await this.store.setProjectArchived(project, !project.archived))) return;
    if (this.projectEditing()?.id === project.id) this.projectEditing.set({...this.store.projects().find(item => item.id === project.id)!});
    this.projectToDelete.set(null);
    this.notifySaved(project.archived ? '專案已還原，重新計入所有專案進度' : '專案已封存，任務保留並排除於所有專案進度');
  }

  closeModal(): void {
    if (this.calendarPublishing()) return;
    if (this.modal() === 'settings' && this.store.pendingWrites() > 0) return;
    this.modal.set(null);
    this.externalEntry.set(null);
    this.categoryToDelete.set(null);
    this.taskToDelete.set(null);
    this.statusToDelete.set(null);
    this.workspaceToDelete.set(null);
    this.projectToDelete.set(null);
  }

  openBackup(): void { this.openSettings('data'); }

  private handleResult(result: StoreResult, category = false): result is Extract<StoreResult, {ok: true}> {
    if (result.ok) return true;
    this.formError.set(result.message);
    if (category) this.categoryError.set(result.message);
    this.notify(result.message);
    return false;
  }

  private rememberFormContext(): void {
    this.formWorkspaceId = this.store.currentWorkspace().id;
    this.formGeneration = this.store.generation();
  }

  private formContextValid(workspaceSpecific = true): boolean {
    if (this.formGeneration === this.store.generation() && (!workspaceSpecific || this.formWorkspaceId === this.store.currentWorkspace().id)) return true;
    const message = '原資料或工作空間已被其他分頁取代，草稿仍保留；請關閉並重新開啟此表單。';
    this.formError.set(message);
    this.categoryError.set(message);
    this.notify(message);
    return false;
  }

  private notifySaved(message: string): void {
    this.notify(this.store.hasUnsavedChanges() ? '變更只暫存在此分頁，請匯出備份。' : message);
  }

  private notify(message: string): void {
    clearTimeout(this.toastTimer);
    this.toast.set(message);
    this.toastTimer = setTimeout(() => this.toast.set(''), 3800);
  }

  private emptyTask(status: TaskStatus): Task {
    const defaultProject = this.store.projects().find(project => !project.archived && project.name === this.store.currentWorkspace().name) ?? this.store.projects().find(project => !project.archived);
    return {id: crypto.randomUUID(), title: '', description: '', categoryId: '', projectId: this.selectedProjectId() === 'all' ? defaultProject?.id ?? '' : this.selectedProjectId(), status, priority: 'medium', startDate: '', startTime: '', dueDate: '', dueTime: '', subtasks: []};
  }
}
