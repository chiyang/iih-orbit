import { effect, inject, Injectable, signal, untracked } from '@angular/core';
import { BoardStore, TaskEditContext } from './board-store';
import { GmailService } from './gmail-service';
import { GMAIL_MIME, MailPreview, MailSchedule, mailTask } from './gmail-data';
import type { Task } from './models';

interface MailDrag {token: string; mail: MailPreview; email: string; accountId: string; workspaceId: string; generation: string}
@Injectable({providedIn: 'root'})
export class MailTasks {
  readonly store = inject(BoardStore);
  readonly gmail = inject(GmailService);
  readonly dragging = signal(false);
  readonly busy = signal(false);
  readonly notice = signal('');
  readonly undoContext = signal<TaskEditContext | null>(null);
  private drag?: MailDrag;
  constructor() {
    effect(() => {
      const generation = this.store.generation(), workspace = this.store.currentWorkspace().id, account = this.gmail.preferences().accountId;
      untracked(() => { if (this.drag && (this.drag.generation !== generation || this.drag.workspaceId !== workspace || this.drag.accountId !== account)) this.end(); });
    });
  }
  start(event: DragEvent, mail: MailPreview): void {
    if (!event.dataTransfer || this.busy() || !this.gmail.preferences().accountId || !this.gmail.isListed(mail)) { event.preventDefault(); return; }
    const preferences = this.gmail.preferences();
    this.drag = {token: crypto.randomUUID(), mail: structuredClone(mail), email: preferences.email, accountId: preferences.accountId, workspaceId: this.store.currentWorkspace().id, generation: this.store.generation()};
    event.dataTransfer.effectAllowed = 'copy'; event.dataTransfer.setData(GMAIL_MIME, this.drag.token);
    this.setDragImage(event, mail.subject); this.dragging.set(true);
  }
  private setDragImage(event: DragEvent, subject: string): void {
    const source = event.currentTarget as HTMLElement | null;
    if (!source?.ownerDocument || !event.dataTransfer?.setDragImage) return;
    try {
      const canvas = source.ownerDocument.createElement('canvas'), context = canvas.getContext('2d');
      if (!context) return;
      // Transparent padding leaves the pointer clear without relying on negative hotspots.
      canvas.width = 220; canvas.height = 52;
      const style = source.ownerDocument.defaultView?.getComputedStyle(source);
      context.globalAlpha = .5;
      context.fillStyle = style?.getPropertyValue('--surface').trim() || '#ffffff';
      context.strokeStyle = style?.getPropertyValue('--border').trim() || '#d5dce3';
      context.beginPath(); context.roundRect(18.5, 18.5, 201, 33, 7); context.fill(); context.stroke();
      context.globalAlpha = .72;
      context.strokeStyle = style?.getPropertyValue('--accent-text').trim() || '#267451';
      context.lineWidth = 1.5;
      context.strokeRect(29, 29, 14, 10);
      context.beginPath(); context.moveTo(29, 29); context.lineTo(36, 34); context.lineTo(43, 29); context.stroke();
      const fontSize = Math.min(16, Math.max(12, parseFloat(style?.fontSize || '') || 14));
      context.font = `500 ${fontSize}px ${style?.fontFamily || 'sans-serif'}`;
      context.fillStyle = style?.getPropertyValue('--text').trim() || '#24342c'; context.textBaseline = 'middle';
      const letters = Array.from(subject.replace(/\s+/g, ' ').trim() || '未命名郵件');
      let label = letters.slice(0, 80).join(''), shortened = letters.length > 80;
      while (label && context.measureText(label + (shortened ? '…' : '')).width > 154) { label = Array.from(label).slice(0, -1).join(''); shortened = true; }
      context.fillText(label + (shortened ? '…' : ''), 54, 35);
      event.dataTransfer.setDragImage(canvas, 0, 0);
    } catch { /* Keep native dragging available if the browser cannot draw a custom preview. */ }
  }
  end(): void { this.drag = undefined; this.dragging.set(false); }
  accepts(event: DragEvent): boolean {
    return !!this.drag && !this.busy() && !!event.dataTransfer?.types.includes(GMAIL_MIME) && this.drag.generation === this.store.generation() && this.drag.workspaceId === this.store.currentWorkspace().id && this.drag.accountId === this.gmail.preferences().accountId;
  }
  over(event: DragEvent): boolean {
    if (!this.accepts(event)) return false;
    event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; return true;
  }
  async drop(event: DragEvent, base: Task, schedule: MailSchedule = {}): Promise<void> {
    if (!this.accepts(event) || event.dataTransfer?.getData(GMAIL_MIME) !== this.drag?.token) return;
    event.preventDefault(); event.stopPropagation(); const drag = this.drag!; this.end();
    await this.create(drag.mail, drag.email, base, schedule, {workspaceId: drag.workspaceId, generation: drag.generation, original: null});
  }
  draft(mail: MailPreview, base: Task, source?: {identity: string; email: string}): Task {
    if (source) {
      if (source.identity !== this.gmail.previewIdentity() || source.email !== this.gmail.preferences().email) throw new Error('Gmail 帳號已變更，請重新選擇郵件。');
    } else if (!this.gmail.isListed(mail)) throw new Error('郵件列表已更新，請重新選擇。');
    return mailTask(mail, source?.email ?? this.gmail.preferences().email, base);
  }
  private async create(mail: MailPreview, email: string, base: Task, schedule: MailSchedule, context: TaskEditContext): Promise<void> {
    if (this.busy()) return; this.busy.set(true); this.undoContext.set(null); this.notice.set('');
    try {
      const task = mailTask(mail, email, base, schedule), result = await this.store.saveTask(task, context);
      if (!result.ok) { this.notice.set(result.message); return; }
      this.undoContext.set({...context, original: structuredClone(task)});
      this.notice.set(result.persisted ? `已建立「${task.title}」${schedule.time ? '，時段為一小時' : schedule.date ? '，已安排全天' : ''}。` : '任務只暫存在此分頁，請匯出備份。');
    } catch (error) { this.notice.set(error instanceof Error ? error.message : '未能建立任務，請重試。'); }
    finally { this.busy.set(false); }
  }
  async undo(): Promise<void> {
    const context = this.undoContext(); if (!context?.original || this.busy()) return;
    this.busy.set(true);
    try {
      const result = await this.store.deleteTask(context.original.id, context);
      if (result.ok) { this.undoContext.set(null); this.notice.set(result.persisted ? '已撤銷這次建立，原信仍保留。' : '已撤銷這次建立，變更只暫存在此分頁。'); }
      else { this.undoContext.set(null); this.notice.set(result.message); }
    } finally { this.busy.set(false); }
  }
  dismiss(): void { this.notice.set(''); this.undoContext.set(null); }
}
