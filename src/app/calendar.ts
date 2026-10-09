import { afterRenderEffect, Component, computed, DestroyRef, ElementRef, inject, input, output, signal, viewChild } from '@angular/core';
import { BoardStatus, Category, COLUMNS, Task } from './models';
import { Icon } from './icon';
import { ThemeColor } from './theme-color';
import { dateKey, monthDates, parseDate, taskDateRange, taskOccursOn, weekDates } from './task-schedule';
import { HOUR_HEIGHT, layoutAllDayTasks, minuteLabel, timedEventsOnDay } from './week-layout';
import { UiPreferences } from './ui-preferences';

export interface CalendarCreate {
  date: string;
  time?: string;
}

@Component({
  selector: 'app-calendar',
  imports: [Icon, ThemeColor],
  templateUrl: './calendar.html',
  styleUrl: './calendar.css'
})
export class Calendar {
  readonly preferences = inject(UiPreferences);
  readonly tasks = input.required<Task[]>();
  readonly categories = input.required<Category[]>();
  readonly statuses = input<BoardStatus[]>(COLUMNS);
  readonly mode = input.required<'month' | 'week'>();
  readonly editTask = output<Task>();
  readonly createTask = output<CalendarCreate>();
  readonly anchor = signal(new Date());
  readonly expandedDays = signal(new Set<string>());
  readonly weekdays = ['週一', '週二', '週三', '週四', '週五', '週六', '週日'];
  readonly now = signal(new Date());
  readonly today = computed(() => dateKey(this.now()));
  readonly weekScroller = viewChild<ElementRef<HTMLDivElement>>('weekScroller');
  readonly hourHeight = computed(() => HOUR_HEIGHT * this.preferences.scale());
  readonly timelineHeight = computed(() => this.hourHeight() * 24);
  readonly hours = Array.from({length: 24}, (_, hour) => ({hour, label: minuteLabel(hour * 60)}));
  readonly slots = Array.from({length: 48}, (_, index) => ({minute: index * 30, label: minuteLabel(index * 30)}));
  readonly nowPosition = computed(() => (this.now().getHours() * 60 + this.now().getMinutes()) / 1440 * 100);
  readonly days = computed(() => {
    const anchor = this.anchor();
    const dates = this.mode() === 'month' ? monthDates(anchor) : weekDates(anchor);
    return dates.map(date => {
      const key = dateKey(date);
      const tasks = this.tasks().filter(task => taskOccursOn(task, key)).sort((left, right) => {
        const leftTime = this.timeOnDay(left, key);
        const rightTime = this.timeOnDay(right, key);
        return leftTime.localeCompare(rightTime) || left.title.localeCompare(right.title, 'zh-Hant-TW');
      });
      return {
        key,
        date,
        label: `${date.getMonth() + 1}/${date.getDate()}`,
        number: date.getDate(),
        currentMonth: date.getMonth() === anchor.getMonth() && date.getFullYear() === anchor.getFullYear(),
        today: key === this.today(),
        tasks,
        visibleTasks: this.mode() === 'week' || this.expandedDays().has(key) ? tasks : tasks.slice(0, 3)
      };
    });
  });
  readonly unscheduled = computed(() => this.tasks().filter(task => !task.startDate && !task.dueDate));
  readonly periodTitle = computed(() => {
    const anchor = this.anchor();
    if (this.mode() === 'month') return `${anchor.getFullYear()} 年 ${anchor.getMonth() + 1} 月`;
    const dates = weekDates(anchor);
    const start = dates[0];
    const end = dates[6];
    const endYear = start.getFullYear() !== end.getFullYear() ? `${end.getFullYear()} 年 ` : '';
    return `${start.getFullYear()} 年 ${start.getMonth() + 1} 月 ${start.getDate()} 日 — ${endYear}${end.getMonth() + 1} 月 ${end.getDate()} 日`;
  });
  readonly weekDays = computed(() => this.days().map((day, index) => ({...day, weekday: this.weekdays[index], timedEvents: timedEventsOnDay(this.tasks(), day.key)})));
  readonly allDayEvents = computed(() => layoutAllDayTasks(this.tasks(), this.days().map(day => day.key)));
  readonly allDayRows = computed(() => Math.max(1, ...this.allDayEvents().map(event => event.row + 1)));
  readonly periodTaskCount = computed(() => new Set(this.mode() === 'week'
    ? [...this.allDayEvents().map(event => event.task.id), ...this.weekDays().flatMap(day => day.timedEvents.map(event => event.task.id))]
    : this.days().flatMap(day => day.tasks.map(task => task.id))).size);
  private previousScroller?: HTMLDivElement;
  private previousAnchor?: Date;
  private previousHourHeight = HOUR_HEIGHT;
  private scrollHour = 7.75;

