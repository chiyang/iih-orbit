export interface WeekTimeRange {startHour: number; endHour: number}
export const CALENDAR_DISPLAY_KEY = 'iih-orbit-calendar-display-v1';
export const DEFAULT_WEEK_RANGE: WeekTimeRange = {startHour: 8, endHour: 19};

export function validWeekRange(value: unknown): value is WeekTimeRange {
  if (!value || typeof value !== 'object') return false;
  const {startHour, endHour} = value as WeekTimeRange;
  return Number.isInteger(startHour) && Number.isInteger(endHour) && startHour >= 0 && endHour <= 24 && endHour > startHour;
}
export function readWeekRange(value: unknown): WeekTimeRange {
  return validWeekRange(value) ? {startHour: value.startHour, endHour: value.endHour} : {...DEFAULT_WEEK_RANGE};
}
export function loadWeekRange(): WeekTimeRange {
  try {const record = JSON.parse(localStorage.getItem(CALENDAR_DISPLAY_KEY) ?? 'null'); return readWeekRange(record?.version === 1 ? record.range : null);}
  catch {return {...DEFAULT_WEEK_RANGE};}
}
