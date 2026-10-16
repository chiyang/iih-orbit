import type { BoardState, BoardStatus, Project, Task, TaskConflict, TaskConflictVersion } from './models';
import { COLUMNS, PRIORITIES } from './models.ts';
import { validColor } from './appearance-data.ts';
import { scheduleError, validDate } from './task-schedule.ts';
import { readCalendarOrigin, readCalendarTransfers } from './calendar-transfer-data.ts';
import { validTaskEditTime } from './task-activity-data.ts';
import { readDeviceIdentity } from './device-data.ts';
import { readDocumentData, readDocumentPresentations } from './document-data.ts';

/** Read saved schemas without mutating the source or discarding legacy tasks. */
export function readBoardState(value: unknown): BoardState | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Omit<BoardState, 'version'> & {version: unknown; projectName?: unknown};
  if (![1, 2, 3, 4, 5, 6].includes(source.version as number)) return null;
  const modern = [4, 5, 6].includes(source.version as number);
  if (![5, 6].includes(source.version as number) && (source.documentSources !== undefined || source.documentLinks !== undefined)) return null;
  if (source.version !== 6 && (source.documentDetails !== undefined || source.documentOrders !== undefined)) return null;
  if (!modern && (typeof source.projectName !== 'string' || !source.projectName.trim())) return null;
  const projects: Project[] = modern ? source.projects : [{id: 'project-legacy', name: (source.projectName as string).trim()}];
  if (!validProjects(projects)) return null;
  if (!Array.isArray(source.categories) || !Array.isArray(source.tasks)) return null;
  const statuses: BoardStatus[] = source.version === 3 || modern ? source.statuses : COLUMNS;
  if (!validStatuses(statuses)) return null;
  const validCategories = source.categories.every(category => category && typeof category.id === 'string'
    && category.id && typeof category.name === 'string' && category.name.trim() && validColor(category.color));
  if (!validCategories || new Set(source.categories.map(category => category.id)).size !== source.categories.length) return null;
  const legacy = source.version === 1;
  const validTasks = source.tasks.every(task => task && typeof task.id === 'string' && task.id && typeof task.title === 'string'
    && task.title.trim() && typeof task.description === 'string' && typeof task.categoryId === 'string'
    && (!task.categoryId || source.categories.some(category => category.id === task.categoryId))
    && (!modern || (typeof task.projectId === 'string' && (!task.projectId || projects.some(project => project.id === task.projectId))))
    && statuses.some(column => column.id === task.status) && PRIORITIES.some(priority => priority.id === task.priority)
    && typeof task.dueDate === 'string' && validDate(task.dueDate)
    && (task.pinned === undefined || typeof task.pinned === 'boolean')
    && (task.updatedAt === undefined || validTaskEditTime(task.updatedAt))
    && (task.editSource === undefined || !!readDeviceIdentity(task.editSource))
    && (task.deletedAt === undefined || validTaskEditTime(task.deletedAt))
    && (legacy || (typeof task.startDate === 'string' && typeof task.startTime === 'string' && typeof task.dueTime === 'string' && !scheduleError(task)))
    && Array.isArray(task.subtasks) && task.subtasks.every(subtask => subtask && typeof subtask.id === 'string'
      && typeof subtask.title === 'string' && typeof subtask.done === 'boolean'));
  if (!validTasks || new Set(source.tasks.map(task => task.id)).size !== source.tasks.length) return null;
  if (source.tasks.some(task => task.calendarOrigin !== undefined && !readCalendarOrigin(task.calendarOrigin))) return null;
  const calendarTransfers = source.calendarTransfers === undefined ? undefined : readCalendarTransfers(source.calendarTransfers);
  if (calendarTransfers === null) return null;
  const tasks: Task[] = source.tasks.map(task => ({
    id: task.id,
    title: task.title,
    description: task.description,
    categoryId: task.categoryId,
    projectId: modern ? task.projectId : projects[0].id,
    status: task.status,
    priority: task.priority,
    startDate: legacy ? '' : task.startDate,
    startTime: legacy ? '' : task.startTime,
    dueDate: task.dueDate,
    dueTime: legacy ? '' : task.dueTime,
    subtasks: task.subtasks.map(subtask => ({id: subtask.id, title: subtask.title, done: subtask.done})),
    ...(task.pinned === undefined ? {} : {pinned: task.pinned}),
    ...(task.updatedAt === undefined ? {} : {updatedAt: task.updatedAt}),
    ...(task.editSource === undefined ? {} : {editSource: readDeviceIdentity(task.editSource)!}),
    ...(task.deletedAt === undefined ? {} : {deletedAt: task.deletedAt}),
    ...(task.calendarOrigin ? {calendarOrigin: readCalendarOrigin(task.calendarOrigin)!} : {})
  }));
  let taskConflicts: TaskConflict[] | undefined;
  if (source.taskConflicts !== undefined) {
    if (!Array.isArray(source.taskConflicts) || source.taskConflicts.length > 10000) return null;
    taskConflicts = [];
    for (const conflict of source.taskConflicts) {
      if (!conflict || typeof conflict.id !== 'string' || !conflict.id || !Array.isArray(conflict.versions) || conflict.versions.length < 2 || conflict.versions.length > 100) return null;
      const versions: TaskConflictVersion[] = [];
      for (const version of conflict.versions) {
        if (!version || typeof version.key !== 'string' || !version.key || version.key.length > 1000000) return null;
        const board = version.task === null ? undefined : readBoardState({...source, version: 4, documentSources: undefined, documentLinks: undefined, documentDetails: undefined, documentOrders: undefined, taskConflicts: undefined, tasks: [version.task]});
        const task = board?.tasks[0];
        if (version.task !== null && (!task || task.id !== conflict.id || task.subtasks.some(item => !item.id) || new Set(task.subtasks.map(item => item.id)).size !== task.subtasks.length)) return null;
        const origin = version.source;
        if (origin !== undefined && (!origin || typeof origin !== 'object' || Array.isArray(origin) || ((origin.id !== undefined || origin.name !== undefined) && !readDeviceIdentity(origin)) || (origin.updatedAt !== undefined && !validTaskEditTime(origin.updatedAt)))) return null;
        versions.push({key: version.key, task: task ?? null, ...(origin === undefined ? {} : {source: {...(origin.id ? readDeviceIdentity(origin)! : {}), ...(origin.updatedAt === undefined ? {} : {updatedAt: origin.updatedAt})}})});
      }
      if (new Set(versions.map(version => version.key)).size !== versions.length || (conflict.resolved !== undefined && !versions.some(version => version.key === conflict.resolved))) return null;
      taskConflicts.push({id: conflict.id, versions, ...(conflict.resolved === undefined ? {} : {resolved: conflict.resolved})});
    }
    if (new Set(taskConflicts.map(conflict => conflict.id)).size !== taskConflicts.length) return null;
  }
  const documents = source.version === 5 || source.version === 6 ? readDocumentData(source as BoardState, new Set([...tasks.map(task => task.id), ...taskConflicts?.map(conflict => conflict.id) ?? []])) : undefined;
  if (documents === null) return null;
  const presentations = source.version === 6 ? readDocumentPresentations({...source, ...documents} as BoardState) : undefined;
  if (presentations === null) return null;
  return {
    // Keep an absent archive flag absent so existing cloud backup hashes stay valid.
    version: modern ? source.version as 4 | 5 | 6 : 4, projects: projects.map(project => ({id: project.id, name: project.name.trim(), ...(project.archived === undefined ? {} : {archived: project.archived})})),
    categories: source.categories.map(category => ({id: category.id, name: category.name, color: category.color})),
    statuses: statuses.map(status => ({id: status.id, label: status.label, subtitle: status.subtitle, color: status.color, kind: status.kind, hidden: status.hidden ?? status.kind === 'archived'})), tasks,
    ...(calendarTransfers ? {calendarTransfers} : {}), ...(taskConflicts ? {taskConflicts} : {}), ...(documents ?? {}), ...(presentations ?? {})
  };
}

export function validProjects(projects: unknown): projects is Project[] {
  return Array.isArray(projects) && projects.every(project => project && typeof project.id === 'string'
    && project.id && project.id !== 'all' && typeof project.name === 'string' && project.name.trim()
    && (project.archived === undefined || typeof project.archived === 'boolean'))
    && new Set(projects.map(project => project.id)).size === projects.length
    && new Set(projects.map(project => project.name.trim().toLocaleLowerCase())).size === projects.length;
}

export function validStatuses(statuses: unknown): statuses is BoardStatus[] {
  if (!Array.isArray(statuses) || !statuses.length) return false;
  return statuses.every(status => status && typeof status.id === 'string' && status.id && typeof status.label === 'string'
    && status.label.trim() && typeof status.subtitle === 'string' && validColor(status.color)
    && ['active', 'done', 'archived'].includes(status.kind) && (status.hidden === undefined || typeof status.hidden === 'boolean'))
    && new Set(statuses.map(status => status.id)).size === statuses.length
    && new Set(statuses.map(status => status.label.trim().toLocaleLowerCase())).size === statuses.length;
}
