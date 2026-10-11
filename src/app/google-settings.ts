import { Component, computed, effect, inject, output, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { BoardStore } from './board-store';
import { GoogleCalendarService } from './google-calendar';
import { CalendarWriteAuth } from './calendar-write-auth';
import { AvailableCalendar, writableCalendar } from './google-api';
import { ThemeColor } from './theme-color';
import { GoogleServiceHeader } from './google-service-header';

@Component({selector: 'app-google-settings', imports: [FormsModule, ThemeColor, GoogleServiceHeader], templateUrl: './google-settings.html', styleUrl: './google-settings.css'})
export class GoogleSettingsPanel {
  readonly store = inject(BoardStore);
  readonly calendar = inject(GoogleCalendarService);
  private readonly writeAuth = inject(CalendarWriteAuth);
  readonly connectionBusy = computed(() => this.store.pendingWrites() > 0 || this.calendar.auth.authorizing() || this.writeAuth.authorizing() || this.calendar.listing() || this.calendar.syncing());
  readonly writable = writableCalendar;
  readonly configure = output<void>();
  readonly error = signal('');

  constructor() {
    effect(() => { const clientId = this.store.google().clientId; untracked(() => { if (clientId) void this.prepare(); }); });
    effect(() => {
      this.store.generation(); this.store.google().clientId; this.store.google().accountId;
      const connected = this.calendar.auth.connected();
      untracked(() => { if (connected) void this.calendar.listCalendars(false); });
    });
  }
  async prepare(): Promise<void> {
    this.error.set('');
    try { await this.calendar.auth.prepare(); }
    catch (error) { this.error.set(error instanceof Error ? error.message : '無法載入 Google 授權元件。'); }
  }
  disconnect(): void {
    this.writeAuth.useSession({generation: this.store.generation(), clientId: this.store.google().clientId, accountId: this.store.google().accountId});
    this.writeAuth.disconnect('已解除 Google Calendar 寫入連線。');
    this.calendar.auth.disconnect('已解除月曆連線，保留離線快取。');
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
