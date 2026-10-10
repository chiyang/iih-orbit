import type { AvailableCalendar } from './google-api';
import type { GoogleSettings } from './google-data';
import { validHex } from './appearance-data.ts';

const STORAGE_KEY = 'iih-orbit-calendar-list-v1';
export const CALENDAR_LIST_TTL = 5 * 60000;
export function calendarListScope(generation: string, settings: GoogleSettings): string { return JSON.stringify([generation, settings.clientId, settings.accountId]); }
export interface CachedCalendarList {scope: string; updatedAt: number; calendars: AvailableCalendar[]}

/** Device-local calendar metadata only; no events or OAuth credentials. */
export class CalendarListCache {
  private memory?: CachedCalendarList;
  read(scope: string, now = Date.now()): CachedCalendarList | undefined {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === null) return this.memory?.scope === scope ? this.memory : undefined;
      const value = JSON.parse(stored) as CachedCalendarList;
      if (!value || value.scope !== scope || !Number.isFinite(value.updatedAt) || value.updatedAt <= 0 || value.updatedAt > now + 1000 || !Array.isArray(value.calendars) || value.calendars.length > 20000) return;
      if (value.calendars.some(item => !item || typeof item.id !== 'string' || !item.id || typeof item.name !== 'string' || typeof item.timeZone !== 'string' || !validHex(item.color) || item.accessRole !== undefined && typeof item.accessRole !== 'string') || new Set(value.calendars.map(item => item.id)).size !== value.calendars.length) return;
      return {scope, updatedAt: value.updatedAt, calendars: value.calendars.map(item => ({id: item.id, name: item.name, color: item.color, timeZone: item.timeZone, ...(item.accessRole ? {accessRole: item.accessRole} : {})}))};
    } catch { return this.memory?.scope === scope ? this.memory : undefined; }
  }
  write(scope: string, calendars: AvailableCalendar[], now = Date.now()): void {
    this.memory = {scope, updatedAt: now, calendars: calendars.map(item => ({...item}))};
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.memory)); }
    catch { /* Retain the service's in-memory list when local storage is unavailable. */ }
  }
}
