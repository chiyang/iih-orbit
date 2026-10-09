import { Component, computed, inject, OnDestroy, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { BoardStore } from './board-store';
import { BackupKind, OrbitBackup, readBackup } from './backup-data';
import { downloadBackup } from './backup-file';
import { Icon } from './icon';

@Component({selector: 'app-backup-panel', imports: [FormsModule, Icon], templateUrl: './backup-panel.html', styleUrls: ['./backup-panel.css']})
export class BackupPanel implements OnDestroy {
  readonly store = inject(BoardStore);
  readonly restored = output<void>();
  readonly message = signal('');
  readonly backupRange = signal<BackupKind>('full');
  readonly backupIncludeGoogle = signal(false);
  readonly applyImportedGoogle = signal(false);
  readonly backupWorkspaceIds = signal<string[]>([this.store.currentWorkspace().id]);
  readonly totalTaskCount = computed(() => this.store.workspaces().reduce((count, workspace) => count + workspace.tasks.length, 0));
  readonly importPreview = signal<OrbitBackup | null>(null);
  readonly backupError = signal('');
  readonly readingBackup = signal(false);
  readonly importingBackup = signal(false);
  readonly confirmingImport = signal(false);
  readonly importFilename = signal('');

  importConfirmation = '';
  private confirmedRevision = '';
  private fileLoadId = 0;
  ngOnDestroy(): void { this.fileLoadId++; }

  toggleBackupWorkspace(id: string, selected: boolean): void {
    this.backupWorkspaceIds.update(ids => selected ? [...new Set([...ids, id])] : ids.filter(item => item !== id));
  }

  async exportBackup(all = false): Promise<void> {
    this.backupError.set('');
    try {
      downloadBackup(await this.store.backupForExport(all ? 'full' : this.backupRange(), this.backupWorkspaceIds(), this.backupIncludeGoogle()));
      this.message.set('備份檔已準備下載。');
    } catch (error) { this.backupError.set(error instanceof Error ? error.message : '無法匯出備份檔。'); }
  }

  async readImportFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const request = ++this.fileLoadId;
    this.readingBackup.set(true);
    this.importPreview.set(null);
    this.applyImportedGoogle.set(false);
    this.confirmingImport.set(false);
    this.backupError.set('');
    this.message.set('');
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error('檔案超過 20 MB，請選擇較小的工作空間備份。');
      const text = await file.text();
      if (request !== this.fileLoadId) return;
      let value: unknown;
      try { value = JSON.parse(text); } catch { throw new Error('檔案不是有效的 JSON，原有資料未變更。'); }
      this.importPreview.set(readBackup(value));
      this.importFilename.set(file.name);
    } catch (error) {
      if (request === this.fileLoadId) this.backupError.set(error instanceof Error ? error.message : '無法讀取備份，原有資料未變更。');
    } finally { if (request === this.fileLoadId) this.readingBackup.set(false); }
  }

  prepareFullImport(): void {
    this.store.refreshFromStorage();
    this.confirmedRevision = this.store.revision();
    this.importConfirmation = '';
    this.backupError.set('');
    this.confirmingImport.set(true);
  }

  async executeImport(): Promise<void> {
    const backup = this.importPreview();
    if (!backup || this.importingBackup() || this.store.pendingWrites()) return;
    if (backup.kind === 'full' && (!this.confirmingImport() || this.importConfirmation !== '取代全部資料')) return;
    this.importingBackup.set(true);
    this.backupError.set('');
    this.message.set('');
    try {
      const result = await this.store.importBackup(backup, this.confirmedRevision, this.applyImportedGoogle());
      if (!result.ok) { this.backupError.set(result.message); return; }
      this.restored.emit();
      this.importPreview.set(null);
      this.confirmingImport.set(false);
      this.message.set(backup.kind === 'full' ? '全部資料已還原' : `已新增 ${backup.data.workspaces.length} 個工作空間，原有資料保留`);
    } catch (error) { this.backupError.set(error instanceof Error ? error.message : '無法匯入備份。'); }
    finally { this.importingBackup.set(false); }
  }

  backupTaskCount(backup: OrbitBackup): number {
    return backup.data.workspaces.reduce((count, workspace) => count + workspace.tasks.length, 0);
  }
}
