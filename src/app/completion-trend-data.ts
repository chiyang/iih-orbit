import type {TaskCompletionEvent, Workspace} from './models.ts';
import {dateKey, startOfWeek, validDate} from './task-schedule.ts';

export interface CompletionBucket {start: string; end: string; label: string; count: number}
export function completionRange(value: unknown): {start: string; end: string} | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}\/\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [start, end] = value.split('/');
  return validDate(start) && validDate(end) && start <= end ? {start, end} : null;
}

/** Pick the first completion for each task/local day before applying the project filter. */
export function dailyCompletions(events: readonly TaskCompletionEvent[]): TaskCompletionEvent[] {
  const unique = new Map<string, TaskCompletionEvent>();
  for (const event of [...events].filter(event => event.kind === 'completed').sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))) {
    const key = JSON.stringify([event.day, event.taskId]);
    if (!unique.has(key)) unique.set(key, event);
  }
  return [...unique.values()];
}

export function completionHistory(workspace: Workspace, project: string, start: string, end: string) {
  const tasks = new Map(workspace.tasks.map(task => [task.id, task]));
  return dailyCompletions(workspace.completionEvents ?? []).filter(event => event.day >= start && event.day <= end && (project === 'all' || event.projectId === project))
    .sort((a, b) => b.day.localeCompare(a.day) || b.at.localeCompare(a.at) || a.id.localeCompare(b.id))
    .map(event => ({event, task: tasks.get(event.taskId)}));
}

export function completionTrend(workspace: Workspace, now: Date, project = 'all', days: 7 | 30 | 90 = 30, weekly = false) {
  const today = dateKey(now), first = new Date(now); first.setDate(first.getDate() - days + 1);
  const recordedFrom = (workspace.completionEvents ?? []).map(event => event.day).filter(day => day <= today).sort()[0] ?? '';
  const start = recordedFrom && recordedFrom > dateKey(first) ? recordedFrom : dateKey(first);
  const rows = completionHistory(workspace, project, start, today), buckets: CompletionBucket[] = [];
  const counts = new Map<string, number>();
  for (const {event} of rows) counts.set(event.day, (counts.get(event.day) ?? 0) + 1);
  for (const day = new Date(start + 'T12:00:00'); recordedFrom && dateKey(day) <= today; day.setDate(day.getDate() + 1)) {
    const key = dateKey(day), week = dateKey(startOfWeek(day)), bucket = weekly ? buckets.at(-1) : undefined;
    if (bucket && dateKey(startOfWeek(new Date(bucket.start + 'T12:00:00'))) === week) {bucket.end = key; bucket.count += counts.get(key) ?? 0;}
    else buckets.push({start: key, end: key, label: '', count: counts.get(key) ?? 0});
  }
  for (const bucket of buckets) bucket.label = bucket.start === bucket.end ? bucket.start.slice(5).replace('-', '/') : bucket.start.slice(5).replace('-', '/') + '–' + bucket.end.slice(5).replace('-', '/');
  return {buckets, start, end: today, recordedFrom, total: rows.length, today: counts.get(today) ?? 0, maximum: Math.max(1, ...buckets.map(bucket => bucket.count))};
}
