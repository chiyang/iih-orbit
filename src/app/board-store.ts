import { computed, Injectable, signal } from '@angular/core';
import { BoardState, Category, CATEGORY_COLORS, COLUMNS, MEMBERS, PRIORITIES, Task, TaskStatus } from './models';
import { createInitialState } from './seed';

const STORAGE_KEY = 'orbit-board-v1';

function isBoardState(value: unknown): value is BoardState {
  if (!value || typeof value !== 'object') return false;
  const state = value as BoardState;
  if (state.version !== 1 || typeof state.projectName !== 'string' || !state.projectName.trim()) return false;
  if (!Array.isArray(state.categories) || !Array.isArray(state.tasks)) return false;
  const validCategories = state.categories.every(category => category && typeof category.id === 'string'
    && typeof category.name === 'string' && category.name.trim() && CATEGORY_COLORS.some(color => color.id === category.color));
  if (!validCategories || new Set(state.categories.map(category => category.id)).size !== state.categories.length) return false;
  const validTasks = state.tasks.every(task => task && typeof task.id === 'string' && typeof task.title === 'string'
    && task.title.trim() && typeof task.description === 'string' && typeof task.categoryId === 'string'
    && (!task.categoryId || state.categories.some(category => category.id === task.categoryId))
    && COLUMNS.some(column => column.id === task.status) && PRIORITIES.some(priority => priority.id === task.priority)
    && (task.assignee === '' || MEMBERS.some(member => member.id === task.assignee))
    && typeof task.dueDate === 'string' && (!task.dueDate || /^\d{4}-\d{2}-\d{2}$/.test(task.dueDate))
    && Array.isArray(task.subtasks) && task.subtasks.every(subtask => subtask && typeof subtask.id === 'string'
      && typeof subtask.title === 'string' && typeof subtask.done === 'boolean'));
  return validTasks && new Set(state.tasks.map(task => task.id)).size === state.tasks.length;
}

@Injectable({providedIn: 'root'})
export class BoardStore {
  readonly storageWarning = signal('');
  readonly state = signal<BoardState>(this.load());
  readonly tasks = computed(() => this.state().tasks);
  readonly categories = computed(() => this.state().categories);
  readonly completed = computed(() => this.tasks().filter(task => task.status === 'done').length);
  readonly progress = computed(() => this.tasks().length ? Math.round(this.completed() / this.tasks().length * 100) : 0);

  saveTask(task: Task): void {
    const exists = this.tasks().some(item => item.id === task.id);
    const tasks = exists ? this.tasks().map(item => item.id === task.id ? structuredClone(task) : item)
      : [...this.tasks(), structuredClone(task)];
    this.commit({...this.state(), tasks});
  }

  deleteTask(id: string): void {
    this.commit({...this.state(), tasks: this.tasks().filter(task => task.id !== id)});
  }

  moveTask(id: string, status: TaskStatus, beforeId?: string): void {
    const task = this.tasks().find(item => item.id === id);
    if (!task) return;
    const tasks = this.tasks().filter(item => item.id !== id);
    const beforeIndex = beforeId ? tasks.findIndex(item => item.id === beforeId && item.status === status) : -1;
    const lastInColumn = tasks.findLastIndex(item => item.status === status);
    const index = beforeIndex >= 0 ? beforeIndex : lastInColumn >= 0 ? lastInColumn + 1 : tasks.length;
    tasks.splice(index, 0, {...task, status});
    this.commit({...this.state(), tasks});
  }

  saveCategory(category: Category): void {
    const exists = this.categories().some(item => item.id === category.id);
    const categories = exists ? this.categories().map(item => item.id === category.id ? {...category} : item)
      : [...this.categories(), {...category}];
    this.commit({...this.state(), categories});
  }

  deleteCategory(id: string): void {
    this.commit({
      ...this.state(),
      categories: this.categories().filter(category => category.id !== id),
      tasks: this.tasks().map(task => task.categoryId === id ? {...task, categoryId: ''} : task)
    });
  }

  renameProject(name: string): void {
    this.commit({...this.state(), projectName: name.trim()});
  }

  private commit(state: BoardState): void {
    this.state.set(state);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      this.storageWarning.set('');
    } catch {
      this.storageWarning.set('瀏覽器目前無法儲存資料，請保持此頁面開啟。');
    }
  }

  private load(): BoardState {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed: unknown = JSON.parse(saved);
        if (isBoardState(parsed)) return parsed;
        this.storageWarning.set('儲存資料格式不完整，已載入範例看板。');
      }
    } catch {
      this.storageWarning.set('無法讀取儲存資料，已載入範例看板。');
    }
    return createInitialState();
  }
}
