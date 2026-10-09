import { backupFilename, OrbitBackup } from './backup-data';

export function downloadBackup(backup: OrbitBackup): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], {type: 'application/json'}));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = backupFilename(backup);
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
