import type { Task, Workspace, WorkspaceState } from './models';
import { readWorkspaceState } from './workspace-data.ts';
import type { AppearancePreferences, TextSize } from './appearance-data.ts';
import { DEFAULT_APPEARANCE, readAppearance } from './appearance-data.ts';

export type BackupKind = 'full' | 'workspaces';
export type {TextSize} from './appearance-data.ts';
export {TEXT_SIZE_IDS} from './appearance-data.ts';

export interface OrbitBackup {
  application: 'iih-orbit';
  formatVersion: 3;
  appVersion: string;
  kind: BackupKind;
  exportedAt: string;
  data: WorkspaceState;
  preferences?: AppearancePreferences;
}

export function createBackup(state: WorkspaceState, kind: BackupKind, selectedIds: string[], appearance: TextSize | AppearancePreferences): OrbitBackup {
  const workspaces = kind === 'full' ? state.workspaces : state.workspaces.filter(workspace => selectedIds.includes(workspace.id));
  if (!workspaces.length || (kind === 'workspaces' && selectedIds.some(id => !workspaces.some(workspace => workspace.id === id)))) {
    throw new Error('請選擇至少一個仍存在的工作空間。');
  }
  return {
    application: 'iih-orbit', formatVersion: 3, appVersion: '1.3.0', kind, exportedAt: new Date().toISOString(),
    data: structuredClone({version: 1, activeWorkspaceId: workspaces.some(workspace => workspace.id === state.activeWorkspaceId) ? state.activeWorkspaceId : workspaces[0].id, workspaces}),
    ...(kind === 'full' ? {preferences: typeof appearance === 'string' ? {...DEFAULT_APPEARANCE, textSize: appearance} : structuredClone(appearance)} : {})
  };
}

/** Validate the complete file before committing anything, and retain only supported fields. */
export function readBackup(value: unknown): OrbitBackup {
  if (!value || typeof value !== 'object') throw new Error('這不是有效的 IIH Orbit 備份檔。');
  const source = value as OrbitBackup;
  if (source.application !== 'iih-orbit') throw new Error('請選擇 IIH Orbit 匯出的 JSON 備份檔。');
  if (![1, 2, 3].includes(source.formatVersion)) throw new Error('這個備份格式尚未支援，請使用相容版本的 IIH Orbit。');
  if (!['full', 'workspaces'].includes(source.kind) || typeof source.appVersion !== 'string'
    || typeof source.exportedAt !== 'string' || !Number.isFinite(Date.parse(source.exportedAt))) {
    throw new Error('備份的範圍、版本或匯出日期不完整。');
  }
  const data = readWorkspaceState(source.data);
  if (!data || data.workspaces.some(workspace => workspace.tasks.some(task => !validSubtaskIds(task)))) {
    throw new Error('備份資料不完整：請檢查任務日期、分類、狀態與識別碼。原有資料未變更。');
  }
  const preferences = source.preferences === undefined ? undefined : readAppearance(source.preferences);
  if (preferences === null) {
    throw new Error('備份的外觀設定不合法。原有資料未變更。');
  }
  return {
    application: 'iih-orbit', formatVersion: 3, appVersion: source.appVersion, kind: source.kind,
    exportedAt: source.exportedAt, data,
    ...(source.kind === 'full' && preferences ? {preferences} : {})
  };
}

function validSubtaskIds(task: Task): boolean {
  return task.subtasks.every(subtask => !!subtask.id) && new Set(task.subtasks.map(subtask => subtask.id)).size === task.subtasks.length;
}

/** Every import creates independent identities while keeping names, order and schedules. */
export function copyWorkspaces(workspaces: Workspace[], newId: () => string = () => crypto.randomUUID()): Workspace[] {
  return workspaces.map(workspace => {
    const categories = new Map(workspace.categories.map(category => [category.id, newId()]));
    const projects = new Map(workspace.projects.map(project => [project.id, newId()]));
    const statuses = new Map(workspace.statuses.map(status => [status.id, newId()]));
    return {
      ...structuredClone(workspace), id: newId(),
      categories: workspace.categories.map(category => ({...category, id: categories.get(category.id)!})),
      projects: workspace.projects.map(project => ({...project, id: projects.get(project.id)!})),
      statuses: workspace.statuses.map(status => ({...status, id: statuses.get(status.id)!})),
      tasks: workspace.tasks.map(task => ({
        ...structuredClone(task), id: newId(), categoryId: categories.get(task.categoryId) ?? '', projectId: projects.get(task.projectId) ?? '', status: statuses.get(task.status)!,
        subtasks: task.subtasks.map(subtask => ({...subtask, id: newId()}))
      }))
    };
  });
}

export function backupFilename(backup: OrbitBackup): string {
  const label = backup.kind === 'full' ? '全部資料' : backup.data.workspaces.length === 1 ? backup.data.workspaces[0].name : `${backup.data.workspaces.length}個工作空間`;
  return `IIH-Orbit-${label.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').slice(0, 60)}-${backup.exportedAt.slice(0, 10)}.json`;
}
