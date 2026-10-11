import type { DeviceIdentity, Task } from './models.ts';

export const RECENT_TASK_LIMIT = 20;
export const RECENT_EDIT_DAYS = 7;

export function validTaskEditTime(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function content(task: Task): string {
  return JSON.stringify([task.title, task.description, task.projectId, task.categoryId, task.status, task.priority, task.startDate, task.startTime, task.dueDate, task.dueTime, task.subtasks, task.calendarOrigin ?? null]);
}

/** Pinning and rearranging cards do not change the last content edit. */
export function recordTaskEdits(previous: readonly Task[], tasks: Task[], now = new Date(), source?: DeviceIdentity): Task[] {
  const originals = new Map(previous.map(task => [task.id, task]));
  return tasks.map(task => {
    const original = originals.get(task.id);
    if (!original || content(original) !== content(task)) return {...task, updatedAt: now.toISOString(), ...(source ? {editSource: {...source}} : {})};
    const {updatedAt, editSource, ...unchanged} = task;
    return {...unchanged, ...(original.updatedAt === undefined ? {} : {updatedAt: original.updatedAt}), ...(original.editSource ? {editSource: {...original.editSource}} : {})};
  });
}

export function recentTasks(tasks: readonly Task[], limit = RECENT_TASK_LIMIT): Task[] {
  return tasks.filter(task => validTaskEditTime(task.updatedAt)).sort((a, b) => b.updatedAt!.localeCompare(a.updatedAt!)).slice(0, limit);
}

export function recentlyEdited(task: Task, now: Date): boolean {
  if (!validTaskEditTime(task.updatedAt)) return false;
  const start = new Date(now);
  start.setDate(start.getDate() - RECENT_EDIT_DAYS + 1);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(24, 0, 0, 0);
  const edited = new Date(task.updatedAt).getTime();
  return edited >= start.getTime() && edited < end.getTime();
}
