import {signal} from '@angular/core';
import type {DriveBrowserAuth} from './drive-browser-auth';
import type {DriveSourceProfile} from './drive-source-data';
import type {GoogleAccount} from './google-auth';

/** One local source. Its account and credential never become document identity. */
export class DriveSourceConnection {
  readonly profile;
  readonly account = signal({id: '', email: ''});
  readonly context = signal('');
  readonly connecting = signal(false);
  readonly warning = signal('');
  readonly error = signal('');
  private request = 0;
  private destroyed = false;
  constructor(profile: DriveSourceProfile, readonly auth: DriveBrowserAuth, private readonly generation: () => string, private readonly saveAccount: (id: string, account: GoogleAccount) => Promise<boolean>) {
    this.profile = signal(profile); this.synchronize(profile);
  }
  get id(): string {return this.profile().id;}
  name(): string {return this.profile().name;}
  clientId(): string {return this.profile().clientId;}
  synchronize(profile = this.profile()): void {
    const context = JSON.stringify([this.generation(), profile.clientId, profile.accountId]);
    if (context !== this.context()) {this.cancelAuthorization(); this.account.set({id: profile.accountId, email: profile.email}); this.context.set(context);}
    this.profile.set(profile);
    this.auth.useSession({generation: this.generation(), clientId: profile.clientId, accountId: profile.accountId});
  }
  prepare(): Promise<void> {return this.auth.prepare();}
  async connect(selectAccount = false): Promise<boolean> {
    if (this.destroyed || !this.auth.ready() || this.connecting() || this.auth.authorizing()) return false;
    const context = this.context(), generation = this.generation(), accountId = this.account().id, clientId = this.clientId(), request = ++this.request;
    this.connecting.set(true); this.error.set(''); this.warning.set('');
    try {
      const account = await this.auth.authorize(clientId, {selectAccount: selectAccount || !accountId, ...(!selectAccount && accountId ? {expectedAccountId: accountId, loginHint: accountId} : {})});
      if (this.destroyed || request !== this.request || context !== this.context() || generation !== this.generation()) return false;
      this.auth.useSession({generation, clientId, accountId: account.id});
      if (!await this.saveAccount(this.id, account)) {this.auth.disconnect(); this.error.set('來源帳號未保存，請重試。任務中的資訊連結保留。'); return false;}
      return true;
    } catch (error) {if (!this.destroyed && request === this.request) this.error.set(error instanceof Error ? error.message : '來源授權未完成，請重試。'); return false;}
    finally {if (request === this.request) this.connecting.set(false);}
  }
  cancelAuthorization(): void {this.request++; this.connecting.set(false); if (this.auth.authorizing()) this.auth.disconnect('來源或操作已更新，請重新連線。');}
  disconnect(): void {this.cancelAuthorization(); this.error.set(''); this.auth.disconnect('來源已解除連線，任務中的資訊連結保留。');}
  destroy(): void {this.destroyed = true; this.cancelAuthorization();}
}
