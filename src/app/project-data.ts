import type { BoardStatus, Project, Task } from './models';

export interface ProjectProgress {
  id: string;
  name: string;
  completed: number;
  total: number;
  taskCount: number;
  percent: number;
}

export function tasksForProject(tasks: readonly Task[], projectId: string): Task[] {
  return tasks.filter(task => projectId === 'all' || task.projectId === projectId);
}

/** Overall progress excludes archived projects; their individual progress remains available. */
export function projectProgress(tasks: readonly Task[], statuses: readonly BoardStatus[], projectId: string, name: string, projects: readonly Project[] = []): ProjectProgress {
  const selected = tasksForProject(tasks, projectId);
  const kinds = new Map(statuses.map(status => [status.id, status.kind]));
  const archived = new Set(projects.filter(project => project.archived).map(project => project.id));
  const active = selected.filter(task => kinds.get(task.status) !== 'archived' && (projectId !== 'all' || !archived.has(task.projectId)));
  const completed = active.filter(task => kinds.get(task.status) === 'done').length;
  return {id: projectId, name, completed, total: active.length, taskCount: selected.length, percent: active.length ? Math.round(completed / active.length * 100) : 0};
}

export function projectSummaries(tasks: readonly Task[], statuses: readonly BoardStatus[], projects: readonly Project[]): ProjectProgress[] {
  const rows = projects.map(project => projectProgress(tasks, statuses, project.id, project.name));
  if (tasks.some(task => !task.projectId)) rows.push(projectProgress(tasks, statuses, '', '未指定專案'));
  return rows;
}
