import { effect, inject, Injectable, OnDestroy, signal, untracked } from '@angular/core';
import { BoardStore, TaskEditContext } from './board-store';
import { GmailService } from './gmail-service';
import { GMAIL_MIME, MailPreview, MailSchedule, mailTask } from './gmail-data';
import type { Task } from './models';
import { createMailDragPreview } from './mail-drag-preview';

interface MailDrag {token: string; mail: MailPreview; email: string; accountId: string; workspaceId: string; generation: string}
interface MailBoardPosition {status: string; beforeId?: string}
@Injectable({providedIn: 'root'})
export class MailTasks implements OnDestroy {
  readonly store = inject(BoardStore);
  readonly gmail = inject(GmailService);
  readonly dragging = signal(false);
  readonly boardPosition = signal<MailBoardPosition | null>(null);
  readonly busy = signal(false);
  readonly notice = signal('');
  readonly undoContext = signal<TaskEditContext | null>(null);
  private drag?: MailDrag;
  private clearDragPreview?: () => void;
  constructor() {
    effect(() => {
      const generation = this.store.generation(), workspace = this.store.currentWorkspace().id, account = this.gmail.preferences().accountId;
      untracked(() => { if (this.drag && (this.drag.generation !== generation || this.drag.workspaceId !== workspace || this.drag.accountId !== account)) this.end(); });
    });
  }
  start(event: DragEvent, mail: MailPreview): void {
    if (!event.dataTransfer || this.busy() || !this.gmail.preferences().accountId || !this.gmail.isListed(mail)) { event.preventDefault(); return; }
    this.end();
    const preferences = this.gmail.preferences();
    this.drag = {token: crypto.randomUUID(), mail: structuredClone(mail), email: preferences.email, accountId: preferences.accountId, workspaceId: this.store.currentWorkspace().id, generation: this.store.generation()};
    event.dataTransfer.effectAllowed = 'copy'; event.dataTransfer.setData(GMAIL_MIME, this.drag.token);
    this.clearDragPreview = createMailDragPreview(event, mail, () => this.end()); this.dragging.set(true);
  }
  end(): void { const clearPreview = this.clearDragPreview; this.clearDragPreview = undefined; this.drag = undefined; this.dragging.set(false); this.boardPosition.set(null); clearPreview?.(); }
  ngOnDestroy(): void { this.end(); }
  accepts(event: DragEvent): boolean {
    return !!this.drag && !this.busy() && !!event.dataTransfer?.types.includes(GMAIL_MIME) && this.drag.generation === this.store.generation() && this.drag.workspaceId === this.store.currentWorkspace().id && this.drag.accountId === this.gmail.preferences().accountId;
  }
  over(event: DragEvent): boolean {
    if (!this.accepts(event)) return false;
    event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; return true;
  }
  async drop(event: DragEvent, base: Task, schedule: MailSchedule = {}, beforeId?: string): Promise<void> {
    if (!this.accepts(event) || event.dataTransfer?.getData(GMAIL_MIME) !== this.drag?.token) return;
    event.preventDefault(); event.stopPropagation(); const drag = this.drag!; this.end();
    await this.create(drag.mail, drag.email, base, schedule, {workspaceId: drag.workspaceId, generation: drag.generation, original: null}, beforeId);
  }
  draft(mail: MailPreview, base: Task, source?: {identity: string; email: string}): Task {
    if (source) {
      if (source.identity !== this.gmail.previewIdentity() || source.email !== this.gmail.preferences().email) throw new Error('Gmail 帳號已變更，請重新選擇郵件。');
    } else if (!this.gmail.isListed(mail)) throw new Error('郵件列表已更新，請重新選擇。');
    return mailTask(mail, source?.email ?? this.gmail.preferences().email, base);
  }
  private async create(mail: MailPreview, email: string, base: Task, schedule: MailSchedule, context: TaskEditContext, beforeId?: string): Promise<void> {
    if (this.busy()) return; this.busy.set(true); this.undoContext.set(null); this.notice.set('');
    try {
      const task = mailTask(mail, email, base, schedule), result = await this.store.saveTask(task, context, beforeId);
      if (!result.ok) { this.notice.set(result.message); return; }
      const saved = this.store.workspaces().find(workspace => workspace.id === context.workspaceId)?.tasks.find(item => item.id === task.id);
      this.undoContext.set(saved ? {...context, original: structuredClone(saved)} : null);
      this.notice.set(result.persisted ? `已建立「${task.title}」${schedule.time ? '，時段為一小時' : schedule.date ? '，已安排全天' : ''}。` : '任務只暫存在此分頁，請匯出備份。');
    } catch (error) { this.notice.set(error instanceof Error ? error.message : '未能建立任務，請重試。'); }
    finally { this.busy.set(false); }
  }
  async undo(): Promise<void> {
    const context = this.undoContext(); if (!context?.original || this.busy()) return;
    this.busy.set(true);
    try {
      const result = await this.store.cancelTaskCreation(context);
      if (result.ok) { this.undoContext.set(null); this.notice.set(result.persisted ? '已撤銷任務建立。' : '已撤銷任務建立，變更只暫存在此分頁。'); }
      else { this.undoContext.set(null); this.notice.set(result.message); }
    } finally { this.busy.set(false); }
  }
  dismiss(): void { this.notice.set(''); this.undoContext.set(null); }
}
