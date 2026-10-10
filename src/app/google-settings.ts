import { Component, effect, inject, output, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { BoardStore } from './board-store';
import { GoogleCalendarService } from './google-calendar';
import { AvailableCalendar, writableCalendar } from './google-api';
import { ThemeColor } from './theme-color';

@Component({selector: 'app-google-settings', imports: [FormsModule, ThemeColor], templateUrl: './google-settings.html', styleUrl: './google-settings.css'})
export class GoogleSettingsPanel {
  readonly store = inject(BoardStore);
  readonly calendar = inject(GoogleCalendarService);
  readonly writable = writableCalendar;
  readonly configure = output<void>();
  readonly error = signal('');

  constructor() {
    effect(() => {
      this.store.generation(); this.store.google().clientId; this.store.google().accountId;
      const connected = this.calendar.auth.connected();
      untracked(() => { if (connected) void this.calendar.listCalendars(false); });
    });
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
