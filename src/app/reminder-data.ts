import type { BoardStatus, Task } from './models';
import { COLUMNS } from './models.ts';
import { startOfWeek, taskMoment, validTime } from './task-schedule.ts';

export interface ReminderPreferences {
  dueSoonDays: number;
  popupEnabled: boolean;
  leadMinutes: number;
  allDayTime: string;
  includeGoogle: boolean;
}
export type DeadlineFilter = 'all' | 'unset' | 'overdue' | 'due-soon' | 'this-week';
export const DUE_DAY_PRESETS = [1, 3, 7, 30];
export const START_LEAD_PRESETS = [15, 30, 60];
export const DEFAULT_REMINDERS: ReminderPreferences = {dueSoonDays: 3, popupEnabled: true, leadMinutes: 30, allDayTime: '09:00', includeGoogle: true};

export function readReminders(value: unknown): ReminderPreferences | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Partial<ReminderPreferences>;
  const {dueSoonDays, popupEnabled = DEFAULT_REMINDERS.popupEnabled, leadMinutes = DEFAULT_REMINDERS.leadMinutes, allDayTime = DEFAULT_REMINDERS.allDayTime, includeGoogle = DEFAULT_REMINDERS.includeGoogle} = source;
  if (!Number.isInteger(dueSoonDays) || dueSoonDays! < 1 || dueSoonDays! > 30 || typeof popupEnabled !== 'boolean'
    || !START_LEAD_PRESETS.includes(leadMinutes) || typeof allDayTime !== 'string' || !allDayTime || !validTime(allDayTime) || typeof includeGoogle !== 'boolean') return null;
  return {dueSoonDays: dueSoonDays!, popupEnabled, leadMinutes, allDayTime, includeGoogle};
}

export function deadlineState(task: Task, now: Date, days: number, statuses: readonly BoardStatus[] = COLUMNS): 'overdue' | 'due-soon' | null {
  if ((statuses.find(status => status.id === task.status)?.kind ?? 'active') !== 'active') return null;
  const deadline = taskMoment(task.dueDate, task.dueTime, true);
  if (deadline === null) return null;
  const remaining = deadline - now.getTime();
  return remaining < 0 ? 'overdue' : remaining <= days * 86400000 ? 'due-soon' : null;
}

export function currentWeekRange(now: Date): {start: number; end: number} {
  const start = startOfWeek(now), end = new Date(start);
  end.setDate(end.getDate() + 7);
  return {start: start.getTime(), end: end.getTime()};
}

/** Date-only schedules include the whole day; timed ranges end exclusively. */
export function taskInWeek(task: Task & {sourceInterval?: {start: number; end: number}}, range: {start: number; end: number}, statuses: readonly BoardStatus[] = COLUMNS): boolean {
  if ((statuses.find(status => status.id === task.status)?.kind ?? 'active') !== 'active') return false;
  const start = task.sourceInterval?.start ?? taskMoment(task.startDate || task.dueDate, task.startDate ? task.startTime : task.dueTime);
  const end = task.sourceInterval?.end ?? taskMoment(task.dueDate || task.startDate, task.dueDate ? task.dueTime : task.startTime, true);
  return start !== null && end !== null && start < range.end && (end > range.start || start === end && start === range.start);
}
