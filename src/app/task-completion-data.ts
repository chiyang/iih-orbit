import type {BoardState, TaskCompletionEvent} from './models.ts';
import {validTaskEditTime} from './task-activity-data.ts';
import {dateKey, validDate} from './task-schedule.ts';

export function readCompletionEvents(value: unknown): TaskCompletionEvent[] | null {
  if (!Array.isArray(value) || value.length > 200000) return null;
  const events: TaskCompletionEvent[] = [];
  const text = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length <= limit;
  for (const event of value) {
    if (!event || !text(event.id, 500) || !event.id || !text(event.taskId, 500) || !event.taskId
      || !['completed', 'reopened'].includes(event.kind) || !validTaskEditTime(event.at)
      || typeof event.day !== 'string' || !event.day || !validDate(event.day)
      || !text(event.title, 1000) || !event.title.trim() || !text(event.projectId, 500) || !text(event.projectName, 1000)) return null;
    if (Math.abs(Date.parse(event.day + 'T00:00:00Z') - Date.parse(event.at.slice(0, 10) + 'T00:00:00Z')) > 86400000) return null;
    events.push({id: event.id, taskId: event.taskId, kind: event.kind, at: event.at, day: event.day, title: event.title, projectId: event.projectId, projectName: event.projectName});
  }
  return new Set(events.map(event => event.id)).size === events.length ? events : null;
}

/** Union, rather than replacement, keeps older devices and undo from removing past events. */
export function mergeCompletionEvents(groups: readonly (readonly TaskCompletionEvent[])[]): TaskCompletionEvent[] {
  const events = new Map<string, TaskCompletionEvent>();
  for (const group of groups) for (const event of group) {
    const previous = events.get(event.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(event)) throw new Error('完成歷史的事件識別重複且內容不同，原資料保留。');
    events.set(event.id, {...event});
  }
  return [...events.values()].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}

export function withCompletionEvents<T extends BoardState>(board: T, events: TaskCompletionEvent[]): T {
  return {...board, version: 7, documentSources: board.documentSources ?? [], documentLinks: board.documentLinks ?? [], documentDetails: board.documentDetails ?? [], documentOrders: board.documentOrders ?? [], completionEvents: events};
}

/** Imports, sync and choosing a stored version do not call this transition recorder. */
export function recordCompletions<T extends BoardState>(previous: BoardState, board: T, now = new Date(), newId: () => string = () => crypto.randomUUID()): T {
  const originals = new Map(previous.tasks.map(task => [task.id, task]));
  const oldKinds = new Map(previous.statuses.map(status => [status.id, status.kind]));
  const kinds = new Map(board.statuses.map(status => [status.id, status.kind]));
  const projects = new Map(board.projects.map(project => [project.id, project.name]));
  const additions: TaskCompletionEvent[] = [];
  for (const task of board.tasks) {
    const original = originals.get(task.id);
    if (task.deletedAt || original?.deletedAt) continue;
    const before = original ? oldKinds.get(original.status) : undefined, after = kinds.get(task.status);
    const kind = after === 'done' && (before === 'active' || !original) ? 'completed' : before === 'done' && after === 'active' ? 'reopened' : undefined;
    if (kind) additions.push({id: newId(), taskId: task.id, kind, at: now.toISOString(), day: dateKey(now), title: task.title.slice(0, 1000), projectId: task.projectId, projectName: (projects.get(task.projectId) ?? '').slice(0, 1000)});
  }
  if (!additions.length && previous.completionEvents === board.completionEvents) return board;
  return withCompletionEvents(board, mergeCompletionEvents([previous.completionEvents ?? [], board.completionEvents ?? [], additions]));
}
