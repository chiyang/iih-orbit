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

/** Overall progress is weighted by task counts, and archived tasks are excluded. */
export function projectProgress(tasks: readonly Task[], statuses: readonly BoardStatus[], projectId: string, name: string): ProjectProgress {
  const selected = tasksForProject(tasks, projectId);
  const kinds = new Map(statuses.map(status => [status.id, status.kind]));
  const active = selected.filter(task => kinds.get(task.status) !== 'archived');
  const completed = active.filter(task => kinds.get(task.status) === 'done').length;
  return {id: projectId, name, completed, total: active.length, taskCount: selected.length, percent: active.length ? Math.round(completed / active.length * 100) : 0};
}

export function projectSummaries(tasks: readonly Task[], statuses: readonly BoardStatus[], projects: readonly Project[]): ProjectProgress[] {
  const rows = projects.map(project => projectProgress(tasks, statuses, project.id, project.name));
  if (tasks.some(task => !task.projectId)) rows.push(projectProgress(tasks, statuses, '', '未指定專案'));
  return rows;
}
