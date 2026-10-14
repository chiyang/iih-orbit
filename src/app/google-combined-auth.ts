import { Injectable } from '@angular/core';
import { GoogleAuth } from './google-auth';
import { CALENDAR_SCOPE } from './google-data';
import { CALENDAR_WRITE_SCOPE } from './calendar-write-auth';
import { GMAIL_SCOPE } from './gmail-data';
import { DRIVE_SCOPE } from './drive-data';
import { DRIVE_BROWSER_SCOPE } from './drive-browser-data';
import type { SessionOptions } from './google-session';

export const COMBINED_GOOGLE_SCOPE = [...new Set(`${CALENDAR_WRITE_SCOPE} ${GMAIL_SCOPE} ${DRIVE_SCOPE} ${DRIVE_BROWSER_SCOPE}`.split(' '))].join(' ');

/** One consent window; the temporary combined credential is never persisted. */
@Injectable({providedIn: 'root'})
export class GoogleCombinedAuth extends GoogleAuth {
  protected override get sessionOptions(): SessionOptions { return {scope: COMBINED_GOOGLE_SCOPE, storageKey: 'iih-orbit-combined-session', controlPrefix: 'iih-orbit-combined-control:'}; }
  protected override get sessionPersistence(): 'memory' { return 'memory'; }
  protected override get sessionChannel(): string { return 'iih-orbit-combined-session'; }
  protected override get permissionMessage(): string { return '尚未取得任何服務的權限，可使用下方按鈕分別連線。'; }
  protected override acceptsScopes(scopes: string[]): boolean { return [CALENDAR_SCOPE, GMAIL_SCOPE, DRIVE_SCOPE, DRIVE_BROWSER_SCOPE].some(scope => scopes.includes(scope)); }
}
