import { Component, inject, input, linkedSignal, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ACCENT_COLORS, ThemeMode, validHex } from './appearance-data';
import { downloadBackup } from './backup-file';
import { BoardStore } from './board-store';
import { Icon } from './icon';
import { BackupPanel } from './backup-panel';
import { UiPreferences } from './ui-preferences';
import { GoogleSettingsPanel } from './google-settings';
import { DUE_DAY_PRESETS, START_LEAD_PRESETS } from './reminder-data';
import type { ReminderPreferences } from './reminder-data';
import { DrivePanel } from './drive-panel';
import { GmailSettings } from './gmail-settings';
import { GoogleConnection } from './google-connection';

export type SettingsTab = 'appearance' | 'reminders' | 'google' | 'calendar' | 'gmail' | 'drive' | 'data' | 'reset';
export const SETTINGS_TABS: {id: SettingsTab; label: string}[] = [
  {id: 'appearance', label: '外觀與閱讀'}, {id: 'reminders', label: '任務提醒'},
  {id: 'google', label: 'Google 連線'}, {id: 'calendar', label: 'Google 月曆'}, {id: 'gmail', label: 'Gmail'}, {id: 'drive', label: 'Google Drive'}, {id: 'data', label: '資料與備份'}, {id: 'reset', label: '資料重置'}
];

@Component({selector: 'app-settings', imports: [FormsModule, Icon, GoogleSettingsPanel, BackupPanel, DrivePanel, GmailSettings, GoogleConnection], templateUrl: './settings.html', styleUrl: './settings.css'})
export class Settings {
  readonly store = inject(BoardStore);
  readonly preferences = inject(UiPreferences);
  readonly initialTab = input<SettingsTab>('appearance');
  readonly activeTab = linkedSignal(() => this.initialTab());
  readonly tabs = SETTINGS_TABS;
  readonly accents = ACCENT_COLORS;
  readonly duePresets = DUE_DAY_PRESETS;
  readonly leadPresets = START_LEAD_PRESETS;
  readonly modes: {id: ThemeMode; label: string}[] = [{id: 'light', label: '淺色'}, {id: 'dark', label: '深色'}, {id: 'system', label: '跟隨系統'}];
  readonly resetDone = output<void>();
  readonly resetMode = signal<'work' | 'all' | null>(null);
  readonly message = signal('');
  readonly error = signal('');
  readonly busy = signal(false);
  confirmation = '';
  private confirmedRevision = '';

  tabKeydown(event: KeyboardEvent): void {
    const index = this.tabs.findIndex(tab => tab.id === this.activeTab());
    const next = event.key === 'ArrowRight' ? (index + 1) % this.tabs.length : event.key === 'ArrowLeft' ? (index + this.tabs.length - 1) % this.tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? this.tabs.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault(); this.activeTab.set(this.tabs[next].id);
    (event.currentTarget as HTMLElement).closest('[role="tablist"]')?.querySelector<HTMLButtonElement>(`[data-tab="${this.activeTab()}"]`)?.focus();
  }

  async setDueSoonDays(value: unknown): Promise<void> {
    await this.setReminderOptions({dueSoonDays: typeof value === 'number' ? value : Number(value)});
  }
  async setReminderOptions(patch: Partial<ReminderPreferences>): Promise<void> {
    this.error.set('');
    const result = await this.store.updateReminders(patch);
    if (!result.ok) this.error.set(result.message);
  }

  async setAccent(value: string): Promise<void> {
    if (!validHex(value)) { this.error.set('請輸入 # 加上六位英數字，例如 #31584b。'); return; }
    this.error.set('');
    await this.preferences.setAccent(value);
  }

  beginReset(mode: 'work' | 'all'): void {
    this.store.refreshFromStorage();
    this.confirmedRevision = this.store.revision();
    this.confirmation = '';
    this.resetMode.set(mode);
    this.error.set('');
    this.message.set('');
  }

  resetPhrase(): string { return this.resetMode() === 'all' ? '重置整個 Orbit' : '清空工作資料'; }

  async downloadCurrent(): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    try { downloadBackup(await this.store.backupForExport('full')); this.message.set('目前全部資料的備份已準備下載。'); }
    catch (error) { this.error.set(error instanceof Error ? error.message : '無法下載備份。'); }
    finally { this.busy.set(false); }
  }

  async reset(): Promise<void> {
    if (!this.resetMode() || this.confirmation !== this.resetPhrase() || this.busy() || this.store.pendingWrites()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const result = await this.store.resetData(this.resetMode() === 'all', this.confirmedRevision);
      if (!result.ok) { this.error.set(result.message); return; }
      this.resetMode.set(null);
      this.confirmation = '';
      this.message.set('已建立空白工作空間。');
      this.resetDone.emit();
    } finally { this.busy.set(false); }
  }
}
