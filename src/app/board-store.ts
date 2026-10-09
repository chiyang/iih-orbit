import { computed, Injectable, OnDestroy, signal } from '@angular/core';
import { BoardState, BoardStatus, Category, Project, Task, TaskStatus, WorkspaceState } from './models';
import { readBoardState } from './board-data';
import { createInitialState } from './seed';
import { createWorkspaceState, emptyWorkspace, readWorkspaceState, removeBoardStatus, statusKind } from './workspace-data';
import { BackupKind, copyWorkspaces, createBackup, OrbitBackup, readBackup } from './backup-data';
import { AppearancePreferences, DEFAULT_APPEARANCE, readAppearance } from './appearance-data';
import { readStoredData, StoredWorkspaceData, WORKSPACE_SELECTION_KEY, WORKSPACE_STORAGE_KEY } from './stored-data';
import { withStorageLock } from './storage-coordinator';

export type StoreResult = {ok: true; persisted: boolean} | {ok: false; message: string};
export interface TaskEditContext {
  workspaceId: string;
  generation: string;
  original: Task | null;
}

@Injectable({providedIn: 'root'})
export class BoardStore implements OnDestroy {
  readonly storageWarning = signal('');
  readonly syncNotice = signal('');
  readonly pendingWrites = signal(0);
  readonly hasUnsavedChanges = signal(false);
  private readonly selectionStorage = this.sessionStorage();
  private snapshot = this.load();
  private lastSavedRevision = this.snapshot.revision;
  readonly generation = signal(this.snapshot.generation);
  readonly revision = signal(this.snapshot.revision);
  readonly appearance = signal<AppearancePreferences>(this.snapshot.preferences ?? this.legacyAppearance());
  readonly workspaceState = signal<WorkspaceState>(this.selectedState(this.snapshot.state));
  readonly workspaces = computed(() => this.workspaceState().workspaces);
  readonly currentWorkspace = computed(() => this.workspaces().find(workspace => workspace.id === this.workspaceState().activeWorkspaceId)!);
  readonly state = computed<BoardState>(() => this.currentWorkspace());
  readonly tasks = computed(() => this.state().tasks);
  readonly categories = computed(() => this.state().categories);
  readonly projects = computed(() => this.state().projects);
  readonly statuses = computed(() => this.state().statuses);
  readonly activeTasks = computed(() => this.tasks().filter(task => !this.isArchived(task)));
  readonly completed = computed(() => this.activeTasks().filter(task => this.isDone(task)).length);
  readonly progress = computed(() => this.activeTasks().length ? Math.round(this.completed() / this.activeTasks().length * 100) : 0);
  private channel?: BroadcastChannel;
  private readonly storageListener = (event: StorageEvent) => {
    if (event.key === WORKSPACE_STORAGE_KEY || event.key === null) this.refreshFromStorage();
  };
  private readonly focusListener = () => this.refreshFromStorage();

