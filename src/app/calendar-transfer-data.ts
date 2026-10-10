import type { CalendarMetadata, CalendarOrigin, CalendarTransfer, Task, Workspace } from './models';
import type { ExternalEvent, GoogleMoment } from './google-data';
import { dateKey, parseDate, validDate } from './task-schedule.ts';
import { readGoogleEvent } from './google-data.ts';

const HEADER = '--- IIH Orbit 任務 v1 ---';
const FOOTER = '--- IIH Orbit 任務結束 ---';
const priorityLabels = {high: '高優先', medium: '中優先', low: '低優先'};
const encodeLine = (value: string) => /[\r\n]/.test(value) || value.startsWith('"') ? JSON.stringify(value) : value;
const decodeLine = (value: string): unknown => value.startsWith('"') ? JSON.parse(value) : value;
export const RESERVE_MINUTES = [15, 30, 60, 120] as const;
export type TransferSchedule = {mode: 'reserve' | 'all-day' | 'custom'; minutes: number; startDate: string; startTime: string; endDate: string; endTime: string};
export interface EventBody {
  id: string;
  summary: string;
  description: string;
  start: GoogleMoment;
  end: GoogleMoment;
  transparency: 'transparent';
  extendedProperties: {private: {orbitTransfer: string; orbitFormat: string}};
}
const labelIndexes = new WeakMap<object, Map<string, string>>();
const nameIndexes = new WeakMap<object, Map<string, string>>();
function labels(items: readonly {id: string; name?: string; label?: string}[]): Map<string, string> {
  let index = labelIndexes.get(items);
  if (!index) { index = new Map(items.map(item => [item.id, item.name ?? item.label ?? ''])); labelIndexes.set(items, index); }
  return index;
}
function namedId(items: readonly {id: string; name?: string; label?: string}[], name: string): string {
  let index = nameIndexes.get(items);
  if (!index) { index = new Map(items.map(item => [item.name ?? item.label ?? '', item.id])); nameIndexes.set(items, index); }
  return index.get(name) ?? '';
}
export function taskMetadata(task: Task, workspace: Workspace): CalendarMetadata {
  return {project: labels(workspace.projects).get(task.projectId) ?? '', category: labels(workspace.categories).get(task.categoryId) ?? '', status: labels(workspace.statuses).get(task.status) ?? '', priority: task.priority};
}
export function taskFingerprint(task: Task): string {
  const {calendarOrigin, ...content} = task;
  return JSON.stringify(content);
}
export function formatCalendarDescription(task: Task, metadata: CalendarMetadata): string {
  if (task.description.includes(HEADER) || task.description.includes(FOOTER)) throw new Error('任務描述已含有 Orbit 子任務格式標記，請先調整描述再移轉。');
  // Calendar accepts HTML; Markdown angle destinations can otherwise be mistaken for tags.
  const description = task.description.replace(/\[([^\]\n]+)\]\(<(https?:\/\/[^<>\s]+)>\)/g, (_, label: string, url: string) => label + '：' + url);
  const lines = [description, '', HEADER, '專案：' + encodeLine(metadata.project), '分類：' + encodeLine(metadata.category), '狀態：' + encodeLine(metadata.status), '優先順序：' + priorityLabels[metadata.priority], '子任務：', ...task.subtasks.map(item => `[${item.done ? 'x' : ' '}] ${encodeLine(item.title)}`), FOOTER];
  const result = lines.join('\n');
  if (result.length > 19000) throw new Error('描述與子任務過長，請縮短內容後再移轉；本機任務仍保留。');
  return result;
}
export function parseCalendarDescription(description: string): {description: string; subtasks: {title: string; done: boolean}[]; metadata?: CalendarMetadata; valid: boolean} {
  const fallback = {description, subtasks: [], valid: !description.includes('--- IIH Orbit 任務')};
  const marker = '\n\n' + HEADER + '\n', index = description.lastIndexOf(marker);
  if (index < 0 || !description.endsWith('\n' + FOOTER)) return fallback;
  try {
    const lines = description.slice(index + marker.length, -(FOOTER.length + 1)).split('\n');
    const read = (line: string, prefix: string) => { if (!line?.startsWith(prefix)) throw new Error(); const value = decodeLine(line.slice(prefix.length)); if (typeof value !== 'string') throw new Error(); return value; };
    const priority = lines[3]?.slice('優先順序：'.length);
    const metadata = {project: read(lines[0], '專案：'), category: read(lines[1], '分類：'), status: read(lines[2], '狀態：'), priority: Object.entries(priorityLabels).find(([, label]) => label === priority)?.[0] ?? priority};
    if (!lines[3]?.startsWith('優先順序：') || !['high', 'medium', 'low'].includes(metadata.priority) || lines[4] !== '子任務：') return {...fallback, valid: false};
    const subtasks = lines.slice(5).map(line => { const match = /^\[([ x])\] (.*)$/.exec(line); if (!match) throw new Error(); const title = decodeLine(match[2]); if (typeof title !== 'string' || !title.trim()) throw new Error(); return {title, done: match[1] === 'x'}; });
    return {description: description.slice(0, index), subtasks, metadata: metadata as CalendarMetadata, valid: true};
  } catch { return {...fallback, valid: false}; }
}
function localMoment(date: string, time: string): Date {
  if (!date || !validDate(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('請補齊日期與時間。');
  const value = parseDate(date), [hours, minutes] = time.split(':').map(Number);
  value.setHours(hours, minutes, 0, 0);
  if (dateKey(value) !== date || value.getHours() !== hours || value.getMinutes() !== minutes) throw new Error('這個時間在目前時區不存在，請選擇其他時段。');
  return value;
}
export function eventSchedule(task: Task, choice: TransferSchedule): {start: GoogleMoment; end: GoogleMoment} {
  if (choice.mode === 'all-day') {
    if (!task.dueDate || !validDate(task.dueDate)) throw new Error('請先設定截止日期，才能建立全天截止提醒。');
    const end = parseDate(task.dueDate); end.setDate(end.getDate() + 1);
    if (end.getFullYear() > 9999) throw new Error('截止日期超出可支援的範圍。');
    return {start: {date: task.dueDate}, end: {date: dateKey(end)}};
  }
  if (choice.mode !== 'reserve' && choice.mode !== 'custom') throw new Error('請選擇活動時段。');
  if (choice.mode === 'reserve' && (task.dueDate && choice.endDate !== task.dueDate || task.dueTime && choice.endTime !== task.dueTime)) throw new Error('截止前預留時間必須以任務原有截止時間結束。若要改期，請選擇自行安排時段。');
  const end = localMoment(choice.endDate, choice.endTime);
  const start = choice.mode === 'reserve' ? new Date(end.getTime() - choice.minutes * 60000) : localMoment(choice.startDate, choice.startTime);
  if (choice.mode === 'reserve' && !(RESERVE_MINUTES as readonly number[]).includes(choice.minutes)) throw new Error('請選擇 15 分鐘、30 分鐘、1 小時或 2 小時。');
  if (start >= end || start.getFullYear() < 1900) throw new Error('活動結束必須晚於開始時間。');
  return {start: {dateTime: start.toISOString()}, end: {dateTime: end.toISOString()}};
}
export function createEventBody(task: Task, workspace: Workspace, choice: TransferSchedule, id: string): EventBody {
  if (!/^[0-9a-v]{5,1024}$/.test(id)) throw new Error('活動識別碼不合法。');
  return {id, summary: task.title, description: formatCalendarDescription(task, taskMetadata(task, workspace)), ...eventSchedule(task, choice), transparency: 'transparent', extendedProperties: {private: {orbitTransfer: id, orbitFormat: '1'}}};
}
export function originKey(source: Pick<CalendarOrigin, 'accountId' | 'calendarId'>, eventId: string): string { return JSON.stringify([source.accountId, source.calendarId, eventId]); }
export function plainGoogleDescription(description: string): string {
  return description.replace(/<br\s*\/?\s*>|<\/(p|div|li)>/gi, '\n').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').trim();
}
export function readCalendarMetadata(value: unknown): CalendarMetadata | null {
  const source = value as CalendarMetadata;
  return source && ['project', 'category', 'status'].every(key => typeof source[key as keyof CalendarMetadata] === 'string' && source[key as keyof CalendarMetadata].length <= 1000) && ['high', 'medium', 'low'].includes(source.priority) ? {project: source.project, category: source.category, status: source.status, priority: source.priority} : null;
}
export function readCalendarOrigin(value: unknown): CalendarOrigin | null {
  const source = value as CalendarOrigin, metadata = readCalendarMetadata(source?.metadata);
  if (!source || !metadata || !['accountId', 'calendarId', 'eventId', 'extra'].every(key => typeof source[key as keyof CalendarOrigin] === 'string') || !source.accountId || !source.calendarId || !source.eventId || [source.accountId, source.calendarId, source.eventId].some(item => item.length > 1000) || source.extra.length > 100000) return null;
  return {accountId: source.accountId, calendarId: source.calendarId, eventId: source.eventId, metadata, extra: source.extra};
}
export function readCalendarTransfers(value: unknown): CalendarTransfer[] | null {
  if (!Array.isArray(value)) return null;
  const result: CalendarTransfer[] = [];
  for (const source of value) {
    const metadata = readCalendarMetadata(source?.metadata);
    if (!metadata || !['accountId', 'calendarId', 'eventId', 'taskId', 'original', 'body'].every(key => typeof source[key] === 'string' && source[key].length <= 100000) || !source.accountId || !source.calendarId || !/^[0-9a-v]{5,1024}$/.test(source.eventId) || typeof source.published !== 'boolean') return null;
    try {
      const body = JSON.parse(source.body), original = JSON.parse(source.original);
      const parsed = typeof body.description === 'string' ? parseCalendarDescription(body.description) : undefined;
      if (body.id !== source.eventId || body.extendedProperties?.private?.orbitTransfer !== source.eventId || body.extendedProperties?.private?.orbitFormat !== '1' || body.transparency !== 'transparent' || typeof body.summary !== 'string' || !body.summary.trim() || typeof body.description !== 'string' || body.description.length > 19000 || !readGoogleEvent(body) || !parsed?.metadata || JSON.stringify(parsed.metadata) !== JSON.stringify(metadata) || !original || !['id', 'title', 'description', 'projectId', 'categoryId', 'status', 'priority', 'startDate', 'startTime', 'dueDate', 'dueTime'].every(key => typeof original[key] === 'string') || !Array.isArray(original.subtasks) || original.subtasks.some((item: {id?: string; title?: string; done?: boolean}) => !item || typeof item.id !== 'string' || typeof item.title !== 'string' || typeof item.done !== 'boolean')) return null;
      if (Object.keys(body).some(key => !['id', 'summary', 'description', 'start', 'end', 'transparency', 'extendedProperties'].includes(key))) return null;
    } catch { return null; }
    result.push({accountId: source.accountId, calendarId: source.calendarId, eventId: source.eventId, taskId: source.taskId, original: source.original, body: source.body, metadata, published: source.published});
  }
  if (new Set(result.map(item => originKey(item, item.eventId))).size !== result.length) return null;
  return result;
}
export function copyEventTask(entry: ExternalEvent, workspace: Workspace, defaults?: CalendarMetadata, newId: () => string = () => crypto.randomUUID()): Task {
  if (entry.event.contentComplete === false) throw new Error('Google 活動內容超過可完整複製的範圍，請先縮短內容再試。Google 與 Orbit 資料仍保留。');
  const parsed = parseCalendarDescription(entry.event.description), metadata = parsed.metadata ?? defaults ?? {project: '', category: '', status: '', priority: 'medium'};
  return {id: newId(), title: entry.event.summary || '未命名活動', description: parsed.metadata || !parsed.valid ? parsed.description : plainGoogleDescription(parsed.description), projectId: namedId(workspace.projects, metadata.project), categoryId: namedId(workspace.categories, metadata.category), status: namedId(workspace.statuses, metadata.status) || workspace.statuses.find(item => item.kind === 'active')?.id || workspace.statuses[0].id, priority: metadata.priority, startDate: entry.task.startDate, startTime: entry.task.startTime, dueDate: entry.task.dueDate, dueTime: entry.task.dueTime, subtasks: parsed.subtasks.map(item => ({...item, id: newId()}))};
}
