import type { Task } from './models';
import { dateKey, parseDate, taskDateRange } from './task-schedule.ts';
import type { ExternalTask } from './google-data.ts';

export interface TimedEvent {
  task: Task;
  startMinute: number;
  endMinute: number;
  displayStart: number;
  displayEnd: number;
  column: number;
  columns: number;
  label: string;
  continuesBefore: boolean;
  continuesAfter: boolean;
  milestone: boolean;
}

export interface AllDayEvent {
  task: Task;
  startColumn: number;
  endColumn: number;
  row: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
}

export const HOUR_HEIGHT = 72;

export function timeMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

export function minuteLabel(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(Math.floor(minute % 60)).padStart(2, '0')}`;
}

/** Return only the calendar days fully covered by a task, including timed multi-day ranges. */
export function allDayRange(task: Task): {start: string; end: string} | null {
  const range = taskDateRange(task);
  if (!range || (!task.startTime && !task.dueTime)) return range;
  const interval = (task as ExternalTask).sourceInterval;
  if (interval) {
    const start = parseDate(range.start), end = parseDate(range.end);
    if (interval.start > start.getTime()) start.setDate(start.getDate() + 1);
    end.setDate(end.getDate() - 1);
    return start <= end ? {start: dateKey(start), end: dateKey(end)} : null;
  }
  if (!task.startDate || !task.dueDate) return null;
  let start = task.startDate;
  let end = task.dueDate;
  if (task.startTime && timeMinutes(task.startTime) > 0) {
    const nextDate = parseDate(start);
    nextDate.setDate(nextDate.getDate() + 1);
    start = dateKey(nextDate);
  }
  if (task.dueTime) {
    const previousDate = parseDate(end);
    previousDate.setDate(previousDate.getDate() - 1);
    end = dateKey(previousDate);
  }
  return start <= end ? {start, end} : null;
}

/** Fully covered dates share compact rows above the clock, spanning their inclusive dates. */
export function layoutAllDayTasks(tasks: readonly Task[], days: readonly string[]): AllDayEvent[] {
  if (!days.length) return [];
  const events: AllDayEvent[] = [];
  for (const task of tasks) {
    const range = allDayRange(task);
    if (!range || range.end < days[0] || range.start > days[days.length - 1]) continue;
    const startColumn = Math.max(0, days.findIndex(day => day >= range.start));
    const lastColumn = days.findLastIndex(day => day <= range.end);
    events.push({task, startColumn, endColumn: lastColumn + 1, row: 0, continuesBefore: range.start < days[0], continuesAfter: range.end > days[days.length - 1]});
  }
  events.sort((left, right) => left.startColumn - right.startColumn || right.endColumn - left.endColumn || left.task.title.localeCompare(right.task.title, 'zh-Hant-TW'));
  const rowEnds: number[] = [];
  for (const event of events) {
    let row = rowEnds.findIndex(end => end <= event.startColumn);
    if (row < 0) row = rowEnds.length;
    event.row = row;
    rowEnds[row] = event.endColumn;
  }
  return events;
}

/** Partial days stay on the clock; complete days are displayed exclusively in the all-day row. */
export function timedEventsOnDay(tasks: readonly Task[], day: string): TimedEvent[] {
  const events: TimedEvent[] = [];
  const nextDate = parseDate(day);
  nextDate.setDate(nextDate.getDate() + 1);
  const nextDay = dateKey(nextDate);
  for (const task of tasks) {
    if (!task.startTime && !task.dueTime) continue;
    const range = taskDateRange(task);
    if (!range || day < range.start || day > range.end) continue;
    const fullDays = allDayRange(task);
    if (fullDays && fullDays.start <= day && day <= fullDays.end) continue;
    const singleBoundary = !task.startDate || !task.dueDate;
    let startMinute = singleBoundary ? timeMinutes(task.startTime || task.dueTime)
      : day === task.startDate && task.startTime ? timeMinutes(task.startTime) : 0;
    let endMinute = singleBoundary ? startMinute
      : day === task.dueDate && task.dueTime ? timeMinutes(task.dueTime) : 1440;
    // An interval ending at midnight belongs to the previous day, except a true point event.
    const interval = (task as ExternalTask).sourceInterval;
    let labelSuffix = '';
    let elapsedMinutes = endMinute - startMinute;
    if (interval) {
      const dayStart = parseDate(day).getTime(), dayEnd = nextDate.getTime();
      if (interval.start >= dayEnd || (interval.end <= dayStart && interval.start !== interval.end)) continue;
      const actualStart = new Date(Math.max(interval.start, dayStart)), actualEnd = new Date(Math.min(interval.end, dayEnd));
      const wallMinute = (date: Date) => date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
      startMinute = wallMinute(actualStart); endMinute = actualEnd.getTime() === dayEnd ? 1440 : wallMinute(actualEnd);
      elapsedMinutes = (actualEnd.getTime() - actualStart.getTime()) / 60000;
      if (endMinute <= startMinute && elapsedMinutes > 0) labelSuffix = '（時區轉換）';
    } else if (!singleBoundary && endMinute === 0 && range.start !== day) continue;
    const milestone = interval ? interval.start === interval.end : startMinute === endMinute;
    const displayStart = Math.min(startMinute, 1410);
    const displayEnd = Math.min(1440, Math.max(endMinute <= startMinute && elapsedMinutes > 0 ? startMinute + elapsedMinutes : endMinute, displayStart + 30));
    const label = milestone ? `${minuteLabel(startMinute)}${singleBoundary ? task.startDate ? ' 開始' : ' 截止' : ''}`
      : `${minuteLabel(startMinute)} – ${minuteLabel(endMinute)}${labelSuffix}`;
    events.push({
      task,
      startMinute,
      endMinute,
      displayStart,
      displayEnd,
      column: 0,
      columns: 1,
      label,
      continuesBefore: !singleBoundary && range.start < day,
      continuesAfter: !singleBoundary && range.end > day && !(task.dueDate === nextDay && task.dueTime === '00:00'),
      milestone
    });
  }
  return layoutOverlaps(events);
}

/** Connected overlap groups use the minimum number of parallel lanes without hiding cards. */
export function layoutOverlaps(events: readonly TimedEvent[]): TimedEvent[] {
  const sorted = events.map(event => ({...event})).sort((left, right) => left.displayStart - right.displayStart
    || right.displayEnd - left.displayEnd || left.task.id.localeCompare(right.task.id));
  let group: TimedEvent[] = [];
  let groupEnd = -1;
  let columnEnds: number[] = [];
  const finishGroup = () => {
    for (const event of group) event.columns = columnEnds.length;
  };
  for (const event of sorted) {
    if (event.displayStart >= groupEnd) {
      finishGroup();
      group = [];
      columnEnds = [];
    }
    let column = columnEnds.findIndex(end => end <= event.displayStart);
    if (column < 0) column = columnEnds.length;
    event.column = column;
    columnEnds[column] = event.displayEnd;
    group.push(event);
    groupEnd = Math.max(...columnEnds);
  }
  finishGroup();
  return sorted;
}

/** Keep original times for labels and edits; clip only the visible part of the clock. */
export function timedEventsInRange(events: readonly TimedEvent[], start: number, end: number): TimedEvent[] {
  const visible = events.flatMap(event => {
    const actualEnd = event.endMinute > event.startMinute ? event.endMinute : event.displayEnd;
    const inside = event.milestone ? event.startMinute >= start && event.startMinute < end : event.startMinute < end && actualEnd > start;
    if (!inside) return [];
    const displayStart = Math.max(start, Math.min(event.displayStart, end - 30));
    return [{...event, displayStart, displayEnd: Math.min(end, Math.max(event.displayEnd, displayStart + 30))}];
  });
  return layoutOverlaps(visible);
}
