import type { Task } from './models';
import { validHex } from './appearance-data.ts';
import { dateKey, monthDates, parseDate, validDate } from './task-schedule.ts';

export interface CalendarSource {
  id: string;
  accountId: string;
  calendarId: string;
  name: string;
  color: string;
  workspaceIds: string[];
  visible: boolean;
}
export interface GoogleSettings {
  clientId: string;
  accountId: string;
  email: string;
  refreshMinutes: 0 | 1 | 5 | 15;
  sources: CalendarSource[];
}
export const DEFAULT_GOOGLE: GoogleSettings = {clientId: '', accountId: '', email: '', refreshMinutes: 5, sources: []};
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
export function validClientId(value: string): boolean { return value === '' || /^\d+-[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(value); }
const text = (value: unknown, max = 1000): value is string => typeof value === 'string' && value.length <= max;

export function readSources(value: unknown, workspaceIds: string[]): CalendarSource[] | null {
  if (!Array.isArray(value)) return null;
  const ids = new Set<string>();
  const result: CalendarSource[] = [];
  for (const source of value) {
    if (!source || !text(source.id) || !source.id || ids.has(source.id) || !text(source.accountId) || !source.accountId
      || !text(source.calendarId) || !source.calendarId || !text(source.name, 300) || !source.name.trim()
      || !validHex(source.color) || typeof source.visible !== 'boolean' || !Array.isArray(source.workspaceIds)
      || source.workspaceIds.some((id: unknown) => typeof id !== 'string' || !workspaceIds.includes(id))
      || new Set(source.workspaceIds).size !== source.workspaceIds.length) return null;
    ids.add(source.id);
    result.push({id: source.id, accountId: source.accountId, calendarId: source.calendarId, name: source.name, color: source.color.toLowerCase(), workspaceIds: [...source.workspaceIds], visible: source.visible});
  }
  return result;
}

export function readGoogleSettings(value: unknown, workspaceIds: string[]): GoogleSettings | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as GoogleSettings;
  const sources = readSources(source.sources, workspaceIds);
  if (!text(source.clientId, 300) || !validClientId(source.clientId) || !text(source.accountId) || !text(source.email, 320)
    || ![0, 1, 5, 15].includes(source.refreshMinutes) || !sources) return null;
  return {clientId: source.clientId, accountId: source.accountId, email: source.email, refreshMinutes: source.refreshMinutes, sources};
}

export interface GoogleMoment {date?: string; dateTime?: string; timeZone?: string}
export interface GoogleEvent {
  id: string;
  status: string;
  summary: string;
  description: string;
  location: string;
  htmlLink: string;
  start?: GoogleMoment;
  end?: GoogleMoment;
  recurringEventId: string;
  originalStartTime?: GoogleMoment;
  recurrence: string[];
  updated: string;
  etag?: string;
  transparency?: string;
  orbitTransfer?: string;
  contentComplete?: boolean;
}
export interface ExternalTask extends Task {sourceInterval?: {start: number; end: number}}
export interface ExternalEvent {source: CalendarSource; event: GoogleEvent; task: ExternalTask; }
export interface CalendarRange {start: string; end: string; timeZone: string; key: string}

function readMoment(value: unknown): GoogleMoment | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const source = value as GoogleMoment;
  if (source.date && validDate(source.date)) return {date: source.date};
  if (typeof source.dateTime === 'string' && /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(source.dateTime) && validDate(source.dateTime.slice(0, 10)) && Number.isFinite(Date.parse(source.dateTime))) {
    return {dateTime: source.dateTime, ...(text(source.timeZone) ? {timeZone: source.timeZone} : {})};
  }
  return undefined;
}

export function safeGoogleLink(value: unknown): string {
  if (typeof value !== 'string') return '';
  try { const url = new URL(value); return url.protocol === 'https:' && ['calendar.google.com', 'www.google.com'].includes(url.hostname) && (url.hostname === 'calendar.google.com' || url.pathname.startsWith('/calendar/')) ? url.href : ''; }
  catch { return ''; }
}