  constructor() {
    if (typeof window === 'undefined') return;
    window.addEventListener('storage', this.storageListener);
    window.addEventListener('focus', this.focusListener);
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        this.channel = new BroadcastChannel('iih-orbit-data');
        this.channel.onmessage = () => this.refreshFromStorage();
      }
    } catch { /* The storage event remains available when channels are blocked. */ }
  }

  ngOnDestroy(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('storage', this.storageListener);
      window.removeEventListener('focus', this.focusListener);
    }
    this.channel?.close();
  }

  isDone(task: Task): boolean { return statusKind(this.statuses(), task.status) === 'done'; }
  isArchived(task: Task): boolean { return statusKind(this.statuses(), task.status) === 'archived'; }

  taskContext(id: string): TaskEditContext {
    return {workspaceId: this.currentWorkspace().id, generation: this.generation(), original: structuredClone(this.tasks().find(task => task.id === id) ?? null)};
  }

  saveTask(task: Task, context: TaskEditContext = this.taskContext(task.id)): Promise<StoreResult> {
    const saved = structuredClone(task);
    return this.mutateBoard(board => {
      const current = board.tasks.find(item => item.id === saved.id) ?? null;
      if (JSON.stringify(current) !== JSON.stringify(context.original)) throw new Error('這個任務已在另一個分頁更新或刪除。草稿已保留，請載入最新版本或另存為新任務。');
      if (!board.statuses.some(status => status.id === saved.status) || (saved.categoryId && !board.categories.some(category => category.id === saved.categoryId))) throw new Error('任務的分類或狀態已變更，請重新選擇後儲存。');
      if (saved.projectId && !board.projects.some(project => project.id === saved.projectId)) throw new Error('所屬專案已被刪除，請重新選擇或改為未指定專案。');
      const tasks = current ? board.tasks.map(item => item.id === saved.id ? saved : item) : [...board.tasks, saved];
      return {...board, tasks};
    }, context.workspaceId, context.generation);
  }

  deleteTask(id: string, context: TaskEditContext = this.taskContext(id)): Promise<StoreResult> {
    return this.mutateBoard(board => {
      const task = board.tasks.find(item => item.id === id) ?? null;
      if (JSON.stringify(task) !== JSON.stringify(context.original)) throw new Error('這個任務已更新，請重新查看後再刪除。');
      return {...board, tasks: board.tasks.filter(task => task.id !== id)};
    }, context.workspaceId, context.generation);
  }

  moveTask(id: string, status: TaskStatus, beforeId?: string): Promise<StoreResult> {
    return this.mutateBoard(board => {
      const task = board.tasks.find(item => item.id === id);
      if (!task) throw new Error('這個任務已被其他分頁刪除，無法移動。');
      if (!board.statuses.some(item => item.id === status)) throw new Error('目的狀態已被其他分頁刪除，請重新選擇。');
      const tasks = board.tasks.filter(item => item.id !== id);
      const beforeIndex = beforeId ? tasks.findIndex(item => item.id === beforeId && item.status === status) : -1;
      const lastInColumn = tasks.findLastIndex(item => item.status === status);
      const index = beforeIndex >= 0 ? beforeIndex : lastInColumn >= 0 ? lastInColumn + 1 : tasks.length;
      tasks.splice(index, 0, {...task, status});
      return {...board, tasks};
    });
  }

  saveCategory(category: Category): Promise<StoreResult> {
    const saved = {...category};
    const original = this.categories().find(item => item.id === saved.id);
    return this.mutateBoard(board => {
      if (original && !board.categories.some(item => item.id === saved.id)) throw new Error('這個分類已被刪除，請重新建立。');
      if (board.categories.some(item => item.id !== saved.id && item.name.toLocaleLowerCase() === saved.name.toLocaleLowerCase())) throw new Error('此分類名稱已存在。');
      const categories = board.categories.some(item => item.id === saved.id) ? board.categories.map(item => item.id === saved.id ? saved : item) : [...board.categories, saved];
      return {...board, categories};
    });
  }

  deleteCategory(id: string): Promise<StoreResult> {
    return this.mutateBoard(board => ({...board, categories: board.categories.filter(category => category.id !== id), tasks: board.tasks.map(task => task.categoryId === id ? {...task, categoryId: ''} : task)}));
  }

  saveStatus(status: BoardStatus): Promise<StoreResult> {
    const saved = {...status, hidden: status.hidden ?? status.kind === 'archived'};
    const original = this.statuses().find(item => item.id === saved.id);
    return this.mutateBoard(board => {
      if (original && !board.statuses.some(item => item.id === saved.id)) throw new Error('這個狀態已被刪除，請重新建立。');
      const statuses = board.statuses.some(item => item.id === saved.id) ? board.statuses.map(item => item.id === saved.id ? saved : item) : [...board.statuses, saved];
      return {...board, statuses};
    });
  }

  reorderStatus(id: string, direction: number): Promise<StoreResult> {
    return this.mutateBoard(board => {
      const statuses = [...board.statuses];
      const index = statuses.findIndex(status => status.id === id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= statuses.length) return board;
      [statuses[index], statuses[target]] = [statuses[target], statuses[index]];
      return {...board, statuses};
    });
  }

  deleteStatus(id: string, destination: string): Promise<StoreResult> {
    return this.mutateBoard(board => {
      const next = removeBoardStatus(board, id, destination);
      if (!next) throw new Error('狀態或任務移入的目的狀態已變更，請重新選擇；至少保留一個狀態。');
      return next;
    });
  }
  saveProject(project: Project, original: Project | null = this.projects().find(item => item.id === project.id) ?? null): Promise<StoreResult> {
    const saved = {id: project.id, name: project.name.trim()};
    return this.mutateBoard(board => {
      const current = board.projects.find(item => item.id === saved.id) ?? null;
      if (JSON.stringify(current) !== JSON.stringify(original)) throw new Error('這個專案已在其他分頁更新或刪除，請重新查看；輸入內容仍保留。');
      if (!saved.name || board.projects.some(item => item.id !== saved.id && item.name.toLocaleLowerCase() === saved.name.toLocaleLowerCase())) throw new Error('請輸入不重複的專案名稱。');
      return {...board, projects: current ? board.projects.map(item => item.id === saved.id ? saved : item) : [...board.projects, saved]};
    });
  }

  deleteProject(project: Project): Promise<StoreResult> {
    return this.mutateBoard(board => {
      const current = board.projects.find(item => item.id === project.id);
      if (JSON.stringify(current) !== JSON.stringify(project)) throw new Error('這個專案已更新或刪除，請重新查看後再移除。');
      return {...board, projects: board.projects.filter(item => item.id !== project.id), tasks: board.tasks.map(task => task.projectId === project.id ? {...task, projectId: ''} : task)};
    });
  }

  switchWorkspace(id: string): void {
    if (!this.workspaces().some(workspace => workspace.id === id)) return;
    this.workspaceState.update(state => ({...state, activeWorkspaceId: id}));
    this.rememberSelection(id);
  }

  saveWorkspace(id: string, name: string): Promise<StoreResult> {
    const label = name.trim();
    const newWorkspace = id ? null : emptyWorkspace(crypto.randomUUID(), label);
    return this.transact(data => {
      if (!label) throw new Error('請輸入工作空間名稱。');
      if (id && !data.state.workspaces.some(workspace => workspace.id === id)) throw new Error('這個工作空間已被刪除。');
      return {...data, state: {...data.state, workspaces: newWorkspace ? [...data.state.workspaces, newWorkspace] : data.state.workspaces.map(workspace => workspace.id === id ? {...workspace, name: label} : workspace)}};
    }, {select: newWorkspace?.id});
  }

  deleteWorkspace(id: string): Promise<StoreResult> {
    return this.transact(data => {
      if (data.state.workspaces.length <= 1) throw new Error('至少保留一個工作空間。');
      const workspaces = data.state.workspaces.filter(workspace => workspace.id !== id);
      return {...data, state: {...data.state, workspaces, activeWorkspaceId: workspaces.some(workspace => workspace.id === data.state.activeWorkspaceId) ? data.state.activeWorkspaceId : workspaces[0].id}};
    });
  }

  async snapshotForExport(): Promise<WorkspaceState> {
    return withStorageLock(() => {
      if (this.hasUnsavedChanges()) return structuredClone(this.workspaceState());
      try { this.apply(this.readLatest()); }
      catch { this.storageWarning.set('最新儲存資料無法讀取，這份備份會保存本分頁目前可讀的內容。'); }
      return structuredClone(this.workspaceState());
    });
  }

  async backupForExport(kind: BackupKind, selectedIds: string[] = []): Promise<OrbitBackup> {
    return withStorageLock(() => {
      if (!this.hasUnsavedChanges()) this.apply(this.readLatest());
      return createBackup(this.workspaceState(), kind, selectedIds, this.appearance());
    });
  }

  updateAppearance(patch: Partial<AppearancePreferences>): Promise<StoreResult> {
    return this.transact(data => {
      const preferences = readAppearance({...data.preferences, ...patch});
      if (!preferences) throw new Error('外觀設定不合法，請輸入完整的六位 HEX 色碼。');
      return {...data, preferences};
    });
  }

  resetData(all: boolean, expectedRevision: string): Promise<StoreResult> {
    const workspace = emptyWorkspace(crypto.randomUUID(), '我的工作空間');
    return this.transact(data => {
      if (data.revision !== expectedRevision) throw new Error('確認期間資料或設定已更新，請重新查看後再重置。');
      return {...data, generation: crypto.randomUUID(), preferences: all ? {...DEFAULT_APPEARANCE} : data.preferences,
        state: {version: 1, activeWorkspaceId: workspace.id, workspaces: [workspace]}};
    }, {requirePersistence: true, select: workspace.id, afterPersist: () => {
      for (const key of ['orbit-workspaces-v1', 'orbit-board-v1', 'orbit-board-v1-backup', 'orbit-text-size-v1']) localStorage.removeItem(key);
      this.selectionStorage?.removeItem(WORKSPACE_SELECTION_KEY);
    }});
  }

  importBackup(input: OrbitBackup, expectedRevision?: string): Promise<StoreResult> {
    let backup: OrbitBackup;
    try { backup = readBackup(input); }
    catch (error) { return Promise.resolve({ok: false, message: this.message(error)}); }
    const added = backup.kind === 'workspaces' ? copyWorkspaces(backup.data.workspaces) : [];
    return this.transact(data => {
      if (backup.kind === 'full') {
        if (!expectedRevision || data.revision !== expectedRevision) throw new Error('確認期間資料已更新，請重新檢查覆蓋範圍後再匯入。');
        return {...data, generation: crypto.randomUUID(), state: structuredClone(backup.data), preferences: backup.preferences ?? {...DEFAULT_APPEARANCE}};
      }
      return {...data, state: {...data.state, workspaces: [...data.state.workspaces, ...added]}};
    }, {requirePersistence: true, select: backup.kind === 'full' ? backup.data.activeWorkspaceId : added[0].id});
  }

  refreshFromStorage(): void {
    try {
      const latest = this.readLatest();
      if (latest.revision === this.lastSavedRevision) return;
      if (this.hasUnsavedChanges()) {
        this.storageWarning.set('其他分頁有新資料，但本分頁仍有未儲存變更。請先匯出此分頁的備份，避免遺失內容。');
        return;
      }
      const replaced = latest.generation !== this.generation();
      this.apply(latest);
      this.syncNotice.set(replaced ? '其他分頁已還原或重置資料，畫面已更新；未送出的表單草稿仍保留。' : '已同步其他分頁的資料與設定。');
    } catch (error) { this.storageWarning.set(this.message(error)); }
  }

  private mutateBoard(change: (board: BoardState) => BoardState, workspaceId = this.currentWorkspace().id, generation = this.generation()): Promise<StoreResult> {
    return this.transact(data => {
      const workspace = data.state.workspaces.find(item => item.id === workspaceId);
      if (!workspace) throw new Error('原工作空間已被刪除或取代，草稿仍保留。');
      const board = change(workspace);
      return {...data, state: {...data.state, workspaces: data.state.workspaces.map(item => item.id === workspaceId ? {...workspace, ...board} : item)}};
    }, {generation});
  }

  private async transact(change: (data: StoredWorkspaceData) => StoredWorkspaceData, options: {generation?: string; requirePersistence?: boolean; select?: string; afterPersist?: () => void} = {}): Promise<StoreResult> {
    const expectedGeneration = options.generation ?? this.generation();
    this.pendingWrites.update(count => count + 1);
    try {
      return await withStorageLock(() => {
        const disk = this.readLatest();
        if (this.hasUnsavedChanges() && disk.revision !== this.lastSavedRevision) throw new Error('其他分頁已更新資料，請先匯出本分頁未儲存的內容，再重新整理。');
        const latest = this.hasUnsavedChanges() ? {...this.snapshot, state: this.workspaceState()} : disk;
        if (latest.generation !== expectedGeneration) {
          this.apply(latest);
          throw new Error('資料已被其他分頁取代，請重新查看後再操作。');
        }
        const changed = change(structuredClone(latest));
        const state = readWorkspaceState(changed.state);
        if (!state) throw new Error('分類、狀態或日期資料不合法，未儲存這次變更。');
        const next: StoredWorkspaceData = {...changed, state, revision: crypto.randomUUID(), updatedAt: new Date().toISOString()};
        try { localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(next)); }
        catch {
          if (options.requirePersistence) throw new Error('瀏覽器儲存空間不足或無法保存，還原或重置未套用；原有資料保留。');
          this.apply(next, options.select, false);
          this.hasUnsavedChanges.set(true);
          this.storageWarning.set('瀏覽器目前無法儲存資料。變更只保留在此分頁，請保持開啟並匯出備份。');
          return {ok: true, persisted: false};
        }
        let cleanupWarning = '';
        try { options.afterPersist?.(); }
        catch { cleanupWarning = '資料已重置，但瀏覽器阻擋部分舊資料的清理。空白工作空間已保存，舊資料不會自動載入。'; }
        this.apply(next, options.select);
        this.hasUnsavedChanges.set(false);
        this.storageWarning.set(cleanupWarning);
        this.syncNotice.set('');
        try { this.channel?.postMessage({revision: next.revision}); } catch { /* Native storage events also notify other tabs. */ }
        return {ok: true, persisted: true};
      });
    } catch (error) {
      const message = this.message(error);
      this.storageWarning.set(message);
      return {ok: false, message};
    } finally { this.pendingWrites.update(count => count - 1); }
  }

  private apply(data: StoredWorkspaceData, select?: string, saved = true): void {
    this.snapshot = data;
    this.generation.set(data.generation);
    this.revision.set(data.revision);
    this.appearance.set(data.preferences ?? this.legacyAppearance());
    if (saved) this.lastSavedRevision = data.revision;
    const active = select ?? this.workspaceState().activeWorkspaceId;
    const state = {...data.state, activeWorkspaceId: data.state.workspaces.some(workspace => workspace.id === active) ? active : data.state.activeWorkspaceId};
    this.workspaceState.set(state);
    this.rememberSelection(state.activeWorkspaceId);
  }

  private selectedState(state: WorkspaceState): WorkspaceState {
    try {
      const id = this.selectionStorage?.getItem(WORKSPACE_SELECTION_KEY);
      if (id && state.workspaces.some(workspace => workspace.id === id)) return {...state, activeWorkspaceId: id};
    } catch { /* Workspace selection is optional and does not affect saved tasks. */ }
    return state;
  }

  private rememberSelection(id: string): void {
    try { this.selectionStorage?.setItem(WORKSPACE_SELECTION_KEY, id); } catch { /* Keep the current selection in memory. */ }
  }

  private sessionStorage(): Storage | undefined {
    try { return typeof sessionStorage === 'undefined' ? undefined : sessionStorage; } catch { return undefined; }
  }

  private readLatest(): StoredWorkspaceData {
    const saved = localStorage.getItem(WORKSPACE_STORAGE_KEY);
    if (saved) {
      const data = readStoredData(JSON.parse(saved));
      if (!data) throw new Error('儲存資料格式不完整，請先匯出目前可讀的資料，避免覆蓋原檔。');
      return {...data, preferences: data.preferences ?? this.legacyAppearance()};
    }
    return this.legacyData();
  }

  private load(): StoredWorkspaceData {
    try { return this.readLatest(); }
    catch {
      this.storageWarning.set('無法讀取最新儲存資料，已嘗試載入升級前資料。請先匯出備份。');
      try { return this.legacyData(); } catch { return this.initialData(createWorkspaceState(createInitialState())); }
    }
  }

  private legacyData(): StoredWorkspaceData {
    const saved = localStorage.getItem('orbit-workspaces-v1');
    if (saved) {
      const state = readWorkspaceState(JSON.parse(saved));
      if (!state) throw new Error('工作空間資料格式不完整。');
      return this.initialData(state);
    }
    const legacy = localStorage.getItem('orbit-board-v1');
    const board = legacy ? readBoardState(JSON.parse(legacy)) : createInitialState();
    if (!board) throw new Error('舊版看板資料格式不完整。');
    return this.initialData(createWorkspaceState(board));
  }

  private initialData(state: WorkspaceState): StoredWorkspaceData {
    return {formatVersion: 2, generation: 'local-v1', revision: 'legacy', updatedAt: new Date(0).toISOString(), state, preferences: this.legacyAppearance()};
  }

  private legacyAppearance(): AppearancePreferences {
    try { return readAppearance({textSize: localStorage.getItem('orbit-text-size-v1') ?? 'standard'}) ?? {...DEFAULT_APPEARANCE}; }
    catch { return {...DEFAULT_APPEARANCE}; }
  }

  private message(error: unknown): string { return error instanceof Error ? error.message : '無法完成資料操作，請保持此頁面開啟並下載備份。'; }
}
