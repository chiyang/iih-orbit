import { A11yModule } from '@angular/cdk/a11y';
import { CdkDrag, CdkDragDrop, CdkDropList, CdkDropListGroup } from '@angular/cdk/drag-drop';
import { CdkScrollable } from '@angular/cdk/scrolling';
import { Component, computed, HostListener, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { BoardStore } from './board-store';
import { Calendar, CalendarCreate } from './calendar';
import { Icon } from './icon';
import { BoardStatus, Category, CategoryColor, CATEGORY_COLORS, PRIORITIES, Priority, StatusKind, Task, TaskScope, TaskStatus, Workspace } from './models';
import { dateKey, isTaskOverdue, parseDate, scheduleError, SortDirection, SortKey, sortTasks } from './task-schedule';
import { minuteLabel, timeMinutes } from './week-layout';
import { UiPreferences } from './ui-preferences';
import { boardStatusesForScope } from './workspace-data';

type Modal = 'task' | 'categories' | 'project' | 'delete' | 'statuses' | 'workspaces' | null;
type BoardColumn = BoardStatus & {tasks: Task[]};

@Component({
  selector: 'app-root',
  imports: [FormsModule, A11yModule, CdkDrag, CdkDropList, CdkDropListGroup, CdkScrollable, Icon, Calendar],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App {
  readonly store = inject(BoardStore);
  readonly preferences = inject(UiPreferences);
  readonly statuses = this.store.statuses;
  readonly priorities = PRIORITIES;
  readonly colors = CATEGORY_COLORS;
  readonly query = signal('');
  readonly categoryFilter = signal('all');
  readonly priorityFilter = signal('all');
  readonly scope = signal<TaskScope>('all');
  readonly view = signal<'board' | 'list' | 'month' | 'week'>('board');
  readonly sortKey = signal<SortKey | null>(null);
  readonly sortDirection = signal<SortDirection>('asc');
  readonly sortHeaders: {key: SortKey; label: string}[] = [
    {key: 'title', label: '任務名稱'},
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
  readonly projectDescription = '把計畫排進日程，讓每一步都清楚可見。';
  draft: Task = this.emptyTask('todo');
  categoryDraft: {name: string; color: CategoryColor} = {name: '', color: 'violet'};
  projectDraft = '';
  statusDraft: Omit<BoardStatus, 'id'> = {label: '', subtitle: '', color: 'gray', kind: 'active', hidden: false};
  statusDestination = '';
  workspaceDraft = '';
  workspaceDeleteName = '';
  subtaskDraft = '';
  hasStartTime = false;
  hasDueTime = false;
  private toastTimer?: ReturnType<typeof setTimeout>;
  private dragEndedAt = 0;

  readonly visibleTasks = computed(() => {
    const search = this.query().trim().toLocaleLowerCase();
    return this.store.tasks().filter(task => {
      const matchesQuery = !search || `${task.title} ${task.description} ${this.category(task.categoryId).name}`.toLocaleLowerCase().includes(search);
      return matchesQuery && (this.categoryFilter() === 'all' || task.categoryId === this.categoryFilter())
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
  readonly sortedTasks = computed(() => sortTasks(this.visibleTasks(), this.store.categories(), this.sortKey(), this.sortDirection(), this.statuses()));
  readonly hasFilters = computed(() => !!this.query() || this.categoryFilter() !== 'all' || this.priorityFilter() !== 'all' || this.scope() !== 'all');

  @HostListener('document:keydown.escape')
  escape(): void {
    if (this.statusToDelete()) this.statusToDelete.set(null);
    else if (this.workspaceToDelete()) this.workspaceToDelete.set(null);
    else if (this.categoryToDelete()) this.categoryToDelete.set(null);
    else if (this.modal()) this.closeModal();
    else this.sidebarOpen.set(false);
  }

  @HostListener('window:resize')
  resize(): void {
    this.mobileViewport.set(window.innerWidth <= 700);
  }

  category(id: string): Category {
    return this.store.categories().find(category => category.id === id) ?? {id: '', name: '未分類', color: 'gray'};
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
    return isTaskOverdue(task, new Date(), this.statuses());
  }

  toggleSort(key: SortKey): void {
    if (this.sortKey() === key) this.sortDirection.update(direction => direction === 'asc' ? 'desc' : 'asc');
    else {
      this.sortKey.set(key);
      this.sortDirection.set('asc');
    }
  }

  sortState(key: SortKey): 'ascending' | 'descending' | 'none' {
    return this.sortKey() === key ? this.sortDirection() === 'asc' ? 'ascending' : 'descending' : 'none';
  }

  sortDescription(): string {
    const key = this.sortKey();
    const label = this.sortHeaders.find(header => header.key === key)?.label ?? '';
    const order = key === 'priority' ? this.sortDirection() === 'asc' ? '高至低' : '低至高'
      : key === 'startDate' || key === 'dueDate' ? this.sortDirection() === 'asc' ? '由早到晚' : '由晚到早'
      : this.sortDirection() === 'asc' ? '升冪' : '降冪';
    return `${label} · ${order}`;
  }

  selectScope(scope: TaskScope): void {
    this.scope.set(scope);
    this.categoryFilter.set('all');
    this.sidebarOpen.set(false);
    if (scope === 'archived' && (this.view() === 'month' || this.view() === 'week')) this.view.set('list');
  }

  selectCategory(id: string): void {
    this.categoryFilter.set(id);
    this.scope.set('all');
    this.sidebarOpen.set(false);
  }

  clearFilters(): void {
    this.query.set('');
    this.categoryFilter.set('all');
    this.priorityFilter.set('all');
    this.scope.set('all');
  }

  openTask(status: TaskStatus = 'todo', task?: Task, date = ''): void {
    if (Date.now() - this.dragEndedAt < 200) return;
    const initialStatus = this.statuses().some(item => item.id === status) ? status : this.statuses().find(item => item.kind === 'active')?.id ?? this.statuses()[0].id;
    this.draft = task ? structuredClone(task) : this.emptyTask(initialStatus);
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

  saveTask(): void {
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
    this.store.saveTask({...this.draft, title, description: this.draft.description.trim()});
    const hidden = !this.visibleTasks().some(task => task.id === this.draft.id);
    const message = this.editing() ? '任務已更新' : '新任務已建立';
    this.closeModal();
    this.notify(hidden ? `${message}，可清除篩選查看。` : message);
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
    this.taskToDelete.set(task);
    this.modal.set('delete');
    setTimeout(() => document.getElementById('keep-task')?.focus(), 0);
  }

  deleteTask(): void {
    const task = this.taskToDelete();
    if (!task) return;
    this.store.deleteTask(task.id);
    this.closeModal();
    this.notify('任務已刪除');
  }

  drop(event: CdkDragDrop<BoardColumn, BoardColumn, Task>): void {
    if (!event.isPointerOverContainer) return;
    const task = event.item.data;
    const destination = event.container.data;
    const remaining = destination.tasks.filter(item => item.id !== task.id);
    this.store.moveTask(task.id, destination.id, remaining[event.currentIndex]?.id);
    if (event.previousContainer !== event.container) this.notify(`「${task.title}」已移至${this.statusLabel(destination.id)}`);
  }

  dragEnded(): void {
    this.dragEndedAt = Date.now();
  }

  changeStatus(task: Task, status: TaskStatus): void {
    this.store.moveTask(task.id, status);
    this.notify(`已移至${this.statusLabel(status)}`);
  }

  openCategories(): void {
    this.resetCategoryDraft();
    this.categoryToDelete.set(null);
    this.modal.set('categories');
  }

  editCategory(category: Category): void {
    this.categoryEditingId.set(category.id);
    this.categoryDraft = {name: category.name, color: category.color};
    this.categoryError.set('');
  }

  saveCategory(): void {
    const name = this.categoryDraft.name.trim();
    if (!name) {
      this.categoryError.set('請輸入分類名稱。');
      return;
    }
    if (this.store.categories().some(category => category.name.toLocaleLowerCase() === name.toLocaleLowerCase() && category.id !== this.categoryEditingId())) {
      this.categoryError.set('此分類名稱已存在，請使用不同名稱。');
      return;
    }
    this.store.saveCategory({id: this.categoryEditingId() || crypto.randomUUID(), name, color: this.categoryDraft.color});
    this.notify(this.categoryEditingId() ? '分類已更新' : '分類已新增');
    this.resetCategoryDraft();
  }

  deleteCategory(): void {
    const category = this.categoryToDelete();
    if (!category) return;
    this.store.deleteCategory(category.id);
    if (this.categoryFilter() === category.id) this.categoryFilter.set('all');
    if (this.categoryEditingId() === category.id) this.resetCategoryDraft();
    this.categoryToDelete.set(null);
    this.notify('分類已刪除，原有任務已移至「未分類」');
  }

  resetCategoryDraft(): void {
    this.categoryEditingId.set('');
    this.categoryDraft = {name: '', color: 'violet'};
    this.categoryError.set('');
  }

  statusCount(id: string): number {
    return this.store.tasks().filter(task => task.status === id).length;
  }

  kindLabel(kind: StatusKind): string {
    return this.statusKinds.find(item => item.id === kind)?.label ?? '';
  }

  openStatuses(): void {
    this.resetStatusDraft();
    this.modal.set('statuses');
  }

  editStatus(status: BoardStatus): void {
    this.statusEditingId.set(status.id);
    this.statusDraft = {label: status.label, subtitle: status.subtitle, color: status.color, kind: status.kind, hidden: status.hidden ?? status.kind === 'archived'};
    this.formError.set('');
    this.statusToDelete.set(null);
  }

  resetStatusDraft(): void {
    this.statusEditingId.set('');
    this.statusDraft = {label: '', subtitle: '', color: 'gray', kind: 'active', hidden: false};
    this.formError.set('');
    this.statusToDelete.set(null);
  }

  saveStatus(): void {
    const label = this.statusDraft.label.trim();
    if (!label) { this.formError.set('請輸入狀態名稱。'); return; }
    if (this.statuses().some(status => status.id !== this.statusEditingId() && status.label.toLocaleLowerCase() === label.toLocaleLowerCase())) {
      this.formError.set('此狀態名稱已存在。');
      return;
    }
    this.store.saveStatus({id: this.statusEditingId() || crypto.randomUUID(), ...this.statusDraft, label, subtitle: this.statusDraft.subtitle.trim()});
    this.notify(this.statusEditingId() ? '狀態已更新' : '狀態已新增');
    this.resetStatusDraft();
  }

  setStatusVisible(status: BoardStatus, visible: boolean): void {
    this.store.saveStatus({...status, hidden: !visible});
    if (this.statusEditingId() === status.id) this.statusDraft.hidden = !visible;
  }

  statusKindChanged(kind: StatusKind): void {
    this.statusDraft.kind = kind;
    if (!this.statusEditingId()) this.statusDraft.hidden = kind === 'archived';
  }

  requestDeleteStatus(status: BoardStatus): void {
    this.statusToDelete.set(status);
    this.statusDestination = this.statuses().find(item => item.id !== status.id)?.id ?? '';
  }

  deleteStatus(): void {
    const status = this.statusToDelete();
    if (!status || !this.statusDestination || status.id === this.statusDestination) return;
    this.store.deleteStatus(status.id, this.statusDestination);
    this.resetStatusDraft();
    this.notify('狀態已刪除，任務已移至指定狀態');
  }

  openWorkspaces(): void {
    this.workspaceDraft = '';
    this.workspaceEditingId.set('');
    this.workspaceToDelete.set(null);
    this.formError.set('');
    this.modal.set('workspaces');
  }

  selectWorkspace(id: string): void {
    this.store.switchWorkspace(id);
    this.clearFilters();
    this.sortKey.set(null);
    this.sidebarOpen.set(false);
    this.closeModal();
  }

  editWorkspace(workspace: Workspace): void {
    this.workspaceEditingId.set(workspace.id);
    this.workspaceDraft = workspace.name;
    this.workspaceToDelete.set(null);
    this.formError.set('');
  }

  saveWorkspace(): void {
    const name = this.workspaceDraft.trim();
    if (!name) { this.formError.set('請輸入工作空間名稱。'); return; }
    if (this.store.workspaces().some(workspace => workspace.id !== this.workspaceEditingId() && workspace.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      this.formError.set('此工作空間名稱已存在。');
      return;
    }
    const editing = !!this.workspaceEditingId();
    this.store.saveWorkspace(this.workspaceEditingId(), name);
    if (!editing) { this.clearFilters(); this.sortKey.set(null); }
    this.sidebarOpen.set(false);
    this.closeModal();
    this.notify(editing ? '工作空間已改名' : '工作空間已建立，可以開始新增任務');
  }

  requestDeleteWorkspace(workspace: Workspace): void {
    this.workspaceToDelete.set(workspace);
    this.workspaceDeleteName = '';
  }

  deleteWorkspace(): void {
    const workspace = this.workspaceToDelete();
    if (!workspace || this.workspaceDeleteName !== workspace.name || this.store.workspaces().length <= 1) return;
    this.store.deleteWorkspace(workspace.id);
    this.clearFilters();
    this.sortKey.set(null);
    this.workspaceToDelete.set(null);
    this.workspaceEditingId.set('');
    this.workspaceDraft = '';
    this.formError.set('');
    this.notify('工作空間已刪除');
  }

  openProject(): void {
    this.projectDraft = this.store.state().projectName;
    this.formError.set('');
    this.modal.set('project');
  }

  saveProject(): void {
    if (!this.projectDraft.trim()) {
      this.formError.set('請輸入專案名稱。');
      return;
    }
    this.store.renameProject(this.projectDraft);
    this.closeModal();
    this.notify('專案名稱已更新');
  }

  closeModal(): void {
    this.modal.set(null);
    this.categoryToDelete.set(null);
    this.taskToDelete.set(null);
    this.statusToDelete.set(null);
    this.workspaceToDelete.set(null);
  }

  private notify(message: string): void {
    clearTimeout(this.toastTimer);
    this.toast.set(message);
    this.toastTimer = setTimeout(() => this.toast.set(''), 3800);
  }

  private emptyTask(status: TaskStatus): Task {
    return {id: crypto.randomUUID(), title: '', description: '', categoryId: '', status, priority: 'medium', startDate: '', startTime: '', dueDate: '', dueTime: '', subtasks: []};
  }
}
