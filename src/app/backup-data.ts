import type { Task, Workspace, WorkspaceState } from './models';
import { readWorkspaceState } from './workspace-data.ts';
import type { BackupAppearancePreferences, SharedAppearancePreferences, TextSize } from './appearance-data.ts';
import { DEFAULT_APPEARANCE, readBackupAppearance, sharedAppearance } from './appearance-data.ts';
import type { CalendarSource, GoogleSettings } from './google-data.ts';
import { DEFAULT_GOOGLE, readGoogleSettings, readSources } from './google-data.ts';
import { DEFAULT_REMINDERS, type ReminderPreferences, readReminders } from './reminder-data.ts';
import { DEFAULT_DRIVE, type DriveSettings, readDriveSettings } from './drive-settings.ts';
import { taskFingerprint } from './calendar-transfer-data.ts';

export type BackupKind = 'full' | 'workspaces';
export type {TextSize} from './appearance-data.ts';
export {TEXT_SIZE_IDS} from './appearance-data.ts';

export interface OrbitBackup {
  application: 'iih-orbit';
  formatVersion: 5 | 6 | 7 | 8;
  appVersion: string;
  kind: BackupKind;
  exportedAt: string;
  data: WorkspaceState;
  preferences?: BackupAppearancePreferences;
  google?: GoogleSettings;
  calendarSources?: CalendarSource[];
  reminders?: ReminderPreferences;
  drive?: DriveSettings;
}

export function createBackup(state: WorkspaceState, kind: BackupKind, selectedIds: string[] = [], appearance: TextSize | SharedAppearancePreferences = DEFAULT_APPEARANCE, google: GoogleSettings = DEFAULT_GOOGLE, includeGoogle = false, reminders: ReminderPreferences = DEFAULT_REMINDERS, drive: DriveSettings = DEFAULT_DRIVE): OrbitBackup {
  const workspaces = kind === 'full' ? state.workspaces : state.workspaces.filter(workspace => selectedIds.includes(workspace.id));
  if (!workspaces.length || (kind === 'workspaces' && selectedIds.some(id => !workspaces.some(workspace => workspace.id === id)))) {
    throw new Error('請選擇至少一個仍存在的工作空間。');
  }
  return {
    application: 'iih-orbit', formatVersion: backupFormat(workspaces), appVersion: '1.7.0', kind, exportedAt: new Date().toISOString(),
    data: structuredClone({version: 1, activeWorkspaceId: workspaces.some(workspace => workspace.id === state.activeWorkspaceId) ? state.activeWorkspaceId : workspaces[0].id, workspaces}),
    ...(kind === 'full' ? {preferences: sharedAppearance(typeof appearance === 'string' ? DEFAULT_APPEARANCE : appearance), google: structuredClone(google), reminders: {...reminders}, drive: structuredClone(drive)}
      : {calendarSources: google.sources.filter(source => source.workspaceIds.some(id => selectedIds.includes(id))).map(source => ({...structuredClone(source), workspaceIds: source.workspaceIds.filter(id => selectedIds.includes(id))})),
        ...(includeGoogle ? {google: {...structuredClone(google), sources: []}} : {})})
  };
}

/** Validate the complete file before committing anything, and retain only supported fields. */
export function readBackup(value: unknown): OrbitBackup {
  if (!value || typeof value !== 'object') throw new Error('這不是有效的 IIH Orbit 備份檔。');
  const source = value as OrbitBackup;
  if (source.application !== 'iih-orbit') throw new Error('請選擇 IIH Orbit 匯出的 JSON 備份檔。');
  if (![1, 2, 3, 4, 5, 6, 7, 8].includes(source.formatVersion)) throw new Error('這個備份格式尚未支援，請使用相容版本的 IIH Orbit。');
  if (!['full', 'workspaces'].includes(source.kind) || typeof source.appVersion !== 'string'
    || typeof source.exportedAt !== 'string' || !Number.isFinite(Date.parse(source.exportedAt))) {
    throw new Error('備份的範圍、版本或匯出日期不完整。');
  }
  const data = readWorkspaceState(source.data);
  if (!data || data.workspaces.some(workspace => workspace.tasks.some(task => !validSubtaskIds(task)))) {
    throw new Error('備份資料不完整：請檢查任務日期、分類、狀態與識別碼。原有資料未變更。');
  }
  if (source.formatVersion < 6 && data.workspaces.some(workspace => workspace.version >= 5)
    || source.formatVersion < 7 && data.workspaces.some(workspace => workspace.version >= 6)
    || source.formatVersion < 8 && data.workspaces.some(workspace => workspace.version === 7)) throw new Error('資訊連結需要新版備份格式，原有資料未變更。');
  const preferences = source.preferences === undefined ? undefined : readBackupAppearance(source.preferences);
  if (preferences === null) {
    throw new Error('備份的外觀設定不合法。原有資料未變更。');
  }
  const workspaceIds = data.workspaces.map(workspace => workspace.id);
  const google = source.formatVersion >= 4 && source.google !== undefined ? readGoogleSettings(source.google, workspaceIds) : undefined;
  const calendarSources = source.formatVersion >= 4 && source.kind === 'workspaces' && source.calendarSources !== undefined ? readSources(source.calendarSources, workspaceIds) : undefined;
  if (google === null || calendarSources === null) throw new Error('Google 月曆來源或連線設定不合法。原有資料未變更。');
  const reminders = source.formatVersion >= 4 && source.kind === 'full' && source.reminders !== undefined ? readReminders(source.reminders) : undefined;
  if (reminders === null) throw new Error('備份的提醒設定不合法。原有資料未變更。');
  const drive = source.formatVersion >= 5 && source.kind === 'full' && source.drive !== undefined ? readDriveSettings(source.drive, workspaceIds) : undefined;
  if (drive === null) throw new Error('Drive 設定不合法。原有資料未變更。');
  return {
    application: 'iih-orbit', formatVersion: source.formatVersion >= 6 ? source.formatVersion : 5, appVersion: source.appVersion, kind: source.kind,
    exportedAt: source.exportedAt, data,
    ...(source.kind === 'full' && preferences ? {preferences} : {}), ...(google ? {google} : {}), ...(calendarSources ? {calendarSources} : {}), ...(reminders ? {reminders} : {}), ...(drive ? {drive} : {})
  };
}

