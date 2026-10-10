import { DOCUMENT } from '@angular/common';
import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { BoardStore } from './board-store';
import { GoogleCalendarService } from './google-calendar';
import { AvailableCalendar, writableCalendar } from './google-api';
import { CalendarWriteAuth } from './calendar-write-auth';
import { validClientId } from './google-data';
import { ThemeColor } from './theme-color';

@Component({selector: 'app-google-settings', imports: [FormsModule, ThemeColor], templateUrl: './google-settings.html', styleUrl: './google-settings.css'})
export class GoogleSettingsPanel {
  readonly store = inject(BoardStore);
  readonly calendar = inject(GoogleCalendarService);
  readonly writeAuth = inject(CalendarWriteAuth);
  readonly writable = writableCalendar;
  disconnect(): void { this.writeAuth.useSession({generation: this.store.generation(), clientId: this.store.google().clientId, accountId: this.store.google().accountId}); this.writeAuth.disconnect('已解除 Google Calendar 寫入連線。'); this.calendar.auth.disconnect('已解除此瀏覽器各分頁的 Google 連線，保留月曆快取。'); }
  readonly origin = inject(DOCUMENT).defaultView?.location.origin ?? '';
  readonly localAddress = this.origin.startsWith('http://127.0.0.1');
  readonly message = signal('');
  readonly error = signal('');
  readonly saving = signal(false);
  readonly loadingLibrary = signal(false);
  readonly draft = signal(this.store.google().clientId);
  private savedId = this.store.google().clientId;
  private readonly clientId = computed(() => this.store.google().clientId);

  constructor() {
    effect(() => {
      const clientId = this.clientId();
      untracked(() => {
        if (this.draft() === this.savedId) this.draft.set(clientId);
        this.savedId = clientId;
        if (clientId) void this.prepare();
      });
    });
    effect(() => {
      this.store.generation(); this.clientId(); this.store.google().accountId;
      const connected = this.calendar.auth.connected();
      untracked(() => { if (connected) void this.calendar.listCalendars(false); });
    });
  }
  async prepare(): Promise<void> {
    this.loadingLibrary.set(true);
    try { await this.calendar.auth.prepare(); this.error.set(''); }
    catch (error) { this.error.set(error instanceof Error ? error.message : 'Google 元件載入失敗。'); }
    finally { this.loadingLibrary.set(false); }
  }
  async saveClientId(): Promise<void> {
    const clientId = this.draft().trim();
    if (!validClientId(clientId) || !clientId) { this.error.set('請貼上完整的 OAuth Client ID，結尾為 .apps.googleusercontent.com。'); return; }
    this.saving.set(true); this.error.set('');
    const result = await this.store.updateGoogle({clientId});
    this.saving.set(false);
    if (!result.ok) this.error.set(result.message);
    else { this.draft.set(clientId); this.message.set('Client ID 已保存，授權元件準備好後即可連線。'); }
  }
  bound(calendar: AvailableCalendar, workspaceId: string): boolean {
    return this.calendar.sources().some(source => source.calendarId === calendar.id && source.workspaceIds.includes(workspaceId));
  }
  async interval(value: string): Promise<void> {
    const result = await this.store.updateGoogle({refreshMinutes: Number(value) as 0 | 1 | 5 | 15});
    if (!result.ok) this.error.set(result.message);
  }
  async changeColor(id: string, color: string): Promise<void> {
    const result = await this.store.updateCalendarSource(id, {color});
    if (!result.ok) this.error.set(result.message);
  }
}
