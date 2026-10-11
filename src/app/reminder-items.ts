import type { Workspace, Task } from './models';
import type { ExternalEvent, ExternalTask } from './google-data';
import type { ReminderPreferences } from './reminder-data';
import { currentWeekRange, deadlineState, taskInWeek } from './reminder-data.ts';
import { dateKey, parseDate, taskMoment } from './task-schedule.ts';

export type ReminderTab = 'today' | 'tomorrow' | 'this-week' | 'next-week' | 'due-soon' | 'overdue';
export interface ReminderItem {
  id: string;
  generation: string;
  workspaceId: string;
  task: Task;
  external?: ExternalEvent;
  start: number | null;
  allDay: boolean;
}

export function reminderItems(workspace: Workspace, generation: string, external: readonly ExternalEvent[]): ReminderItem[] {
  const items: ReminderItem[] = [];
  for (const task of workspace.tasks) {
    if (task.deletedAt) continue;
    if ((workspace.statuses.find(status => status.id === task.status)?.kind ?? 'active') !== 'active') continue;
    items.push({id: 'orbit:' + task.id, generation, workspaceId: workspace.id, task, start: taskMoment(task.startDate, task.startTime), allDay: !task.startTime});
  }
  const seen = new Set<string>();
  for (const entry of external) {
    if (seen.has(entry.task.id) || !entry.source.visible || !entry.source.workspaceIds.includes(workspace.id) || entry.event.status === 'cancelled') continue;
    seen.add(entry.task.id);
    const start = (entry.task as ExternalTask).sourceInterval?.start ?? taskMoment(entry.task.startDate, entry.task.startTime);
    items.push({id: entry.task.id, generation, workspaceId: workspace.id, task: entry.task, external: entry, start, allDay: !!entry.event.start?.date});
  }
  return items;
}

export function startWindow(now: Date, tab: 'today' | 'tomorrow' | 'this-week' | 'next-week'): {start: number; end: number; label: string} {
  const weekly = tab === 'this-week' || tab === 'next-week';
  const start = weekly ? new Date(currentWeekRange(now).start) : parseDate(dateKey(now));
  start.setDate(start.getDate() + (tab === 'next-week' ? 7 : tab === 'tomorrow' ? 1 : 0));
  const end = new Date(start); end.setDate(end.getDate() + (weekly ? 7 : 1));
  const last = new Date(end); last.setDate(last.getDate() - 1);
  const format = (date: Date) => `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
  return {start: start.getTime(), end: end.getTime(), label: weekly ? `${format(start)} — ${format(last)}（週日至週六）` : format(start)};
}

export function itemsForReminderTab(items: readonly ReminderItem[], tab: ReminderTab, now: Date, days: number, workspace: Workspace): ReminderItem[] {
  if (tab === 'due-soon' || tab === 'overdue') {
    return items.filter(item => !item.external && deadlineState(item.task, now, days, workspace.statuses) === tab)
      .sort((left, right) => taskMoment(left.task.dueDate, left.task.dueTime, true)! - taskMoment(right.task.dueDate, right.task.dueTime, true)! || left.task.title.localeCompare(right.task.title, 'zh-Hant-TW'));
  }
  const window = startWindow(now, tab);
  if (tab === 'this-week') {
    const scheduledStart = (item: ReminderItem) => item.start ?? taskMoment(item.task.dueDate, item.task.dueTime)!;
    return items.filter(item => taskInWeek(item.task, window, item.external ? [] : workspace.statuses))
      .sort((left, right) => scheduledStart(left) - scheduledStart(right) || left.task.title.localeCompare(right.task.title, 'zh-Hant-TW'));
  }
  return items.filter(item => item.start !== null && item.start >= window.start && item.start < window.end
    && (tab !== 'today' || item.allDay || item.start >= now.getTime() - 300000))
    .sort((left, right) => left.start! - right.start! || Number(!left.allDay) - Number(!right.allDay) || left.task.title.localeCompare(right.task.title, 'zh-Hant-TW'));
}

export interface PopupCandidate {key: string; item: ReminderItem; expires: number}

export function startPopupCandidates(items: readonly ReminderItem[], now: Date, preferences: ReminderPreferences): PopupCandidate[] {
  if (!preferences.popupEnabled) return [];
  return items.flatMap(item => {
    if (item.start === null || item.external && !preferences.includeGoogle) return [];
    let eligible = false, expires: number;
    if (item.allDay) {
      const date = dateKey(new Date(item.start));
      expires = taskMoment(date, '', true)!;
      eligible = date === dateKey(now) && now.getTime() >= taskMoment(date, preferences.allDayTime)!;
    } else {
      expires = item.start + 300000;
      eligible = now.getTime() >= item.start - preferences.leadMinutes * 60000 && now.getTime() <= expires;
    }
    const key = JSON.stringify([item.generation, item.workspaceId, item.id, item.start, item.allDay]);
    return eligible ? [{key, item, expires}] : [];
  }).sort((left, right) => left.item.start! - right.item.start! || left.item.id.localeCompare(right.item.id));
}
