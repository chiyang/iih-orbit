import type { BoardStatus, Task } from './models';
import { COLUMNS } from './models.ts';
import { taskMoment, validTime } from './task-schedule.ts';

export interface ReminderPreferences {
  dueSoonDays: number;
  popupEnabled: boolean;
  leadMinutes: number;
  allDayTime: string;
  includeGoogle: boolean;
}
export type DeadlineFilter = 'all' | 'overdue' | 'due-soon';
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
