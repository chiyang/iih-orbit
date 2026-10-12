import { Injectable } from '@angular/core';
import { GoogleAuth } from './google-auth';
import { GMAIL_SCOPE } from './gmail-data';
import type { SessionOptions } from './google-session';
import type { GoogleSessionContext } from './google-session';
import { GmailReadQueue } from './gmail-requests';

@Injectable({providedIn: 'root'})
export class GmailAuth extends GoogleAuth {
  private readonly reads = new GmailReadQueue((url, _parameters, signal) => this.fetchJson(url, {signal}));
  protected override get sessionOptions(): SessionOptions { return {scope: GMAIL_SCOPE, storageKey: 'iih-orbit-gmail-session-v1', controlPrefix: 'iih-orbit-gmail-session-control-v1:', sharedStorage: true}; }
  protected override get sessionPersistence(): 'browser' { return 'browser'; }
  protected override get sessionChannel(): string { return 'iih-orbit-gmail-session'; }
  protected override get permissionMessage(): string { return '請允許讀取 Gmail 郵件，才能瀏覽並複製為任務。'; }
  protected override get networkMessage(): string { return 'Gmail 連線中斷或逾時，請確認網路後再試。'; }
  protected override get resourceName(): string { return 'Gmail 郵件'; }
  protected override get maxResponseBytes(): number { return 2 * 1024 * 1024; }
  override useSession(context: GoogleSessionContext): void {
    this.reads.useContext(JSON.stringify([context.generation, context.clientId, context.accountId]));
    super.useSession(context);
  }
  api(path: string, parameters: Record<string, string> = {}, signal?: AbortSignal): Promise<unknown> {
    if (!/^(profile|history|labels|threads(?:\/[A-Za-z0-9_-]{1,200})?|messages(?:\/[A-Za-z0-9_-]{1,200}(?:\/attachments\/[A-Za-z0-9_-]{1,1000})?)?)$/.test(path)) throw new Error('Gmail 讀取位址不正確。');
    // metadataHeaders is a repeated query parameter, not a comma-separated header name.
    const query = new URLSearchParams(parameters); query.delete('metadataHeaders');
    if (parameters['metadataHeaders']) for (const name of parameters['metadataHeaders'].split(',')) query.append('metadataHeaders', name);
    const version = this.connectionVersion();
    return this.reads.read('https://www.googleapis.com/gmail/v1/users/me/' + path + '?' + query, undefined, signal, () => version === this.connectionVersion());
  }
}
