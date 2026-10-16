import { computed, Injectable, OnDestroy, signal } from '@angular/core';
import { BoardState, BoardStatus, CalendarTransfer, Category, DocumentDescription, DocumentLink, DocumentSource, Project, Task, TaskConflict, TaskStatus, WorkspaceState } from './models';
import { originKey, taskFingerprint } from './calendar-transfer-data';
import { readBoardState } from './board-data';
import { createInitialState, isInitialWorkspace } from './seed';
import { createWorkspaceState, emptyWorkspace, readWorkspaceState, removeBoardStatus, statusKind } from './workspace-data';
import { BackupKind, copyWorkspaces, createBackup, OrbitBackup, readBackup } from './backup-data';
import { AppearancePreferences, DEFAULT_APPEARANCE, readAppearance, sharedAppearance } from './appearance-data';
import { OnboardingPhase, readStoredData, StoredWorkspaceData, WORKSPACE_SELECTION_KEY, WORKSPACE_STORAGE_KEY } from './stored-data';
import { withStorageLock } from './storage-coordinator';
import { CalendarSource, DEFAULT_GOOGLE, GoogleSettings, readGoogleSettings } from './google-data';
import { DEFAULT_REMINDERS, ReminderPreferences, readReminders } from './reminder-data';
import { DEFAULT_DRIVE, DriveSettings, readDriveSettings } from './drive-settings';
import { projectProgress } from './project-data';
import { recordTaskEdits } from './task-activity-data';
import { BoardHistoryEntry, boardChangeLabel, HISTORY_LIMIT, sameBoard } from './board-history';
import type { WorkspaceCreationOptions } from './workspace-templates';
import { unresolvedTaskConflicts } from './task-conflict-data';
import { DEVICE_NAME_LIMIT, DEVICE_STORAGE_KEY, loadDeviceIdentity } from './device-data';
import { WorkspaceRecordRepository } from './workspace-records';
import { descriptionsForTask, documentIdentity, documentsForTask, indexDocumentTasks, indexTaskInformation, mergeDocumentLinks, mergeDocumentSources, reconcileDocumentTasks, setTaskDocuments, taskDocumentIds, taskInformationKey } from './document-data';
import {documentCleanupCandidates} from './document-source-cleanup';

export type StoreResult = {ok: true; persisted: boolean} | {ok: false; message: string};
export interface TaskEditContext {
  workspaceId: string;
  generation: string;
  original: Task | null;
  documentLinks?: DocumentLink[];
  informationKey?: string;
}
export interface TrashContext {workspaceId: string; workspaceName: string; generation: string; tasks: Task[]}

@Injectable({providedIn: 'root'})
export class BoardStore implements OnDestroy {
  readonly storageWarning = signal('');
  readonly syncNotice = signal('');
  readonly pendingWrites = signal(0);
  readonly hasUnsavedChanges = signal(false);
  readonly storageLoading = signal(false);
  private readonly records = typeof window !== 'undefined' && typeof indexedDB !== 'undefined' ? new WorkspaceRecordRepository() : null;
  private ready: Promise<void> = Promise.resolve();
  private storageFailure = '';
  readonly device = signal(loadDeviceIdentity());
  private readonly selectionStorage = this.sessionStorage();
  private snapshot = this.load();
  private lastSavedRevision = this.snapshot.revision;
  readonly generation = signal(this.snapshot.generation);
  readonly revision = signal(this.snapshot.revision);
  readonly onboarding = signal<OnboardingPhase | null>(!this.storageWarning() && isInitialWorkspace(this.snapshot.state) ? this.snapshot.onboarding ?? null : null);
  readonly appearance = signal<AppearancePreferences>(this.snapshot.preferences ?? this.legacyAppearance());
  readonly google = signal<GoogleSettings>(this.snapshot.google ?? structuredClone(DEFAULT_GOOGLE));
  readonly reminders = signal<ReminderPreferences>(this.snapshot.reminders ?? {...DEFAULT_REMINDERS});
  readonly drive = signal<DriveSettings>(this.snapshot.drive ?? structuredClone(DEFAULT_DRIVE));
  readonly cloudResume = signal(this.snapshot.cloudResume);
  readonly workspaceState = signal<WorkspaceState>(this.selectedState(this.snapshot.state));
  readonly workspaces = computed(() => this.workspaceState().workspaces);
  readonly currentWorkspace = computed(() => this.workspaces().find(workspace => workspace.id === this.workspaceState().activeWorkspaceId)!);
  readonly state = computed<BoardState>(() => this.currentWorkspace());
  readonly tasks = computed(() => this.state().tasks.filter(task => !task.deletedAt));
  readonly trashedTasks = computed(() => this.state().tasks.filter(task => !!task.deletedAt));
  readonly taskConflicts = computed(() => this.workspaces().flatMap(workspace => unresolvedTaskConflicts(workspace.taskConflicts).map(conflict => ({workspace, conflict}))));
  readonly documents = computed(() => [...new Map(this.workspaces().flatMap(workspace => workspace.documentSources ?? []).map(source => [documentIdentity(source), source])).values()]);
  private readonly documentRelations = computed(() => indexDocumentTasks(this.workspaces(), true));
  private readonly documentCounts = computed(() => {
    const active = new Set(this.tasks().map(task => task.id));
    return new Map([...taskDocumentIds(this.state())].filter(([id]) => active.has(id)).map(([id, documents]) => [id, documents.length]));
  });
  documentCount(taskId: string): number {return this.documentCounts().get(taskId) ?? 0;}
  documentsForTask(taskId: string, workspaceId = this.currentWorkspace().id): DocumentSource[] {
    const workspace = this.workspaces().find(item => item.id === workspaceId);
    return workspace ? documentsForTask(workspace, taskId) : [];
  }
  tasksForDocument(source: DocumentSource, includeTrash = false) {return (this.documentRelations().get(documentIdentity(source)) ?? []).filter(entry => includeTrash || !entry.task.deletedAt);}
  private readonly history = signal<BoardHistoryEntry[]>([]);
  private readonly documentProtections = signal<(() => ReadonlySet<string>)[]>([]);
  private protectedDocumentIds(): Set<string> {return new Set(this.documentProtections().flatMap(read => [...read()]));}
  readonly documentCleanupPreview = computed(() => documentCleanupCandidates(this.workspaces(), this.history(), this.protectedDocumentIds()));
  protectDocumentSources(read: () => ReadonlySet<string>): () => void {this.documentProtections.update(values => [...values, read]); return () => this.documentProtections.update(values => values.filter(value => value !== read));}
  async cleanUnusedDocumentSources(): Promise<StoreResult & {removed?: number}> {
    const generation = this.generation(), requested = new Set(this.documentCleanupPreview().filter(item => !item.reasons.length).map(item => JSON.stringify([item.workspaceId, item.documentId])));
    if (!requested.size) return {ok: false, message: '目前沒有可安全整理的無使用來源。'};
    let removed = 0;
    const result = await this.transact(data => {
      const allowed = new Set(documentCleanupCandidates(data.state.workspaces, this.history(), this.protectedDocumentIds()).filter(item => !item.reasons.length && requested.has(JSON.stringify([item.workspaceId, item.documentId]))).map(item => JSON.stringify([item.workspaceId, item.documentId])));
      if (!allowed.size) throw new Error('來源已被使用或保護範圍已更新，請重新查看整理清單。');
      removed = allowed.size;
      return {...data, state: {...data.state, workspaces: data.state.workspaces.map(workspace => ({...workspace, ...(workspace.documentSources ? {documentSources: workspace.documentSources.filter(source => !allowed.has(JSON.stringify([workspace.id, source.id])))} : {})}))}};
    }, {generation, requirePersistence: true, persistenceMessage: '來源整理未能保存，原來源與歷史紀錄保留。'});
    return {...result, removed: result.ok ? removed : 0};
  }
  private readonly lastUndo = computed(() => this.history().findLast(entry => !entry.undone && entry.workspaceId === this.currentWorkspace().id && entry.generation === this.generation()));
  private readonly nextRedo = computed(() => this.history().find(entry => entry.undone && entry.workspaceId === this.currentWorkspace().id && entry.generation === this.generation()));
  readonly undoLabel = computed(() => this.lastUndo()?.label ?? '');
  readonly canUndo = computed(() => !!this.lastUndo() && sameBoard(readBoardState(this.state())!, this.lastUndo()!.after));
  readonly redoLabel = computed(() => this.nextRedo()?.label ?? '');
  readonly canRedo = computed(() => !!this.nextRedo() && sameBoard(readBoardState(this.state())!, this.nextRedo()!.before));
  readonly categories = computed(() => this.state().categories);
  readonly projects = computed(() => this.state().projects);
  readonly statuses = computed(() => this.state().statuses);
  readonly activeTasks = computed(() => this.tasks().filter(task => !this.isArchived(task)));
  readonly completed = computed(() => this.activeTasks().filter(task => this.isDone(task)).length);
  readonly progress = computed(() => projectProgress(this.tasks(), this.statuses(), 'all', '所有專案', this.projects()).percent);
  private channel?: BroadcastChannel;
  private readonly storageListener = (event: StorageEvent) => {
    if (event.key === DEVICE_STORAGE_KEY || event.key === null) this.device.set(loadDeviceIdentity(this.device()));
    if (event.key === WORKSPACE_STORAGE_KEY || event.key === null) this.refreshFromStorage();
  };
  private readonly focusListener = () => {this.device.set(loadDeviceIdentity(this.device())); this.refreshFromStorage();};

