import { A11yModule } from '@angular/cdk/a11y';
import { CdkDrag, CdkDragDrop, CdkDropList, CdkDropListGroup } from '@angular/cdk/drag-drop';
import { CdkScrollable } from '@angular/cdk/scrolling';
import { Component, computed, HostListener, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { BoardStore } from './board-store';
import { Icon } from './icon';
import { Category, CategoryColor, CATEGORY_COLORS, COLUMNS, MEMBERS, PRIORITIES, Priority, Task, TaskStatus } from './models';

type Modal = 'task' | 'categories' | 'project' | 'delete' | null;
type Scope = 'all' | 'mine' | 'done';
type BoardColumn = {id: TaskStatus; label: string; subtitle: string; tasks: Task[]};

@Component({
  selector: 'app-root',
  imports: [FormsModule, A11yModule, CdkDrag, CdkDropList, CdkDropListGroup, CdkScrollable, Icon],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App {
  readonly store = inject(BoardStore);
  readonly members = MEMBERS;
  readonly statuses = COLUMNS;
  readonly priorities = PRIORITIES;
  readonly colors = CATEGORY_COLORS;
  readonly query = signal('');
  readonly categoryFilter = signal('all');
  readonly priorityFilter = signal('all');
  readonly scope = signal<Scope>('all');
  readonly view = signal<'board' | 'list'>('board');
  readonly sidebarOpen = signal(false);
  readonly mobileViewport = signal(window.innerWidth <= 700);
  readonly modal = signal<Modal>(null);
  readonly editing = signal(false);
  readonly formError = signal('');
  readonly categoryError = signal('');
  readonly categoryEditingId = signal('');
  readonly categoryToDelete = signal<Category | null>(null);
  readonly taskToDelete = signal<Task | null>(null);
  readonly toast = signal('');
  readonly projectDescription = '讓品牌煥然一新，從每一個小任務開始。';
  draft: Task = this.emptyTask('todo');
  categoryDraft: {name: string; color: CategoryColor} = {name: '', color: 'violet'};
  projectDraft = '';
  subtaskDraft = '';
  private toastTimer?: ReturnType<typeof setTimeout>;
  private dragEndedAt = 0;

  readonly visibleTasks = computed(() => {
    const search = this.query().trim().toLocaleLowerCase();
    return this.store.tasks().filter(task => {
      const matchesQuery = !search || `${task.title} ${task.description} ${this.category(task.categoryId).name}`.toLocaleLowerCase().includes(search);
      return matchesQuery && (this.categoryFilter() === 'all' || task.categoryId === this.categoryFilter())
        && (this.priorityFilter() === 'all' || task.priority === this.priorityFilter())
        && (this.scope() !== 'mine' || task.assignee === 'me')
        && (this.scope() !== 'done' || task.status === 'done');
    });
  });
  readonly columns = computed(() => COLUMNS.map(column => ({...column, tasks: this.visibleTasks().filter(task => task.status === column.id)})));
  readonly inProgressCount = computed(() => this.store.tasks().filter(task => task.status === 'progress').length);
  readonly myTaskCount = computed(() => this.store.tasks().filter(task => task.assignee === 'me').length);
  readonly hasFilters = computed(() => !!this.query() || this.categoryFilter() !== 'all' || this.priorityFilter() !== 'all' || this.scope() !== 'all');

  @HostListener('document:keydown.escape')
  escape(): void {
    if (this.categoryToDelete()) this.categoryToDelete.set(null);
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

  member(id: string) {
    return MEMBERS.find(member => member.id === id) ?? {id: '', name: '未指派', initials: '—', color: 'neutral'};
  }

  priorityLabel(priority: Priority): string {
    return PRIORITIES.find(item => item.id === priority)?.label ?? '';
  }

  statusLabel(status: TaskStatus): string {
    return COLUMNS.find(column => column.id === status)?.label ?? '';
  }

  categoryCount(id: string): number {
    return this.store.tasks().filter(task => task.categoryId === id).length;
  }

  completedSubtasks(task: Task): number {
    return task.subtasks.filter(subtask => subtask.done).length;
  }

  formatDate(date: string): string {
    if (!date) return '未設定日期';
    const [, month, day] = date.split('-');
    return `${Number(month)} 月 ${Number(day)} 日`;
  }

  isOverdue(task: Task): boolean {
    if (!task.dueDate || task.status === 'done') return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return new Date(`${task.dueDate}T00:00:00`) < today;
  }

  selectScope(scope: Scope): void {
    this.scope.set(scope);
    this.categoryFilter.set('all');
    this.sidebarOpen.set(false);
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

  openTask(status: TaskStatus = 'todo', task?: Task): void {
    if (Date.now() - this.dragEndedAt < 200) return;
    this.draft = task ? structuredClone(task) : this.emptyTask(status);
    if (!task && this.categoryFilter() !== 'all') this.draft.categoryId = this.categoryFilter();
    this.editing.set(!!task);
    this.formError.set('');
    this.subtaskDraft = '';
    this.modal.set('task');
  }

  saveTask(): void {
    const title = this.draft.title.trim();
    if (!title) {
      this.formError.set('請輸入任務名稱。');
      return;
    }
    if (this.subtaskDraft.trim()) this.addSubtask();
    this.store.saveTask({...this.draft, title, description: this.draft.description.trim()});
    const hidden = !this.visibleTasks().some(task => task.id === this.draft.id);
    const message = this.editing() ? '任務已更新' : '新任務已建立';
    this.closeModal();
    this.notify(hidden ? `${message}，可清除篩選查看。` : message);
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
  }

  private notify(message: string): void {
    clearTimeout(this.toastTimer);
    this.toast.set(message);
    this.toastTimer = setTimeout(() => this.toast.set(''), 3800);
  }

  private emptyTask(status: TaskStatus): Task {
    return {id: crypto.randomUUID(), title: '', description: '', categoryId: '', status, priority: 'medium', assignee: '', dueDate: '', subtasks: []};
  }
}
