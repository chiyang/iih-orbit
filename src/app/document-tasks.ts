import { effect, inject, Injectable, OnDestroy, signal, untracked } from '@angular/core';
import { BoardStore, type TaskEditContext } from './board-store';
import { DOCUMENT_DRAG_TYPE, readDocumentSource } from './document-data';
import type { DocumentSource, Task } from './models';
import type { CalendarPosition } from './calendar-move';
import { scheduleDocumentTask, type DocumentDropPosition } from './drive-browser-data';
import { createDocumentDragPreview } from './document-drag-preview';

interface DocumentDrag {token: string; source: DocumentSource; context: TaskEditContext; current: () => boolean}
@Injectable({providedIn: 'root'})
export class DocumentTasks implements OnDestroy {
  readonly store = inject(BoardStore);
  readonly dragging = signal(false);
  readonly busy = signal(false);
  readonly notice = signal('');
  readonly position = signal<DocumentDropPosition | null>(null);
  private drag?: DocumentDrag;
  private clearPreview?: () => void;
  constructor() {
    effect(() => {const generation = this.store.generation(), workspace = this.store.currentWorkspace().id; untracked(() => {if (this.drag && (this.drag.context.generation !== generation || this.drag.context.workspaceId !== workspace)) this.end();});});
  }
  start(event: DragEvent, source: DocumentSource, current: () => boolean): void {
    const valid = readDocumentSource(source);
    if (!valid || !event.dataTransfer || this.busy() || !current()) {event.preventDefault(); return;}
    this.end();
    this.drag = {token: crypto.randomUUID(), source: valid, context: {workspaceId: this.store.currentWorkspace().id, generation: this.store.generation(), original: null}, current};
    event.dataTransfer.setData(DOCUMENT_DRAG_TYPE, this.drag.token); event.dataTransfer.effectAllowed = 'copy'; this.dragging.set(true);
    this.clearPreview = createDocumentDragPreview(event, valid, () => this.end());
  }
  accepts(event: DragEvent): boolean {
    return !!this.drag && !this.busy() && !!event.dataTransfer?.types.includes(DOCUMENT_DRAG_TYPE) && this.drag.current()
      && this.drag.context.generation === this.store.generation() && this.drag.context.workspaceId === this.store.currentWorkspace().id;
  }
  over(event: DragEvent): boolean {if (!this.accepts(event)) return false; event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; return true;}
  validate(): void {if (this.drag && !this.drag.current()) this.end();}
  async drop(event: DragEvent, base: Task, position: DocumentDropPosition = {kind: 'create'}, schedule?: CalendarPosition): Promise<string | undefined> {
    if (!this.accepts(event) || event.dataTransfer?.getData(DOCUMENT_DRAG_TYPE) !== this.drag?.token) return;
    event.preventDefault(); event.stopPropagation(); const drag = this.drag!; this.end(); this.busy.set(true); this.notice.set('');
    try {
      if (position.kind === 'link' && !this.store.tasks().some(task => task.id === position.taskId)) {this.notice.set('任務已更新或刪除，請重新查看後再加入資訊連結。'); return;}
      if (position.kind === 'link' && this.store.documentsForTask(position.taskId).some(source => source.id === drag.source.id)) {this.notice.set('這份檔案或資料夾已連結到此任務。'); return;}
      const task = position.kind === 'create' ? scheduleDocumentTask(base, drag.source, schedule) : null;
      const result = task ? await this.store.saveTask(task, drag.context, position.kind === 'create' ? position.beforeId : undefined, [drag.source]) : await this.store.linkDocument((position as {taskId: string}).taskId, drag.source);
      if (!result.ok) {this.notice.set(result.message); return;}
      const detail = task ? `已建立「${task.title}」並連結來源${schedule?.kind === 'time' ? '，已安排一小時。' : '。'}` : '已加入資訊連結，原雲端項目保留。';
      this.notice.set(result.persisted ? detail : detail + '變更只保留在此分頁，請匯出備份。');
      return task?.id;
    } catch (error) {this.notice.set(error instanceof Error ? error.message : '檔案關聯未保存，請重新拖曳。');}
    finally {this.busy.set(false);}
    return undefined;
  }
  end(): void {const preview = this.clearPreview; this.clearPreview = undefined; this.drag = undefined; this.dragging.set(false); this.position.set(null); preview?.();}
  ngOnDestroy(): void {this.end();}
}
