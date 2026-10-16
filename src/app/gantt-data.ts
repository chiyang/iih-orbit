import type {BoardStatus, Project, Task} from './models.ts';
import {COLUMNS} from './models.ts';
import {dateKey, parseDate, taskMoment, validDate, validTime} from './task-schedule.ts';
import type {CalendarPosition} from './calendar-move.ts';

export type GanttScale = 'day' | 'week' | 'month';
export type GanttCompletion = 'all' | 'done' | 'pending';
export type GanttOrder = 'start' | 'end';
export interface GanttDateRange {start: string; end: string}
export interface GanttColumn {start: number; end: number; label: string; detail: string; weekend: boolean}
export interface GanttAxis {start: number; end: number; count: number; offset: number; units: number; scale: GanttScale; origin: number; column: (index: number) => GanttColumn; label: string}
export type GanttRow = {kind: 'group'; id: string; label: string; count: number; done: number; pending: number; archived: number} | {kind: 'task'; id: string; task: Task};
export interface GanttSpan {left: number; width: number; marker: boolean; clippedStart: boolean; clippedEnd: boolean; outside: 'before' | 'after' | null}

/** Civil date coordinates, independent of local UTC offsets and daylight saving changes. */
export function civilDay(key: string): number {
  const [year, month, day] = key.split('-').map(Number);
  return Date.UTC(year, month - 1, day) / 86400000;
}
export function civilKey(day: number): string {return new Date(day * 86400000).toISOString().slice(0, 10);}
const MIN_DAY = civilDay('1900-01-01'), MAX_DAY = civilDay('9999-12-31');
const clampDay = (day: number) => Math.min(MAX_DAY, Math.max(MIN_DAY, day));
const shortDate = (day: number) => {const key = civilKey(day); return Number(key.slice(5, 7)) + '/' + Number(key.slice(8, 10));};

export function moveGanttDate(key: string, scale: GanttScale, direction: number): string {
  const value = validDate(key) && key ? key : dateKey(new Date());
  if (scale !== 'month') return civilKey(clampDay(civilDay(value) + direction * (scale === 'day' ? 42 : 84)));
  const date = parseDate(value), originalDay = date.getDate();
  date.setDate(1); date.setMonth(date.getMonth() + direction * 12);
  date.setDate(Math.min(originalDay, new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()));
  return civilKey(clampDay(civilDay(dateKey(date))));
}

export function readGanttRange(value: unknown): GanttDateRange | null {
  if (!value || typeof value !== 'object') return null;
  const {start, end} = value as Partial<GanttDateRange>;
  return typeof start === 'string' && !!start && validDate(start) && typeof end === 'string' && !!end && validDate(end) && start <= end ? {start, end} : null;
}

export function ganttTaskInRange(task: Task, range: GanttDateRange | null): boolean {
  if (!range) return true;
  const start = task.startDate || task.dueDate, end = task.dueDate || task.startDate;
  return !!start && start <= range.end && end >= range.start;
}

const weekday = (day: number) => new Date(day * 86400000).getUTCDay();
const monthIndex = (day: number) => {const date = new Date(day * 86400000); return date.getUTCFullYear() * 12 + date.getUTCMonth();};
const monthDay = (index: number) => Date.UTC(Math.floor(index / 12), index % 12, 1) / 86400000;

/** Date columns are generated on demand, so selecting a long range does not allocate every day. */
export function ganttAxis(key: string, scale: GanttScale, range: GanttDateRange | null = null): GanttAxis {
  const anchor = civilDay(key && validDate(key) ? key : dateKey(new Date()));
  const start = range ? civilDay(range.start) : clampDay(scale === 'month' ? monthDay(monthIndex(anchor) - 1) : anchor - weekday(anchor) - 7);
  const origin = scale === 'month' ? monthIndex(start) : scale === 'week' ? start - weekday(start) : start;
  const end = range ? civilDay(range.end) + 1 : Math.min(MAX_DAY + 1, scale === 'month' ? monthDay(origin + 12) : scale === 'week' ? origin + 84 : start + 42);
  const count = scale === 'month' ? monthIndex(end - 1) - origin + 1 : Math.ceil((end - origin) / (scale === 'week' ? 7 : 1));
  const firstDay = scale === 'month' ? monthDay(origin) : origin, firstEnd = scale === 'month' ? monthDay(origin + 1) : origin + (scale === 'week' ? 7 : 1);
  const lastDay = scale === 'month' ? monthDay(origin + count - 1) : origin + (count - 1) * (scale === 'week' ? 7 : 1), lastEnd = scale === 'month' ? monthDay(origin + count) : lastDay + (scale === 'week' ? 7 : 1);
  const offset = (start - firstDay) / (firstEnd - firstDay), units = count - 1 + (end - lastDay) / (lastEnd - lastDay) - offset;
  const column = (index: number): GanttColumn => {
    const first = scale === 'month' ? monthDay(origin + index) : origin + index * (scale === 'week' ? 7 : 1);
    const next = scale === 'month' ? monthDay(origin + index + 1) : first + (scale === 'week' ? 7 : 1);
    const day = Math.max(start, first), last = Math.min(end, next), weekDay = weekday(day), value = civilKey(day);
    return {start: day, end: last, label: scale === 'month' ? Number(value.slice(5, 7)) + ' 月' : scale === 'day' ? shortDate(day) : shortDate(day) + '–' + shortDate(last - 1), detail: scale === 'day' ? '日一二三四五六'[weekDay] : value.slice(0, 4), weekend: scale === 'day' && (weekDay === 0 || weekDay === 6)};
  };
  return {start, end, count, offset, units, scale, origin, column, label: civilKey(start) + ' — ' + civilKey(end - 1)};
}

