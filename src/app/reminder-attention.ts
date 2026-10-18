import type { Workspace } from './models';
import type { ReminderItem } from './reminder-items';
import { deadlineState } from './reminder-data.ts';
import { dateKey } from './task-schedule.ts';

export const REMINDER_SEEN_KEY = 'iih-orbit-reminder-seen-v1';
export const MAX_SEEN_REMINDERS = 5000;

/** Schedule changes and a newly overdue/today state can request attention again. */
export function reminderNoticeKey(item: ReminderItem, now: Date, days: number, workspace: Workspace): string {
  const task = item.task;
  return JSON.stringify([item.generation, item.workspaceId, item.id, task.startDate, task.startTime, task.dueDate, task.dueTime, item.start, reminderStage(item, now, days, workspace)]);
}
export function reminderStage(item: ReminderItem, now: Date, days: number, workspace: Workspace): 'overdue' | 'today' | 'due-soon' | 'upcoming' {
  const task = item.task, today = dateKey(now);
  const deadline = item.external ? null : deadlineState(task, now, days, workspace.statuses);
  return deadline === 'overdue' ? 'overdue' : task.startDate === today || task.dueDate === today ? 'today' : deadline ?? 'upcoming';
}
export function readSeenReminders(value: unknown): Set<string> {
  if (!value || typeof value !== 'object') return new Set();
  const record = value as {version?: unknown; keys?: unknown};
  return record.version === 1 && Array.isArray(record.keys) ? new Set(record.keys.filter((key): key is string => typeof key === 'string' && key.length <= 1000).slice(-MAX_SEEN_REMINDERS)) : new Set();
}
