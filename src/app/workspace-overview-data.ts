import type {DocumentSource, Task, Workspace} from './models';
import type {DocumentMetadataView} from './document-metadata-manager';
import {taskDocumentIds} from './document-data.ts';
import {unresolvedTaskConflicts} from './task-conflict-data.ts';
import {dateKey, isTaskOverdue, startOfWeek} from './task-schedule.ts';
import {deadlineState} from './reminder-data.ts';

export type OverviewKind = 'total' | 'pending' | 'done' | 'overdue' | 'unscheduled' | 'linked' | 'archived' | 'today-start' | 'week-start' | 'due-soon' | 'status' | 'project' | 'conflicts' | 'unavailable';
export interface OverviewSelection {kind: OverviewKind; value?: string}
export interface OverviewOptions {project: string; includeArchived: boolean; dueSoonDays: number}
const KINDS: readonly OverviewKind[] = ['total', 'pending', 'done', 'overdue', 'unscheduled', 'linked', 'archived', 'today-start', 'week-start', 'due-soon', 'status', 'project', 'conflicts', 'unavailable'];
export const OVERVIEW_LABELS: Record<OverviewKind, string> = {total: '範圍內任務', pending: '待完成', done: '已完成', overdue: '已逾期', unscheduled: '未排程', linked: '有資訊連結', archived: '封存任務', 'today-start': '今日開始', 'week-start': '本週開始', 'due-soon': '即將截止', status: '任務狀態', project: '專案任務', conflicts: '衝突任務', unavailable: '有待處理連結的任務'};
export function readOverviewSelection(value: unknown): OverviewSelection | null {
  const selection = value as OverviewSelection | null;
  if (!selection || !KINDS.includes(selection.kind)) return null;
  if (selection.kind === 'status' || selection.kind === 'project') return typeof selection.value === 'string' && selection.value.length <= 500 ? {kind: selection.kind, value: selection.value} : null;
  return {kind: selection.kind};
}

/** Local derivation only: the metadata callback reads an existing cache and never refreshes it. */
export function workspaceOverview(workspace: Workspace, now: Date, options: OverviewOptions, metadata?: (source: DocumentSource) => Pick<DocumentMetadataView, 'status' | 'checkedAt' | 'stale'>) {
  const statuses = new Map(workspace.statuses.map(status => [status.id, status]));
  const archivedProjects = new Set(workspace.projects.filter(project => project.archived).map(project => project.id));
  const inScope = (task: Task) => !task.deletedAt && (options.project === 'all' || task.projectId === options.project)
    && (options.includeArchived || statuses.get(task.status)?.kind !== 'archived' && !archivedProjects.has(task.projectId));
  const tasks = workspace.tasks.filter(inScope), taskIds = new Set(tasks.map(task => task.id));
  const links = taskDocumentIds(workspace), linkedSources = new Set<string>();
  const groups = new Map<OverviewKind, Task[]>(KINDS.map(kind => [kind, []])); groups.set('total', tasks);
  const statusGroups = new Map(workspace.statuses.map(status => [status.id, [] as Task[]]));
  const projectGroups = new Map<string, Task[]>();
  const today = dateKey(now), weekStart = startOfWeek(now), weekEnd = new Date(weekStart); weekEnd.setDate(weekEnd.getDate() + 6);
  const firstDay = dateKey(weekStart), lastDay = dateKey(weekEnd);
  let subtaskTotal = 0, subtaskDone = 0;
  for (const task of tasks) {
    const kind = statuses.get(task.status)?.kind ?? 'active';
    groups.get(kind === 'done' ? 'done' : kind === 'archived' ? 'archived' : 'pending')!.push(task);
    statusGroups.get(task.status)?.push(task);
    if (!projectGroups.has(task.projectId)) projectGroups.set(task.projectId, []); projectGroups.get(task.projectId)!.push(task);
    if (!task.startDate && !task.dueDate) groups.get('unscheduled')!.push(task);
    if (isTaskOverdue(task, now, workspace.statuses)) groups.get('overdue')!.push(task);
    if (kind === 'active' && task.startDate === today) groups.get('today-start')!.push(task);
    if (kind === 'active' && task.startDate >= firstDay && task.startDate <= lastDay) groups.get('week-start')!.push(task);
    if (deadlineState(task, now, options.dueSoonDays, workspace.statuses) === 'due-soon') groups.get('due-soon')!.push(task);
    if (links.get(task.id)?.length) {groups.get('linked')!.push(task); for (const id of links.get(task.id)!) linkedSources.add(id);}
    subtaskTotal += task.subtasks.length; subtaskDone += task.subtasks.filter(subtask => subtask.done).length;
  }
  const unavailableSources = new Set<string>();
  let driveTotal = 0, checked = 0, stale = 0;
  for (const source of workspace.documentSources ?? []) {
    if (!linkedSources.has(source.id) || source.provider !== 'google-drive' || source.sourceScope !== 'drive' || !source.fileId) continue;
    driveTotal++;
    const view = metadata?.(source);
    if (view?.checkedAt === undefined) continue;
    if (view.stale) {stale++; continue;}
    if (['available', 'trashed', 'unavailable'].includes(view.status)) checked++;
    if (view.status === 'trashed' || view.status === 'unavailable') unavailableSources.add(source.id);
  }
  groups.set('unavailable', tasks.filter(task => links.get(task.id)?.some(id => unavailableSources.has(id))));
  const conflicts = unresolvedTaskConflicts(workspace.taskConflicts).filter(conflict => taskIds.has(conflict.id) || conflict.versions.some(version => version.task && inScope(version.task)));
  const completed = groups.get('done')!.length;
  const percent = tasks.length ? Math.round(completed / tasks.length * 100) : 0;
  const rows = [...workspace.projects.filter(project => (options.includeArchived || !project.archived) && (options.project === 'all' || options.project === project.id)), {id: '', name: '未指定專案', archived: false}].filter(project => options.project === 'all' || options.project === project.id);
  return {
    tasks, groups, statusGroups, projectGroups, percent, completed, subtaskTotal, subtaskDone, conflicts,
    statuses: workspace.statuses.filter(status => options.includeArchived || status.kind !== 'archived').map(status => ({...status, count: statusGroups.get(status.id)!.length, percent: tasks.length ? statusGroups.get(status.id)!.length / tasks.length * 100 : 0})),
    projects: rows.map(project => {
      const selected = projectGroups.get(project.id) ?? [];
      let done = 0, archivedCount = 0;
      for (const task of selected) {const kind = statuses.get(task.status)?.kind; if (kind === 'done') done++; else if (kind === 'archived') archivedCount++;}
      return {...project, count: selected.length, completed: done, pending: selected.length - done - archivedCount, archivedCount, percent: selected.length ? Math.round(done / selected.length * 100) : 0};
    }),
    coverage: {total: driveTotal, checked, stale, unavailable: unavailableSources.size},
    weekLabel: `${firstDay} ～ ${lastDay}`,
    todayLabel: today
  };
}
export type WorkspaceOverviewData = ReturnType<typeof workspaceOverview>;
export function overviewTasks(data: WorkspaceOverviewData, selection: OverviewSelection): Task[] {
  return selection.kind === 'status' ? data.statusGroups.get(selection.value ?? '') ?? []
    : selection.kind === 'project' ? data.projectGroups.get(selection.value ?? '') ?? [] : data.groups.get(selection.kind) ?? [];
}
