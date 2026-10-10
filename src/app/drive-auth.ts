import { Injectable } from '@angular/core';
import { GoogleAuth } from './google-auth';
import { DRIVE_CONTROL_PREFIX, DRIVE_SCOPE, DRIVE_SESSION_KEY } from './drive-data';
import type { SessionOptions } from './google-session';

@Injectable({providedIn: 'root'})
export class DriveAuth extends GoogleAuth {
  protected override get sessionOptions(): SessionOptions { return {scope: DRIVE_SCOPE, storageKey: DRIVE_SESSION_KEY, controlPrefix: DRIVE_CONTROL_PREFIX}; }
  protected override get sessionChannel(): string { return 'iih-orbit-drive-session'; }
  protected override get permissionMessage(): string { return '請允許 IIH Orbit 存取自行建立的 Drive 備份檔。'; }
  protected override get networkMessage(): string { return 'Drive 連線中斷或逾時，已保留本機資料與待上傳版本。'; }
  protected override get resourceName(): string { return 'Drive 備份'; }
  protected override get maxResponseBytes(): number { return 20 * 1024 * 1024; }
  protected override get requestTimeoutMs(): number { return 60000; }
  api(path: string, parameters: Record<string, string> = {}, options: RequestInit = {}): Promise<unknown> {
    return this.fetchJson('https://www.googleapis.com/drive/v3/' + path + '?' + new URLSearchParams(parameters), options);
  }
  upload(url: string, options: RequestInit): Promise<Response> {
    const target = new URL(url);
    if (target.origin !== 'https://www.googleapis.com' || !/^\/upload\/drive\/v3\/files(?:\/[A-Za-z0-9_-]{5,200})?$/.test(target.pathname)) throw new Error('Drive 上傳位址不合法。');
    return this.fetchResponse(url, options);
  }
}