/** Month columns have equal pixel widths; days within each month retain their actual proportions. */
export function ganttPosition(day: number, axis: GanttAxis, columnWidth: number): number {
  if (day <= axis.start) return 0;
  if (day >= axis.end) return axis.units * columnWidth;
  const index = axis.scale === 'month' ? monthIndex(day) - axis.origin : Math.floor((day - axis.origin) / (axis.scale === 'week' ? 7 : 1));
  const start = axis.scale === 'month' ? monthDay(axis.origin + index) : axis.origin + index * (axis.scale === 'week' ? 7 : 1);
  const end = axis.scale === 'month' ? monthDay(axis.origin + index + 1) : start + (axis.scale === 'week' ? 7 : 1);
  return (index + (day - start) / (end - start) - axis.offset) * columnWidth;
}

export function ganttSpan(task: Task, axis: GanttAxis, columnWidth: number): GanttSpan | null {
  if (!task.startDate && !task.dueDate) return null;
  const fraction = (time: string, fallback: number) => {
    if (axis.scale !== 'day' || !time || !validTime(time)) return fallback;
    const [hour, minute] = time.split(':').map(Number);
    return (hour * 60 + minute) / 1440;
  };
  const single = !task.startDate || !task.dueDate;
  const start = civilDay(task.startDate || task.dueDate) + fraction(single ? task.startDate ? task.startTime : task.dueTime : task.startTime, single ? 0.5 : 0);
  const end = single ? start : civilDay(task.dueDate) + fraction(task.dueTime, 1);
  const marker = single || end <= start;
  const outside = (marker ? start < axis.start : end <= axis.start) ? 'before' : start >= axis.end ? 'after' : null;
  const left = ganttPosition(start, axis, columnWidth);
  return {left, width: marker ? 0 : Math.max(0, ganttPosition(end, axis, columnWidth) - left), marker, clippedStart: start < axis.start, clippedEnd: end > axis.end, outside};
}

export function ganttRows(tasks: readonly Task[], projects: readonly Project[] = [], statuses: readonly BoardStatus[] = COLUMNS, completion: GanttCompletion = 'all', order: GanttOrder = 'start', range: GanttDateRange | null = null): GanttRow[] {
  const kinds = new Map(statuses.map(status => [status.id, status.kind])), projectIds = new Set(projects.map(project => project.id));
  const kind = (task: Task) => kinds.get(task.status) ?? 'active';
  const rank = (task: Task) => ({done: 0, active: 1, archived: 2}[kind(task)]);
  const moment = (task: Task, endpoint: GanttOrder) => endpoint === 'start'
    ? taskMoment(task.startDate, task.startTime) ?? taskMoment(task.dueDate, task.dueTime, true) ?? Infinity
    : taskMoment(task.dueDate, task.dueTime, true) ?? taskMoment(task.startDate, task.startTime) ?? Infinity;
  const ordered = tasks.filter(task => !task.deletedAt && ganttTaskInRange(task, range) && (completion === 'all' || (completion === 'done' ? kind(task) === 'done' : kind(task) === 'active')))
    .map((task, index) => ({task, index, rank: rank(task), first: moment(task, order), second: moment(task, order === 'start' ? 'end' : 'start')}))
    .sort((left, right) => left.rank - right.rank || (left.first === right.first ? 0 : left.first - right.first) || (left.second === right.second ? 0 : left.second - right.second) || left.index - right.index);
  const sections = new Map<string, Task[]>(), unscheduled: Task[] = [];
  for (const {task} of ordered) {
    if (!task.startDate && !task.dueDate) {unscheduled.push(task); continue;}
    const id = projectIds.has(task.projectId) ? task.projectId : '';
    if (!sections.has(id)) sections.set(id, []);
    sections.get(id)!.push(task);
  }
  const rows: GanttRow[] = [];
  const append = (id: string, label: string, values: Task[]) => {
    if (!values.length) return;
    let done = 0, pending = 0, archived = 0;
    for (const task of values) {if (kind(task) === 'done') done++; else if (kind(task) === 'archived') archived++; else pending++;}
    rows.push({kind: 'group', id, label, count: values.length, done, pending, archived});
    for (const task of values) rows.push({kind: 'task', id: task.id, task});
  };
  for (const project of projects) append('project:' + project.id, project.name, sections.get(project.id) ?? []);
  append('project:', '未指定專案', sections.get('') ?? []);
  append('unscheduled', '未排程', unscheduled);
  return rows;
}

