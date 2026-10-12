import { Component, computed, inject, linkedSignal, OnDestroy, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DOCUMENT } from '@angular/common';
import { Icon } from './icon';
import { BoardStore } from './board-store';
import { GoogleCalendarService } from './google-calendar';
import { CalendarWriteAuth } from './calendar-write-auth';
import { GmailService } from './gmail-service';
import { DriveService } from './drive-service';
import { validClientId } from './google-data';
import { GoogleCombinedAuth } from './google-combined-auth';
import { GoogleConnections } from './google-connections';

@Component({selector: 'app-google-connection', imports: [FormsModule, Icon], templateUrl: './google-connection.html', styleUrls: ['./google-settings.css', './google-connection.css']})
export class GoogleConnection implements OnDestroy {
  private readonly document = inject(DOCUMENT);
  readonly store = inject(BoardStore);
  readonly calendar = inject(GoogleCalendarService);
  readonly writeAuth = inject(CalendarWriteAuth);
  readonly gmail = inject(GmailService);
  readonly drive = inject(DriveService);
  readonly combined = inject(GoogleCombinedAuth);
  readonly configure = output<'calendar' | 'gmail' | 'drive'>();
  readonly draft = linkedSignal(() => this.store.google().clientId || this.gmail.preferences().clientId);
  readonly copying = signal(false);
  readonly copyStatus = linkedSignal({source: this.draft, computation: (): 'idle' | 'success' | 'error' => 'idle'});
  readonly saving = signal(false);
  readonly connections = inject(GoogleConnections);
  readonly preparing = this.connections.preparing;
  readonly connectingAll = this.connections.connectingAll;
  private destroyed = false;
  private startedConsent = false;
  readonly error = this.connections.error;
  readonly message = this.connections.message;
  readonly busy = computed(() => this.saving() || this.connectingAll() || this.store.pendingWrites() > 0 || this.calendar.auth.authorizing() || this.writeAuth.authorizing() || this.gmail.auth.authorizing() || this.drive.busy());
  readonly unsaved = computed(() => this.draft().trim() !== this.store.google().clientId);
  async copyClientId(): Promise<void> {
    const clientId = this.draft().trim();
    if (!clientId || this.copying()) return;
    this.copying.set(true); this.copyStatus.set('idle');
    try {
      const clipboard = this.document.defaultView?.navigator.clipboard;
      if (!clipboard) throw new Error('Clipboard unavailable');
      await clipboard.writeText(clientId);
      if (!this.destroyed && this.draft().trim() === clientId) this.copyStatus.set('success');
    } catch {
      if (!this.destroyed && this.draft().trim() === clientId) this.copyStatus.set('error');
    } finally { this.copying.set(false); }
  }
  prepare(): Promise<void> {return this.connections.prepare();}
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

  async connectAll(): Promise<void> {
    if (this.busy() || this.unsaved()) return;
    this.startedConsent = true;
    try {await this.connections.connectAll();}
    finally {this.startedConsent = false;}
  }
  disconnectCalendar(): void {
    this.writeAuth.useSession({generation: this.store.generation(), clientId: this.store.google().clientId, accountId: this.store.google().accountId});
    this.writeAuth.disconnect('已解除 Google Calendar 寫入連線。');
    this.calendar.auth.disconnect('已解除月曆連線，保留離線快取。');
  }
  ngOnDestroy(): void {this.destroyed = true; if (this.startedConsent) this.connections.cancelAll();}
}
