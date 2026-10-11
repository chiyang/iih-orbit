import { Component, computed, effect, inject, linkedSignal, OnDestroy, output, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { BoardStore } from './board-store';
import { GoogleCalendarService } from './google-calendar';
import { CalendarWriteAuth, CALENDAR_WRITE_SCOPE } from './calendar-write-auth';
import { GmailService } from './gmail-service';
import { DriveService } from './drive-service';
import { validClientId, CALENDAR_SCOPE } from './google-data';
import { GMAIL_SCOPE } from './gmail-data';
import { DRIVE_SCOPE } from './drive-data';
import { GoogleCombinedAuth } from './google-combined-auth';
import type { GoogleAuth } from './google-auth';

@Component({selector: 'app-google-connection', imports: [FormsModule], templateUrl: './google-connection.html', styleUrls: ['./google-settings.css', './google-connection.css']})
export class GoogleConnection implements OnDestroy {
  readonly store = inject(BoardStore);
  readonly calendar = inject(GoogleCalendarService);
  readonly writeAuth = inject(CalendarWriteAuth);
  readonly gmail = inject(GmailService);
  readonly drive = inject(DriveService);
  readonly combined = inject(GoogleCombinedAuth);
  readonly configure = output<'calendar' | 'gmail' | 'drive'>();
  readonly draft = linkedSignal(() => this.store.google().clientId || this.gmail.preferences().clientId);
  readonly saving = signal(false);
  readonly preparing = signal(false);
  readonly connectingAll = signal(false);
  private destroyed = false;
  readonly error = signal('');
  readonly message = signal('');
  readonly busy = computed(() => this.saving() || this.connectingAll() || this.store.pendingWrites() > 0 || this.calendar.auth.authorizing() || this.writeAuth.authorizing() || this.gmail.auth.authorizing() || this.drive.busy());
  readonly unsaved = computed(() => this.draft().trim() !== this.store.google().clientId);
  constructor() {
    effect(() => { const id = this.store.google().clientId; untracked(() => { if (id) void this.prepare(); }); });
  }
  async prepare(): Promise<void> {
    if (this.preparing()) return;
    this.preparing.set(true); this.error.set('');
    try {
      await this.calendar.auth.prepare();
      await Promise.all([this.gmail.auth.prepare(), this.drive.auth.prepare(), this.combined.prepare()]);
    } catch (error) { this.error.set(error instanceof Error ? error.message : '無法載入 Google 授權元件。'); }
    finally { this.preparing.set(false); }
  }
  async save(): Promise<void> {
    if (this.busy()) return;
    const clientId = this.draft().trim();
    if (!clientId || !validClientId(clientId)) { this.error.set('請貼上完整的 OAuth Client ID，結尾為 .apps.googleusercontent.com。'); return; }
    if (clientId !== this.store.google().clientId && this.drive.runtime().pending) { this.error.set('請先完成 Drive 等待上傳的資料，再更換 Client ID。'); return; }
    this.saving.set(true); this.error.set('');
    try {
      const result = await this.store.updateGoogle({clientId});
      if (!result.ok) this.error.set(result.message);
      else { this.draft.set(clientId); this.message.set(result.persisted ? 'Google Client ID 已保存，請選擇要啟用的服務。' : 'Client ID 只暫存在此分頁，重新整理後需重新設定。'); void this.prepare(); }
    } finally { this.saving.set(false); }
  }

  private accountConfiguration(): string {
    return JSON.stringify([this.store.generation(), this.store.google().clientId, this.store.google().accountId, this.store.drive().accountId, this.gmail.preferences().accountId]);
  }

  async connectAll(): Promise<void> {
    const clientId = this.store.google().clientId, generation = this.store.generation();
    if (this.busy() || this.unsaved() || !clientId || !this.combined.ready() || !this.drive.online()) return;
    if (this.drive.runtime().pending) { this.error.set('請先完成 Drive 等待上傳的資料，再一次授權全部服務。'); return; }
    const configuration = this.accountConfiguration();
    const targets = [this.calendar.auth, this.gmail.auth, this.drive.auth, this.writeAuth];
    const accounts = [this.store.google().accountId, this.gmail.preferences().accountId, this.store.drive().accountId, this.store.google().accountId];
    const markers = new Map<GoogleAuth, string>();
    targets.forEach((auth, index) => { auth.useSession({clientId, generation, accountId: accounts[index]}); markers.set(auth, auth.authorizationMarker()); });
    this.combined.useSession({clientId, generation, accountId: ''});
    this.connectingAll.set(true); this.error.set(''); this.message.set('');
    try {
      const account = await this.combined.authorize(clientId);
      if (this.destroyed || configuration !== this.accountConfiguration() || targets.some(auth => !auth.authorizationIsCurrent(markers.get(auth)!))) throw new Error('帳號或設定已變更，請重新授權。');
      const context = {clientId, generation, accountId: account.id};
      this.combined.useSession(context);
      const activate = (auth: GoogleAuth) => () => {
        if (this.destroyed || generation !== this.store.generation() || clientId !== this.store.google().clientId) throw new Error('資料或 Client ID 已變更，請重新授權。');
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
      if (this.destroyed || generation !== this.store.generation() || clientId !== this.store.google().clientId) return;
      if (this.combined.hasScope(CALENDAR_WRITE_SCOPE) && this.calendar.auth.connected() && this.store.google().accountId === account.id) {
        this.writeAuth.useSession(context); activate(this.writeAuth)();
      }
      const connected = approved.filter(service => service.auth.connected() && service.auth.account()?.id === account.id).map(service => service.name);
      const missing = services.filter(service => !this.combined.hasScope(service.scope)).map(service => service.name);
      if (this.combined.hasScope(CALENDAR_SCOPE) && !this.combined.hasScope(CALENDAR_WRITE_SCOPE)) missing.push('Calendar 寫入');
      if (connected.length) this.message.set(`已連線：${connected.join('、')}（${account.email}）。`);
      if (missing.length) this.error.set(`本次尚未取得 ${missing.join('、')} 權限，可使用下方按鈕分別授權。`);
      else if (connected.length !== services.length) this.error.set('部分服務尚未完成連線，請查看下方各服務的訊息。');
    } catch (error) { if (!this.destroyed) this.error.set(error instanceof Error ? error.message : 'Google 授權未完成，可分別連線所需服務。'); }
    finally { this.combined.disconnect(); this.connectingAll.set(false); }
  }
  disconnectCalendar(): void {
    this.writeAuth.useSession({generation: this.store.generation(), clientId: this.store.google().clientId, accountId: this.store.google().accountId});
    this.writeAuth.disconnect('已解除 Google Calendar 寫入連線。');
    this.calendar.auth.disconnect('已解除月曆連線，保留離線快取。');
  }
  ngOnDestroy(): void { this.destroyed = true; this.combined.disconnect(); }
}