export function readGanttZoom(value: unknown): number {return typeof value === 'number' && Number.isFinite(value) ? Math.min(250, Math.max(50, Math.round(value / 25) * 25)) : 100;}

export function ganttDayAtPosition(position: number, axis: GanttAxis, columnWidth: number): number {
  const value = Math.min(axis.units, Math.max(0, position / columnWidth)) + axis.offset;
  const index = Math.floor(value), start = axis.scale === 'month' ? monthDay(axis.origin + index) : axis.origin + index * (axis.scale === 'week' ? 7 : 1);
  const end = axis.scale === 'month' ? monthDay(axis.origin + index + 1) : start + (axis.scale === 'week' ? 7 : 1);
  return Math.min(axis.end, start + (value - index) * (end - start));
}

/** Empty timeline drops use the visible civil day; daily mode snaps to a quarter hour. */
export function ganttDropPosition(position: number, axis: GanttAxis, columnWidth: number): CalendarPosition | undefined {
  if (!Number.isFinite(position) || !Number.isFinite(columnWidth) || columnWidth <= 0 || position < 0 || position >= axis.units * columnWidth) return;
  const value = ganttDayAtPosition(position, axis, columnWidth), day = Math.floor(value), key = civilKey(day);
  if (!validDate(key) || day < axis.start || day >= axis.end) return;
  return axis.scale === 'day' ? {kind: 'time', day: key, minute: Math.min(1425, Math.floor(((value - day) * 1440 + 0.00001) / 15) * 15)} : {kind: 'all-day', day: key};
}

export function ganttZoomScroll(axis: GanttAxis, oldWidth: number, newWidth: number, scroll: number, visibleWidth: number): number {
  const centerDay = ganttDayAtPosition(scroll + visibleWidth / 2, axis, oldWidth);
  return Math.max(0, Math.min(axis.units * newWidth - visibleWidth, ganttPosition(centerDay, axis, newWidth) - visibleWidth / 2));
}

/** Daily columns split into hours; weeks into days; months at real Sunday boundaries. */
export function ganttParts(column: GanttColumn, scale: GanttScale): {start: number; end: number; label: string; weekend: boolean}[] {
  if (scale === 'day') return Array.from({length: 24}, (_, hour) => ({start: column.start + hour / 24, end: column.start + (hour + 1) / 24, label: String(hour).padStart(2, '0') + ':00', weekend: column.weekend}));
  const result = [];
  for (let start = column.start; start < column.end;) {
    const weekday = new Date(start * 86400000).getUTCDay();
    const end = Math.min(column.end, start + (scale === 'week' ? 1 : 7 - weekday));
    result.push({start, end, label: scale === 'week' ? '日一二三四五六'[weekday] : shortDate(start), weekend: scale === 'week' && (weekday === 0 || weekday === 6)});
    start = end;
  }
  return result;
}

export function ganttSchedule(task: Task): string {
  if (!task.startDate && !task.dueDate) return '未排程';
  if (!task.dueDate) return '僅開始：' + task.startDate + (task.startTime ? ' ' + task.startTime : '（全天）');
  if (!task.startDate) return '僅截止：' + task.dueDate + (task.dueTime ? ' ' + task.dueTime : '（全天）');
  return '開始：' + task.startDate + (task.startTime ? ' ' + task.startTime : '（全天）') + '；截止：' + task.dueDate + (task.dueTime ? ' ' + task.dueTime : '（全天）');
}

/** Both row and column DOM stay bounded, even when the underlying data contains many tasks. */
export function virtualRange(total: number, offset: number, extent: number, size: number, overscan = 3): {start: number; end: number} {
  const start = Math.min(total, Math.max(0, Math.floor(Math.max(0, offset) / size) - overscan));
  return {start, end: Math.min(total, Math.max(start, Math.ceil((Math.max(0, offset) + Math.max(0, extent)) / size) + overscan))};
}
