import type {TaskEditContext} from './board-store';
import type {DocumentDescription, DocumentSource, Task} from './models';
import {readDocumentSource} from './document-data';

export interface TaskDraftSnapshot {
  context: TaskEditContext;
  task: Task;
  documents: DocumentSource[];
  descriptions: DocumentDescription[];
  subtaskDraft: string;
  hasStartTime: boolean;
  hasDueTime: boolean;
  documentInput: {name: string; url: string; adding: boolean};
}
export interface LocalTaskDraft {id: string; savedAt: string; snapshot: TaskDraftSnapshot; raw: string}
const PREFIX = 'iih-orbit-task-edit-draft-v1:';
const string = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length <= limit;
function task(value: Task | null | undefined): value is Task {
  return !!value && string(value.id, 500) && !!value.id && string(value.title, 100) && string(value.description, 20000)
    && ['categoryId', 'projectId', 'status', 'startDate', 'startTime', 'dueDate', 'dueTime'].every(key => string(value[key as keyof Task], 500))
    && ['high', 'medium', 'low'].includes(value.priority) && Array.isArray(value.subtasks) && value.subtasks.length <= 1000
    && value.subtasks.every(item => item && string(item.id, 500) && string(item.title, 120) && typeof item.done === 'boolean');
}
function snapshot(value: TaskDraftSnapshot): boolean {
  const context = value?.context, input = value?.documentInput;
  return !!context && string(context.generation, 500) && string(context.workspaceId, 500)
    && (context.original === null || task(context.original)) && task(value.task)
    && (!context.original || context.original.id === value.task.id)
    && (context.informationKey === undefined || string(context.informationKey, 1000000))
    && (context.documentLinks === undefined || Array.isArray(context.documentLinks) && context.documentLinks.every(link => link && string(link.id, 3000) && string(link.taskId, 500) && string(link.documentId, 3000) && (link.removed === undefined || link.removed === true)))
    && Array.isArray(value.documents) && value.documents.length <= 1000 && value.documents.every(item => !!readDocumentSource(item))
    && Array.isArray(value.descriptions) && value.descriptions.every(item => item && string(item.documentId, 3000) && string(item.description, 1000))
    && string(value.subtaskDraft, 120) && typeof value.hasStartTime === 'boolean' && typeof value.hasDueTime === 'boolean'
    && !!input && string(input.name, 300) && string(input.url, 4096) && typeof input.adding === 'boolean';
}

/** Separate records per editing session prevent tabs from overwriting one another's drafts. */
export class TaskEditDrafts {
  save(id: string, value: TaskDraftSnapshot): void {
    const raw = JSON.stringify({version: 1, savedAt: new Date().toISOString(), snapshot: value});
    if (raw.length > 2000000 || !snapshot(value)) throw new Error('草稿過大或格式不完整，請使用「儲存變更」。');
    if (!localStorage.getItem(PREFIX + id) && this.entries().length >= 50) throw new Error('本機草稿已滿，請先恢復或捨棄舊草稿。');
    localStorage.setItem(PREFIX + id, raw);
  }
  find(context: TaskEditContext): LocalTaskDraft | null {
    return this.entries().filter(entry => entry.snapshot.context.generation === context.generation
      && entry.snapshot.context.workspaceId === context.workspaceId && entry.snapshot.context.original?.id === context.original?.id)
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt))[0] ?? null;
  }
  remove(id: string, expected?: string): void {
    if (expected !== undefined && localStorage.getItem(PREFIX + id) !== expected) return;
    localStorage.removeItem(PREFIX + id);
  }
  private entries(): LocalTaskDraft[] {
    const entries: LocalTaskDraft[] = [];
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index); if (!key?.startsWith(PREFIX)) continue;
      const raw = localStorage.getItem(key); if (!raw || raw.length > 2000000) continue;
      try {
        const value = JSON.parse(raw);
        if (value?.version === 1 && typeof value.savedAt === 'string' && Number.isFinite(Date.parse(value.savedAt)) && snapshot(value.snapshot)) entries.push({id: key.slice(PREFIX.length), savedAt: value.savedAt, snapshot: value.snapshot, raw});
      } catch { /* A malformed record cannot replace the form. */ }
    }
    return entries;
  }
}
