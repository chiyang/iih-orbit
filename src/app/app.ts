import { taskInformationKey } from './document-data';
import { A11yModule } from '@angular/cdk/a11y';
import { CdkScrollable } from '@angular/cdk/scrolling';
import { afterNextRender, afterRenderEffect, Component, computed, DestroyRef, effect, ElementRef, HostListener, inject, Injector, signal, untracked, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { BoardStore, StoreResult, TaskEditContext, TrashContext } from './board-store';
import { Calendar } from './calendar';
import type { CalendarCreate } from './calendar';
import { Icon } from './icon';
import { BrandMark } from './brand-mark';
import { ThemeColor } from './theme-color';
import { Settings } from './settings';
import type { SettingsTab } from './settings';
import { colorHex, validHex } from './appearance-data';
import { BoardStatus, Category, CategoryColor, CATEGORY_COLORS, PRIORITIES, Priority, Project, StatusKind, Task, TaskScope, TaskStatus, Workspace } from './models';
import { dateKey, isTaskOverdue, parseDate, scheduleError, SortDirection, SortKey, sortTasks, validDate } from './task-schedule';
import { minuteLabel, timeMinutes } from './week-layout';
import { UiPreferences } from './ui-preferences';
import { boardStatusesForScope } from './workspace-data';
import { projectProgress, projectSummaries, tasksForProject } from './project-data';
import { CalendarSources } from './calendar-sources';
import { DriveStatus } from './drive-status';
import { ExternalEventDetails } from './external-event-details';
import { ExternalEvent } from './google-data';
import { currentWeekRange, DeadlineFilter, deadlineState, DUE_DAY_PRESETS, taskInWeek } from './reminder-data';
import { ReminderCenter } from './reminder-center';
import { ReminderPopups } from './reminder-popups';
import type { ReminderItem, ReminderTab } from './reminder-items';
import { TaskCell } from './task-cell';
import type { TaskCellField } from './task-cell';
import { WorkspaceTemplatePicker } from './workspace-template-picker';
import type { WorkspaceTemplateId } from './workspace-templates';
import { CalendarPublish } from './calendar-publish';
import { GmailPanel } from './gmail-panel';
import { MailTasks } from './mail-tasks';
import { GMAIL_MIME, type MailPreview } from './gmail-data';
import type { CalendarPosition } from './calendar-move';
import { MailPreview as MailPreviewDialog } from './mail-preview';
import { MarkdownEditor } from './markdown-editor';
import { ScheduleTime } from './schedule-time';
import { DatePickerTrigger, adjacentHour } from './schedule-controls';
import { RichContent } from './rich-content';
import { loadBrowseState, readBrowseState, saveBrowseState, type BrowseState } from './browse-state';
import { StartupGuide } from './startup-guide';
import { TaskPanel } from './task-panel';
import { recentlyEdited } from './task-activity-data';
import { TrashView } from './trash-view';
import { TaskConflictEditor, TaskConflictContext } from './task-conflict-editor';
import { GoogleRenewalButton } from './google-renewal-button';
import { DriveSyncButton } from './drive-sync-button';
import { CloudLogoutButton } from './cloud-logout-button';
import { CloudResumeNotice } from './cloud-resume-notice';
import { CloudLogoutConfirm } from './cloud-logout-confirm';
import { Tooltip } from './tooltip';
import { PanelButton, type PanelActivation } from './panel-button';
import { DocumentLinksEditor } from './document-links-editor';
import type { DocumentDescription, DocumentSource } from './models';
import { DocumentPanel } from './document-panel';
import { DocumentTasks } from './document-tasks';
import { documentCardPosition, type DocumentDropPosition } from './drive-browser-data';
import { DOCUMENT_DRAG_TYPE } from './document-data';
import {DescriptionKeyboard} from './description-keyboard';
import {TaskEditDrafts, type LocalTaskDraft, type TaskDraftSnapshot} from './task-edit-drafts';
import {WorkspaceOverview} from './workspace-overview';
import {Gantt} from './gantt';
import type {OverviewSelection} from './workspace-overview-data';
import {RelatedTasksEditor} from './related-tasks-editor';
import {relatedTasksKey} from './task-links-data';
import {BOARD_TASK_DRAG_TYPE, readTaskLinkDrag, TASK_LINK_DRAG_TYPE, type BoardTaskDropPosition} from './task-link-drag';
import {createSourceDragPreview} from './source-drag-preview';
import {SourceTouchDrag} from './source-touch-drag';
import type {DialogRef} from '@angular/cdk/dialog';
import {NotificationBridge} from './notification-bridge';
import type {TaskLinkPicker, TaskLinkPickerData} from './task-link-picker';

type Modal = 'intro' | 'task' | 'task-conflict' | 'overview-list' | 'calendar-publish' | 'categories' | 'projects' | 'delete' | 'purge-task' | 'empty-trash' | 'statuses' | 'workspaces' | 'settings' | 'external-event' | 'mail-preview' | 'logout' | null;
type BoardColumn = BoardStatus & {tasks: Task[]};

@Component({
  selector: 'app-root',
  imports: [FormsModule, A11yModule, SourceTouchDrag, CdkScrollable, Icon, BrandMark, Calendar, ThemeColor, Settings, CalendarSources, DriveStatus, ExternalEventDetails, ReminderCenter, ReminderPopups, TaskCell, WorkspaceTemplatePicker, CalendarPublish, GmailPanel, MailPreviewDialog, MarkdownEditor, RichContent, ScheduleTime, DatePickerTrigger, StartupGuide, TaskPanel, TrashView, TaskConflictEditor, GoogleRenewalButton, DriveSyncButton, CloudLogoutButton, CloudResumeNotice, CloudLogoutConfirm, Tooltip, PanelButton, DocumentLinksEditor, DocumentPanel, WorkspaceOverview, Gantt, RelatedTasksEditor, NotificationBridge],
  templateUrl: './app.html',
  styleUrls: ['./app.css', './side-panel.css', './topbar.css', './forms.css', './document-dialog.css', './startup.css', './task-shortcuts.css', './workspace-controls.css']
})
export class App {
  readonly store = inject(BoardStore);
  private readonly savedBrowse = loadBrowseState(this.store.generation(), this.store.currentWorkspace().id);
  private browseContext = JSON.stringify([this.store.generation(), this.store.currentWorkspace().id]);
  private browseGeneration = this.store.generation();
  private readonly injector = inject(Injector);
  get mailTasks(): MailTasks { return this.injector.get(MailTasks); }
  get documentTasks(): DocumentTasks { return this.injector.get(DocumentTasks); }
  readonly filesOpen = signal(this.savedBrowse.panel === 'files');
  readonly mailOpen = signal(this.savedBrowse.panel === 'gmail');
  readonly tasksOpen = signal(this.savedBrowse.panel === 'tasks');
  readonly panelTab = signal(this.savedBrowse.panelTab);
  readonly mailVisit = signal(0);
  readonly panelOpen = computed(() => this.mailOpen() || this.remindersOpen() || this.tasksOpen() || this.filesOpen());
  readonly panelOverlay = signal(window.innerWidth <= 700);
  readonly sourcePanelDragging = signal(false);
  readonly taskLinkSource = signal<TaskEditContext | null>(null);
  readonly taskLinkTarget = signal('');
  readonly boardTaskDrag = signal<TaskEditContext | null>(null);
  readonly boardTaskPosition = signal<BoardTaskDropPosition | null>(null);
  readonly boardTaskLinkTarget = signal<TaskEditContext | null>(null);
  readonly calendarTaskDragging = signal(false);
  private boardDragContext = '';
  private boardTaskToken = '';
  private clearBoardTaskPreview?: () => void;
  canDragBoardTask(task: Task): boolean {
    return this.view() === 'board' && !this.modal() && !this.trashOpen() && !this.overviewOpen() && !this.store.pendingWrites() && !task.deletedAt && !this.taskLinkDragging() && !this.ganttLockedTaskIds().includes(task.id);
  }
  startBoardTaskDrag(event: DragEvent, task: Task): void {
    if (!this.canDragBoardTask(task) || !event.dataTransfer) {event.preventDefault(); return;}
    const context = this.store.taskContext(task.id);
    if (JSON.stringify(context.original) !== JSON.stringify(task)) {event.preventDefault(); this.notify('任務已更新，請重新查看後再拖曳。'); return;}
    this.endBoardTaskDrag(); this.cancelTaskLink(); this.boardDragContext = this.ganttContext();
    this.boardTaskDrag.set(context); this.boardTaskToken = crypto.randomUUID();
    event.dataTransfer.setData(BOARD_TASK_DRAG_TYPE, JSON.stringify({token: this.boardTaskToken, taskId: task.id, generation: context.generation, workspaceId: context.workspaceId}));
    event.dataTransfer.effectAllowed = 'all'; event.stopPropagation();
    this.clearBoardTaskPreview = createSourceDragPreview(event, task.title, () => this.endBoardTaskDrag(), 'document-drag-preview task-drag-preview');
  }
  private boardDragValid(): boolean {
    const source = this.boardTaskDrag();
    return !!source?.original && this.canDragBoardTask(source.original) && source.generation === this.store.generation() && source.workspaceId === this.store.currentWorkspace().id && this.boardDragContext === this.ganttContext()
      && JSON.stringify(this.store.tasks().find(task => task.id === source.original!.id)) === JSON.stringify(source.original);
  }
  boardTaskOver(event: DragEvent, column: BoardColumn): boolean {
    if (!this.boardTaskDrag() || !event.dataTransfer?.types.includes(BOARD_TASK_DRAG_TYPE)) return false;
    event.preventDefault(); event.stopPropagation();
    if (!this.boardDragValid()) {this.endBoardTaskDrag(); return false;}
    const area = event.currentTarget as HTMLElement, current = this.boardTaskPosition();
    const placeholder = area.querySelector<HTMLElement>('.task-board-placeholder, .task-board-empty')?.getBoundingClientRect();
    // Keep the insertion target while its visible placeholder is under the pointer.
    if (current?.kind === 'move' && current.status === column.id && placeholder && event.clientY >= placeholder.top && event.clientY <= placeholder.bottom) {event.dataTransfer.dropEffect = 'move'; return true;}
    const cards = [...area.querySelectorAll<HTMLElement>('.task-card[data-task-id]')].map(card => {const bounds = card.getBoundingClientRect(); return {id: card.dataset['taskId']!, top: bounds.top, bottom: bounds.bottom};});
    const position = documentCardPosition(cards, event.clientY, column.id), sourceId = this.boardTaskDrag()!.original!.id;
    if (position.kind === 'link') {
      if (position.taskId === sourceId || this.ganttLockedTaskIds().includes(position.taskId)) {this.boardTaskPosition.set(null); this.boardTaskLinkTarget.set(null); event.dataTransfer.dropEffect = 'none'; return false;}
      if (this.boardTaskLinkTarget()?.original?.id !== position.taskId) this.boardTaskLinkTarget.set(this.store.taskContext(position.taskId));
      if (!this.boardTaskLinkTarget()?.original) {this.boardTaskPosition.set(null); event.dataTransfer.dropEffect = 'none'; return false;}
      this.boardTaskPosition.set({kind: 'link', taskId: position.taskId, status: column.id}); event.dataTransfer.dropEffect = 'link';
    } else {
      const beforeId = position.beforeId === sourceId ? column.tasks[column.tasks.findIndex(task => task.id === sourceId) + 1]?.id : position.beforeId;
      const next: BoardTaskDropPosition = {kind: 'move', status: column.id, ...(beforeId ? {beforeId} : {})};
      if (JSON.stringify(current) !== JSON.stringify(next)) this.boardTaskPosition.set(next);
      this.boardTaskLinkTarget.set(null); event.dataTransfer.dropEffect = 'move';
    }
    return true;
  }
  boardTaskLeave(event: DragEvent): void {
    const area = event.currentTarget as HTMLElement, bounds = area.getBoundingClientRect();
    const outside = event.clientX < bounds.left || event.clientX >= bounds.right || event.clientY < bounds.top || event.clientY >= bounds.bottom;
    if (outside && (!(event.relatedTarget instanceof Node) || !area.contains(event.relatedTarget))) {this.boardTaskPosition.set(null); this.boardTaskLinkTarget.set(null);}
  }
  boardTaskMoves(beforeId: string | undefined, status: string): boolean {const position = this.boardTaskPosition(); return !!this.boardTaskDrag() && position?.kind === 'move' && position.status === status && position.beforeId === beforeId;}
  boardTaskLinks(taskId: string): boolean {return !!this.boardTaskDrag() && this.boardTaskPosition()?.kind === 'link' && this.boardTaskLinkTarget()?.original?.id === taskId;}
  async dropBoardTask(event: DragEvent, column: BoardColumn): Promise<void> {
    if (!this.boardTaskOver(event, column)) return;
    const payload = readTaskLinkDrag(event.dataTransfer!.getData(BOARD_TASK_DRAG_TYPE)), context = this.boardTaskDrag()!, position = this.boardTaskPosition(), target = this.boardTaskLinkTarget();
    const valid = payload && payload.token === this.boardTaskToken && payload.taskId === context.original!.id && payload.workspaceId === context.workspaceId && payload.generation === context.generation;
    this.endBoardTaskDrag();
    if (!valid || !position) return;
    if (position.kind === 'link' && target?.original) {
      if (this.store.relatedTaskIds(context.original!.id).includes(target.original.id)) {this.notify('這兩個任務已經連結。'); return;}
      if (this.handleResult(await this.store.linkTasks(context, target))) this.notify('任務連結已建立，可復原。');
    } else if (position.kind === 'move') {
      const sourceIndex = column.tasks.findIndex(task => task.id === context.original!.id);
      if (context.original!.status === column.id && column.tasks[sourceIndex + 1]?.id === position.beforeId) return;
      if (this.handleResult(await this.store.moveTask(context.original!.id, column.id, position.beforeId, context))) this.notifySaved(context.original!.status === column.id ? '任務順序已調整' : `「${context.original!.title}」已移至${column.label}`);
    }
  }
  @HostListener('window:pagehide')
  @HostListener('window:blur')
  endBoardTaskDrag(): void {
    const active = !!this.boardTaskDrag(), clear = this.clearBoardTaskPreview; this.clearBoardTaskPreview = undefined;
    this.boardTaskDrag.set(null); this.boardTaskPosition.set(null); this.boardTaskLinkTarget.set(null); this.boardTaskToken = ''; clear?.();
    if (active) this.dragEnded();
  }
  private readonly taskLinkToken = signal('');
  readonly taskLinkDragging = computed(() => !!this.taskLinkToken());
  private taskLinkView = '';
  beginTaskLink(task: Task): void {
    if (this.modal() || this.store.pendingWrites() || Date.now() - this.dragEndedAt < 200) return;
    if (task.deletedAt || this.store.taskConflicts().some(entry => entry.workspace.id === this.store.currentWorkspace().id && entry.conflict.id === task.id)) {this.notify('請先處理任務衝突或還原任務，再建立連結。'); return;}
    this.taskLinkView = this.view(); this.taskLinkSource.set({...this.store.taskContext(task.id), original: structuredClone(task)}); this.taskLinkTarget.set('');
  }
  startTaskLinkDrag(event: DragEvent, task: Task): void {
    this.beginTaskLink(task);
    const source = this.taskLinkSource();
    if (!source?.original || source.original.id !== task.id || !event.dataTransfer) {event.preventDefault(); return;}
    const token = crypto.randomUUID(); this.taskLinkToken.set(token);
    event.dataTransfer.setData(TASK_LINK_DRAG_TYPE, JSON.stringify({token, generation: source.generation, workspaceId: source.workspaceId, taskId: task.id}));
    event.dataTransfer.effectAllowed = 'link'; event.stopPropagation();
  }
  taskLinkOver(event: DragEvent, task: Task): boolean {
    const source = this.taskLinkSource();
    if (!this.taskLinkToken() || !event.dataTransfer?.types.includes(TASK_LINK_DRAG_TYPE) || !source?.original || this.modal() || source.workspaceId !== this.store.currentWorkspace().id || source.generation !== this.store.generation()) return false;
    event.preventDefault(); event.stopPropagation();
    const valid = task.id !== source.original.id && !task.deletedAt && !this.ganttLockedTaskIds().includes(task.id);
    event.dataTransfer.dropEffect = valid ? 'link' : 'none'; this.taskLinkTarget.set(valid ? task.id : ''); return valid;
  }
  dropTaskLink(event: DragEvent, task: Task): void {
    if (!this.taskLinkOver(event, task)) return;
    const data = readTaskLinkDrag(event.dataTransfer!.getData(TASK_LINK_DRAG_TYPE)), source = this.taskLinkSource()!;
    if (!data || data.token !== this.taskLinkToken() || data.taskId !== source.original!.id || data.generation !== source.generation || data.workspaceId !== source.workspaceId) {this.cancelTaskLink(); return;}
    void this.linkSelectedTask(task);
  }
  async linkSelectedTask(task: Task): Promise<void> {
    const source = this.taskLinkSource(); if (!source?.original || this.modal() || this.store.pendingWrites()) return;
    if (task.id === source.original.id) {this.notify('請選擇另一個任務。'); return;}
    const target = {...this.store.taskContext(task.id), original: structuredClone(task)};
    this.cancelTaskLink();
    const result = await this.store.linkTasks(source, target);
    if (this.handleResult(result)) this.notify(result.persisted ? '相關任務已連結，可復原。' : '連結只暫存在此分頁，請匯出備份。');
  }
  @HostListener('window:pagehide')
  cancelTaskLink(): void {this.taskLinkSource.set(null); this.taskLinkToken.set(''); this.taskLinkTarget.set('');}
  endTaskLinkDrag(): void {this.cancelTaskLink(); this.dragEnded();}
  readonly panelBlocking = computed(() => this.panelOverlay() && this.panelOpen() && !this.sourcePanelDragging());
  readonly narrowPanelViewport = signal(window.innerWidth <= 1100);
  readonly panelViewportWidth = signal(window.innerWidth);
  readonly compactNavigation = computed(() => this.mobileViewport() || this.panelOpen() && (this.narrowPanelViewport() || this.panelViewportWidth() - this.effectivePanelWidth() < 900));
  readonly panelWidth = signal(this.readPanelWidth());
  readonly panelMaxWidth = computed(() => {
    const width = this.panelViewportWidth();
    return Math.max(300, Math.min(Math.max(800, Math.floor(width * 0.45)), width - 480));
  });
  readonly effectivePanelWidth = computed(() => Math.min(this.panelWidth(), this.panelMaxWidth()));
  private resizingPanel = false;
  private readPanelWidth(): number { try { const width = Number(localStorage.getItem('orbit-side-panel-width-v1')) || 360; return Number.isFinite(width) ? Math.max(300, width) : 360; } catch { return 360; } }
  openMail(): void { if (!this.modal()) { this.sidebarOpen.set(false); this.filesOpen.set(false); this.tasksOpen.set(false); this.remindersOpen.set(false); this.mailOpen.set(true); this.panelTab.set('gmail'); this.mailVisit.update(visit => visit + 1); } }
  toggleMail(): void { if (this.mailOpen()) this.closePanel(); else this.openMail(); }
  closePanel(): void { this.filesOpen.set(false); this.documentTasks.end(); this.mailOpen.set(false); this.remindersOpen.set(false); this.tasksOpen.set(false); }
  @HostListener('document:dragstart', ['$event'])
  sourceDragStarted(event: DragEvent): void {
    const types = event.dataTransfer?.types ?? [];
    if (!event.defaultPrevented && this.panelOverlay() && this.panelOpen() && (types.includes(GMAIL_MIME) || types.includes(DOCUMENT_DRAG_TYPE))
      && (event.target as Element | null)?.closest?.('#right-panel')) this.sourcePanelDragging.set(true);
  }
  @HostListener('document:dragend')
  @HostListener('window:pagehide')
  sourceDragFinished(): void {
    if (!this.sourcePanelDragging()) return;
    this.sourcePanelDragging.set(false); this.closePanel();
  }
  cancelSourceDrag(): void {
    if (this.mailOpen()) this.mailTasks.end();
    this.documentTasks.end(); this.sourceDragFinished();
  }
  openTaskPanel(): void {
    if (this.modal()) return;
    this.sidebarOpen.set(false); this.filesOpen.set(false); this.mailOpen.set(false); this.remindersOpen.set(false); this.tasksOpen.set(true); this.panelTab.set('tasks');
  }
  openFiles(): void {
    if (this.modal()) return;
    this.sidebarOpen.set(false); this.mailOpen.set(false); this.remindersOpen.set(false); this.tasksOpen.set(false); this.filesOpen.set(true); this.panelTab.set('files');
  }
  togglePanel(): void {
    if (this.modal()) return;
    if (this.panelOpen()) this.closePanel();
    else if (this.panelTab() === 'files') this.openFiles();
    else if (this.panelTab() === 'gmail') this.openMail();
    else if (this.panelTab() === 'reminders') this.openReminders(this.reminderTab());
    else this.openTaskPanel();
  }
  activatePanel(entry: PanelActivation): void {
    if (this.modal()) return;
    if (entry.target === 'toggle') {this.togglePanel(); return;}
    if (entry.target !== 'gmail' && this.panelOpen() && this.panelTab() === entry.target) {this.closePanel(); return;}
    if (entry.target === 'tasks') this.openTaskPanel();
    else if (entry.target === 'reminders') this.openReminders(entry.tab);
    else this.openMail();
  }
  openPanelTask(task: Task): void {
    if (this.modal()) return;
    this.store.refreshFromStorage();
    const current = this.store.tasks().find(item => item.id === task.id);
    if (current) this.openTask(current.status, current);
    else this.notify('這個任務已被刪除或移至其他工作空間。');
  }
  openDocumentTask(entry: {workspaceId: string; task: Task}): void {
    if (this.modal()) return;
    const workspace = this.store.workspaces().find(item => item.id === entry.workspaceId), task = workspace?.tasks.find(item => item.id === entry.task.id);
    if (!task) {this.notify('這個任務已不存在，請重新查看。'); return;}
    this.store.switchWorkspace(entry.workspaceId);
    if (task.deletedAt) {this.openTrash(); return;}
    this.openTask(task.status, task);
  }
  createDocumentTask(source: DocumentSource, status?: string): void {
    if (this.modal()) return;
    this.openTask(status); this.draft.title = source.name.slice(0, 100); this.setDraftDocuments([structuredClone(source)]);
  }
  documentOver(event: DragEvent): void {
    if (this.modal() || this.trashOpen() || !this.documentTasks.accepts(event)) return;
    const target = event.target instanceof Element ? event.target : null;
    const column = this.view() === 'board' ? target?.closest<HTMLElement>('.kanban-column') : null;
    const list = this.view() === 'list' ? target?.closest<HTMLElement>('.list-scroll') : null;
    const area = column ?? list;
    if (!area || target?.closest('thead')) {this.documentTasks.position.set(null); return;}
    this.documentTasks.over(event); event.stopPropagation();
    const current = this.documentTasks.position(), status = column?.dataset['status'];
    const placeholder = area.querySelector<HTMLElement>('.document-board-placeholder, .document-list-placeholder')?.getBoundingClientRect();
    if (current?.kind === 'create' && current.status === status && placeholder && event.clientY >= placeholder.top && event.clientY <= placeholder.bottom) return;
    const cards = [...area.querySelectorAll<HTMLElement>(column ? '.task-card[data-task-id]' : '.task-row[data-task-id]')].map(card => {
      const bounds = card.getBoundingClientRect(); return {id: card.dataset['taskId']!, top: bounds.top, bottom: bounds.bottom};
    });
    const position = documentCardPosition(cards, event.clientY, status);
    if (JSON.stringify(position) !== JSON.stringify(current)) this.documentTasks.position.set(position);
  }
  documentLeave(event: DragEvent): void {
    const area = event.currentTarget as HTMLElement;
    if (!(event.relatedTarget instanceof Node) || !area.contains(event.relatedTarget)) this.documentTasks.position.set(null);
  }
  documentCreates(beforeId?: string, status?: string): boolean {
    const position = this.documentTasks.position(); return this.documentTasks.dragging() && position?.kind === 'create' && position.beforeId === beforeId && position.status === status;
  }
  documentLinks(taskId: string): boolean {const position = this.documentTasks.position(); return this.documentTasks.dragging() && position?.kind === 'link' && position.taskId === taskId;}
  async dropDocument(event: DragEvent): Promise<void> {
    this.documentOver(event);
    const position = this.documentTasks.position();
    if (!position || this.modal() || this.trashOpen()) return;
    const mobileDrag = this.sourcePanelDragging();
    const taskId = await this.documentTasks.drop(event, this.emptyTask(position.status ?? this.statuses().find(status => status.kind === 'active')?.id ?? this.statuses()[0].id), position);
    this.documentCreated(taskId);
    if (mobileDrag && this.documentTasks.notice()) this.notify(this.documentTasks.notice());
  }
  async dropCalendarDocument(entry: {event: DragEvent; position?: CalendarPosition; taskId?: string; projectId?: string}): Promise<void> {
    if (this.modal() || this.trashOpen()) return;
    const position: DocumentDropPosition = entry.taskId ? {kind: 'link', taskId: entry.taskId} : {kind: 'create'};
    const mobileDrag = this.sourcePanelDragging();
    const base = this.emptyTask(this.statuses().find(status => status.kind === 'active')?.id ?? this.statuses()[0].id);
    if (entry.projectId !== undefined && (!entry.projectId || this.store.projects().some(project => project.id === entry.projectId))) base.projectId = entry.projectId;
    const taskId = await this.documentTasks.drop(entry.event, base, position, entry.position);
    this.documentCreated(taskId);
    if (mobileDrag && this.documentTasks.notice()) this.notify(this.documentTasks.notice());
  }
  private documentCreated(taskId?: string): void {
    if (!taskId) return;
    if (!this.visibleTasks().some(task => task.id === taskId)) this.documentTasks.notice.update(message => message + '此任務不符合目前篩選，原篩選條件已保留。');
    else if ((this.view() === 'month' || this.view() === 'week') && !this.calendarShowOrbit()) this.documentTasks.notice.update(message => message + 'Orbit 任務目前隱藏，開啟「Orbit 任務」即可查看。');
  }
  readonly conflictContext = signal<TaskConflictContext | null>(null);
  readonly conflictSaving = signal(false);
  openTaskConflict(entry: Pick<TaskConflictContext, 'workspace' | 'conflict'>): void {
    if (this.modal()) return;
    this.store.refreshFromStorage();
    const current = this.store.taskConflicts().find(value => value.workspace.id === entry.workspace.id && value.conflict.id === entry.conflict.id);
    if (!current) {this.notify('這個衝突已處理完成。'); return;}
    this.conflictContext.set({...structuredClone(current), generation: this.store.generation()});
    this.conflictSaving.set(false); this.modal.set('task-conflict');
  }
  taskConflictSaved(persisted: boolean): void {
    this.conflictSaving.set(false); this.closeModal();
    this.notify(persisted ? '已儲存並採用任務版本；啟用同步並連線後，會傳到其他裝置。' : '內容只暫存於此分頁，請先匯出備份。');
  }
  async togglePin(task: Task): Promise<void> {
    if (this.modal() || this.store.pendingWrites()) return;
    const pinned = !task.pinned;
    const result = await this.store.setTaskPinned(task.id, pinned);
    if (this.handleResult(result)) this.notifySaved(pinned ? '任務已釘選，可在右側任務欄查看' : '已取消釘選');
  }
  startPanelResize(event: PointerEvent): void { event.preventDefault(); this.resizingPanel = true; (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId); }
  @HostListener('document:pointermove', ['$event'])
  resizePanel(event: PointerEvent): void { if (this.resizingPanel) this.panelWidth.set(Math.min(this.panelMaxWidth(), Math.max(300, this.panelViewportWidth() - event.clientX))); }
  @HostListener('document:pointerup')
  @HostListener('document:pointercancel')
  finishPanelResize(): void { if (!this.resizingPanel) return; this.resizingPanel = false; this.persistPanelWidth(); }
  panelResizeKey(event: KeyboardEvent): void { if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return; event.preventDefault(); this.panelWidth.set(Math.min(this.panelMaxWidth(), Math.max(300, this.effectivePanelWidth() + (event.key === 'ArrowLeft' ? 20 : -20)))); this.persistPanelWidth(); }
  private persistPanelWidth(): void { try { localStorage.setItem('orbit-side-panel-width-v1', String(this.panelWidth())); } catch { /* Width still applies to the current tab. */ } }
  private setMailPosition(element: HTMLElement, y: number, status?: string): void {
    const current = this.mailTasks.boardPosition(), placeholder = element.querySelector<HTMLElement>('.mail-board-placeholder, .mail-list-placeholder')?.getBoundingClientRect();
    if (current && !current.taskId && current.status === status && placeholder && y >= placeholder.top && y <= placeholder.bottom) return;
    const cards = [...element.querySelectorAll<HTMLElement>('.task-card[data-task-id], .task-row[data-task-id]')].map(card => {const bounds = card.getBoundingClientRect(); return {id: card.dataset['taskId']!, top: bounds.top, bottom: bounds.top + bounds.height};});
    const position = documentCardPosition(cards, y, status), next = position.kind === 'link' ? {status, taskId: position.taskId} : {status, beforeId: position.beforeId};
    if (JSON.stringify(current) !== JSON.stringify(next)) this.mailTasks.boardPosition.set(next);
  }
  boardMailOver(event: DragEvent, column: BoardColumn): boolean {
    if (this.modal() || this.trashOpen() || !this.mailTasks.over(event)) {this.mailTasks.boardPosition.set(null); return false;}
    this.setMailPosition(event.currentTarget as HTMLElement, event.clientY, column.id); return true;
  }
  listMailOver(event: DragEvent): boolean {
    if (this.modal() || this.trashOpen() || (event.target as Element | null)?.closest?.('thead') || !this.mailTasks.over(event)) {this.mailTasks.boardPosition.set(null); return false;}
    this.setMailPosition(event.currentTarget as HTMLElement, event.clientY); return true;
  }
  listMailLeave(event: DragEvent): void {const area = event.currentTarget as HTMLElement; if (!(event.relatedTarget instanceof Node) || !area.contains(event.relatedTarget)) this.mailTasks.boardPosition.set(null);}
  async dropListMail(event: DragEvent): Promise<void> {if (this.listMailOver(event)) {const position = this.mailTasks.boardPosition(); await this.dropMail(event, undefined, undefined, position?.beforeId, position?.taskId);}}
  mailCreates(beforeId?: string, status?: string): boolean {const position = this.mailTasks.boardPosition(); return this.mailTasks.dragging() && !!position && !position.taskId && position.status === status && position.beforeId === beforeId;}
  mailLinks(taskId: string): boolean {return this.mailTasks.dragging() && this.mailTasks.boardPosition()?.taskId === taskId;}
  boardMailLeave(event: DragEvent, status: string): void {
    if (this.mailTasks.boardPosition()?.status !== status) return;
    const next = event.relatedTarget;
    if (!next || !('nodeType' in next) || !(event.currentTarget as HTMLElement).contains(next as Node)) this.mailTasks.boardPosition.set(null);
  }
  async dropBoardMail(event: DragEvent, column: BoardColumn): Promise<void> {
    if (!this.boardMailOver(event, column)) return;
    const position = this.mailTasks.boardPosition();
    await this.dropMail(event, column.id, undefined, position?.beforeId, position?.taskId);
  }
  async dropMail(event: DragEvent, status?: string, position?: CalendarPosition, beforeId?: string, taskId?: string, projectId?: string): Promise<void> {
    if (this.modal()) return;
    const mobileDrag = this.sourcePanelDragging();
    const initialStatus = status ?? this.statuses().find(status => status.kind === 'active')?.id ?? this.statuses()[0].id, base = this.emptyTask(initialStatus);
    if (projectId !== undefined && (!projectId || this.store.projects().some(project => project.id === projectId))) base.projectId = projectId;
    await this.mailTasks.drop(event, base, position ? {date: position.day, ...(position.kind === 'time' ? {time: minuteLabel(position.minute ?? 0)} : {})} : {}, beforeId, taskId);
    const context = this.mailTasks.undoContext();
    if (context?.original?.id === base.id && context.generation === this.store.generation() && context.workspaceId === this.store.currentWorkspace().id && this.hasFilters()) {
      const reminder = this.visibleTasks().some(task => task.id === base.id)
        ? '目前有篩選條件，原篩選條件已保留。'
        : '此任務不符合目前篩選，暫時不會顯示。原篩選條件已保留。';
      this.mailTasks.notice.update(message => `${message} ${reminder}`);
    }
    if (mobileDrag && this.mailTasks.notice()) this.notify(this.mailTasks.notice());
  }
  openMailTask(mail: MailPreview): void {
    if (this.modal()) return;
    this.openTask();
    try { this.draft = this.mailTasks.draft(mail, this.draft); this.setDraftDocuments([this.mailTasks.source(mail)]); }
    catch (error) { this.formError.set(error instanceof Error ? error.message : '無法建立郵件任務。'); }
  }
  readonly mailPreview = signal<{mail: MailPreview; identity: string; email: string} | null>(null);
  openMailPreview(mail: MailPreview): void {
    if (this.modal() || this.mailTasks.dragging()) return;
    const gmail = this.mailTasks.gmail;
    if (!gmail.isListed(mail)) return;
    this.mailPreview.set({mail: structuredClone(mail), identity: gmail.previewIdentity(), email: gmail.preferences().email});
    this.modal.set('mail-preview');
  }
  createPreviewTask(mail: MailPreview): void {
    const preview = this.mailPreview();
    if (!preview || this.modal() !== 'mail-preview' || preview.identity !== this.mailTasks.gmail.previewIdentity() || mail.threadId !== preview.mail.threadId) return;
    this.closeModal(); this.openTask(); this.draft = this.mailTasks.draft(mail, this.draft, preview); this.setDraftDocuments([this.mailTasks.source(mail, preview)]);
  }
  openCreatedMailTask(): void {
    if (this.modal()) return;
    const context = this.mailTasks.undoContext();
    if (!context?.original || context.generation !== this.store.generation()) return;
    const task = this.store.workspaces().find(workspace => workspace.id === context.workspaceId)?.tasks.find(task => task.id === context.original!.id);
    if (!task) return;
    if (context.workspaceId !== this.store.currentWorkspace().id) this.store.switchWorkspace(context.workspaceId);
    this.openTask(task.status, task);
  }
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
  readonly query = signal(this.savedBrowse.query);
  readonly categoryFilter = signal(this.validCategoryFilter(this.savedBrowse.category));
  readonly projectFilter = signal(this.validProjectFilter(this.savedBrowse.project));
  readonly progressExpanded = signal(this.savedBrowse.progressExpanded);
  private readonly legacyHeaderCompact = signal(this.savedBrowse.headerCompact);
  readonly headerCompact = computed(() => this.store.currentWorkspace().headerCompact ?? this.legacyHeaderCompact());
  readonly trashOpen = signal(this.savedBrowse.trashOpen);
  readonly overviewOpen = signal(this.savedBrowse.overviewOpen);
  readonly overviewProject = signal(this.savedBrowse.overviewProject);
  readonly overviewArchived = signal(this.savedBrowse.overviewArchived);
  readonly overviewSelection = signal<OverviewSelection | null>(this.savedBrowse.overviewSelection);
  readonly overviewPage = signal(0);
  readonly overviewScroll = signal(0);
  private overviewReturnContext?: {workspaceId: string; generation: string};
  private readonly taskTitleInput = viewChild<ElementRef<HTMLInputElement>>('taskTitleInput');
  private readonly modalTitle = viewChild<ElementRef<HTMLElement>>('modalTitle');
  private readonly overviewDashboard = viewChild<WorkspaceOverview>('overviewDashboard');
  private overviewModalWasOpen = false;
  openOverviewList(selection: OverviewSelection): void {
    if (this.modal() || !this.overviewOpen()) return;
    this.overviewSelection.set(selection); this.overviewPage.set(0); this.overviewScroll.set(0);
    this.modal.set('overview-list');
  }
  openOverviewTask(task: Task): void {
    if (!this.leaveOverviewList()) return;
    this.openTask(task.status, task);
    if (!this.modal()) this.modal.set('overview-list');
  }
  openOverviewConflict(entry: Pick<TaskConflictContext, 'workspace' | 'conflict'>): void {
    if (!this.leaveOverviewList()) return;
    this.openTaskConflict(entry);
    if (!this.modal()) this.modal.set('overview-list');
  }
  private leaveOverviewList(): boolean {
    if (this.modal() !== 'overview-list') return false;
    this.overviewReturnContext = {workspaceId: this.store.currentWorkspace().id, generation: this.store.generation()};
    this.modal.set(null);
    return true;
  }
  openOverview(): void {
    if (this.modal()) return;
    this.trashOpen.set(false); this.overviewOpen.set(true); this.sidebarOpen.set(false);
  }
  readonly emptyTrashContext = signal<TrashContext | null>(null);
  readonly taskPurgeContext = signal<(TaskEditContext & {original: Task; workspaceName: string}) | null>(null);
  readonly selectedProjectId = computed(() => {
    const id = this.projectFilter();
    return id === '' || this.store.projects().some(project => project.id === id) ? id : 'all';
  });
  readonly headingProjectName = computed(() => {
    if (this.trashOpen()) return '';
    const id = this.overviewOpen() ? this.overviewProject() : this.selectedProjectId();
    if (id === 'all') return '';
    if (id === '') return '未指定專案';
    const project = this.store.projects().find(project => project.id === id);
    return project && (!this.overviewOpen() || this.overviewArchived() || !project.archived) ? project.name : '';
  });
  readonly workspaceTitle = computed(() => this.store.currentWorkspace().name + (this.headingProjectName() ? ' ／ ' + this.headingProjectName() : ''));
  readonly activeProjectCount = computed(() => this.store.projects().filter(project => !project.archived).length);
  readonly progressRows = computed(() => projectSummaries(this.store.tasks(), this.statuses(), this.store.projects().filter(project => !project.archived)));
  readonly archivedProgressRows = computed(() => this.store.projects().filter(project => project.archived).map(project => projectProgress(this.store.tasks(), this.statuses(), project.id, project.name)));
  readonly selectedProjectArchived = computed(() => !!this.store.projects().find(project => project.id === this.selectedProjectId())?.archived);
  readonly selectedProgress = computed(() => projectProgress(this.store.tasks(), this.statuses(), this.selectedProjectId(), this.selectedProjectId() === 'all' ? '所有專案' : this.projectName(this.selectedProjectId()), this.store.projects()));
  readonly overallProgress = computed(() => projectProgress(this.store.tasks(), this.statuses(), 'all', '所有專案', this.store.projects()));
  readonly selectedPendingCount = computed(() => tasksForProject(this.store.tasks(), this.selectedProjectId()).filter(task => !this.store.isDone(task) && !this.store.isArchived(task)).length);
  readonly projectEditing = signal<Project | null>(null);
  readonly projectToDelete = signal<Project | null>(null);
  readonly priorityFilter = signal(this.savedBrowse.priority);
  readonly priorityFilterLabel = computed(() => this.priorities.find(priority => priority.id === this.priorityFilter())?.label ?? '');
  readonly pinnedOnly = signal(this.savedBrowse.pinnedOnly);
  readonly advancedFiltersOpen = signal(false);
  readonly advancedFilterCount = computed(() => Number(this.categoryFilter() !== 'all') + Number(this.deadlineFilter() !== 'all') + Number(this.priorityFilter() !== 'all') + Number(this.pinnedOnly()) + Number(this.recentOnly()));
  readonly recentOnly = signal(this.savedBrowse.recentOnly);
  readonly deadlineFilter = signal<DeadlineFilter>(this.savedBrowse.deadline);
  readonly deadlineDays = signal<number | null>(this.savedBrowse.deadlineDays);
  readonly effectiveDeadlineDays = computed(() => this.deadlineDays() ?? this.store.reminders().dueSoonDays);
  readonly deadlineSelection = computed(() => this.deadlineFilter() === 'due-soon' && this.deadlineDays() !== null ? 'due-' + this.deadlineDays() : this.deadlineFilter());
  readonly reminderTab = signal<ReminderTab>(this.savedBrowse.reminderTab);
  readonly remindersOpen = signal(this.savedBrowse.panel === 'reminders');
  readonly now = signal(new Date());
  readonly settingsTab = signal<SettingsTab>('appearance');
  readonly scope = signal<TaskScope>(this.savedBrowse.scope);
  readonly view = signal<BrowseState['view']>(this.savedBrowse.view);
  readonly viewTabs = viewChild<ElementRef<HTMLElement>>('viewTabs');
  readonly calendarDate = signal(this.savedBrowse.calendarDate);
  readonly ganttDate = signal(this.savedBrowse.ganttDate);
  readonly ganttScale = signal(this.savedBrowse.ganttScale);
  readonly ganttZoom = signal(this.savedBrowse.ganttZoom);
  readonly ganttCompletion = signal(this.savedBrowse.ganttCompletion);
  readonly ganttOrder = signal(this.savedBrowse.ganttOrder);
  readonly ganttLockedTaskIds = computed(() => this.store.taskConflicts().filter(entry => entry.workspace.id === this.store.currentWorkspace().id).map(entry => entry.conflict.id));
  readonly ganttRange = signal(this.savedBrowse.ganttRange);
  readonly ganttStatuses = signal(this.savedBrowse.ganttStatuses);
  readonly ganttCategories = signal(this.savedBrowse.ganttCategories);
  readonly calendarScrollHour = signal(this.savedBrowse.calendarScrollHour);
  readonly calendarExpandAll = signal(this.savedBrowse.calendarExpandAll);
  readonly calendarShowOrbit = signal(this.savedBrowse.showOrbit);
  readonly calendarShowGoogle = signal(this.savedBrowse.showGoogle);
  readonly sortKey = signal<SortKey | null>(this.savedBrowse.sort);
  readonly sortDirection = signal<SortDirection>(this.savedBrowse.direction);
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
  readonly sidebarCollapsed = signal(false);
  readonly sidebarVisible = computed(() => this.compactNavigation() ? this.sidebarOpen() : !this.sidebarCollapsed());
  readonly mobileViewport = signal(window.innerWidth <= 700);
  readonly modal = signal<Modal>(this.savedBrowse.overviewOpen && this.savedBrowse.overviewSelection ? 'overview-list' : null);
  readonly logoutSaving = signal(false);
  openLogout(): void {if (!this.modal()) {this.sidebarOpen.set(false); this.modal.set('logout');}}
  private backdropClick?: {pointerId: number; x: number; y: number; released: boolean};
  readonly editing = signal(false);
  readonly documentCreationPrompt = signal(false);
  private documentCreationRequest = 0;
  readonly descriptionFocused = signal(false);
  readonly taskEditorExpanded = signal(false);
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
  readonly localTaskDraftStatus = signal('停頓後自動暫存於本機；按「儲存變更」後生效。');
  readonly localTaskDraftRecovery = signal<LocalTaskDraft | null>(null);
  private readonly localTaskDrafts = new TaskEditDrafts();
  private readonly descriptionKeyboard = new DescriptionKeyboard();
  resetDescriptionKeyboard(): void {this.descriptionKeyboard.reset();}
  private localTaskDraftId = '';
  private localTaskDraftBaseline = '';
  private localTaskDraftObserved = '';
  private restoredTaskDraft: LocalTaskDraft | null = null;
  private localTaskDraftTimer?: ReturnType<typeof setTimeout>;
  descriptionKeydown(event: KeyboardEvent): void {
    const value = this.descriptionKeyboard.handle(event);
    if (value !== undefined) this.draft.description = value;
  }
  private taskDraftSnapshot(): TaskDraftSnapshot {
    const editor = this.documentLinksEditor();
    return {context: this.taskEditContext()!, task: this.draft, documents: this.draftDocuments(), descriptions: this.draftDocumentDescriptions(), relatedTaskIds: this.draftRelatedTasks(), subtaskDraft: this.subtaskDraft, hasStartTime: this.hasStartTime, hasDueTime: this.hasDueTime, documentInput: {name: editor?.name ?? '', url: editor?.url ?? '', adding: editor?.adding() ?? false}};
  }
  private relatedDraftUnchanged(): boolean {return JSON.stringify([...this.draftRelatedTasks()].sort()) === JSON.stringify(this.store.relatedTaskIds(this.draft.id));}
  openRelatedTask(id: string): void {
    if (this.modal() !== 'task' || this.store.pendingWrites()) return;
    if (this.taskDraftConflict() || JSON.stringify(this.taskDraftSnapshot()) !== this.localTaskDraftBaseline) {this.formError.set('請先儲存或取消目前變更，再開啟相關任務。'); return;}
    const task = this.store.tasks().find(task => task.id === id && !task.deletedAt);
    if (!task) {this.formError.set('相關任務已移除或在垃圾桶，無法開啟。'); return;}
    this.closeModal(); this.openTask(task.status, task);
  }
  private startLocalTaskDraft(): void {
    clearTimeout(this.localTaskDraftTimer); this.localTaskDraftTimer = undefined;
    this.localTaskDraftId = crypto.randomUUID(); this.restoredTaskDraft = null;
    this.localTaskDraftBaseline = this.localTaskDraftObserved = JSON.stringify(this.taskDraftSnapshot());
    this.localTaskDraftStatus.set('停頓後自動暫存於本機；按「儲存變更」後生效。');
    try {this.localTaskDraftRecovery.set(this.localTaskDrafts.find(this.taskEditContext()!));}
    catch {this.localTaskDraftRecovery.set(null); this.localTaskDraftStatus.set('無法讀取本機草稿，請使用「儲存變更」。');}
  }
  ngDoCheck(): void {
    if (this.modal() !== 'task' || !this.localTaskDraftId || !this.taskEditContext()) return;
    const current = JSON.stringify(this.taskDraftSnapshot());
    if (current === this.localTaskDraftObserved) return;
    this.localTaskDraftObserved = current;
    clearTimeout(this.localTaskDraftTimer);
    this.localTaskDraftStatus.set('等待暫存…');
    this.localTaskDraftTimer = setTimeout(() => this.flushLocalTaskDraft(), 1200);
  }
  @HostListener('window:pagehide')
  flushLocalTaskDraft(): void {
    clearTimeout(this.localTaskDraftTimer); this.localTaskDraftTimer = undefined;
    if (this.modal() !== 'task' || !this.localTaskDraftId || !this.taskEditContext()) return;
    const value = this.taskDraftSnapshot(), current = JSON.stringify(value);
    if (value.context.generation !== this.store.generation() || value.context.workspaceId !== this.store.currentWorkspace().id) return;
    try {
      if (current === this.localTaskDraftBaseline) {
        this.localTaskDrafts.remove(this.localTaskDraftId);
        this.localTaskDraftStatus.set('沒有尚未儲存的變更。');
      } else {
        this.localTaskDrafts.save(this.localTaskDraftId, value);
        this.localTaskDraftStatus.set('已暫存本機草稿，不會同步。');
      }
      this.localTaskDraftObserved = current;
    } catch {this.localTaskDraftStatus.set('本機草稿暫存失敗，內容仍在此視窗，請按「儲存變更」。');}
  }
  restoreLocalTaskDraft(): void {
    const saved = this.localTaskDraftRecovery(), context = this.taskEditContext();
    if (!saved || !context || saved.snapshot.context.generation !== this.store.generation() || saved.snapshot.context.workspaceId !== this.store.currentWorkspace().id) return;
    const value = structuredClone(saved.snapshot);
    this.draft = value.task; this.taskEditContext.set(value.context); this.editing.set(!!value.context.original);
    this.draftDocuments.set(value.documents); this.draftDocumentDescriptions.set(value.descriptions);
    this.draftRelatedTasks.set(value.relatedTaskIds ?? this.store.relatedTaskIds(value.task.id));
    this.subtaskDraft = value.subtaskDraft; this.hasStartTime = value.hasStartTime; this.hasDueTime = value.hasDueTime;
    const editor = this.documentLinksEditor();
    if (editor) {editor.name = value.documentInput.name; editor.url = value.documentInput.url; editor.adding.set(value.documentInput.adding);}
    this.restoredTaskDraft = saved; this.localTaskDraftRecovery.set(null);
    this.ngDoCheck(); this.flushLocalTaskDraft();
  }
  discardRecoveredTaskDraft(): void {
    const saved = this.localTaskDraftRecovery(); if (!saved) return;
    try {this.localTaskDrafts.remove(saved.id, saved.raw); this.localTaskDraftRecovery.set(this.localTaskDrafts.find(this.taskEditContext()!));}
    catch {this.localTaskDraftStatus.set('無法移除本機草稿，請稍後重試。');}
  }
  private clearLocalTaskDraft(): boolean {
    clearTimeout(this.localTaskDraftTimer); this.localTaskDraftTimer = undefined;
    try {
      if (this.localTaskDraftId) this.localTaskDrafts.remove(this.localTaskDraftId);
      if (this.restoredTaskDraft) this.localTaskDrafts.remove(this.restoredTaskDraft.id, this.restoredTaskDraft.raw);
    } catch {this.localTaskDraftStatus.set('無法移除本機草稿，請稍後重試。'); return false;}
    this.restoredTaskDraft = null;
    this.localTaskDraftBaseline = this.localTaskDraftObserved = JSON.stringify(this.taskDraftSnapshot());
    return true;
  }
  cancelTaskEdit(): void {if (this.clearLocalTaskDraft()) this.closeModal();}
  readonly draftDocuments = signal<DocumentSource[]>([]);
  readonly draftRelatedTasks = signal<string[]>([]);
  readonly taskLinkPickerOpen = signal(false);
  private taskLinkPickerRef?: DialogRef<string[], TaskLinkPicker>;
  private taskLinkPickerRequest = 0;
  private taskLinkDisposed = false;
  async openTaskLinkPicker(): Promise<void> {
    if (this.modal() !== 'task' || this.taskLinkPickerOpen() || this.store.pendingWrites()) return;
    const context = this.taskEditContext()!, taskId = this.draft.id, request = ++this.taskLinkPickerRequest;
    const data: TaskLinkPickerData = {taskId, workspaceId: context.workspaceId, generation: context.generation, excluded: [...this.draftRelatedTasks()]};
    this.taskLinkPickerOpen.set(true); this.formError.set('');
    const current = () => request === this.taskLinkPickerRequest && this.modal() === 'task' && this.draft.id === taskId && this.taskEditContext() === context && this.store.generation() === data.generation && this.store.currentWorkspace().id === data.workspaceId;
    try {
      const [{Dialog}, {TaskLinkPicker}] = await Promise.all([import('@angular/cdk/dialog'), import('./task-link-picker')]);
      if (!current()) {if (request === this.taskLinkPickerRequest) this.taskLinkPickerOpen.set(false); return;}
      const ref = this.injector.get(Dialog).open<string[], TaskLinkPickerData, TaskLinkPicker>(TaskLinkPicker, {data, injector: this.injector, width: 'min(700px, calc(100vw - 24px))', maxHeight: 'calc(100dvh - 32px)', panelClass: 'information-picker-dialog', ariaLabel: '建立任務連結', ariaModal: true, autoFocus: '.task-link-search', restoreFocus: '.task-link-create', disableClose: true});
      this.taskLinkPickerRef = ref;
      ref.backdropClick.subscribe(() => ref.close());
      ref.closed.subscribe(ids => {
        if (this.taskLinkPickerRef !== ref) return;
        this.taskLinkPickerRef = undefined; this.taskLinkPickerOpen.set(false);
        if (!this.taskLinkDisposed && typeof document !== 'undefined') afterNextRender(() => {if (this.modal() === 'task' && this.draft.id === taskId) this.documentLinksEditor()?.focusTaskLinkButton();}, {injector: this.injector});
        if (ids === undefined || !current()) return;
        const locked = new Set(this.ganttLockedTaskIds()), available = new Set(this.store.tasks().filter(task => task.id !== taskId && !locked.has(task.id)).map(task => task.id));
        if (ids.some(id => !available.has(id))) {this.formError.set('部分任務已更新或移除，請重新選擇任務連結。'); return;}
        this.draftRelatedTasks.update(previous => [...new Set([...previous, ...ids])]);
      });
    } catch {if (request === this.taskLinkPickerRequest) {this.taskLinkPickerOpen.set(false); this.formError.set('無法開啟任務選擇視窗，原有草稿保留，請重試。');}}
  }
  cancelTaskLinkPicker(): void {this.taskLinkPickerRequest++; this.taskLinkPickerRef?.close(); this.taskLinkPickerRef = undefined; this.taskLinkPickerOpen.set(false);}
  readonly draftDocumentDescriptions = signal<DocumentDescription[]>([]);
  setDraftDocuments(sources: DocumentSource[]): void {
    const notes = new Map(this.draftDocumentDescriptions().map(item => [item.documentId, item.description]));
    this.draftDocuments.set(sources);
    this.draftDocumentDescriptions.set(sources.map(source => ({documentId: source.id, description: notes.get(source.id) ?? ''})));
  }
  private readonly documentLinksEditor = viewChild(DocumentLinksEditor);
  readonly taskDraftConflict = computed(() => {
    const context = this.taskEditContext();
    if (this.modal() !== 'task' || !context) return false;
    const workspace = this.store.workspaces().find(item => item.id === context.workspaceId);
    const current = context.original ? workspace?.tasks.find(task => task.id === context.original!.id) ?? null : null;
    return this.store.generation() !== context.generation || !workspace || JSON.stringify(current) !== JSON.stringify(context.original)
      || !!context.original && JSON.stringify(workspace.documentLinks?.filter(link => link.taskId === context.original!.id) ?? []) !== JSON.stringify(context.documentLinks ?? [])
      || !!context.original && context.informationKey !== undefined && taskInformationKey(workspace, context.original.id) !== context.informationKey
      || !!context.original && context.relatedTasksKey !== undefined && relatedTasksKey(workspace, context.original.id) !== context.relatedTasksKey;
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
  readonly introSaving = signal(false);
  readonly introFirstUse = signal(false);
  readonly firstWorkspaceDialog = signal(false);
  readonly workspaceNameInput = viewChild<ElementRef<HTMLInputElement>>('workspaceNameInput');
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

  readonly thisWeekRange = computed(() => currentWeekRange(this.now()));
  readonly thisWeekCount = computed(() => this.store.tasks().filter(task => taskInWeek(task, this.thisWeekRange(), this.statuses())).length);
  readonly visibleTasks = computed(() => {
    const search = this.query().trim().toLocaleLowerCase(), deadline = this.deadlineFilter();
    return tasksForProject(this.store.tasks(), this.selectedProjectId()).filter(task => {
      const matchesQuery = !search || `${task.title} ${task.description} ${this.category(task.categoryId).name} ${this.projectName(task.projectId)}`.toLocaleLowerCase().includes(search);
      const matchesDate = deadline === 'all' || (deadline === 'unset' ? !task.dueDate
        : deadline === 'this-week' ? taskInWeek(task, this.thisWeekRange(), this.statuses())
        : deadlineState(task, this.now(), this.effectiveDeadlineDays(), this.statuses()) === deadline);
      return matchesQuery && (this.categoryFilter() === 'all' || task.categoryId === this.categoryFilter())
        && matchesDate
        && (!this.pinnedOnly() || !!task.pinned)
        && (!this.recentOnly() || recentlyEdited(task, this.now()))
        && (this.priorityFilter() === 'all' || task.priority === this.priorityFilter())
        && (this.scope() !== 'active' || (!this.store.isDone(task) && !this.store.isArchived(task)))
        && (this.scope() !== 'done' || this.store.isDone(task))
        && (this.scope() !== 'archived' || this.store.isArchived(task));
    });
  });
  readonly columns = computed(() => boardStatusesForScope(this.statuses(), this.scope()).map(column => ({...column, tasks: this.visibleTasks().filter(task => task.status === column.id)})));
  readonly navigationTitle = computed(() => {
    if (this.trashOpen()) return '垃圾桶';
    if (this.overviewOpen()) return '空間總覽';
    const labels = {all: '專案看板', active: '待完成任務', done: '已完成任務', archived: '封存任務'};
    return this.scope() === 'all' && this.categoryFilter() !== 'all' ? this.category(this.categoryFilter()).name : labels[this.scope()];
  });
  readonly activeTaskCount = computed(() => this.store.activeTasks().filter(task => !this.store.isDone(task)).length);
  readonly calendarTasks = computed(() => this.visibleTasks().filter(task => !this.store.isArchived(task)));
  readonly effectiveSortKey = computed(() => this.sortKey() ?? (this.deadlineFilter() === 'all' || this.deadlineFilter() === 'unset' ? null : this.deadlineFilter() === 'this-week' ? 'startDate' : 'dueDate'));
  readonly sortedTasks = computed(() => sortTasks(this.visibleTasks(), this.store.categories(), this.effectiveSortKey(), this.sortKey() ? this.sortDirection() : 'asc', this.statuses(), this.store.projects()));
  readonly ganttContext = computed(() => JSON.stringify([this.store.generation(), this.store.currentWorkspace().id, this.scope(), this.query(), this.selectedProjectId(), this.categoryFilter(), this.priorityFilter(), this.pinnedOnly(), this.recentOnly(), this.deadlineFilter(), this.effectiveDeadlineDays(), this.sortKey(), this.sortDirection()]));
  readonly hasFilters = computed(() => !!this.query() || this.selectedProjectId() !== 'all' || this.categoryFilter() !== 'all' || this.priorityFilter() !== 'all' || this.scope() !== 'all' || this.deadlineFilter() !== 'all' || this.pinnedOnly() || this.recentOnly());
  readonly deadlineCounts = computed(() => this.store.tasks().reduce((counts, task) => {
    const state = deadlineState(task, this.now(), this.effectiveDeadlineDays(), this.statuses());
    if (state) counts[state]++;
    return counts;
  }, {'overdue': 0, 'due-soon': 0}));
  readonly deadlinePresets = computed(() => DUE_DAY_PRESETS.map(days => ({days, count: this.store.tasks().filter(task => deadlineState(task, this.now(), days, this.statuses()) === 'due-soon').length})));

  constructor() {
    afterRenderEffect(() => {
      this.view(); this.compactNavigation(); this.preferences.textSize();
      const tabs = this.viewTabs()?.nativeElement, selected = tabs?.querySelector<HTMLElement>('[aria-pressed="true"]');
      if (tabs && selected) {
        const tabRect = tabs.getBoundingClientRect(), selectedRect = selected.getBoundingClientRect();
        if (selectedRect.right > tabRect.right) tabs.scrollLeft += selectedRect.right - tabRect.right;
        else if (selectedRect.left < tabRect.left) tabs.scrollLeft -= tabRect.left - selectedRect.left;
      }
    });
    afterRenderEffect(() => {
      const modal = this.modal();
      if (modal === 'overview-list') this.overviewModalWasOpen = true;
      if (!modal && this.overviewModalWasOpen) {
        this.overviewModalWasOpen = false;
        if (document.activeElement === document.body) this.overviewDashboard()?.focusTitle();
      }
      if (!this.overviewReturnContext) return;
      if (modal === 'task') this.taskTitleInput()?.nativeElement.focus();
      else if (modal === 'task-conflict') this.modalTitle()?.nativeElement.focus();
    });
    inject(DestroyRef).onDestroy(() => {this.taskLinkDisposed = true; this.endBoardTaskDrag(); this.cancelTaskLinkPicker(); this.flushLocalTaskDraft(); clearTimeout(this.localTaskDraftTimer);});
    inject(DestroyRef).onDestroy(this.store.protectDocumentSources(() => new Set(this.modal() === 'task' ? this.draftDocuments().map(source => source.id) : [])));
    if (this.store.onboarding()) afterRenderEffect(() => {
      const field = this.firstWorkspaceDialog() && this.modal() === 'workspaces' ? this.workspaceNameInput()?.nativeElement : undefined;
      field?.focus();
    });
    effect(() => {
      if (this.store.storageLoading()) return;
      const phase = this.store.onboarding();
      untracked(() => {
        if (phase === 'guide' && this.modal() !== 'intro') { this.introFirstUse.set(true); this.closePanel(); this.modal.set('intro'); }
        else if (phase === 'workspace' && this.modal() !== 'workspaces') this.openWorkspaces();
        else if (!phase && (this.modal() === 'intro' && this.introFirstUse() || this.modal() === 'workspaces' && this.firstWorkspaceDialog())) this.closeModal();
      });
    });
    effect(() => {
      if (this.store.storageLoading()) return;
      const generation = this.store.generation(), workspace = this.store.currentWorkspace().id;
      const context = JSON.stringify([generation, workspace]);
      if (context !== this.browseContext) untracked(() => {
        const sameGeneration = generation === this.browseGeneration;
        const fallback = sameGeneration ? readBrowseState({overviewOpen: this.overviewOpen(), view: this.view(), ganttDate: this.ganttDate(), ganttScale: this.ganttScale(), ganttZoom: this.ganttZoom(), ganttCompletion: this.ganttCompletion(), ganttOrder: this.ganttOrder(), ganttRange: this.ganttRange(), calendarDate: this.calendarDate(), calendarScrollHour: this.calendarScrollHour(), calendarExpandAll: this.calendarExpandAll()}) : undefined;
        this.browseGeneration = generation;
        this.browseContext = context;
        this.restoreBrowse(loadBrowseState(generation, workspace, fallback), sameGeneration);
      });
      const state = this.browseSnapshot();
      untracked(() => saveBrowseState(generation, workspace, state));
      if (this.store.currentWorkspace().headerCompact === undefined && state.headerCompact) untracked(() => {
        void this.store.setWorkspaceHeaderCompact(true, workspace, generation, true);
      });
    });
    effect(() => {
      this.boardTaskDrag(); this.ganttContext(); this.store.tasks(); this.store.pendingWrites(); this.view(); this.modal(); this.trashOpen(); this.overviewOpen(); this.ganttLockedTaskIds();
      untracked(() => {if (this.boardTaskDrag() && !this.boardDragValid()) this.endBoardTaskDrag();});
    });
    const timer = setInterval(() => this.now.set(new Date()), 30000);
    effect(() => {
      const source = this.taskLinkSource(), generation = this.store.generation(), workspace = this.store.currentWorkspace(), view = this.view(), modal = this.modal();
      untracked(() => {if (source && (generation !== source.generation || workspace.id !== source.workspaceId || view !== this.taskLinkView || !!modal || JSON.stringify(workspace.tasks.find(task => task.id === source.original?.id)) !== JSON.stringify(source.original))) this.cancelTaskLink();});
    });
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  private validProjectFilter(id: string): string { return id === '' || id === 'all' || this.store.projects().some(project => project.id === id) ? id : 'all'; }
  private validCategoryFilter(id: string): string { return id === '' || id === 'all' || this.store.categories().some(category => category.id === id) ? id : 'all'; }
  private browseSnapshot(): BrowseState {
    return {overviewOpen: this.overviewOpen(), overviewProject: this.overviewProject(), overviewArchived: this.overviewArchived(), overviewSelection: this.overviewSelection(), view: this.view(), scope: this.scope(), query: this.query(), project: this.projectFilter(), category: this.categoryFilter(), priority: this.priorityFilter(), pinnedOnly: this.pinnedOnly(), recentOnly: this.recentOnly(), deadline: this.deadlineFilter(), deadlineDays: this.deadlineDays(), sort: this.sortKey(), direction: this.sortDirection(), ganttDate: this.ganttDate(), ganttScale: this.ganttScale(), ganttZoom: this.ganttZoom(), ganttCompletion: this.ganttCompletion(), ganttOrder: this.ganttOrder(), ganttRange: this.ganttRange(), ganttStatuses: this.ganttStatuses(), ganttCategories: this.ganttCategories(), calendarDate: this.calendarDate(), calendarScrollHour: this.calendarScrollHour(), calendarExpandAll: this.calendarExpandAll(), showOrbit: this.calendarShowOrbit(), showGoogle: this.calendarShowGoogle(), progressExpanded: this.progressExpanded(), headerCompact: this.headerCompact(), trashOpen: this.trashOpen(), panel: this.filesOpen() ? 'files' : this.tasksOpen() ? 'tasks' : this.mailOpen() ? 'gmail' : this.remindersOpen() ? 'reminders' : 'closed', panelTab: this.panelTab(), reminderTab: this.reminderTab()};
  }
  private restoreBrowse(state: BrowseState, preserveSharedControls = false): void {
    this.overviewReturnContext = undefined; this.overviewPage.set(0); this.overviewScroll.set(0);
    if (!this.modal() || this.modal() === 'overview-list') this.modal.set(state.overviewOpen && state.overviewSelection ? 'overview-list' : null);
    this.overviewOpen.set(state.overviewOpen); this.overviewProject.set(state.overviewProject); this.overviewArchived.set(state.overviewArchived); this.overviewSelection.set(state.overviewSelection);
    this.view.set(state.view); this.scope.set(state.scope); this.query.set(state.query);
    this.projectFilter.set(this.validProjectFilter(state.project)); this.categoryFilter.set(this.validCategoryFilter(state.category));
    this.priorityFilter.set(state.priority); this.deadlineFilter.set(state.deadline); this.deadlineDays.set(state.deadlineDays);
    this.pinnedOnly.set(state.pinnedOnly); this.recentOnly.set(state.recentOnly);
    this.sortKey.set(state.sort); this.sortDirection.set(state.direction); this.progressExpanded.set(state.progressExpanded);
    this.legacyHeaderCompact.set(state.headerCompact); this.trashOpen.set(state.trashOpen);
    this.calendarDate.set(state.calendarDate); this.calendarScrollHour.set(state.calendarScrollHour); this.calendarExpandAll.set(state.calendarExpandAll);
    this.ganttDate.set(state.ganttDate); this.ganttScale.set(state.ganttScale);
    this.ganttZoom.set(state.ganttZoom); this.ganttCompletion.set(state.ganttCompletion); this.ganttOrder.set(state.ganttOrder); this.ganttRange.set(state.ganttRange);
    this.ganttStatuses.set(state.ganttStatuses.filter(id => this.statuses().some(status => status.id === id)));
    this.ganttCategories.set(state.ganttCategories.filter(id => id === '' || this.store.categories().some(category => category.id === id)));
    if (!preserveSharedControls) {
      this.calendarShowOrbit.set(state.showOrbit); this.calendarShowGoogle.set(state.showGoogle);
      this.filesOpen.set(state.panel === 'files'); this.mailOpen.set(state.panel === 'gmail'); this.remindersOpen.set(state.panel === 'reminders'); this.tasksOpen.set(state.panel === 'tasks'); this.reminderTab.set(state.reminderTab);
      this.panelTab.set(state.panel === 'closed' ? state.panelTab : state.panel);
    }
  }
  openCalendarWeek(date: string): void {
    if (!date || !validDate(date)) return;
    this.calendarDate.set(date); this.calendarScrollHour.set(7.75); this.view.set('week');
  }

  openCalendarMonth(date: string): void {
    if (!date || !validDate(date)) return;
    this.calendarDate.set(date); this.view.set('month');
  }

  @HostListener('window:pagehide')
  rememberBrowse(): void { saveBrowseState(this.store.generation(), this.store.currentWorkspace().id, this.browseSnapshot()); }

  @HostListener('window:focus')
  updateNow(): void { this.now.set(new Date()); }

  openSettings(tab: SettingsTab = 'appearance'): void {
    this.settingsTab.set(tab); this.sidebarOpen.set(false); this.modal.set('settings');
  }

  selectDeadline(value: DeadlineFilter): void {
    if (!['all', 'unset', 'overdue', 'due-soon', 'this-week'].includes(value)) return;
    this.deadlineFilter.set(value);
    if (value === 'all') this.deadlineDays.set(null);
    if (value !== 'all') {
      if (value !== 'unset') this.scope.set('active');
      this.sortKey.set(null);
    }
  }

  selectDueSoonDays(days: number): void {
    if (!Number.isInteger(days) || days < 1 || days > 30) return;
    this.deadlineDays.set(days); this.selectDeadline('due-soon');
  }
  selectDeadlineOption(value: string): void {
    if (value.startsWith('due-') && value !== 'due-soon') { const days = Number(value.slice(4)); if (DUE_DAY_PRESETS.includes(days)) this.selectDueSoonDays(days); }
    else if (['all', 'unset', 'overdue', 'due-soon', 'this-week'].includes(value)) { this.deadlineDays.set(null); this.selectDeadline(value as DeadlineFilter); }
  }
  openReminders(tab: ReminderTab = 'today'): void {
    if (this.modal()) return;
    this.reminderTab.set(tab); this.sidebarOpen.set(false); this.filesOpen.set(false); this.mailOpen.set(false); this.tasksOpen.set(false); this.remindersOpen.set(true); this.panelTab.set('reminders');
  }
  toggleReminders(): void {
    if (this.modal()) return;
    if (this.remindersOpen()) this.remindersOpen.set(false);
    else this.openReminders();
  }
  systemNotificationNotice(message: string): void {this.notify(message);}
  openReminder(item: ReminderItem): void {
    if (this.modal()) return;
    if (item.generation !== this.store.generation()) return;
    const workspace = this.store.workspaces().find(workspace => workspace.id === item.workspaceId);
    if (!workspace) {this.notify('原工作空間已不存在，請重新查看提醒。'); return;}
    if (item.external) {
      const source = this.store.google().sources.find(source => source.id === item.external!.source.id);
      if (!source?.visible || !source.workspaceIds.includes(item.workspaceId) || source.accountId !== this.store.google().accountId) return;
      this.store.switchWorkspace(workspace.id); this.openExternalEvent(item.external);
    } else {
      const task = workspace.tasks.find(task => task.id === item.task.id && !task.deletedAt);
      const active = task && workspace.statuses.find(status => status.id === task.status)?.kind === 'active';
      if (task && (item.historical || active)) {this.store.switchWorkspace(workspace.id); this.openTask(task.status, task);}
    }
  }
  async adjustGanttSchedule(change: {task: Task; original: Task; context: string}): Promise<void> {
    if (this.modal() || this.store.pendingWrites() || change.context !== this.ganttContext()) return;
    const context = {...this.store.taskContext(change.original.id), original: change.original};
    const result = await this.store.saveTask(change.task, context);
    if (this.handleResult(result)) this.notify(result.persisted ? '任務時程已更新，可復原。' : '變更只暫存在此分頁，請匯出備份。');
  }
  showReminderDeadline(days: number): void {
    this.overviewOpen.set(false);
    this.clearFilters(); this.selectDueSoonDays(days); this.view.set('list');
  }

  @HostListener('document:keydown.escape')
  escape(): void {
    if (this.taskLinkPickerOpen()) {this.cancelTaskLinkPicker(); return;}
    if (this.taskLinkSource()) {this.cancelTaskLink(); return;}
    if (this.boardTaskDrag()) {this.endBoardTaskDrag(); return;}
    if (this.sourcePanelDragging()) {this.cancelSourceDrag(); return;}
    if (this.documentLinksEditor()?.pickerOpen()) {this.documentLinksEditor()?.cancelPicker(); return;}
    if (this.projectToDelete()) this.projectToDelete.set(null);
    else if (this.statusToDelete()) this.statusToDelete.set(null);
    else if (this.workspaceToDelete()) this.workspaceToDelete.set(null);
    else if (this.categoryToDelete()) this.categoryToDelete.set(null);
    else if (this.modal() === 'task') return;
    else if (this.modal()) this.closeModal();
    else if (this.sidebarOpen()) this.sidebarOpen.set(false);
    else if (this.panelOpen()) this.closePanel();
    else this.sidebarOpen.set(false);
  }

  @HostListener('window:resize')
  resize(): void {
    this.panelViewportWidth.set(window.innerWidth);
    this.mobileViewport.set(window.innerWidth <= 700);
    this.panelOverlay.set(window.innerWidth <= 700);
    this.narrowPanelViewport.set(window.innerWidth <= 1100);
    if (!this.compactNavigation()) this.sidebarOpen.set(false);
  }

  toggleSidebar(): void {
    if (this.modal()) return;
    if (this.compactNavigation()) this.sidebarOpen.update(open => !open);
    else {this.sidebarOpen.set(false); this.sidebarCollapsed.update(collapsed => !collapsed);}
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
    this.overviewOpen.set(false);
    this.trashOpen.set(false);
    this.clearFilters();
    this.projectFilter.set(id);
  }

  priorityLabel(priority: Priority): string {
    return PRIORITIES.find(item => item.id === priority)?.label ?? '';
  }

  priorityShortLabel(priority: Priority): string {
    return {low: '低', medium: '中', high: '高'}[priority] ?? '';
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

  openBoardHome(): void {
    if (this.modal()) return;
    this.overviewOpen.set(false); this.overviewSelection.set(null);
    this.overviewPage.set(0); this.overviewScroll.set(0); this.overviewReturnContext = undefined;
    this.clearFilters(); this.view.set('board'); this.sidebarOpen.set(false);
  }

  selectScope(scope: TaskScope): void {
    this.overviewOpen.set(false);
    this.trashOpen.set(false);
    if (scope === 'all') this.projectFilter.set('all');
    this.scope.set(scope);
    this.deadlineFilter.set('all');
    this.deadlineDays.set(null);
    this.categoryFilter.set('all');
    this.sidebarOpen.set(false);
    if (scope === 'archived' && (this.view() === 'month' || this.view() === 'week')) this.view.set('list');
  }

  selectCategory(id: string): void {
    this.overviewOpen.set(false);
    this.trashOpen.set(false);
    this.categoryFilter.set(id);
    this.scope.set('all');
    this.deadlineFilter.set('all');
    this.deadlineDays.set(null);
    this.sidebarOpen.set(false);
  }

  clearFilters(): void {
    this.trashOpen.set(false);
    this.query.set('');
    this.categoryFilter.set('all');
    this.projectFilter.set('all');
    this.priorityFilter.set('all');
    this.pinnedOnly.set(false);
    this.recentOnly.set(false);
    this.deadlineFilter.set('all');
    this.deadlineDays.set(null);
    this.scope.set('all');
  }

  openTask(status: TaskStatus = 'todo', task?: Task, date = ''): void {
    if (this.taskLinkSource()) {if (task) void this.linkSelectedTask(task); else this.notify('請先選擇要連結的任務，或取消建立連結。'); return;}
    if (Date.now() - this.dragEndedAt < 200) return;
    const conflict = task && this.store.taskConflicts().find(entry => entry.workspace.id === this.store.currentWorkspace().id && entry.conflict.id === task.id);
    if (conflict) {if (!this.modal()) this.openTaskConflict(conflict); else this.notify('此任務有同步衝突，草稿仍保留。請關閉後重新開啟，比較與編輯完整版本。'); return;}
    if (task?.deletedAt) { this.openTrash(); return; }
    if (!task) this.trashOpen.set(false);
    const initialStatus = this.statuses().some(item => item.id === status) ? status : this.statuses().find(item => item.kind === 'active')?.id ?? this.statuses()[0].id;
    this.draft = task ? structuredClone(task) : this.emptyTask(initialStatus);
    if (!task && this.overviewOpen()) {
      const selected = this.overviewProject();
      this.draft.projectId = selected === '' ? '' : this.store.projects().some(project => project.id === selected && (!project.archived || this.overviewArchived())) ? selected : this.store.projects().find(project => !project.archived)?.id ?? '';
    }
    this.draftDocuments.set(task ? structuredClone(this.store.documentsForTask(task.id)) : []);
    this.draftRelatedTasks.set(task ? [...this.store.relatedTaskIds(task.id)] : []);
    this.draftDocumentDescriptions.set(task ? structuredClone(this.store.descriptionsForTask(task.id)) : []);
    this.taskEditContext.set(this.store.taskContext(this.draft.id));
    if (!task && !this.overviewOpen() && this.categoryFilter() !== 'all') this.draft.categoryId = this.categoryFilter();
    this.editing.set(!!task);
    this.documentCreationPrompt.set(false);
    this.descriptionFocused.set(false);
    this.taskEditorExpanded.set(false);
    this.formError.set('');
    this.subtaskDraft = '';
    this.hasStartTime = !!this.draft.startTime;
    this.hasDueTime = !!this.draft.dueTime;
    if (!task && date) {
      this.draft.startDate = date;
      this.draft.dueDate = date;
    }
    this.modal.set('task');
    this.startLocalTaskDraft();
  }

  async saveTask(publish = false, createDocument = false): Promise<void> {
    if (this.store.pendingWrites() || this.taskLinkPickerOpen()) return;
    const documents = this.documentLinksEditor();
    if (documents?.hasDraft() && !documents.add()) {this.formError.set('請先確認文件名稱與連結。'); return;}
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
    if (publish && this.relatedDraftUnchanged() && JSON.stringify(saved) === JSON.stringify(this.taskEditContext()?.original) && JSON.stringify(this.draftDocuments().map(source => ({documentId: source.id, description: this.draftDocumentDescriptions().find(item => item.documentId === source.id)?.description ?? ''}))) === taskInformationKey(this.store.state(), saved.id) && !this.store.hasUnsavedChanges()) {
      this.store.refreshFromStorage();
      if (this.taskDraftConflict()) { this.formError.set('任務已更新，請載入最新版本再移轉。'); return; }
      this.draft = structuredClone(saved); this.modal.set('calendar-publish'); return;
    }
    const result = await this.store.saveTask(saved, this.taskEditContext()!, undefined, this.draftDocuments(), this.draftDocumentDescriptions(), this.draftRelatedTasks());
    if (!this.handleResult(result)) return;
    if (result.persisted) this.clearLocalTaskDraft();
    if (createDocument) {
      if (!result.persisted) {this.formError.set('任務尚未成功保存，未建立雲端文件。請先匯出備份並確認本機儲存。'); return;}
      this.refreshDocumentTaskDraft(); this.documentCreationPrompt.set(false); await this.openDocumentCreation(); return;
    }
    const hidden = !this.overviewOpen() && !this.visibleTasks().some(task => task.id === this.draft.id);
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

  async requestDocumentCreation(): Promise<void> {
    if (this.store.pendingWrites() || this.taskLinkPickerOpen() || this.modal() !== 'task') return;
    if (this.taskDraftConflict()) {this.formError.set('任務已更新，請先載入最新版本再建立文件。'); return;}
    const context = this.taskEditContext(), information = this.draftDocuments().map(source => ({documentId: source.id, description: this.draftDocumentDescriptions().find(item => item.documentId === source.id)?.description ?? ''}));
    if (context?.original && this.relatedDraftUnchanged() && JSON.stringify(this.draft) === JSON.stringify(context.original) && JSON.stringify(information) === context.informationKey && !this.subtaskDraft.trim() && !this.documentLinksEditor()?.hasDraft() && !this.store.hasUnsavedChanges()) {await this.openDocumentCreation(); return;}
    this.documentCreationPrompt.set(true);
  }

  private refreshDocumentTaskDraft(): void {
    const task = this.store.currentWorkspace().tasks.find(task => task.id === this.draft.id && !task.deletedAt);
    if (!task) return;
    this.draft = structuredClone(task); this.draftDocuments.set(structuredClone(this.store.documentsForTask(task.id)));
    this.draftRelatedTasks.set([...this.store.relatedTaskIds(task.id)]);
    this.draftDocumentDescriptions.set(structuredClone(this.store.descriptionsForTask(task.id))); this.taskEditContext.set(this.store.taskContext(task.id)); this.editing.set(true);
    this.clearLocalTaskDraft(); this.startLocalTaskDraft();
  }

  private async openDocumentCreation(): Promise<void> {
    const context = this.taskEditContext(); if (!context?.original || this.modal() !== 'task') return;
    const request = ++this.documentCreationRequest;
    try {
      const [{Dialog}, {DocumentCreateDialog}] = await Promise.all([import('@angular/cdk/dialog'), import('./document-create-dialog')]);
      if (request !== this.documentCreationRequest || this.modal() !== 'task' || this.taskEditContext() !== context || this.taskDraftConflict()) return;
      const ref = this.injector.get(Dialog).open(DocumentCreateDialog, {data: {context: structuredClone(context)}, injector: this.injector, width: 'min(620px, calc(100vw - 24px))', maxHeight: 'calc(100dvh - 32px)', panelClass: 'information-picker-dialog', ariaLabel: '建立文件並連結任務', ariaModal: true, autoFocus: '.create-cancel', disableClose: true});
      ref.closed.subscribe(() => {if (this.modal() === 'task' && this.draft.id === context.original?.id && this.store.generation() === context.generation) this.refreshDocumentTaskDraft();});
    } catch {this.formError.set('無法開啟文件建立視窗，已儲存的任務保留。請重試。');}
  }

  reloadTaskDraft(): void {
    const context = this.taskEditContext();
    const task = this.store.workspaces().find(workspace => workspace.id === context?.workspaceId)?.tasks.find(task => task.id === context?.original?.id);
    if (!task || !context) { this.formError.set('原任務已不存在，可以將草稿另存為新任務。'); return; }
    if (!this.clearLocalTaskDraft()) return;
    this.store.switchWorkspace(context.workspaceId);
    this.openTask(task.status, task);
  }

  async saveTaskDraftAsNew(): Promise<void> {
    if (this.store.pendingWrites()) return;
    this.draft = {...this.draft, id: crypto.randomUUID(), subtasks: this.draft.subtasks.map(subtask => ({...subtask, id: crypto.randomUUID()}))};
    this.draftRelatedTasks.update(ids => ids.filter(id => this.store.tasks().some(task => task.id === id && !task.deletedAt)));
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
    const other = kind === 'start' ? adjacentHour(this.draft.dueDate, this.draft.dueTime, -1) : adjacentHour(this.draft.startDate, this.draft.startTime, 1);
    if (kind === 'start') {
      this.hasStartTime = enabled;
      if (enabled && !this.draft.startTime && other && (!this.draft.startDate || this.draft.startDate === this.draft.dueDate)) this.draft.startDate = other.date;
      this.draft.startTime = enabled ? this.draft.startTime || other?.time || '09:00' : '';
    } else {
      this.hasDueTime = enabled;
      if (enabled && !this.draft.dueTime && other && (!this.draft.dueDate || this.draft.dueDate === this.draft.startDate)) this.draft.dueDate = other.date;
      this.draft.dueTime = enabled ? this.draft.dueTime || other?.time || '18:00' : '';
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
    this.flushLocalTaskDraft();
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
    this.notifySaved('任務已移至垃圾桶，可還原');
  }

  openTrash(): void { if (!this.modal()) { this.trashOpen.set(true); this.sidebarOpen.set(false); } }

  async restoreTrashedTask(task: Task): Promise<void> {
    if (this.modal() || this.store.pendingWrites()) return;
    const context = {...this.store.taskContext(task.id), original: structuredClone(task)};
    if (this.handleResult(await this.store.restoreTask(task.id, context))) this.notifySaved('任務已還原');
  }

  requestPurgeTask(task: Task): void {
    if (this.modal() || this.store.pendingWrites()) return;
    this.store.refreshFromStorage();
    const context = this.store.taskContext(task.id);
    if (!context.original?.deletedAt || JSON.stringify(context.original) !== JSON.stringify(task)) {this.notify('垃圾桶中的任務已更新或移除，請重新查看後再刪除。'); return;}
    this.taskPurgeContext.set({...context, original: context.original, workspaceName: this.store.currentWorkspace().name});
    this.formError.set(''); this.modal.set('purge-task');
  }

  async purgeTask(): Promise<void> {
    const context = this.taskPurgeContext();
    if (!context || this.modal() !== 'purge-task' || this.store.pendingWrites()) return;
    if (!this.handleResult(await this.store.purgeTask(context.original.id, context))) return;
    this.closeModal(); this.notifySaved('任務已徹底刪除');
  }

  requestEmptyTrash(): void {
    if (this.modal() || this.store.pendingWrites()) return;
    this.store.refreshFromStorage();
    const context = this.store.trashContext();
    if (!context.tasks.length) return;
    this.emptyTrashContext.set(context); this.formError.set(''); this.modal.set('empty-trash');
  }

  async emptyTrash(): Promise<void> {
    const context = this.emptyTrashContext();
    if (!context || this.store.pendingWrites()) return;
    if (!this.handleResult(await this.store.emptyTrash(context))) return;
    this.closeModal(); this.notifySaved('垃圾桶已清空');
  }

  async undoLastAction(): Promise<void> {
    if (this.modal() || this.store.pendingWrites() || !this.store.canUndo()) return;
    const label = this.store.undoLabel();
    if (this.handleResult(await this.store.undo())) this.notifySaved('已復原：' + label);
  }

  async redoLastAction(): Promise<void> {
    if (this.modal() || this.store.pendingWrites() || !this.store.canRedo()) return;
    const label = this.store.redoLabel();
    if (this.handleResult(await this.store.redo())) this.notifySaved('已重做：' + label);
  }

  async toggleWorkspaceHeader(): Promise<void> {
    if (this.modal() || this.store.pendingWrites()) return;
    this.handleResult(await this.store.setWorkspaceHeaderCompact(!this.headerCompact()));
  }

  @HostListener('document:keydown', ['$event'])
  undoKey(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    const key = event.key.toLowerCase();
    const redo = key === 'z' && event.shiftKey || key === 'y' && event.ctrlKey && !event.metaKey && !event.shiftKey;
    if (event.defaultPrevented || event.altKey || !(event.metaKey || event.ctrlKey) || key !== 'z' && !redo) return;
    if (this.modal() || this.sidebarOpen() || this.panelOverlay() && this.panelOpen() || target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')) return;
    if (!(redo ? this.store.canRedo() : this.store.canUndo()) || this.store.pendingWrites()) return;
    event.preventDefault(); void (redo ? this.redoLastAction() : this.undoLastAction());
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
  googleAuthorizationResult(message: string): void {this.notify(message);}

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
    this.firstWorkspaceDialog.set(this.store.onboarding() === 'workspace');
    this.workspaceExamples = !this.firstWorkspaceDialog();
    this.workspaceEditingId.set('');
    this.workspaceToDelete.set(null);
    this.formError.set('');
    this.modal.set('workspaces');
  }

  openIntroduction(): void {
    if (this.modal() || this.introSaving() || this.workspaceSaving()) return;
    this.introFirstUse.set(false); this.formError.set(''); this.modal.set('intro');
  }

  async finishIntroduction(): Promise<void> {
    if (this.modal() !== 'intro') return;
    if (!this.introFirstUse()) { this.closeModal(); return; }
    if (this.introSaving() || this.store.pendingWrites()) return;
    this.introSaving.set(true); this.formError.set('');
    try {
      const result = await this.store.finishIntroduction();
      if (!this.handleResult(result)) { this.store.refreshFromStorage(); return; }
      this.openWorkspaces();
    } finally { this.introSaving.set(false); }
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
    const first = this.firstWorkspaceDialog();
    if (!first && this.store.workspaces().some(workspace => workspace.id !== this.workspaceEditingId() && workspace.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      this.formError.set('此工作空間名稱已存在。');
      return;
    }
    const editing = !!this.workspaceEditingId();
    this.workspaceSaving.set(true);
    let saved: StoreResult;
    const options = {templateId: this.workspaceTemplateId(), includeExamples: this.workspaceExamples};
    try { saved = await (first ? this.store.createFirstWorkspace(name, options) : this.store.saveWorkspace(this.workspaceEditingId(), name, options)); }
    finally { this.workspaceSaving.set(false); }
    if (!this.handleResult(saved)) return;
    if (!editing) { this.clearFilters(); this.sortKey.set(null); }
    this.sidebarOpen.set(false);
    this.closeModal();
    this.notifySaved(editing ? '工作空間已改名' : first ? '第一個工作空間已建立' : '工作空間已建立，並已加入同名專案');
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
    if (!this.firstWorkspaceDialog()) this.editWorkspace(this.store.currentWorkspace());
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

  startBackdropClick(event: PointerEvent): void {
    this.backdropClick = event.target === event.currentTarget && event.button === 0 && event.isPrimary !== false
      ? {pointerId: event.pointerId, x: event.clientX, y: event.clientY, released: false} : undefined;
  }
  finishBackdropClick(event: PointerEvent): void {
    const start = this.backdropClick;
    if (!start || start.pointerId !== event.pointerId || event.target !== event.currentTarget || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) this.backdropClick = undefined;
    else start.released = true;
  }
  cancelBackdropClick(): void {this.backdropClick = undefined;}
  closeFromBackdrop(event: MouseEvent): void {
    const close = this.backdropClick?.released && event.target === event.currentTarget;
    this.cancelBackdropClick();
    if (close && this.modal() !== 'task') this.closeModal();
  }

  closeModal(): void {
    if (this.introSaving() || this.workspaceSaving() || this.conflictSaving() || this.logoutSaving()) return;
    if (this.modal() === 'intro' && this.introFirstUse() && this.store.onboarding() === 'guide') { void this.finishIntroduction(); return; }
    if (this.calendarPublishing()) return;
    if (this.modal() === 'settings' && this.store.pendingWrites() > 0) return;
    if (this.modal() === 'purge-task' && this.store.pendingWrites() > 0) return;
    this.cancelTaskLinkPicker();
    const current = this.modal(), context = this.overviewReturnContext;
    const returnToOverview = current !== 'overview-list' && !!context && context.workspaceId === this.store.currentWorkspace().id
      && context.generation === this.store.generation() && this.overviewOpen() && !!this.overviewSelection();
    this.flushLocalTaskDraft();
    this.cancelBackdropClick();
    this.documentCreationRequest++; this.documentCreationPrompt.set(false);
    this.modal.set(returnToOverview ? 'overview-list' : null);
    if (!returnToOverview) {
      this.overviewReturnContext = undefined;
      if (current === 'overview-list') {this.overviewSelection.set(null); this.overviewPage.set(0); this.overviewScroll.set(0);}
    }
    this.conflictContext.set(null);
    this.introFirstUse.set(false);
    this.firstWorkspaceDialog.set(false);
    this.descriptionFocused.set(false);
    this.taskEditorExpanded.set(false);
    this.mailPreview.set(null);
    this.externalEntry.set(null);
    this.categoryToDelete.set(null);
    this.taskToDelete.set(null);
    this.emptyTrashContext.set(null);
    this.taskPurgeContext.set(null);
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
