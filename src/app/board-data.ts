import type { BoardState, BoardStatus, Task } from './models';
import { CATEGORY_COLORS, COLUMNS, PRIORITIES } from './models.ts';
import { scheduleError, validDate } from './task-schedule.ts';

/** Read saved schemas without mutating the source or discarding legacy tasks. */
export function readBoardState(value: unknown): BoardState | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Omit<BoardState, 'version'> & {version: unknown};
  if (![1, 2, 3].includes(source.version as number) || typeof source.projectName !== 'string' || !source.projectName.trim()) return null;
  if (!Array.isArray(source.categories) || !Array.isArray(source.tasks)) return null;
  const statuses: BoardStatus[] = source.version === 3 ? source.statuses : COLUMNS;
  if (!validStatuses(statuses)) return null;
  const validCategories = source.categories.every(category => category && typeof category.id === 'string'
    && category.id && typeof category.name === 'string' && category.name.trim() && CATEGORY_COLORS.some(color => color.id === category.color));
  if (!validCategories || new Set(source.categories.map(category => category.id)).size !== source.categories.length) return null;
  const legacy = source.version === 1;
  const validTasks = source.tasks.every(task => task && typeof task.id === 'string' && task.id && typeof task.title === 'string'
    && task.title.trim() && typeof task.description === 'string' && typeof task.categoryId === 'string'
    && (!task.categoryId || source.categories.some(category => category.id === task.categoryId))
    && statuses.some(column => column.id === task.status) && PRIORITIES.some(priority => priority.id === task.priority)
    && typeof task.dueDate === 'string' && validDate(task.dueDate)
    && (legacy || (typeof task.startDate === 'string' && typeof task.startTime === 'string' && typeof task.dueTime === 'string' && !scheduleError(task)))
    && Array.isArray(task.subtasks) && task.subtasks.every(subtask => subtask && typeof subtask.id === 'string'
      && typeof subtask.title === 'string' && typeof subtask.done === 'boolean'));
  if (!validTasks || new Set(source.tasks.map(task => task.id)).size !== source.tasks.length) return null;
  const tasks: Task[] = source.tasks.map(task => ({
    id: task.id,
    title: task.title,
    description: task.description,
    categoryId: task.categoryId,
    status: task.status,
    priority: task.priority,
    startDate: legacy ? '' : task.startDate,
    startTime: legacy ? '' : task.startTime,
    dueDate: task.dueDate,
    dueTime: legacy ? '' : task.dueTime,
    subtasks: task.subtasks.map(subtask => ({...subtask}))
  }));
  return {version: 3, projectName: source.projectName, categories: source.categories.map(category => ({...category})), statuses: statuses.map(status => ({...status, hidden: status.hidden ?? status.kind === 'archived'})), tasks};
}

export function validStatuses(statuses: unknown): statuses is BoardStatus[] {
  if (!Array.isArray(statuses) || !statuses.length) return false;
  return statuses.every(status => status && typeof status.id === 'string' && status.id && typeof status.label === 'string'
    && status.label.trim() && typeof status.subtitle === 'string' && CATEGORY_COLORS.some(color => color.id === status.color)
    && ['active', 'done', 'archived'].includes(status.kind) && (status.hidden === undefined || typeof status.hidden === 'boolean'))
    && new Set(statuses.map(status => status.id)).size === statuses.length
    && new Set(statuses.map(status => status.label.trim().toLocaleLowerCase())).size === statuses.length;
}
