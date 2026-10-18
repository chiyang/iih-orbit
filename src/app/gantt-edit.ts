import type {Task} from './models.ts';
import {civilDay, civilKey} from './gantt-data.ts';
import {scheduleError, validDate} from './task-schedule.ts';

export type GanttEditKind = 'move' | 'start' | 'end';
/** Calendar-day changes retain optional boundaries and wall-clock times across DST. */
export function editGanttSchedule(task: Task, kind: GanttEditKind, days: number): Task {
  if (!Number.isInteger(days) || !['move', 'start', 'end'].includes(kind) || task.deletedAt || scheduleError(task) || !task.startDate && !task.dueDate) throw new Error('這個任務的時程無法調整，請開啟任務確認。');
  if (kind === 'start' && !task.startDate || kind === 'end' && !task.dueDate) throw new Error('請先在任務內設定這個日期。');
  const shift = (date: string) => {
    if (!date) return '';
    const day = civilDay(date) + days;
    if (day < civilDay('1900-01-01') || day > civilDay('9999-12-31')) throw new Error('日期超出可用範圍，原時程保留。');
    const result = civilKey(day); if (!validDate(result)) throw new Error('請使用有效日期。'); return result;
  };
  const result = {...task, startDate: kind === 'end' ? task.startDate : shift(task.startDate), dueDate: kind === 'start' ? task.dueDate : shift(task.dueDate)};
  const error = scheduleError(result); if (error) throw new Error(error);
  return result;
}
