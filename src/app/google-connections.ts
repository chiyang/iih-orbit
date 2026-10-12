import { computed, effect, inject, Injectable, OnDestroy, signal, untracked } from '@angular/core';
import { BoardStore } from './board-store';
import { GoogleCalendarService } from './google-calendar';
import { CalendarWriteAuth, CALENDAR_WRITE_SCOPE } from './calendar-write-auth';
import { GmailService } from './gmail-service';
import { DriveService } from './drive-service';
import { CALENDAR_SCOPE } from './google-data';
import { GMAIL_SCOPE } from './gmail-data';
import { DRIVE_SCOPE } from './drive-data';
import { GoogleCombinedAuth } from './google-combined-auth';
import type { GoogleAuth } from './google-auth';

/** Shared consent and connection state for settings and the direct renewal button. */
@Injectable({providedIn: 'root'})
export class GoogleConnections implements OnDestroy {
  readonly store = inject(BoardStore);
  readonly calendar = inject(GoogleCalendarService);
  readonly writeAuth = inject(CalendarWriteAuth);
  readonly gmail = inject(GmailService);
  readonly drive = inject(DriveService);
  readonly combined = inject(GoogleCombinedAuth);
  readonly preparing = signal(false);
  readonly connectingAll = signal(false);
  readonly error = signal('');
  readonly message = signal('');
  private destroyed = false;
  private requestVersion = 0;
  readonly busy = computed(() => this.connectingAll() || this.store.pendingWrites() > 0 || this.calendar.auth.authorizing() || this.writeAuth.authorizing() || this.gmail.auth.authorizing() || this.drive.busy());
  readonly allConnected = computed(() => !!this.store.google().clientId && [this.calendar.auth, this.gmail.auth, this.drive.auth, this.writeAuth].every(auth => auth.connected()));
  readonly renewalNeeded = computed(() => !!this.store.google().clientId && [this.calendar.auth, this.gmail.auth, this.drive.auth, this.writeAuth].some(auth => auth.expired()));
  readonly canConnect = computed(() => !!this.store.google().clientId && this.combined.ready() && this.drive.online() && !this.busy() && !this.drive.runtime().pending);
  constructor() {
    effect(() => {const id = this.store.google().clientId; untracked(() => {if (id) void this.prepare();});});
    effect(() => {
      const context = {generation: this.store.generation(), clientId: this.store.google().clientId, accountId: this.store.google().accountId};
      const connecting = this.connectingAll();
      untracked(() => {if (!this.writeAuth.authorizing() && !connecting) this.writeAuth.useSession(context);});
    });
  }
  async prepare(): Promise<void> {
    if (this.preparing()) return;
    this.preparing.set(true); this.error.set('');
    try {await Promise.all([this.calendar.auth, this.gmail.auth, this.drive.auth, this.combined].map(auth => auth.prepare()));}
    catch (error) {this.error.set(error instanceof Error ? error.message : '無法載入 Google 授權元件。');}
    finally {this.preparing.set(false);}
  }
  private accountConfiguration(): string {
    return JSON.stringify([this.store.generation(), this.store.google().clientId, this.store.google().accountId, this.store.drive().accountId, this.gmail.preferences().accountId]);
  }
  async connectAll(): Promise<void> {
    const clientId = this.store.google().clientId, generation = this.store.generation();
    if (this.busy() || !clientId || !this.combined.ready() || !this.drive.online()) return;
    if (this.drive.runtime().pending) {this.error.set('請先完成 Drive 等待上傳的資料，再一次授權全部服務。'); return;}
    const configuration = this.accountConfiguration();
    const request = ++this.requestVersion;
    const targets = [this.calendar.auth, this.gmail.auth, this.drive.auth, this.writeAuth];
    const accounts = [this.store.google().accountId, this.gmail.preferences().accountId, this.store.drive().accountId, this.store.google().accountId];
    const markers = new Map<GoogleAuth, string>();
    targets.forEach((auth, index) => {auth.useSession({clientId, generation, accountId: accounts[index]}); markers.set(auth, auth.authorizationMarker());});
    this.combined.useSession({clientId, generation, accountId: ''});
    this.connectingAll.set(true); this.error.set(''); this.message.set('');
    try {
      const account = await this.combined.authorize(clientId);
      if (this.destroyed || request !== this.requestVersion || configuration !== this.accountConfiguration() || targets.some(auth => !auth.authorizationIsCurrent(markers.get(auth)!))) throw new Error('帳號或設定已變更，請重新授權。');
      const context = {clientId, generation, accountId: account.id};
      this.combined.useSession(context);
      const activate = (auth: GoogleAuth) => () => {
        if (this.destroyed || request !== this.requestVersion || generation !== this.store.generation() || clientId !== this.store.google().clientId) throw new Error('資料或 Client ID 已變更，請重新授權。');
        this.combined.copyAuthorizationTo(auth, context, markers.get(auth)!);
      };
      const services = [
        {name: 'Calendar', scope: CALENDAR_SCOPE, auth: this.calendar.auth, connect: () => this.calendar.connect(async () => account, activate(this.calendar.auth))},
        {name: 'Gmail', scope: GMAIL_SCOPE, auth: this.gmail.auth, connect: () => this.gmail.connect(async () => account, activate(this.gmail.auth))},
        {name: 'Drive', scope: DRIVE_SCOPE, auth: this.drive.auth, connect: () => this.drive.connect(async () => account, activate(this.drive.auth))}
      ];
      const approved = services.filter(service => this.combined.hasScope(service.scope));
      if (this.combined.hasScope(CALENDAR_SCOPE)) this.writeAuth.useSession(context);
      await Promise.all(approved.map(service => service.connect()));
      if (this.destroyed || request !== this.requestVersion || generation !== this.store.generation() || clientId !== this.store.google().clientId) return;
      if (this.combined.hasScope(CALENDAR_WRITE_SCOPE) && this.calendar.auth.connected() && this.store.google().accountId === account.id) {
        this.writeAuth.useSession(context); activate(this.writeAuth)();
      }
      const connected = approved.filter(service => service.auth.connected() && service.auth.account()?.id === account.id).map(service => service.name);
      const missing = services.filter(service => !this.combined.hasScope(service.scope)).map(service => service.name);
      if (this.combined.hasScope(CALENDAR_SCOPE) && !this.combined.hasScope(CALENDAR_WRITE_SCOPE)) missing.push('Calendar 寫入');
      if (connected.length) this.message.set(`已連線：${connected.join('、')}（${account.email}）。`);
      if (missing.length) this.error.set(`本次尚未取得 ${missing.join('、')} 權限，可到 Google 連線設定分別授權。`);
      else if (connected.length !== services.length) this.error.set('部分服務尚未完成連線，請查看 Google 連線設定中的訊息。');
    } catch (error) {if (!this.destroyed && request === this.requestVersion) this.error.set(error instanceof Error ? error.message : 'Google 授權未完成，可分別連線所需服務。');}
    finally {this.combined.disconnect(); this.connectingAll.set(false);}
  }
  cancelAll(): void {this.requestVersion++; this.combined.disconnect();}
  ngOnDestroy(): void {this.destroyed = true; this.cancelAll();}
}