/** Whitelist external content; descriptions are rendered as plain text, never HTML. */
export function readGoogleEvent(value: unknown): GoogleEvent | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as GoogleEvent;
  if (!text(source.id) || !source.id) return null;
  const start = readMoment(source.start), end = readMoment(source.end);
  if (source.status !== 'cancelled' && (!start || !end || !!start.date !== !!end.date
    || (start.date ? start.date >= end.date! : Date.parse(start.dateTime!) > Date.parse(end.dateTime!)))) return null;
  return {
    id: source.id, status: source.status === 'cancelled' ? 'cancelled' : 'confirmed',
    ...(typeof source.etag === 'string' ? {etag: source.etag} : {}),
    transparency: source.transparency === 'transparent' ? 'transparent' : 'opaque',
    orbitTransfer: text(source.orbitTransfer) ? source.orbitTransfer : typeof (value as {extendedProperties?: {private?: {orbitTransfer?: unknown}}}).extendedProperties?.private?.orbitTransfer === 'string' ? (value as {extendedProperties: {private: {orbitTransfer: string}}}).extendedProperties.private.orbitTransfer : '',
    contentComplete: source.contentComplete !== false && (!source.summary || source.summary.length <= 2000) && (!source.description || source.description.length <= 20000) && (!source.location || source.location.length <= 2000),
    summary: typeof source.summary === 'string' ? source.summary.slice(0, 2000) : '未命名活動',
    description: typeof source.description === 'string' ? source.description.slice(0, 20000) : '',
    location: typeof source.location === 'string' ? source.location.slice(0, 2000) : '', htmlLink: safeGoogleLink(source.htmlLink),
    ...(start ? {start} : {}), ...(end ? {end} : {}),
    recurringEventId: text(source.recurringEventId) ? source.recurringEventId : '',
    ...(readMoment(source.originalStartTime) ? {originalStartTime: readMoment(source.originalStartTime)} : {}),
    recurrence: Array.isArray(source.recurrence) ? source.recurrence.filter(item => text(item)).slice(0, 100) : [],
    updated: text(source.updated) ? source.updated : ''
  };
}

export function mergeGoogleEvents(previous: GoogleEvent[], changes: GoogleEvent[]): GoogleEvent[] {
  const events = new Map(previous.map(event => [event.id, event]));
  for (const event of changes) {
    // Recurring cancellation tombstones retain the original instance identity.
    if (event.status === 'cancelled' && !event.recurringEventId) events.delete(event.id);
    else events.set(event.id, event);
  }
  return [...events.values()];
}

export function sourceKey(source: Pick<CalendarSource, 'accountId' | 'calendarId'>): string { return JSON.stringify([source.accountId, source.calendarId]); }
export function cacheKey(generation: string, clientId: string, source: CalendarSource): string { return JSON.stringify([generation, clientId, source.accountId, source.calendarId]); }
export function calendarRange(first: string, last: string, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): CalendarRange {
  const start = parseDate(first), end = parseDate(last);
  start.setDate(start.getDate() - 7);
  end.setDate(end.getDate() + 8);
  return {start: start.toISOString(), end: end.toISOString(), timeZone, key: JSON.stringify([start.toISOString(), end.toISOString(), timeZone])};
}

/** Both calendar views read the same month, including its leading and trailing week days. */
export function calendarMonthRange(anchor: Date): CalendarRange {
  const dates = monthDates(anchor);
  return calendarRange(dateKey(dates[0]), dateKey(dates[dates.length - 1]));
}

export function externalEvent(source: CalendarSource, event: GoogleEvent): ExternalEvent | null {
  if (event.status === 'cancelled' || !event.start || !event.end) return null;
  const allDay = !!event.start.date;
  const start = allDay ? parseDate(event.start.date!) : new Date(event.start.dateTime!);
  const end = allDay ? parseDate(event.end.date!) : new Date(event.end.dateTime!);
  if (allDay) end.setDate(end.getDate() - 1); // Google all-day ends are exclusive.
  const time = (date: Date) => `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const task: ExternalTask = {
    id: 'google:' + JSON.stringify([source.accountId, source.calendarId, event.id]), title: event.summary || '未命名活動', description: event.description,
    categoryId: 'google:' + source.id, projectId: '', status: 'external', priority: 'medium', subtasks: [],
    startDate: dateKey(start), dueDate: dateKey(end), startTime: allDay ? '' : time(start), dueTime: allDay ? '' : time(end),
    ...(allDay ? {} : {sourceInterval: {start: start.getTime(), end: end.getTime()}})
  };
  return {source, event, task};
}

/** Use actual instants for timed events, so an exclusive midnight end adds no extra day. */
export function externalOccursOn(entry: ExternalEvent, day: string): boolean {
  if (entry.event.start?.date) return day >= entry.task.startDate && day <= entry.task.dueDate;
  const start = parseDate(day), end = parseDate(day);
  end.setDate(end.getDate() + 1);
  const eventStart = Date.parse(entry.event.start!.dateTime!), eventEnd = Date.parse(entry.event.end!.dateTime!);
  return eventStart < end.getTime() && (eventEnd > start.getTime() || (eventStart === eventEnd && eventStart === start.getTime()));
}
