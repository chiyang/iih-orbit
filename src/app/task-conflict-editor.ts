import { DatePipe } from '@angular/common';
import { Component, computed, inject, input, linkedSignal, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { BoardStore } from './board-store';
import { Icon } from './icon';
import { MarkdownEditor } from './markdown-editor';
import { ScheduleTime } from './schedule-time';
import { PRIORITIES, Task, TaskConflict, TaskConflictVersion, Workspace } from './models';
import { scheduleError } from './task-schedule';

export interface TaskConflictContext {workspace: Workspace; conflict: TaskConflict; generation: string}

@Component({
  selector: 'app-task-conflict-editor',
  imports: [DatePipe, FormsModule, Icon, MarkdownEditor, ScheduleTime],
  templateUrl: './task-conflict-editor.html',
  styleUrl: './task-conflict-editor.css'
})
export class TaskConflictEditor {
  readonly store = inject(BoardStore);
  readonly context = input.required<TaskConflictContext>();
  readonly saved = output<boolean>();
  readonly busyChange = output<boolean>();
  readonly drafts = linkedSignal(() => this.context().conflict.versions.map(version => version.task ? structuredClone(version.task) : null));
  readonly priorities = PRIORITIES;
  readonly busy = signal(false);
  readonly error = signal('');
  readonly errorIndex = signal(-1);
  readonly deleting = signal(-1);
  readonly focusedDescription = signal(-1);
  readonly workspace = computed(() => this.store.workspaces().find(workspace => workspace.id === this.context().workspace.id) ?? this.context().workspace);
  readonly stale = computed(() => !this.store.workspaces().some(workspace => workspace.id === this.context().workspace.id) || this.store.generation() !== this.context().generation
    || JSON.stringify(this.workspace().taskConflicts?.find(conflict => conflict.id === this.context().conflict.id)) !== JSON.stringify(this.context().conflict));
  newSubtasks: Record<number, string> = {};

  sourceName(version: TaskConflictVersion): string {return (version.source ? version.source.name : version.task?.editSource?.name) ?? '未記錄來源';}
  sourceTime(version: TaskConflictVersion): string | undefined {return version.source ? version.source.updatedAt : version.task?.updatedAt;}
  addSubtask(index: number): void {
    const title = (this.newSubtasks[index] ?? '').trim(), task = this.drafts()[index];
    if (!title || !task) return;
    task.subtasks.push({id: crypto.randomUUID(), title, done: false});
    this.newSubtasks[index] = '';
  }
  removeSubtask(index: number, id: string): void {
    const task = this.drafts()[index];
    if (task) task.subtasks = task.subtasks.filter(subtask => subtask.id !== id);
  }
  dateChanged(task: Task, kind: 'start' | 'due', date: string): void {
    if (kind === 'start') {task.startDate = date; if (!date) task.startTime = '';}
    else {task.dueDate = date; if (!date) task.dueTime = '';}
  }
  setTrashed(task: Task, trashed: boolean): void {
    if (trashed) task.deletedAt ??= new Date().toISOString();
    else delete task.deletedAt;
  }
  escapeDescription(event: Event): void {
    if (this.focusedDescription() < 0) return;
    event.stopPropagation(); this.focusedDescription.set(-1);
  }
  async save(index: number): Promise<void> {
    if (this.busy() || this.store.pendingWrites() || this.stale()) return;
    const task = this.drafts()[index], context = this.context();
    this.errorIndex.set(index);
    if (task) {
      this.addSubtask(index);
      task.title = task.title.trim();
      const error = !task.title ? '請輸入任務名稱。' : task.description.length > 20000 ? '任務描述不能超過 20,000 字元。' : scheduleError(task);
      if (error) {this.error.set(error); return;}
    }
    this.error.set(''); this.busy.set(true); this.busyChange.emit(true);
    try {
      const result = await this.store.resolveTaskConflict(context.workspace.id, context.conflict, context.conflict.versions[index].key, context.generation, task ?? undefined);
      if (result.ok) this.saved.emit(result.persisted);
      else this.error.set(result.message + ' 你的草稿仍保留。');
    } finally {this.busy.set(false); this.busyChange.emit(false);}
  }
}