  constructor() {
    if (this.records) {
      this.storageLoading.set(true); this.pendingWrites.update(count => count + 1);
      this.ready = this.initializeRecords().catch(error => {this.storageFailure = this.message(error); this.storageWarning.set(this.storageFailure);}).finally(() => {this.storageLoading.set(false); this.pendingWrites.update(count => count - 1);});
    }
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

  setDeviceName(value: string): StoreResult {
    const name = value.trim();
    if (!name || name.length > DEVICE_NAME_LIMIT) return {ok: false, message: '請填寫 1–60 字的裝置名稱。'};
    const identity = {...loadDeviceIdentity(this.device()), name};
    try {localStorage.setItem(DEVICE_STORAGE_KEY, JSON.stringify(identity));}
    catch {return {ok: false, message: '瀏覽器無法保存裝置名稱，原名稱保留。'};}
    this.device.set(identity);
    return {ok: true, persisted: true};
  }

  taskContext(id: string): TaskEditContext {
    return {workspaceId: this.currentWorkspace().id, generation: this.generation(), original: structuredClone(this.state().tasks.find(task => task.id === id) ?? null), documentLinks: structuredClone(this.state().documentLinks?.filter(link => link.taskId === id) ?? []), informationKey: taskInformationKey(this.state(), id)};
  }

  descriptionsForTask(taskId: string, workspaceId = this.currentWorkspace().id): DocumentDescription[] {
    const workspace = this.workspaces().find(item => item.id === workspaceId);
    return workspace ? descriptionsForTask(workspace, taskId) : [];
  }

  saveTask(task: Task, context: TaskEditContext = this.taskContext(task.id), beforeId?: string, documents?: readonly DocumentSource[], descriptions?: readonly DocumentDescription[]): Promise<StoreResult> {
    const saved = structuredClone(task);
    const selected = documents === undefined ? undefined : structuredClone([...documents]);
    const notes = descriptions === undefined ? undefined : structuredClone([...descriptions]);
    return this.mutateBoard(board => {
      const current = board.tasks.find(item => item.id === saved.id) ?? null;
      if (current?.deletedAt || saved.deletedAt) throw new Error('這個任務已刪除並移至垃圾桶，請先還原後再編輯。');
      if (JSON.stringify(current) !== JSON.stringify(context.original)) throw new Error('這個任務已在另一個分頁更新或刪除。草稿已保留，請載入最新版本或另存為新任務。');
      if (selected && context.documentLinks && JSON.stringify(board.documentLinks?.filter(link => link.taskId === saved.id) ?? []) !== JSON.stringify(context.documentLinks)) throw new Error('文件關聯已在另一個分頁更新。草稿已保留，請載入最新版本或另存新任務。');
      if (selected && context.informationKey !== undefined && taskInformationKey(board, saved.id) !== context.informationKey) throw new Error('連結用途或順序已在另一個分頁更新。草稿已保留，請載入最新版本或另存新任務。');
      if (!board.statuses.some(status => status.id === saved.status) || (saved.categoryId && !board.categories.some(category => category.id === saved.categoryId))) throw new Error('任務的分類或狀態已變更，請重新選擇後儲存。');
      if (saved.projectId && !board.projects.some(project => project.id === saved.projectId)) throw new Error('所屬專案已被刪除，請重新選擇或改為未指定專案。');
      const tasks = current ? board.tasks.map(item => item.id === saved.id ? saved : item) : [...board.tasks];
      if (!current) {
        const beforeIndex = beforeId ? tasks.findIndex(item => item.id === beforeId && item.status === saved.status) : -1;
        tasks.splice(beforeIndex < 0 ? tasks.length : beforeIndex, 0, saved);
      }
      const changed = {...board, tasks};
      return selected === undefined ? changed : setTaskDocuments(changed, saved.id, selected, undefined, notes ?? []);
    }, context.workspaceId, context.generation);
  }

  linkDocument(taskId: string, source: DocumentSource, context = this.taskContext(taskId), options: {verify?: () => void; requirePersistence?: boolean} = {}): Promise<StoreResult> {
    const document = structuredClone(source);
    return this.mutateBoard(board => {
      const task = board.tasks.find(item => item.id === taskId);
      if (!task || task.deletedAt || JSON.stringify(task) !== JSON.stringify(context.original)) throw new Error('任務已更新或刪除，請重新查看後再加入文件。');
      return setTaskDocuments(board, taskId, [...documentsForTask(board, taskId), document], undefined, []);
    }, context.workspaceId, context.generation, false, options);
  }

  deleteTask(id: string, context: TaskEditContext = this.taskContext(id)): Promise<StoreResult> {
    return this.mutateBoard(board => {
      const task = board.tasks.find(item => item.id === id) ?? null;
      if (!task || task.deletedAt) throw new Error('這個任務已移至垃圾桶或不存在。');
      if (JSON.stringify(task) !== JSON.stringify(context.original)) throw new Error('這個任務已更新，請重新查看後再刪除。');
      return {...board, tasks: board.tasks.map(item => item.id === id ? {...item, deletedAt: new Date().toISOString()} : item)};
    }, context.workspaceId, context.generation);
  }

  restoreTask(id: string, context: TaskEditContext = this.taskContext(id)): Promise<StoreResult> {
    return this.mutateBoard(board => {
      const task = board.tasks.find(item => item.id === id);
      if (!task?.deletedAt || JSON.stringify(task) !== JSON.stringify(context.original)) throw new Error('垃圾桶中的任務已更新或移除，請重新查看後再還原。');
      return {...board, tasks: board.tasks.map(item => {
        if (item.id !== id) return item;
        const {deletedAt, ...restored} = item;
        return restored;
      })};
    }, context.workspaceId, context.generation);
  }

  trashContext(): TrashContext {
    return {workspaceId: this.currentWorkspace().id, workspaceName: this.currentWorkspace().name, generation: this.generation(), tasks: structuredClone(this.trashedTasks())};
  }

  purgeTask(id: string, context: TaskEditContext = this.taskContext(id)): Promise<StoreResult> {
    return this.transact(data => {
      const workspace = data.state.workspaces.find(item => item.id === context.workspaceId);
      const task = workspace?.tasks.find(item => item.id === id);
      if (!workspace || !task?.deletedAt || JSON.stringify(task) !== JSON.stringify(context.original)) throw new Error('垃圾桶中的任務已更新、還原或移除，請重新查看後再確認刪除。');
      if (context.documentLinks && JSON.stringify(workspace.documentLinks?.filter(link => link.taskId === id) ?? []) !== JSON.stringify(context.documentLinks)
        || context.informationKey !== undefined && taskInformationKey(workspace, id) !== context.informationKey) throw new Error('任務的資訊連結已更新，請重新查看後再確認刪除。');
      if (unresolvedTaskConflicts(workspace.taskConflicts).some(conflict => conflict.id === id)) throw new Error('這個任務有同步衝突，請先在右側欄處理衝突。');
      const changed = {...workspace, tasks: workspace.tasks.filter(item => item.id !== id),
        ...(workspace.documentLinks ? {documentLinks: workspace.documentLinks.map(link => link.taskId === id ? {...link, removed: true as const} : link)} : {})};
      return {...data, state: {...data.state, workspaces: data.state.workspaces.map(item => item.id === workspace.id ? reconcileDocumentTasks(changed) : item)}};
    }, {generation: context.generation, requirePersistence: true, persistenceMessage: '無法保存徹底刪除的變更，任務仍保留在垃圾桶。', afterApply: () => this.history.update(entries => entries.filter(entry => entry.workspaceId !== context.workspaceId))});
  }

  emptyTrash(context: TrashContext): Promise<StoreResult> {
    return this.transact(data => {
      const workspace = data.state.workspaces.find(item => item.id === context.workspaceId);
      if (!workspace || JSON.stringify(workspace.tasks.filter(task => !!task.deletedAt)) !== JSON.stringify(context.tasks)) throw new Error('垃圾桶內容已更新，請重新查看後再確認清空。');
      const ids = new Set(context.tasks.map(task => task.id));
      if (unresolvedTaskConflicts(workspace.taskConflicts).some(conflict => ids.has(conflict.id))) throw new Error('垃圾桶含有待選擇版本的任務，請先在右側欄處理衝突。');
      return {...data, state: {...data.state, workspaces: data.state.workspaces.map(item => item.id === workspace.id ? reconcileDocumentTasks({...item, tasks: item.tasks.filter(task => !ids.has(task.id))}) : item)}};
    }, {generation: context.generation, requirePersistence: true, persistenceMessage: '無法保存清空垃圾桶的變更，垃圾桶內容仍保留。', afterApply: () => this.history.update(entries => entries.filter(entry => entry.workspaceId !== context.workspaceId))});
  }

  cancelTaskCreation(context: TaskEditContext): Promise<StoreResult> {
    return this.mutateBoard(board => {
      const task = board.tasks.find(item => item.id === context.original?.id);
      if (!task || task.deletedAt || JSON.stringify(task) !== JSON.stringify(context.original)) throw new Error('這個任務已更新，無法撤銷建立。');
      return reconcileDocumentTasks({...board, tasks: board.tasks.filter(item => item.id !== task.id)});
    }, context.workspaceId, context.generation);
  }

  undo(): Promise<StoreResult> { return this.travelHistory(false); }
  redo(): Promise<StoreResult> { return this.travelHistory(true); }

  private async travelHistory(redo: boolean): Promise<StoreResult> {
    const entry = redo ? this.nextRedo() : this.lastUndo();
    const action = redo ? '重做' : '復原';
    if (!entry || this.pendingWrites()) return {ok: false, message: `目前沒有可${action}的操作。`};
    const result = await this.transact(data => {
      const workspace = data.state.workspaces.find(item => item.id === entry.workspaceId);
      if (!workspace || !sameBoard(readBoardState(workspace)!, redo ? entry.before : entry.after)) throw new Error(`工作區已在其他分頁更新，無法${action}這一步；目前內容保留。`);
      const target = structuredClone(redo ? entry.after : entry.before);
      let restored: BoardState = target;
      if (workspace.documentSources) {
        const modern = workspace.version === 6 || target.version === 6;
        restored = {...target, version: modern ? 6 : 5, documentSources: mergeDocumentSources([workspace.documentSources, target.documentSources ?? []]), documentLinks: mergeDocumentLinks([workspace.documentLinks ?? [], target.documentLinks ?? []]),
          ...(modern ? {documentDetails: [...new Map([...(workspace.documentDetails ?? []), ...(target.documentDetails ?? [])].map(item => [item.id, item])).values()], documentOrders: target.documentOrders ?? []} : {})};
        for (const task of target.tasks.filter(task => !task.deletedAt)) restored = setTaskDocuments(restored, task.id, documentsForTask(target, task.id), undefined, modern ? descriptionsForTask(target, task.id) : undefined);
        restored = reconcileDocumentTasks(restored);
      }
      return {...data, state: {...data.state, workspaces: data.state.workspaces.map(item => item.id === workspace.id ? {...item, ...restored} : item)}};
    }, {generation: entry.generation, afterApply: () => this.history.update(entries => entries.map(item => item === entry ? {...item, undone: !redo} : item))});
    if (!result.ok) this.refreshFromStorage();
    return result;
  }

  setTaskPinned(id: string, pinned: boolean, context: TaskEditContext = this.taskContext(id)): Promise<StoreResult> {
    return this.mutateBoard(board => {
      const task = board.tasks.find(item => item.id === id);
      if (!task || task.deletedAt) throw new Error('這個任務已被刪除，無法變更釘選。');
      return {...board, tasks: board.tasks.map(item => item.id === id ? {...item, pinned} : item)};
    }, context.workspaceId, context.generation);
  }

  resolveTaskConflict(workspaceId: string, expected: TaskConflict, key: string, generation = this.generation(), edited?: Task): Promise<StoreResult> {
    const draft = edited ? structuredClone(edited) : undefined;
    return this.mutateBoard(board => {
      const conflict = board.taskConflicts?.find(value => value.id === expected.id);
      if (!conflict || conflict.resolved || JSON.stringify(conflict) !== JSON.stringify(expected)) throw new Error('這個衝突已在其他裝置或分頁更新，請重新查看版本。');
      const version = conflict.versions.find(value => value.key === key);
      if (!version) throw new Error('選定的任務版本已不存在，請重新查看。');
      if (draft && (!version.task || draft.id !== conflict.id)) throw new Error('草稿不屬於選定的任務版本，原有內容保留。');
      const task = draft ?? (version.task ? structuredClone(version.task) : null);
      if (task && (!task.title.trim() || task.title.length > 100 || task.description.length > 20000 || task.subtasks.some(item => !item.title.trim() || item.title.length > 200) || !readBoardState({...board, version: 4, documentSources: undefined, documentLinks: undefined, documentDetails: undefined, documentOrders: undefined, tasks: [task]}))) throw new Error('請確認名稱、描述、子任務、分類及時程，原有版本尚未變更。');
      const tasks = task ? board.tasks.some(value => value.id === task.id) ? board.tasks.map(value => value.id === task.id ? task : value) : [...board.tasks, task] : board.tasks.filter(value => value.id !== conflict.id);
      return {...board, tasks, taskConflicts: board.taskConflicts!.map(value => value.id === conflict.id ? {...value, resolved: key} : value)};
    }, workspaceId, generation, true);
  }

  prepareCalendarTransfer(transfer: CalendarTransfer, context: TaskEditContext, clientId: string): Promise<StoreResult> {
    return this.calendarTransaction(context, clientId, transfer.accountId, board => {
      const current = board.tasks.find(task => task.id === transfer.taskId);
      if (!current || current.deletedAt || JSON.stringify(current) !== JSON.stringify(context.original)) throw new Error('任務已更新，請重新查看後再移轉。');
      const pending = board.calendarTransfers?.find(item => item.taskId === current.id && !item.published);
      if (pending && pending.eventId !== transfer.eventId) throw new Error('這個任務有尚未確認的 Google 活動，請先重試原本的移轉。');
      if (pending) return board;
      return {...board, calendarTransfers: [...board.calendarTransfers ?? [], transfer]};
    });
  }
  finishCalendarTransfer(transfer: CalendarTransfer, context: TaskEditContext, clientId: string, keepOrbit = false, current?: () => void): Promise<StoreResult> {
    return this.calendarTransaction(context, clientId, transfer.accountId, board => {
      current?.();
      const saved = board.calendarTransfers?.find(item => originKey(item, item.eventId) === originKey(transfer, transfer.eventId));
      if (!saved || saved.body !== transfer.body) throw new Error('移轉紀錄已變更，Google 活動已保留，請重新查看。');
      return {...board, calendarTransfers: board.calendarTransfers!.filter(item => item !== saved), tasks: board.tasks.filter(task => keepOrbit || task.id !== saved.taskId || taskFingerprint(task) !== saved.original)};
    });
  }
  saveCalendarCopy(task: Task, context: TaskEditContext, clientId: string, accountId: string, verify?: () => void): Promise<StoreResult> {
    const saved = structuredClone(task);
    delete saved.calendarOrigin;
    return this.calendarTransaction(context, clientId, accountId, board => {
      verify?.();
      if (context.original || board.tasks.some(item => item.id === saved.id)) throw new Error('這份 Orbit 副本已建立，請重新開啟活動後再複製。');
      return {...board, tasks: [...board.tasks, saved]};
    });
  }
  private calendarTransaction(context: TaskEditContext, clientId: string, accountId: string, change: (board: BoardState) => BoardState): Promise<StoreResult> {
    return this.transact(data => {
      if (data.google?.clientId !== clientId || data.google.accountId !== accountId) throw new Error('Google 帳號或連線設定已變更，原有 Orbit 任務保留。');
      const workspace = data.state.workspaces.find(item => item.id === context.workspaceId);
      if (workspace && unresolvedTaskConflicts(workspace.taskConflicts).some(conflict => conflict.id === context.original?.id)) throw new Error('這個任務有同步衝突，請先在右側欄選擇版本後再移轉。');
      if (!workspace) throw new Error('原工作空間已不存在，Google 活動與本機資料未再修改。');
      const board = reconcileDocumentTasks(change(workspace));
      return {...data, state: {...data.state, workspaces: data.state.workspaces.map(item => item.id === workspace.id ? {...workspace, ...board, tasks: recordTaskEdits(workspace.tasks, board.tasks, new Date(), this.device())} : item)}};
    }, {generation: context.generation, requirePersistence: true});
  }

  moveTask(id: string, status: TaskStatus, beforeId?: string): Promise<StoreResult> {
    return this.mutateBoard(board => {
      const task = board.tasks.find(item => item.id === id);
      if (!task || task.deletedAt) throw new Error('這個任務已被其他分頁刪除，無法移動。');
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

  reorderCategory(id: string, direction: -1 | 1): Promise<StoreResult> {
    return this.mutateBoard(board => {
      const categories = [...board.categories];
      const index = categories.findIndex(category => category.id === id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= categories.length) return board;
      [categories[index], categories[target]] = [categories[target], categories[index]];
      return {...board, categories};
    });
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
    const archived = project.archived ?? original?.archived;
    const saved = {id: project.id, name: project.name.trim(), ...(archived === undefined ? {} : {archived})};
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

  setProjectArchived(project: Project, archived: boolean): Promise<StoreResult> {
    return this.saveProject({...project, archived}, project);
  }

  switchWorkspace(id: string): void {
    if (!this.workspaces().some(workspace => workspace.id === id)) return;
    this.workspaceState.update(state => ({...state, activeWorkspaceId: id}));
    this.rememberSelection(id);
  }

  setWorkspaceHeaderCompact(headerCompact: boolean, workspaceId = this.currentWorkspace().id, generation = this.generation(), onlyIfUnset = false): Promise<StoreResult> {
    return this.transact(data => {
      if (!data.state.workspaces.some(workspace => workspace.id === workspaceId)) throw new Error('原工作空間已不存在，請重新查看後再調整。');
      return {...data, state: {...data.state, workspaces: data.state.workspaces.map(workspace => workspace.id === workspaceId && (!onlyIfUnset || workspace.headerCompact === undefined) ? {...workspace, headerCompact} : workspace)}};
    }, {generation});
  }

  finishIntroduction(): Promise<StoreResult> {
    return this.transact(data => {
      if (!isInitialWorkspace(data.state) || data.onboarding !== 'guide') throw new Error('首次使用流程已在其他分頁更新，請重新查看目前的工作空間。');
      return {...data, onboarding: 'workspace'};
    });
  }

  saveWorkspace(id: string, name: string, options: WorkspaceCreationOptions = {}): Promise<StoreResult> {
    return this.writeWorkspace(id, name, options, false);
  }

  createFirstWorkspace(name: string, options: WorkspaceCreationOptions = {}): Promise<StoreResult> {
    return this.writeWorkspace('', name, {...options, includeExamples: options.includeExamples === true}, true);
  }

  private async writeWorkspace(id: string, name: string, options: WorkspaceCreationOptions, first: boolean): Promise<StoreResult> {
    const label = name.trim();
    const generation = this.generation();
    let newWorkspace = id ? null : emptyWorkspace(crypto.randomUUID(), label);
    if (newWorkspace && options.templateId && options.templateId !== 'blank') {
      try {
        const { workspaceFromTemplate } = await import('./workspace-templates');
        newWorkspace = workspaceFromTemplate(newWorkspace.id, label, options);
      } catch { return {ok: false, message: '無法建立樣板，請重新選擇或重新整理後再試。'}; }
    }
    return this.transact(data => {
      if (data.generation !== generation) throw new Error('原資料已被其他分頁取代，請重新開啟工作空間設定。');
      if (!label) throw new Error('請輸入工作空間名稱。');
      if (first) {
        if (data.onboarding !== 'workspace' || !isInitialWorkspace(data.state)) throw new Error('空白工作空間已在其他分頁使用或取代，請重新查看，現有資料不會被覆蓋。');
        if (!options.templateId || options.templateId === 'blank') newWorkspace!.projects = [];
        const workspace = newWorkspace!, previousId = data.state.workspaces[0].id;
        const remap = (ids: string[]) => ids.map(id => id === previousId ? workspace.id : id);
        return {...data, onboarding: undefined, google: {...data.google!, sources: data.google!.sources.map(source => ({...source, workspaceIds: remap(source.workspaceIds)}))},
          ...(data.drive ? {drive: {...data.drive, workspaceIds: remap(data.drive.workspaceIds)}} : {}),
          state: {version: 1, activeWorkspaceId: workspace.id, workspaces: [workspace]}};
      }
      if (id && !data.state.workspaces.some(workspace => workspace.id === id)) throw new Error('這個工作空間已被刪除。');
      return {...data, state: {...data.state, workspaces: newWorkspace ? [...data.state.workspaces, newWorkspace] : data.state.workspaces.map(workspace => workspace.id === id ? {...workspace, name: label} : workspace)}};
    }, {select: newWorkspace?.id, requirePersistence: first, persistenceMessage: first ? '無法保存第一個工作空間，請檢查瀏覽器儲存空間後再試。' : undefined});
  }

  deleteWorkspace(id: string): Promise<StoreResult> {
    return this.transact(data => {
      if (data.state.workspaces.length <= 1) throw new Error('至少保留一個工作空間。');
      const workspaces = data.state.workspaces.filter(workspace => workspace.id !== id);
      return {...data, google: {...data.google!, sources: data.google!.sources.map(source => ({...source, workspaceIds: source.workspaceIds.filter(item => item !== id)}))}, state: {...data.state, workspaces, activeWorkspaceId: workspaces.some(workspace => workspace.id === data.state.activeWorkspaceId) ? data.state.activeWorkspaceId : workspaces[0].id}};
    });
  }

  async snapshotForExport(): Promise<WorkspaceState> {
    if (this.records) {
      await this.ready;
      if (this.hasUnsavedChanges() || this.storageFailure) return structuredClone(this.workspaceState());
      const latest = await this.records.read(); if (!latest) throw new Error('本機資料索引遺失，請先匯出目前內容。');
      this.apply(latest); return structuredClone(this.workspaceState());
    }
    return withStorageLock(() => {
      if (this.hasUnsavedChanges()) return structuredClone(this.workspaceState());
      try { this.apply(this.readLatest()); }
      catch { this.storageWarning.set('最新儲存資料無法讀取，這份備份會保存本分頁目前可讀的內容。'); }
      return structuredClone(this.workspaceState());
    });
  }

  async backupForExport(kind: BackupKind, selectedIds: string[] = [], includeGoogle = false): Promise<OrbitBackup> {
    await this.ready;
    if (this.records && (this.hasUnsavedChanges() || this.storageFailure)) return createBackup(this.workspaceState(), kind, selectedIds, this.appearance(), this.google(), includeGoogle, this.reminders(), this.drive());
    return this.readCurrent(data => {
      if (!this.hasUnsavedChanges()) this.apply(data);
      return createBackup(this.workspaceState(), kind, selectedIds, this.appearance(), this.google(), includeGoogle, this.reminders(), this.drive());
    });
  }

  driveSnapshot(kind: BackupKind, selectedIds: string[]): Promise<{backup: OrbitBackup; revision: string}> {
    return this.readCurrent(data => {
      if (this.hasUnsavedChanges()) throw new Error('本機有未保存的資料，請先下載備份，Drive 自動同步已暫停。');
      this.apply(data);
      return {backup: createBackup(this.workspaceState(), kind, selectedIds, this.appearance(), this.google(), false, this.reminders(), this.drive()), revision: this.revision()};
    });
  }

  updateAppearance(patch: Partial<AppearancePreferences>): Promise<StoreResult> {
    return this.transact(data => {
      const preferences = readAppearance({...data.preferences, ...patch});
      if (!preferences) throw new Error('外觀設定不合法，請輸入完整的六位 HEX 色碼。');
      return {...data, preferences};
    });
  }

  updateReminders(patch: Partial<ReminderPreferences>): Promise<StoreResult> {
    return this.transact(data => {
      const reminders = readReminders({...DEFAULT_REMINDERS, ...data.reminders, ...patch});
      if (!reminders) throw new Error('提醒設定不合法：天數須為 1 到 30 的整數，提前時間須為 15、30 或 60 分鐘，全天時間須有效。');
      return {...data, reminders};
    });
  }

  updateGoogle(patch: Partial<Omit<GoogleSettings, 'sources'>>): Promise<StoreResult> {
    return this.transact(data => {
      const settings = {...data.google!, ...patch};
      if (patch.clientId !== undefined && patch.clientId !== data.google!.clientId) {
        settings.accountId = ''; settings.email = ''; settings.sources = [];
      }
      return {...data, google: settings, ...(patch.clientId !== undefined && patch.clientId !== data.google!.clientId ? {drive: structuredClone(DEFAULT_DRIVE)} : {})};
    });
  }

  updateDrive(patch: Partial<DriveSettings>): Promise<StoreResult> {
    return this.transact(data => {
      const drive = readDriveSettings({...DEFAULT_DRIVE, ...data.drive, ...structuredClone(patch)}, data.state.workspaces.map(w => w.id));
      if (!drive) throw new Error('Drive 設定不合法，請確認帳號與工作空間範圍。');
      return {...data, drive};
    }, {requirePersistence: true});
  }
  stopDrive(expectedGeneration: string, expectedSettings: string): Promise<StoreResult> {
    return this.transact(data => {
      const drive = data.drive ?? structuredClone(DEFAULT_DRIVE);
      if (data.generation !== expectedGeneration || JSON.stringify(drive) !== expectedSettings) throw new Error('Drive 設定已變更，請重新確認刪除範圍。');
      return {...data, drive: {...drive, mode: 'off'}};
    }, {requirePersistence: true});
  }

  /** Full synchronization includes accent colors; theme, font size, authentication and Drive controls stay local. */
  applyDriveBackup(input: OrbitBackup, expectedRevision: string, targetIds: string[]): Promise<StoreResult> {
    const backup = readBackup(input);
    return this.transact(data => {
      if (this.hasUnsavedChanges() || data.revision !== expectedRevision) throw new Error('本機資料已變更，雲端資料未套用。請重新檢查同步版本。');
      const incoming = structuredClone(backup.data.workspaces);
      const incomingIds = new Set(incoming.map(w => w.id));
      const workspaces = backup.kind === 'full' ? incoming : [...data.state.workspaces.filter(w => !targetIds.includes(w.id) && !incomingIds.has(w.id)), ...incoming];
      const affected = backup.kind === 'full' ? data.state.workspaces.map(w => w.id) : targetIds;
      const oldSources = data.google!.sources.map(s => ({...s, workspaceIds: s.workspaceIds.filter(id => !affected.includes(id) && !incomingIds.has(id))}));
      for (const source of backup.kind === 'full' ? backup.google?.sources ?? [] : backup.calendarSources ?? []) {
        const old = oldSources.find(s => s.accountId === source.accountId && s.calendarId === source.calendarId);
        if (old) {old.workspaceIds = [...new Set([...old.workspaceIds, ...source.workspaceIds])]; old.name = source.name; old.color = source.color; old.visible = source.visible;}
        else oldSources.push({...structuredClone(source), id: crypto.randomUUID()});
      }
      return {...data, onboarding: undefined, state: {...data.state, workspaces, activeWorkspaceId: incomingIds.has(data.state.activeWorkspaceId) ? data.state.activeWorkspaceId : workspaces[0].id},
        ...(backup.kind === 'full' && backup.preferences ? {preferences: {...data.preferences!, ...sharedAppearance(backup.preferences)}} : {}),
        ...(backup.kind === 'full' && backup.reminders ? {reminders: {...backup.reminders}} : {}),
        google: {...data.google!, ...(backup.kind === 'full' && backup.google ? {refreshMinutes: backup.google.refreshMinutes} : {}), sources: oldSources.filter(s => s.workspaceIds.length)}};
    }, {requirePersistence: true});
  }

  saveCalendarSource(source: CalendarSource): Promise<StoreResult> {
    const saved = structuredClone(source);
    return this.transact(data => ({...data, google: {...data.google!, sources: data.google!.sources.some(item => item.id === saved.id)
      ? data.google!.sources.map(item => item.id === saved.id ? saved : item) : [...data.google!.sources, saved]}}));
  }

  bindCalendar(source: CalendarSource, workspaceId: string, enabled: boolean): Promise<StoreResult> {
    const saved = structuredClone(source);
    return this.transact(data => {
      if (saved.accountId !== data.google!.accountId || !data.state.workspaces.some(workspace => workspace.id === workspaceId)) throw new Error('Google 帳號或工作空間已變更，請重新選擇。');
      const existing = data.google!.sources.find(item => item.accountId === saved.accountId && item.calendarId === saved.calendarId);
      const sources = data.google!.sources.map(item => {
        if (item.accountId !== saved.accountId || item.calendarId !== saved.calendarId) return item;
        return {...item, workspaceIds: enabled ? item.id === existing!.id ? [...new Set([...item.workspaceIds, workspaceId])] : item.workspaceIds : item.workspaceIds.filter(id => id !== workspaceId)};
      });
      if (enabled && !existing) sources.push({...saved, workspaceIds: [workspaceId]});
      return {...data, google: {...data.google!, sources}};
    });
  }

  updateCalendarSource(id: string, patch: Partial<Pick<CalendarSource, 'color' | 'visible' | 'workspaceIds' | 'name'>>): Promise<StoreResult> {
    const saved = structuredClone(patch);
    return this.transact(data => {
      if (!data.google!.sources.some(source => source.id === id)) throw new Error('這個月曆來源已被解除綁定，請重新查看。');
      return {...data, google: {...data.google!, sources: data.google!.sources.map(source => source.id === id ? {...source, ...saved} : source)}};
    });
  }

  removeCalendarSource(id: string): Promise<StoreResult> {
    return this.transact(data => ({...data, google: {...data.google!, sources: data.google!.sources.filter(source => source.id !== id)}}));
  }

  resetData(all: boolean, expectedRevision: string): Promise<StoreResult> {
    const workspace = emptyWorkspace(crypto.randomUUID(), '我的工作空間');
    return this.transact(data => {
      if (data.revision !== expectedRevision) throw new Error('確認期間資料或設定已更新，請重新查看後再重置。');
      return {...data, cloudResume: undefined, generation: crypto.randomUUID(), preferences: all ? {...DEFAULT_APPEARANCE} : data.preferences,
        reminders: all ? {...DEFAULT_REMINDERS} : data.reminders,
        drive: {...(all ? DEFAULT_DRIVE : data.drive ?? DEFAULT_DRIVE), mode: 'off', workspaceIds: []},
        google: all ? structuredClone(DEFAULT_GOOGLE) : {...data.google!, sources: []},
        state: {version: 1, activeWorkspaceId: workspace.id, workspaces: [workspace]}};
    }, {requirePersistence: true, select: workspace.id, afterPersist: () => {
      for (const key of ['orbit-workspaces-v1', 'orbit-board-v1', 'orbit-board-v1-backup', 'orbit-text-size-v1', 'orbit-reminder-delivery-v1']) localStorage.removeItem(key);
      this.selectionStorage?.removeItem(WORKSPACE_SELECTION_KEY);
    }});
  }

  logoutToCloud(clientId: string, datasetId: string, expectedRevision: string, generation: string): Promise<StoreResult> {
    const workspace = {...emptyWorkspace(crypto.randomUUID(), '空白工作空間'), projects: []};
    return this.transact(data => {
      if (data.revision !== expectedRevision || data.google?.clientId !== clientId || this.hasUnsavedChanges()) throw new Error('備份後本機資料或設定又有變更，尚未登出，請再試一次。');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(datasetId)) throw new Error('雲端集合識別不合法，尚未登出。');
      return {formatVersion: 2, generation: crypto.randomUUID(), revision: data.revision, updatedAt: data.updatedAt,
        cloudResume: {datasetId, cleanupPending: true}, google: {...structuredClone(DEFAULT_GOOGLE), clientId}, preferences: {...DEFAULT_APPEARANCE},
        reminders: {...DEFAULT_REMINDERS}, drive: structuredClone(DEFAULT_DRIVE),
        state: {version: 1, activeWorkspaceId: workspace.id, workspaces: [workspace]}};
    }, {generation, requirePersistence: true, select: workspace.id, persistenceMessage: '瀏覽器無法保存登出資訊，尚未清除本機資料。'});
  }

  finishLogoutCleanup(datasetId: string, generation: string): Promise<StoreResult> {
    return this.transact(data => {
      if (data.cloudResume?.datasetId !== datasetId) throw new Error('登出資訊已變更，本次清理已停止。');
      return {...data, cloudResume: {datasetId}};
    }, {generation, requirePersistence: true});
  }

  finishCloudLogin(datasetId: string, generation: string): Promise<StoreResult> {
    return this.transact(data => {
      if (data.cloudResume?.datasetId !== datasetId) throw new Error('登入目的地已變更，請重新登入。');
      return {...data, cloudResume: undefined};
    }, {generation, requirePersistence: true});
  }

  importBackup(input: OrbitBackup, expectedRevision?: string, applyGoogle = false): Promise<StoreResult> {
    let backup: OrbitBackup;
    try { backup = readBackup(input); }
    catch (error) { return Promise.resolve({ok: false, message: this.message(error)}); }
    const added = backup.kind === 'workspaces' ? copyWorkspaces(backup.data.workspaces) : [];
    return this.transact(data => {
      if (backup.kind === 'full') {
        if (!expectedRevision || data.revision !== expectedRevision) throw new Error('確認期間資料已更新，請重新檢查覆蓋範圍後再匯入。');
        return {...data, generation: crypto.randomUUID(), state: structuredClone(backup.data), preferences: {...data.preferences!, ...sharedAppearance(backup.preferences ?? DEFAULT_APPEARANCE)}, reminders: backup.reminders ?? {...DEFAULT_REMINDERS}, drive: {...structuredClone(backup.drive ?? DEFAULT_DRIVE), mode: 'off'}, google: {...structuredClone(backup.google ?? DEFAULT_GOOGLE), refreshMinutes: 0}};
      }
      const workspaceIds = new Map(backup.data.workspaces.map((workspace, index) => [workspace.id, added[index].id]));
      const sources = (backup.calendarSources ?? []).map(source => ({...structuredClone(source), id: crypto.randomUUID(), workspaceIds: source.workspaceIds.map(id => workspaceIds.get(id)!)}));
      const settings = applyGoogle && backup.google ? {...structuredClone(backup.google), refreshMinutes: 0 as const} : data.google!;
      return {...data, google: {...settings, sources: [...data.google!.sources, ...sources]}, state: {...data.state, workspaces: [...data.state.workspaces, ...added]}};
    }, {requirePersistence: true, select: backup.kind === 'full' ? backup.data.activeWorkspaceId : added[0].id});
  }

  refreshFromStorage(): void {
    if (this.records) {
      const revision = this.lastSavedRevision;
      void this.readCurrent(data => {if (this.lastSavedRevision === revision) this.acceptRefresh(data);}).catch(error => this.storageWarning.set(this.message(error)));
      return;
    }
    try {
      this.acceptRefresh(this.readLatest());
    } catch (error) { this.storageWarning.set(this.message(error)); }
  }

  private acceptRefresh(latest: StoredWorkspaceData): void {
      if (latest.revision === this.lastSavedRevision) return;
      if (this.hasUnsavedChanges()) {
        this.storageWarning.set('其他分頁有新資料，但本分頁仍有未儲存變更。請先匯出此分頁的備份，避免遺失內容。');
        return;
      }
      const replaced = latest.generation !== this.generation();
      this.apply(latest);
      this.syncNotice.set(replaced ? '其他分頁已還原或重置資料，畫面已更新；未送出的表單草稿仍保留。' : '已同步其他分頁的資料與設定。');
  }

  private mutateBoard(change: (board: BoardState) => BoardState, workspaceId = this.currentWorkspace().id, generation = this.generation(), resolvingConflict = false, options: {verify?: () => void; requirePersistence?: boolean} = {}): Promise<StoreResult> {
    let before: BoardState;
    return this.transact(data => {
      options.verify?.();
      const workspace = data.state.workspaces.find(item => item.id === workspaceId);
      if (!workspace) throw new Error('原工作空間已被刪除或取代，草稿仍保留。');
      before = readBoardState(workspace)!;
      const changed = change(workspace);
      if (!resolvingConflict && unresolvedTaskConflicts(workspace.taskConflicts).some(conflict => JSON.stringify(workspace.tasks.find(task => task.id === conflict.id)) !== JSON.stringify(changed.tasks.find(task => task.id === conflict.id)))) throw new Error('這個任務有同步衝突，請先在右側欄選擇版本後再編輯。');
      const now = new Date(), tasks = recordTaskEdits(workspace.tasks, changed.tasks, now, this.device()), previousInformation = indexTaskInformation(workspace), nextInformation = indexTaskInformation(changed);
      const board = reconcileDocumentTasks({...changed, tasks: tasks.map(task => JSON.stringify(previousInformation.get(task.id) ?? []) === JSON.stringify(nextInformation.get(task.id) ?? []) ? task : {...task, updatedAt: now.toISOString(), editSource: {...this.device()}})});
      return {...data, state: {...data.state, workspaces: data.state.workspaces.map(item => item.id === workspaceId ? {...workspace, ...board} : item)}};
    }, {generation, requirePersistence: options.requirePersistence, afterApply: () => {
      const after = readBoardState(this.workspaces().find(workspace => workspace.id === workspaceId))!;
      if (!sameBoard(before, after)) this.history.update(entries => [...entries.filter(entry => entry.workspaceId !== workspaceId || !entry.undone), {workspaceId, generation, before, after, label: boardChangeLabel(before, after)}].slice(-HISTORY_LIMIT));
    }});
  }

  private async transact(change: (data: StoredWorkspaceData) => StoredWorkspaceData, options: {generation?: string; requirePersistence?: boolean; persistenceMessage?: string; select?: string; afterPersist?: () => void; afterApply?: () => void} = {}): Promise<StoreResult> {
    const expectedGeneration = options.generation ?? this.generation();
    this.pendingWrites.update(count => count + 1);
    try {
      await this.ready;
      if (this.storageFailure) throw new Error(this.storageFailure);
      let prepared: StoredWorkspaceData | undefined;
      const prepare = (disk: StoredWorkspaceData): StoredWorkspaceData => {
        if (this.hasUnsavedChanges() && disk.revision !== this.lastSavedRevision) throw new Error('其他分頁已更新資料，請先匯出本分頁未儲存的內容，再重新整理。');
        const latest = this.hasUnsavedChanges() ? {...this.snapshot, state: this.workspaceState()} : disk;
        if (latest.generation !== expectedGeneration) {
          this.apply(latest);
          throw new Error('資料已被其他分頁取代，請重新查看後再操作。');
        }
        const changed = change(structuredClone(latest));
        const state = readWorkspaceState(changed.state);
        if (!state) throw new Error('分類、狀態或日期資料不合法，未儲存這次變更。');
        const google = readGoogleSettings(changed.google, state.workspaces.map(workspace => workspace.id));
        if (!google) throw new Error('Google 連線或月曆來源設定不合法，未儲存這次變更。');
        const settings = changed.drive ?? structuredClone(DEFAULT_DRIVE);
        const workspaceIds = settings.workspaceIds.filter(id => state.workspaces.some(w => w.id === id));
        const drive = readDriveSettings({...settings, workspaceIds, ...(settings.kind === 'workspaces' && workspaceIds.length !== settings.workspaceIds.length ? {mode: 'off'} : {})}, state.workspaces.map(w => w.id));
        if (!drive) throw new Error('Drive 設定不合法，未儲存這次變更。');
        const onboarding = changed.generation === latest.generation && isInitialWorkspace(state) ? changed.onboarding : undefined;
        const next: StoredWorkspaceData = {...changed, onboarding, state, google, drive, revision: crypto.randomUUID(), updatedAt: new Date().toISOString()};
        prepared = next; return next;
      };
      const unsaved = (next: StoredWorkspaceData): StoreResult => {
          if (options.requirePersistence) throw new Error(options.persistenceMessage ?? '瀏覽器儲存空間不足或無法保存，還原或重置未套用；原有資料保留。');
          this.apply(next, options.select, false);
          options.afterApply?.();
          this.hasUnsavedChanges.set(true);
          this.storageWarning.set('瀏覽器目前無法儲存資料。變更只保留在此分頁，請保持開啟並匯出備份。');
          return {ok: true, persisted: false};
      };
      const finish = (next: StoredWorkspaceData): StoreResult => {
        let cleanupWarning = '';
        try { options.afterPersist?.(); }
        catch { cleanupWarning = '資料已重置，但瀏覽器阻擋部分舊資料的清理。空白工作空間已保存，舊資料不會自動載入。'; }
        this.apply(next, options.select);
        options.afterApply?.();
        this.hasUnsavedChanges.set(false);
        this.storageWarning.set(cleanupWarning);
        this.syncNotice.set('');
        try { this.channel?.postMessage({revision: next.revision}); } catch { /* Native storage events also notify other tabs. */ }
        return {ok: true, persisted: true};
      };
      if (this.records) {
        let next: StoredWorkspaceData;
        try {next = await this.records.update(disk => {if (!disk) throw new Error('本機資料索引遺失，未覆蓋原有內容。'); return prepare(disk);});}
        catch (error) {if (prepared) return unsaved(prepared); throw error;}
        const result = finish(next); this.notifyRecordWrite(next); return result;
      }
      return await withStorageLock(() => {
        const next = prepare(this.readLatest());
        try {localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(next));} catch {return unsaved(next);}
        return finish(next);
      });
    } catch (error) {
      const message = this.message(error);
      this.storageWarning.set(message);
      return {ok: false, message};
    } finally { this.pendingWrites.update(count => count - 1); }
  }

  private apply(data: StoredWorkspaceData, select?: string, saved = true): void {
    if (data.generation !== this.generation()) this.history.set([]);
    this.snapshot = data;
    this.generation.set(data.generation);
    this.revision.set(data.revision);
    this.onboarding.set(isInitialWorkspace(data.state) ? data.onboarding ?? null : null);
    this.appearance.set(data.preferences ?? this.legacyAppearance());
    this.google.set(data.google ?? structuredClone(DEFAULT_GOOGLE));
    this.reminders.set(data.reminders ?? {...DEFAULT_REMINDERS});
    this.drive.set(data.drive ?? structuredClone(DEFAULT_DRIVE));
    this.cloudResume.set(data.cloudResume);
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
      if (JSON.parse(saved)?.storage === 'indexeddb') {
        if (!this.records) throw new Error('此瀏覽器無法讀取已升級的本機資料，請使用支援 IndexedDB 的瀏覽器。');
        return this.initialData(createWorkspaceState(createInitialState()));
      }
      const data = readStoredData(JSON.parse(saved));
      if (!data) throw new Error('儲存資料格式不完整，請先匯出目前可讀的資料，避免覆蓋原檔。');
      return {...data, preferences: data.preferences ?? this.legacyAppearance(), google: data.google ?? structuredClone(DEFAULT_GOOGLE)};
    }
    return this.legacyData();
  }

  private async initializeRecords(): Promise<void> {
    const raw = localStorage.getItem(WORKSPACE_STORAGE_KEY), migrated = raw && JSON.parse(raw)?.storage === 'indexeddb';
    if (this.storageWarning() && !migrated) throw new Error('舊本機資料無法完整驗證，尚未升級，請先匯出可讀內容。');
    const migrate = async () => {
      const data = await this.records!.update(current => {
        if (current) return current;
        if (migrated) throw new Error('本機資料索引存在，但保存紀錄遺失；請從 JSON 或雲端備份還原。');
        return this.readLatest();
      });
      this.apply(data, this.selectedState(data.state).activeWorkspaceId); this.storageWarning.set(''); this.notifyRecordWrite(data);
    };
    // Hold the legacy Web Lock through commit and marker publication during upgrade.
    if (navigator.locks) await navigator.locks.request('iih-orbit-data-write', migrate); else await migrate();
  }
  private notifyRecordWrite(data: StoredWorkspaceData): void {
    try {localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify({formatVersion: 3, storage: 'indexeddb', generation: data.generation, revision: data.revision}));}
    catch {this.storageWarning.set('資料已保存在本機，但其他分頁的更新提示暫時無法保存；請重新整理舊分頁。');}
  }
  private async readCurrent<T>(read: (data: StoredWorkspaceData) => T): Promise<T> {
    await this.ready;
    if (this.storageFailure) throw new Error(this.storageFailure);
    if (!this.records) return withStorageLock(() => read(this.readLatest()));
    const data = await this.records.read(); if (!data) throw new Error('本機資料索引遺失，原有資料保留。');
    return read(data);
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
    const state = createWorkspaceState(board);
    if (!legacy) state.workspaces[0].name = '空白工作空間';
    return this.initialData(state, legacy ? undefined : 'guide');
  }

  private initialData(state: WorkspaceState, onboarding?: OnboardingPhase): StoredWorkspaceData {
    return {formatVersion: 2, generation: 'local-v1', revision: 'legacy', updatedAt: new Date(0).toISOString(), state, preferences: this.legacyAppearance(), google: structuredClone(DEFAULT_GOOGLE), ...(onboarding ? {onboarding} : {})};
  }

  private legacyAppearance(): AppearancePreferences {
    try { return readAppearance({textSize: localStorage.getItem('orbit-text-size-v1') ?? 'standard'}) ?? {...DEFAULT_APPEARANCE}; }
    catch { return {...DEFAULT_APPEARANCE}; }
  }

  private message(error: unknown): string { return error instanceof Error ? error.message : '無法完成資料操作，請保持此頁面開啟並下載備份。'; }
}
