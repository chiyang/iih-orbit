import type { BoardStatus, Category, Project, Task } from './models';
import { COLUMNS } from './models.ts';

export type SortKey = 'title' | 'project' | 'category' | 'status' | 'priority' | 'startDate' | 'dueDate';
export type SortDirection = 'asc' | 'desc';

export function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function parseDate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}

export function validDate(value: string): boolean {
  return value === '' || (/^\d{4}-\d{2}-\d{2}$/.test(value) && value >= '1900-01-01' && dateKey(parseDate(value)) === value);
}

export function validTime(value: string): boolean {
  return value === '' || /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function taskMoment(date: string, time: string, endOfDay = false): number | null {
  if (!date) return null;
  const day = parseDate(date);
  if (time) {
    const [hours, minutes] = time.split(':').map(Number);
    day.setHours(hours, minutes, 0, 0);
  } else if (endOfDay) day.setHours(23, 59, 59, 999);
  return day.getTime();
}

export function scheduleError(task: Pick<Task, 'startDate' | 'startTime' | 'dueDate' | 'dueTime'>): string {
  if (!validDate(task.startDate) || !validDate(task.dueDate)) return '請輸入有效的日期。';
  if (!validTime(task.startTime) || !validTime(task.dueTime)) return '請輸入有效的時間。';
  if ((task.startTime && !task.startDate) || (task.dueTime && !task.dueDate)) return '設定時間前，請先選擇日期。';
  const start = taskMoment(task.startDate, task.startTime);
  const end = taskMoment(task.dueDate, task.dueTime, true);
  return start !== null && end !== null && start > end ? '截止日期與時間不能早於開始日期與時間。' : '';
}

export function isTaskOverdue(task: Task, now = new Date(), statuses: readonly BoardStatus[] = COLUMNS): boolean {
  const deadline = taskMoment(task.dueDate, task.dueTime, true);
  const kind = statuses.find(status => status.id === task.status)?.kind ?? 'active';
  return kind === 'active' && deadline !== null && deadline < now.getTime();
}

export function taskDateRange(task: Task): {start: string; end: string} | null {
  const start = task.startDate || task.dueDate;
  const end = task.dueDate || task.startDate;
  return start && end ? {start, end} : null;
}

export function taskOccursOn(task: Task, day: string): boolean {
  const range = taskDateRange(task);
  return !!range && range.start <= day && day <= range.end;
}

export function startOfWeek(date: Date): Date {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  result.setDate(result.getDate() - result.getDay());
  return result;
}

export function monthDates(anchor: Date): Date[] {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const start = startOfWeek(first);
  const offset = first.getDay();
  const daysInMonth = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0).getDate();
  return Array.from({length: Math.ceil((offset + daysInMonth) / 7) * 7}, (_, index) => {
    const day = new Date(start);
    day.setDate(day.getDate() + index);
    return day;
  });
}

export function weekDates(anchor: Date): Date[] {
  const start = startOfWeek(anchor);
  return Array.from({length: 7}, (_, index) => {
    const day = new Date(start);
    day.setDate(day.getDate() + index);
    return day;
  });
}

const collator = new Intl.Collator('zh-Hant-TW', {numeric: true, sensitivity: 'base'});
const priorityOrder = {high: 0, medium: 1, low: 2};

export function sortTasks(tasks: readonly Task[], categories: readonly Category[], key: SortKey | null, direction: SortDirection, statuses: readonly BoardStatus[] = COLUMNS, projects: readonly Project[] = []): Task[] {
  if (!key) return [...tasks];
  const categoryNames = new Map(categories.map(category => [category.id, category.name]));
  const projectNames = new Map(projects.map(project => [project.id, project.name]));
  const statusOrder = new Map(statuses.map((status, index) => [status.id, index]));
  const factor = direction === 'asc' ? 1 : -1;
  return [...tasks].sort((left, right) => {
    if (key === 'startDate' || key === 'dueDate') {
      const leftDate = left[key];
      const rightDate = right[key];
      if (!leftDate || !rightDate) return leftDate ? -1 : rightDate ? 1 : 0;
      const timeKey = key === 'startDate' ? 'startTime' : 'dueTime';
      const leftMoment = taskMoment(leftDate, left[timeKey], key === 'dueDate') ?? 0;
      const rightMoment = taskMoment(rightDate, right[timeKey], key === 'dueDate') ?? 0;
      return (leftMoment - rightMoment) * factor;
    }
    if (key === 'priority') return (priorityOrder[left.priority] - priorityOrder[right.priority]) * factor;
    if (key === 'status') return ((statusOrder.get(left.status) ?? statuses.length) - (statusOrder.get(right.status) ?? statuses.length)) * factor;
    const leftValue = key === 'category' ? categoryNames.get(left.categoryId) || '未分類' : key === 'project' ? projectNames.get(left.projectId) || '未指定專案' : left.title;
    const rightValue = key === 'category' ? categoryNames.get(right.categoryId) || '未分類' : key === 'project' ? projectNames.get(right.projectId) || '未指定專案' : right.title;
    return collator.compare(leftValue, rightValue) * factor;
  });
}
