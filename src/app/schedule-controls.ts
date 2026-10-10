import {Directive, HostListener} from '@angular/core';
import {dateKey, parseDate, validDate} from './task-schedule';

export function adjacentHour(date: string, time: string, hours: number): {date: string; time: string} | null {
  if (!validDate(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;
  const value = parseDate(date), [hour, minute] = time.split(':').map(Number);
  value.setHours(hour + hours, minute, 0, 0);
  if (value.getFullYear() < 1900 || value.getFullYear() > 9999) return null;
  return {date: dateKey(value), time: String(value.getHours()).padStart(2, '0') + ':' + String(value.getMinutes()).padStart(2, '0')};
}
@Directive({selector: 'input[type=date]'})
export class DatePickerTrigger {
  @HostListener('click', ['$event'])
  open(event: MouseEvent): void {
    const field = event.currentTarget as HTMLInputElement;
    if (field.disabled || field.readOnly) return;
    try { field.showPicker?.(); } catch { field.focus(); }
  }
}