export function backupFormat(workspaces: readonly Workspace[]): OrbitBackup['formatVersion'] {
  return workspaces.some(workspace => workspace.version === 7) ? 8 : workspaces.some(workspace => workspace.version === 6) ? 7 : workspaces.some(workspace => workspace.version === 5) ? 6 : 5;
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
    const tasks = new Map(workspace.tasks.map(task => [task.id, newId()]));
    for (const conflict of workspace.taskConflicts ?? []) if (!tasks.has(conflict.id)) tasks.set(conflict.id, newId());
    for (const event of workspace.completionEvents ?? []) {
      if (!tasks.has(event.taskId)) tasks.set(event.taskId, newId());
      if (event.projectId && !projects.has(event.projectId)) projects.set(event.projectId, newId());
    }
    const subtasks = new Map(workspace.tasks.flatMap(task => task.subtasks.map(subtask => [JSON.stringify([task.id, subtask.id]), newId()])));
    for (const conflict of workspace.taskConflicts ?? []) for (const version of conflict.versions) for (const item of version.task?.subtasks ?? []) if (!subtasks.has(JSON.stringify([conflict.id, item.id]))) subtasks.set(JSON.stringify([conflict.id, item.id]), newId());
    const copyTask = (task: Task): Task => ({...structuredClone(task), id: tasks.get(task.id) ?? task.id, categoryId: categories.get(task.categoryId) ?? '', projectId: projects.get(task.projectId) ?? '', status: statuses.get(task.status) ?? task.status, subtasks: task.subtasks.map(subtask => ({...subtask, id: subtasks.get(JSON.stringify([task.id, subtask.id])) ?? subtask.id}))});
    const links = new Map(workspace.documentLinks?.map(link => [link.id, newId()]));
    return {
      ...structuredClone(workspace), id: newId(),
      categories: workspace.categories.map(category => ({...category, id: categories.get(category.id)!})),
      projects: workspace.projects.map(project => ({...project, id: projects.get(project.id)!})),
      statuses: workspace.statuses.map(status => ({...status, id: statuses.get(status.id)!})),
      tasks: workspace.tasks.map(copyTask),
      ...(workspace.completionEvents ? {completionEvents: workspace.completionEvents.map(event => ({...event, id: newId(), taskId: tasks.get(event.taskId)!, projectId: projects.get(event.projectId) ?? ''}))} : {}),
      ...(workspace.documentLinks ? {documentLinks: workspace.documentLinks.map(link => ({...link, id: links.get(link.id)!, taskId: tasks.get(link.taskId) ?? link.taskId}))} : {}),
      ...(workspace.documentDetails ? {documentDetails: workspace.documentDetails.map(item => {const taskId = tasks.get(item.taskId) ?? item.taskId; return {...item, id: JSON.stringify([taskId, item.documentId]), taskId, linkIds: item.linkIds.map(id => links.get(id)!)};})} : {}),
      ...(workspace.documentOrders ? {documentOrders: workspace.documentOrders.map(item => ({...item, id: tasks.get(item.id) ?? item.id, documentIds: [...item.documentIds]}))} : {}),
      ...(workspace.taskConflicts ? {taskConflicts: workspace.taskConflicts.map(conflict => {
        const versions = conflict.versions.map(version => ({...version, key: version.key === 'null' ? 'null' : JSON.stringify([tasks.get(conflict.id), version.key]), task: version.task ? copyTask(version.task) : null}));
        return {id: tasks.get(conflict.id)!, versions, ...(conflict.resolved ? {resolved: versions[conflict.versions.findIndex(version => version.key === conflict.resolved)].key} : {})};
      })} : {}),
      ...(workspace.calendarTransfers ? {calendarTransfers: workspace.calendarTransfers.map(item => ({...structuredClone(item), taskId: tasks.get(item.taskId) ?? item.taskId, original: taskFingerprint(copyTask(JSON.parse(item.original)))}))} : {})
    };
  });
}

export function backupFilename(backup: OrbitBackup): string {
  const label = backup.kind === 'full' ? '全部資料' : backup.data.workspaces.length === 1 ? backup.data.workspaces[0].name : `${backup.data.workspaces.length}個工作空間`;
  return `IIH-Orbit-${label.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').slice(0, 60)}-${backup.exportedAt.slice(0, 10)}.json`;
}