  constructor() {
    const timer = setInterval(() => this.now.set(new Date()), 60000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
    afterRenderEffect(() => {
      const anchor = this.anchor();
      const hourHeight = this.hourHeight();
      const scroller = this.weekScroller()?.nativeElement;
      if (scroller) {
        const samePeriod = this.previousScroller === scroller && this.previousAnchor === anchor;
        scroller.scrollTop = (samePeriod ? this.scrollHour : 7.75) * hourHeight;
        this.scrollHour = scroller.scrollTop / hourHeight;
      }
      this.previousScroller = scroller;
      this.previousAnchor = anchor;
      this.previousHourHeight = hourHeight;
    });
  }

  rememberScroll(): void {
    const scroller = this.weekScroller()?.nativeElement;
    if (scroller && this.hourHeight() === this.previousHourHeight) {
      this.scrollHour = scroller.scrollTop / this.previousHourHeight;
    }
  }

  scrollPageFromHeader(event: WheelEvent): void {
    if (event.ctrlKey || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    const scroller = this.weekScroller()?.nativeElement;
    const page = scroller?.ownerDocument.defaultView;
    if (!scroller || !page || !event.cancelable) return;
    const lineHeight = parseFloat(page.getComputedStyle(scroller).lineHeight) || 20;
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? lineHeight
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? page.innerHeight : 1;
    event.preventDefault();
    page.scrollBy({top: event.deltaY * unit, behavior: 'instant'});
  }

  createAt(date: string, time?: string): void {
    this.createTask.emit(time ? {date, time} : {date});
  }

  slotKeydown(event: KeyboardEvent, day: number, minute: number): void {
    const offsets: Record<string, [number, number]> = {ArrowUp: [0, -30], ArrowDown: [0, 30], ArrowLeft: [-1, 0], ArrowRight: [1, 0]};
    const offset = offsets[event.key];
    if (!offset) return;
    event.preventDefault();
    const nextDay = Math.min(6, Math.max(0, day + offset[0]));
    const nextMinute = Math.min(1410, Math.max(0, minute + offset[1]));
    this.weekScroller()?.nativeElement.querySelector<HTMLButtonElement>(`[data-day="${nextDay}"][data-minute="${nextMinute}"]`)?.focus();
  }

  navigate(direction: number): void {
    const current = this.anchor();
    if (this.mode() === 'month') this.anchor.set(new Date(current.getFullYear(), current.getMonth() + direction, 1));
    else {
      const next = new Date(current);
      next.setDate(next.getDate() + direction * 7);
      this.anchor.set(next);
    }
    this.expandedDays.set(new Set());
  }

  goToday(): void {
    this.anchor.set(new Date());
    this.expandedDays.set(new Set());
  }

  toggleDay(key: string): void {
    const expanded = new Set(this.expandedDays());
    if (expanded.has(key)) expanded.delete(key);
    else expanded.add(key);
    this.expandedDays.set(expanded);
  }

  category(id: string): Category {
    return this.categories().find(category => category.id === id) ?? {id: '', name: '未分類', color: 'gray'};
  }

  isDone(task: Task): boolean {
    return this.statuses().find(status => status.id === task.status)?.kind === 'done';
  }

  timeOnDay(task: Task, day: string): string {
    if (task.startDate === day && task.startTime) return task.startTime;
    if (task.dueDate === day && task.dueTime) return task.dueTime;
    return '';
  }

  scheduleLabel(task: Task, day: string): string {
    const range = taskDateRange(task);
    if (!range) return '未排程';
    if (range.start === range.end) {
      if (task.startTime && task.dueTime) return `${task.startTime} – ${task.dueTime}`;
      if (task.startTime) return `${task.startTime} 開始`;
      if (task.dueTime) return `${task.dueTime} 截止`;
      if (!task.startDate) return '截止日';
      if (!task.dueDate) return '開始日';
      return '全天';
    }
    if (day === task.startDate) return task.startTime ? `${task.startTime} 開始` : '開始';
    if (day === task.dueDate) return task.dueTime ? `${task.dueTime} 截止` : '截止';
    return '跨日任務';
  }

  taskTitle(task: Task): string {
    const range = taskDateRange(task);
    const dateLabel = (value: string) => {
      const date = parseDate(value);
      return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
    };
    return `${task.title}${range ? ` · ${dateLabel(range.start)}${task.startTime ? ' ' + task.startTime : ''} — ${dateLabel(range.end)}${task.dueTime ? ' ' + task.dueTime : ''}` : ''}`;
  }
}
