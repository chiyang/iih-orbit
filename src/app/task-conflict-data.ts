import type { Task, TaskConflict } from './models.ts';

/** Stable content identity; wall-clock edit/deletion times do not decide whose content wins. */
export function taskVersionKey(task: Task | null): string {
  return JSON.stringify(task ? [task.id, task.title, task.description, task.categoryId, task.projectId, task.status, task.priority,
    task.startDate, task.startTime, task.dueDate, task.dueTime, task.subtasks.map(item => [item.id, item.title, item.done]),
    !!task.pinned, !!task.deletedAt, task.calendarOrigin ?? null] : null);
}
export function unresolvedTaskConflicts(conflicts: TaskConflict[] = []): TaskConflict[] {return conflicts.filter(conflict => !conflict.resolved);}
