import { Injectable } from '@angular/core';
import { GoogleAuth } from './google-auth';
import { CALENDAR_SCOPE } from './google-data';
import type { SessionOptions } from './google-session';

export const CALENDAR_WRITE_SCOPE = CALENDAR_SCOPE + ' https://www.googleapis.com/auth/calendar.events';
@Injectable({providedIn: 'root'})
export class CalendarWriteAuth extends GoogleAuth {
  protected override get sessionOptions(): SessionOptions { return {scope: CALENDAR_WRITE_SCOPE, storageKey: 'iih-orbit-calendar-write-session-v1', controlPrefix: 'iih-orbit-calendar-write-control-v1:'}; }
  protected override get sessionChannel(): string { return 'iih-orbit-calendar-write-session'; }
  protected override get permissionMessage(): string { return '請允許 IIH Orbit 建立 Google Calendar 活動。'; }
  protected override get networkMessage(): string { return 'Google 連線中斷，Orbit 任務仍保留。重試會確認同一個活動。'; }
  api(path: string, parameters: Record<string, string> = {}, options: RequestInit = {}): Promise<unknown> {
    return this.fetchJson('https://www.googleapis.com/calendar/v3/' + path + '?' + new URLSearchParams(parameters), options);
  }
}
