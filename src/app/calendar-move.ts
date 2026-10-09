import type { Task } from './models';
import { scheduleError, validDate } from './task-schedule.ts';

export interface CalendarPosition {day: string; minute?: number; kind: 'month' | 'all-day' | 'time'}
export type TaskSchedule = Pick<Task, 'startDate' | 'startTime' | 'dueDate' | 'dueTime'>;
const MINUTES_PER_DAY = 1440;
const dayNumber = (value: string) => { const [year, month, day] = value.split('-').map(Number); return Date.UTC(year, month - 1, day) / 86400000; };
const dateFromNumber = (day: number) => new Date(day * 86400000).toISOString().slice(0, 10);
const timeNumber = (time: string) => { const [hour, minute] = time.split(':').map(Number); return hour * 60 + minute; };
const label = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
export const snapCalendarMinute = (minute: number) => Math.max(0, Math.min(1425, Math.round(minute / 15) * 15));

/** Move the whole task using the grabbed segment as the anchor; keep absent boundaries absent. */
export function moveCalendarTask(task: TaskSchedule, origin: CalendarPosition, target: CalendarPosition): TaskSchedule {
  if (!origin.day || !target.day || !validDate(origin.day) || !validDate(target.day) || scheduleError(task)) throw new Error('日期或任務時程不合法，無法移動。');
  const moved = {...task};
  const days = dayNumber(target.day) - dayNumber(origin.day);
  const shiftDate = (date: string) => date ? dateFromNumber(dayNumber(date) + days) : '';
  moved.startDate = shiftDate(task.startDate); moved.dueDate = shiftDate(task.dueDate);
  if (!moved.startDate && !moved.dueDate) moved.dueDate = target.day;
  if (target.kind === 'all-day' && origin.kind === 'time') {
    moved.startTime = ''; moved.dueTime = '';
  } else if (target.kind === 'time') {
    if (!Number.isFinite(target.minute)) throw new Error('請選擇有效的時間位置。');
    const minute = snapCalendarMinute(target.minute!);
    const hasTime = !!(task.startTime || task.dueTime);
    const originMinute = origin.minute ?? (task.startDate === origin.day && task.startTime ? timeNumber(task.startTime) : !task.startDate && task.dueTime ? timeNumber(task.dueTime) : 0);
    const delta = days * MINUTES_PER_DAY + minute - originMinute;
    const shiftMoment = (date: string, time: string) => {
      if (!date) return {date: '', time: ''};
      const value = dayNumber(date) * MINUTES_PER_DAY + timeNumber(time || '00:00') + delta;
      const day = Math.floor(value / MINUTES_PER_DAY);
      return {date: dateFromNumber(day), time: label(value - day * MINUTES_PER_DAY)};
    };
    if (hasTime) {
      const start = shiftMoment(task.startDate, task.startTime);
      const end = shiftMoment(task.dueDate, task.dueTime);
      moved.startDate = start.date; moved.startTime = start.time;
      moved.dueDate = end.date; moved.dueTime = end.time;
      // Optional untimed boundaries retain their day-level meaning.
      if (!task.startTime) moved.startTime = '';
      if (!task.dueTime) moved.dueTime = '';
    } else if (task.startDate && task.dueDate) {
      // A one-day all-day task becomes a one-hour task; longer ranges keep their day span.
      const span = dayNumber(task.dueDate) - dayNumber(task.startDate);
      const startDay = dayNumber(task.startDate) + days;
      const end = startDay * MINUTES_PER_DAY + minute + (span > 0 ? (span + 1) * MINUTES_PER_DAY : 60);
      moved.startDate = dateFromNumber(startDay); moved.startTime = label(minute);
      moved.dueDate = dateFromNumber(Math.floor(end / MINUTES_PER_DAY)); moved.dueTime = label(end % MINUTES_PER_DAY);
    } else {
      if (moved.startDate) moved.startTime = label(minute);
      if (moved.dueDate) moved.dueTime = label(minute);
    }
  }
  const error = scheduleError(moved);
  if (error) throw new Error(error);
  return {startDate: moved.startDate, startTime: moved.startTime, dueDate: moved.dueDate, dueTime: moved.dueTime};
}
