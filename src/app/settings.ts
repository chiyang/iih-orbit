import { Component, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ACCENT_COLORS, ThemeMode, validHex } from './appearance-data';
import { downloadBackup } from './backup-file';
import { BoardStore } from './board-store';
import { Icon } from './icon';
import { UiPreferences } from './ui-preferences';

@Component({selector: 'app-settings', imports: [FormsModule, Icon], templateUrl: './settings.html', styleUrl: './settings.css'})
export class Settings {
  readonly store = inject(BoardStore);
  readonly preferences = inject(UiPreferences);
  readonly accents = ACCENT_COLORS;
  readonly modes: {id: ThemeMode; label: string}[] = [{id: 'light', label: '淺色'}, {id: 'dark', label: '深色'}, {id: 'system', label: '跟隨系統'}];
  readonly openBackup = output<void>();
  readonly resetDone = output<void>();
  readonly resetMode = signal<'work' | 'all' | null>(null);
  readonly message = signal('');
  readonly error = signal('');
  readonly busy = signal(false);
  confirmation = '';
  private confirmedRevision = '';

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
