import type { CalendarRange, GoogleEvent } from './google-data.ts';
import { mergeGoogleEvents, readGoogleEvent } from './google-data.ts';
import { validHex } from './appearance-data.ts';

export class GoogleHttpError extends Error {
  readonly status: number;
  constructor(status: number, resource = '月曆') {
    super(status === 401 ? 'Google 授權已到期，請重新連線。' : status === 403 ? `無法存取${resource}，請檢查 API 是否啟用、授權權限與存取權。` : status === 429 ? 'Google 暫時限制讀取次數，請稍後再試。' : status === 404 ? `${resource}已不存在或無法存取，請重新選擇。` : 'Google 暫時無法回應，請稍後再試。');
    this.status = status;
  }
}
export interface AvailableCalendar {id: string; name: string; color: string; timeZone: string}
export interface CalendarViewCache {rangeKey: string; events: GoogleEvent[]; updatedAt: string; invalidated?: boolean}
export interface CalendarSnapshot {key: string; events: GoogleEvent[]; syncToken: string; updatedAt: string; views: CalendarViewCache[]}
export type GoogleRequest = (path: string, parameters: Record<string, string>) => Promise<unknown>;

/** Reuse a covering query, including existing caches saved before the views shared a month. */
export function calendarViewForRange(snapshot: CalendarSnapshot | undefined, range: CalendarRange): CalendarViewCache | undefined {
  return snapshot?.views.filter(view => {
    try {
      const [start, end, timeZone] = JSON.parse(view.rangeKey);
      return timeZone === range.timeZone && Date.parse(start) <= Date.parse(range.start) && Date.parse(end) >= Date.parse(range.end);
    } catch { return false; }
  }).sort((left, right) => Number(!!left.invalidated) - Number(!!right.invalidated) || Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
}

/** GET-only Calendar API; cursor queries and date-filtered instance queries stay separate. */
export class CalendarApi {
  private readonly request: GoogleRequest;
  constructor(request: GoogleRequest) { this.request = request; }

  private async pages(path: string, parameters: Record<string, string>): Promise<{items: unknown[]; syncToken: string}> {
    const items: unknown[] = [];
    const visited = new Set<string>();
    let pageToken = '', syncToken = '';
    do {
      if (visited.has(pageToken) || visited.size >= 200) throw new Error('月曆分頁資料異常或資料量過大，請稍後再試。');
      visited.add(pageToken);
      const response = await this.request(path, {...parameters, ...(pageToken ? {pageToken} : {})}) as {items?: unknown[]; nextPageToken?: string; nextSyncToken?: string};
      if (!response || (response.items !== undefined && !Array.isArray(response.items))) throw new Error('Google 月曆回應不完整，未取代原有快取。');
      items.push(...response.items ?? []);
      if ((response.nextPageToken !== undefined && typeof response.nextPageToken !== 'string') || (response.nextSyncToken !== undefined && typeof response.nextSyncToken !== 'string')) throw new Error('Google 月曆分頁資訊不完整。');
      pageToken = response.nextPageToken ?? '';
      syncToken = response.nextSyncToken ?? '';
    } while (pageToken);
    return {items, syncToken};
  }

  async calendars(): Promise<AvailableCalendar[]> {
    const result = await this.pages('users/me/calendarList', {maxResults: '250', minAccessRole: 'reader', showHidden: 'true'});
    return result.items.map(value => {
      const source = value as {id: string; summary?: string; summaryOverride?: string; backgroundColor?: string; timeZone?: string};
      if (!source || typeof source.id !== 'string' || !source.id) throw new Error('Google 月曆清單不完整。');
      return {id: source.id, name: source.summaryOverride || source.summary || source.id, color: validHex(source.backgroundColor) ? source.backgroundColor : '#759acb', timeZone: source.timeZone || ''};
    });
  }

  private events(items: unknown[]): GoogleEvent[] {
    return items.map(item => { const event = readGoogleEvent(item); if (!event) throw new Error('活動的日期或格式不完整，原有快取仍保留。'); return event; });
  }

  async sync(calendarId: string, previous?: CalendarSnapshot): Promise<{events: GoogleEvent[]; syncToken: string}> {
    const path = 'calendars/' + encodeURIComponent(calendarId) + '/events';
    const base = {maxResults: '2500', singleEvents: 'false', showDeleted: 'true'};
    let result;
    let full = !previous?.syncToken;
    try { result = await this.pages(path, {...base, ...(full ? {} : {syncToken: previous!.syncToken})}); }
    catch (error) {
      if (!(error instanceof GoogleHttpError) || error.status !== 410 || full) throw error;
      full = true;
      result = await this.pages(path, base);
    }
    if (!result.syncToken) throw new Error('Google 未提供同步游標，原有快取仍保留。');
    return {events: mergeGoogleEvents(full ? [] : previous!.events, this.events(result.items)), syncToken: result.syncToken};
  }

  async instances(calendarId: string, range: CalendarRange): Promise<GoogleEvent[]> {
    const result = await this.pages('calendars/' + encodeURIComponent(calendarId) + '/events', {
      maxResults: '2500', singleEvents: 'true', showDeleted: 'false', timeMin: range.start, timeMax: range.end, timeZone: range.timeZone
    });
    return mergeGoogleEvents([], this.events(result.items)).filter(event => event.status !== 'cancelled');
  }
}
