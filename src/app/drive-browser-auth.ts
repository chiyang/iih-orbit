import { Injectable } from '@angular/core';
import { GoogleAuth } from './google-auth';
import type { SessionOptions } from './google-session';
import { DRIVE_BROWSER_SCOPE, validBrowserId } from './drive-browser-data';

@Injectable({providedIn: 'root'})
export class DriveBrowserAuth extends GoogleAuth {
  protected override get sessionOptions(): SessionOptions {return {scope: DRIVE_BROWSER_SCOPE, storageKey: 'iih-orbit-drive-browser-session-v1', controlPrefix: 'iih-orbit-drive-browser-control-v1:'};}
  protected override get sessionChannel(): string {return 'iih-orbit-drive-browser-session';}
  protected override get permissionMessage(): string {return '請允許讀取 Google Drive 的檔案名稱與資料夾資訊。';}
  protected override get networkMessage(): string {return 'Drive 檔案列表讀取中斷或逾時，原列表與任務保留。';}
  protected override get resourceName(): string {return 'Drive 檔案資訊';}
  protected override get maxResponseBytes(): number {return 2 * 1024 * 1024;}
  api(path: string, parameters: Record<string, string>, signal?: AbortSignal, resourceKeys?: string): Promise<unknown> {
    if (path !== 'files' || parameters['alt'] || parameters['fields']?.includes('*')) throw new Error('檔案瀏覽只允許讀取 Drive 清單資訊。');
    if (resourceKeys && !resourceKeys.split(',').every(pair => {const parts = pair.split('/'); return parts.length === 2 && parts.every(validBrowserId);})) throw new Error('Drive 共用資料夾資訊不合法。');
    return this.fetchJson('https://www.googleapis.com/drive/v3/files?' + new URLSearchParams(parameters), {signal, ...(resourceKeys ? {headers: {'X-Goog-Drive-Resource-Keys': resourceKeys}} : {})});
  }
}
