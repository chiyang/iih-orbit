import { computed, Injectable, signal } from '@angular/core';
import { BoardState, BoardStatus, Category, Task, TaskStatus, WorkspaceState } from './models';
import { readBoardState } from './board-data';
import { createInitialState } from './seed';
import { createWorkspaceState, emptyWorkspace, readWorkspaceState, removeBoardStatus, statusKind, updateWorkspaceBoard } from './workspace-data';

const STORAGE_KEY = 'orbit-workspaces-v1';
const LEGACY_KEY = 'orbit-board-v1';

@Injectable({providedIn: 'root'})
export class BoardStore {
  readonly storageWarning = signal('');
  readonly workspaceState = signal<WorkspaceState>(this.load());
  readonly workspaces = computed(() => this.workspaceState().workspaces);
  readonly currentWorkspace = computed(() => this.workspaces().find(workspace => workspace.id === this.workspaceState().activeWorkspaceId)!);
  readonly state = computed<BoardState>(() => this.currentWorkspace());
  readonly tasks = computed(() => this.state().tasks);
  readonly categories = computed(() => this.state().categories);
  readonly statuses = computed(() => this.state().statuses);
  readonly activeTasks = computed(() => this.tasks().filter(task => !this.isArchived(task)));
  readonly completed = computed(() => this.activeTasks().filter(task => this.isDone(task)).length);
  readonly progress = computed(() => this.activeTasks().length ? Math.round(this.completed() / this.activeTasks().length * 100) : 0);

  isDone(task: Task): boolean {
    return statusKind(this.statuses(), task.status) === 'done';
  }

  isArchived(task: Task): boolean {
    return statusKind(this.statuses(), task.status) === 'archived';
  }

  saveTask(task: Task): void {
    if (!this.statuses().some(status => status.id === task.status)) return;
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
    if (!task || !this.statuses().some(item => item.id === status)) return;
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
    this.commit({...this.state(), categories: this.categories().filter(category => category.id !== id), tasks: this.tasks().map(task => task.categoryId === id ? {...task, categoryId: ''} : task)});
  }

  saveStatus(status: BoardStatus): void {
    const normalized = {...status, hidden: status.hidden ?? status.kind === 'archived'};
    const statuses = this.statuses().some(item => item.id === status.id)
      ? this.statuses().map(item => item.id === status.id ? normalized : item) : [...this.statuses(), normalized];
    this.commit({...this.state(), statuses});
  }

  reorderStatus(id: string, direction: number): void {
    const statuses = [...this.statuses()];
    const index = statuses.findIndex(status => status.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= statuses.length) return;
    [statuses[index], statuses[target]] = [statuses[target], statuses[index]];
    this.commit({...this.state(), statuses});
  }

  deleteStatus(id: string, destination: string): void {
    const board = removeBoardStatus(this.state(), id, destination);
    if (board) this.commit(board);
  }

  renameProject(name: string): void {
    this.commit({...this.state(), projectName: name.trim()});
  }

  switchWorkspace(id: string): void {
    if (this.workspaces().some(workspace => workspace.id === id)) this.persist({...this.workspaceState(), activeWorkspaceId: id});
  }

  saveWorkspace(id: string, name: string): void {
    if (!name.trim()) return;
    if (id) {
      this.persist({...this.workspaceState(), workspaces: this.workspaces().map(workspace => workspace.id === id ? {...workspace, name: name.trim()} : workspace)});
    } else {
      const workspace = emptyWorkspace(crypto.randomUUID(), name);
      this.persist({...this.workspaceState(), activeWorkspaceId: workspace.id, workspaces: [...this.workspaces(), workspace]});
    }
  }

  deleteWorkspace(id: string): void {
    if (this.workspaces().length <= 1 || !this.workspaces().some(workspace => workspace.id === id)) return;
    const workspaces = this.workspaces().filter(workspace => workspace.id !== id);
    this.persist({...this.workspaceState(), workspaces, activeWorkspaceId: this.workspaceState().activeWorkspaceId === id ? workspaces[0].id : this.workspaceState().activeWorkspaceId});
  }

  private commit(state: BoardState): void {
    this.persist(updateWorkspaceBoard(this.workspaceState(), state));
  }

  private persist(state: WorkspaceState): void {
    this.workspaceState.set(state);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      this.storageWarning.set('');
    } catch {
      this.storageWarning.set('瀏覽器目前無法儲存資料，請保持此頁面開啟。');
    }
  }

  private load(): WorkspaceState {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const state = readWorkspaceState(JSON.parse(saved));
        if (state) return state;
        this.storageWarning.set('工作空間資料格式不完整，已嘗試載入升級前的看板。');
      }
      const legacy = localStorage.getItem(LEGACY_KEY);
      const board = legacy ? readBoardState(JSON.parse(legacy)) : createInitialState();
      if (board) {
        const state = createWorkspaceState(board);
        // Keep the old key intact as a recoverable copy of the original board.
        if (!saved) {
          try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
          catch { this.storageWarning.set('工作空間已建立，但瀏覽器目前無法保存升級資料。'); }
        }
        return state;
      }
      this.storageWarning.set('儲存資料格式不完整，已載入範例看板。');
    } catch {
      this.storageWarning.set('無法讀取儲存資料，已載入範例看板。');
    }
    return createWorkspaceState(createInitialState());
  }
}
