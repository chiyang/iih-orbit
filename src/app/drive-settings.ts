import type { BackupKind } from './backup-data.ts';

export interface DriveSettings {
  accountId: string;
  email: string;
  mode: 'off' | 'backup' | 'sync';
  kind: BackupKind;
  workspaceIds: string[];
  debounceSeconds: number;
  pollMinutes: number;
}
export const DEFAULT_DRIVE: DriveSettings = {accountId: '', email: '', mode: 'off', kind: 'full', workspaceIds: [], debounceSeconds: 15, pollMinutes: 5};
export function readDriveSettings(value: unknown, workspaceIds: string[]): DriveSettings | null {
  if (!value || typeof value !== 'object') return null;
  const s = value as DriveSettings;
  if (typeof s.accountId !== 'string' || s.accountId.length > 300 || typeof s.email !== 'string' || s.email.length > 320
    || !['off', 'backup', 'sync'].includes(s.mode) || !['full', 'workspaces'].includes(s.kind)
    || !Array.isArray(s.workspaceIds) || s.workspaceIds.some(id => typeof id !== 'string' || !workspaceIds.includes(id))
    || new Set(s.workspaceIds).size !== s.workspaceIds.length || ![15, 30, 60].includes(s.debounceSeconds) || ![0, 1, 5, 15].includes(s.pollMinutes)
    || (s.mode !== 'off' && (!s.accountId || (s.kind === 'workspaces' && !s.workspaceIds.length)))) return null;
  return {accountId: s.accountId, email: s.email, mode: s.mode, kind: s.kind, workspaceIds: [...s.workspaceIds], debounceSeconds: s.debounceSeconds, pollMinutes: s.pollMinutes};
}
