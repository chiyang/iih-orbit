import {validDate, validTime} from './task-schedule.ts';

export const REMINDER_HISTORY_KEY = 'iih-orbit-reminder-history-v1';
export const MAX_REMINDER_HISTORY = 500;
export const REMINDER_HISTORY_AGE = 30 * 86400000;
export interface ReminderHistoryEntry {
  key: string;
  generation: string;
  workspaceId: string;
  workspaceIds: string[];
  workspaceName: string;
  itemId: string;
  taskId: string;
  title: string;
  source: 'orbit' | 'google';
  sourceId: string;
  sourceName: string;
  stage: 'today' | 'overdue' | 'due-soon' | 'upcoming';
  startDate: string;
  startTime: string;
  dueDate: string;
  dueTime: string;
  at: number;
  readAt?: number;
  dismissedAt?: number;
  popupAt?: number;
}
export type ReminderHistoryUpdate = Partial<Pick<ReminderHistoryEntry, 'readAt' | 'dismissedAt' | 'popupAt'>>;
const text = (value: unknown, limit = 1000): value is string => typeof value === 'string' && value.length <= limit;
const time = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 8640000000000000;

export function readReminderHistory(value: unknown, now: number): ReminderHistoryEntry[] {
  if (!value || typeof value !== 'object') return [];
  const source = value as {version?: unknown; entries?: unknown};
  if (source.version !== 1 || !Array.isArray(source.entries)) return [];
  const entries = new Map<string, ReminderHistoryEntry>();
  for (const entry of source.entries.slice(-MAX_REMINDER_HISTORY * 2)) {
    if (!entry || !text(entry.key, 2000) || !entry.key || !text(entry.generation, 500) || !entry.generation
      || !text(entry.workspaceId, 500) || !entry.workspaceId || !text(entry.workspaceName) || !Array.isArray(entry.workspaceIds)
      || !entry.workspaceIds.length || entry.workspaceIds.length > 1000 || !entry.workspaceIds.every((id: unknown) => text(id, 500) && !!id)
      || !entry.workspaceIds.includes(entry.workspaceId) || !text(entry.itemId, 1500) || !entry.itemId || !text(entry.taskId, 1500) || !entry.taskId
      || !text(entry.title) || !entry.title.trim() || !['orbit', 'google'].includes(entry.source) || !text(entry.sourceId, 500) || !text(entry.sourceName)
      || !['today', 'overdue', 'due-soon', 'upcoming'].includes(entry.stage)
      || !text(entry.startDate, 10) || !validDate(entry.startDate) || !text(entry.dueDate, 10) || !validDate(entry.dueDate)
      || !text(entry.startTime, 5) || !validTime(entry.startTime) || !text(entry.dueTime, 5) || !validTime(entry.dueTime)
      || !time(entry.at) || entry.at < now - REMINDER_HISTORY_AGE
      || [entry.readAt, entry.dismissedAt, entry.popupAt].some(value => value !== undefined && !time(value))) continue;
    entries.set(entry.key, {key: entry.key, generation: entry.generation, workspaceId: entry.workspaceId, workspaceIds: [...new Set(entry.workspaceIds as string[])], workspaceName: entry.workspaceName,
      itemId: entry.itemId, taskId: entry.taskId, title: entry.title, source: entry.source, sourceId: entry.sourceId, sourceName: entry.sourceName, stage: entry.stage,
      startDate: entry.startDate, startTime: entry.startTime, dueDate: entry.dueDate, dueTime: entry.dueTime, at: entry.at,
      ...(entry.readAt === undefined ? {} : {readAt: entry.readAt}), ...(entry.dismissedAt === undefined ? {} : {dismissedAt: entry.dismissedAt}), ...(entry.popupAt === undefined ? {} : {popupAt: entry.popupAt})});
  }
  return [...entries.values()].sort((a, b) => a.at - b.at || a.key.localeCompare(b.key)).slice(-MAX_REMINDER_HISTORY);
}

/** Browser-local inbox snapshots. Serialized writes preserve acknowledgements from other tabs. */
export class ReminderHistory {
  private readonly storage: {getItem(key: string): string | null; setItem(key: string, value: string): void};
  private readonly lock: <T>(operation: () => T) => Promise<T>;
  constructor(storage: ReminderHistory['storage'], lock: ReminderHistory['lock']) {this.storage = storage; this.lock = lock;}
  read(now: number): ReminderHistoryEntry[] {
    const value = this.storage.getItem(REMINDER_HISTORY_KEY);
    try {return readReminderHistory(JSON.parse(value ?? 'null'), now);} catch {return [];}
  }
  save(additions: readonly ReminderHistoryEntry[], keys: readonly string[], update: ReminderHistoryUpdate, now: number, current: () => boolean = () => true): Promise<ReminderHistoryEntry[]> {
    return this.lock(() => {
      if (!current()) return [];
      const entries = new Map(this.read(now).map(entry => [entry.key, entry]));
      for (const entry of additions) if (!entries.has(entry.key)) entries.set(entry.key, {...entry});
      for (const key of keys) {const entry = entries.get(key); if (entry) entries.set(key, {...entry, ...update});}
      const result = readReminderHistory({version: 1, entries: [...entries.values()]}, now);
      this.storage.setItem(REMINDER_HISTORY_KEY, JSON.stringify({version: 1, entries: result}));
      return result;
    });
  }
}
