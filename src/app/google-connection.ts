import { DOCUMENT } from '@angular/common';
import { Component, computed, effect, inject, linkedSignal, output, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { BoardStore } from './board-store';
import { GoogleCalendarService } from './google-calendar';
import { CalendarWriteAuth } from './calendar-write-auth';
import { GmailService } from './gmail-service';
import { DriveService } from './drive-service';
import { validClientId } from './google-data';

@Component({selector: 'app-google-connection', imports: [FormsModule], templateUrl: './google-connection.html', styleUrls: ['./google-settings.css', './google-connection.css']})
export class GoogleConnection {
  readonly store = inject(BoardStore);
  readonly calendar = inject(GoogleCalendarService);
  readonly writeAuth = inject(CalendarWriteAuth);
  readonly gmail = inject(GmailService);
  readonly drive = inject(DriveService);
  readonly configure = output<'calendar' | 'gmail' | 'drive'>();
  readonly origin = inject(DOCUMENT).defaultView?.location.origin ?? '';
  readonly draft = linkedSignal(() => this.store.google().clientId || this.gmail.preferences().clientId);
  readonly saving = signal(false);
  readonly preparing = signal(false);
  readonly error = signal('');
  readonly message = signal('');
  readonly busy = computed(() => this.saving() || this.store.pendingWrites() > 0 || this.calendar.auth.authorizing() || this.gmail.auth.authorizing() || this.drive.busy());
  readonly unsaved = computed(() => this.draft().trim() !== this.store.google().clientId);
  constructor() {
    effect(() => { const id = this.store.google().clientId; untracked(() => { if (id) void this.prepare(); }); });
  }
  async prepare(): Promise<void> {
    if (this.preparing()) return;
    this.preparing.set(true); this.error.set('');
    try {
      await this.calendar.auth.prepare();
      await Promise.all([this.gmail.auth.prepare(), this.drive.auth.prepare()]);
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
  disconnectCalendar(): void {
    this.writeAuth.useSession({generation: this.store.generation(), clientId: this.store.google().clientId, accountId: this.store.google().accountId});
    this.writeAuth.disconnect('已解除 Google Calendar 寫入連線。');
    this.calendar.auth.disconnect('已解除月曆連線，保留離線快取。');
  }
}
