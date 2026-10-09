import { afterRenderEffect, Component, computed, DestroyRef, effect, ElementRef, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { BoardStatus, Category, COLUMNS, Task } from './models';
import { Icon } from './icon';
import { ThemeColor } from './theme-color';
import { dateKey, monthDates, parseDate, taskDateRange, weekDates } from './task-schedule';
import { allDayRange, HOUR_HEIGHT, layoutAllDayTasks, minuteLabel, timedEventsOnDay } from './week-layout';
import { UiPreferences } from './ui-preferences';
import { GoogleCalendarService } from './google-calendar';
import { ExternalEvent, externalOccursOn } from './google-data';
import { CalendarPosition, moveCalendarTask, snapCalendarMinute } from './calendar-move';
import type { TaskEditContext } from './board-store';

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
  readonly google = inject(GoogleCalendarService);
  readonly tasks = input.required<Task[]>();
  readonly categories = input.required<Category[]>();
  readonly statuses = input<BoardStatus[]>(COLUMNS);
  readonly mode = input.required<'month' | 'week'>();
  readonly showOrbit = input(true);
  readonly showGoogle = input(true);
  readonly deadlineFiltered = input(false);
  readonly orbitVisibilityChange = output<boolean>();
  readonly googleVisibilityChange = output<boolean>();
  readonly googleVisible = computed(() => this.showGoogle() && !this.deadlineFiltered());
  readonly editTask = output<Task>();
  readonly readExternal = output<ExternalEvent>();
  readonly createTask = output<CalendarCreate>();
  readonly anchor = signal(new Date());
  readonly expandedDays = signal(new Set<string>());
  readonly expandAll = signal(false);
  readonly monthPreviewLimit = 4;
  readonly savingMove = signal(false);
  readonly moveNotice = signal('');
  readonly moveError = signal('');
  readonly draggedTaskId = signal('');
  readonly dropPosition = signal<CalendarPosition | null>(null);
  readonly dropTimeLabel = computed(() => minuteLabel(this.dropPosition()?.minute ?? 0));
  readonly weekdays = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
  readonly now = signal(new Date());
  readonly today = computed(() => dateKey(this.now()));
  readonly weekScroller = viewChild<ElementRef<HTMLDivElement>>('weekScroller');
  readonly hourHeight = computed(() => HOUR_HEIGHT * this.preferences.scale());
  readonly timelineHeight = computed(() => this.hourHeight() * 24);
  readonly hours = Array.from({length: 24}, (_, hour) => ({hour, label: minuteLabel(hour * 60)}));
  readonly slots = Array.from({length: 48}, (_, index) => ({minute: index * 30, label: minuteLabel(index * 30)}));
  readonly nowPosition = computed(() => (this.now().getHours() * 60 + this.now().getMinutes()) / 1440 * 100);
  readonly externalEntries = computed(() => new Map(this.google.events().map(entry => [entry.task.id, entry])));
  readonly combinedTasks = computed(() => [
    ...(this.showOrbit() ? this.tasks() : []),
    ...(this.googleVisible() ? this.google.events().map(entry => entry.task) : [])
  ]);
  readonly days = computed(() => {
    const anchor = this.anchor();
    const dates = this.mode() === 'month' ? monthDates(anchor) : weekDates(anchor);
    return dates.map(date => {
      const key = dateKey(date);
      const timedEvents = timedEventsOnDay(this.combinedTasks(), key);
      const times = new Map(timedEvents.map(event => [event.task.id, event.startMinute]));
      const tasks = this.combinedTasks().filter(task => {
        const external = this.externalEntries().get(task.id);
        return (!external || externalOccursOn(external, key)) && (this.isAllDay(task, key) || times.has(task.id));
      }).sort((left, right) => {
        return Number(!this.isAllDay(left, key)) - Number(!this.isAllDay(right, key))
          || Number(!this.isExternal(left)) - Number(!this.isExternal(right))
          || (times.get(left.id) ?? 0) - (times.get(right.id) ?? 0)
          || left.title.localeCompare(right.title, 'zh-Hant-TW') || left.id.localeCompare(right.id);
      });
      return {
        key,
        date,
        label: `${date.getMonth() + 1}/${date.getDate()}`,
        number: date.getDate(),
        currentMonth: date.getMonth() === anchor.getMonth() && date.getFullYear() === anchor.getFullYear(),
        today: key === this.today(),
        tasks,
        timedEvents,
        visibleTasks: this.mode() === 'week' || this.expandAll() || this.expandedDays().has(key) ? tasks : tasks.slice(0, this.monthPreviewLimit)
      };
    });
  });
  readonly unscheduled = computed(() => this.showOrbit() ? this.tasks().filter(task => !task.startDate && !task.dueDate) : []);
  readonly hasOverflow = computed(() => this.days().some(day => day.tasks.length > this.monthPreviewLimit));
  readonly allDaysExpanded = computed(() => this.expandAll() || this.hasOverflow() && this.days().filter(day => day.tasks.length > this.monthPreviewLimit).every(day => this.expandedDays().has(day.key)));
  readonly periodTitle = computed(() => {
    const anchor = this.anchor();
    if (this.mode() === 'month') return `${anchor.getFullYear()} 年 ${anchor.getMonth() + 1} 月`;
    const dates = weekDates(anchor);
    const start = dates[0];
    const end = dates[6];
    const endYear = start.getFullYear() !== end.getFullYear() ? `${end.getFullYear()} 年 ` : '';
    return `${start.getFullYear()} 年 ${start.getMonth() + 1} 月 ${start.getDate()} 日 — ${endYear}${end.getMonth() + 1} 月 ${end.getDate()} 日`;
  });
  readonly weekDays = computed(() => this.days().map((day, index) => ({...day, weekday: this.weekdays[index]})));
  readonly allDayEvents = computed(() => layoutAllDayTasks(this.combinedTasks(), this.days().map(day => day.key)));
  readonly allDayRows = computed(() => Math.max(1, ...this.allDayEvents().map(event => event.row + 1)));
  readonly periodIds = computed(() => new Set(this.mode() === 'week'
    ? [...this.allDayEvents().map(event => event.task.id), ...this.weekDays().flatMap(day => day.timedEvents.map(event => event.task.id))]
    : this.days().flatMap(day => day.tasks.map(task => task.id))));
  readonly periodTaskCount = computed(() => [...this.periodIds()].filter(id => !this.externalEntries().has(id)).length);
  readonly periodExternalCount = computed(() => [...this.periodIds()].filter(id => this.externalEntries().has(id)).length);
  private previousScroller?: HTMLDivElement;
  private previousAnchor?: Date;
  private previousHourHeight = HOUR_HEIGHT;
  private scrollHour = 7.75;
  private drag?: {task: Task; context: TaskEditContext; origin: CalendarPosition; pointerOffset: number};
  private pointer?: {x: number; y: number; timeDay?: HTMLElement};
  private dragScrollTimer?: ReturnType<typeof setInterval>;
  private ignoreClickUntil = 0;

  constructor() {
    effect(() => {
      const anchor = this.anchor();
      untracked(() => this.google.setMonthRange(anchor));
    });
    const timer = setInterval(() => this.now.set(new Date()), 60000);
    inject(DestroyRef).onDestroy(() => { clearInterval(timer); this.endDrag(); });
    effect(() => {
      const generation = this.google.store.generation(), workspace = this.google.store.currentWorkspace().id, mode = this.mode(), showOrbit = this.showOrbit();
      untracked(() => { if (this.drag && (!showOrbit || this.drag.context.generation !== generation || this.drag.context.workspaceId !== workspace || this.drag.origin.kind === 'month' && mode !== 'month')) this.endDrag(); });
    });
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
    if (this.drag || Date.now() < this.ignoreClickUntil) return;
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
    if (this.expandAll()) {
      this.expandedDays.set(new Set(this.days().filter(day => day.key !== key).map(day => day.key)));
      this.expandAll.set(false); return;
    }
    const expanded = new Set(this.expandedDays());
    if (expanded.has(key)) expanded.delete(key);
    else expanded.add(key);
    this.expandedDays.set(expanded);
  }
  dayExpanded(key: string): boolean { return this.expandAll() || this.expandedDays().has(key); }
  toggleAllDays(): void { const expand = !this.allDaysExpanded(); this.expandedDays.set(new Set()); this.expandAll.set(expand); }
  toggleOrbit(): void { this.endDrag(); this.orbitVisibilityChange.emit(!this.showOrbit()); }
  toggleGoogle(): void { if (!this.deadlineFiltered()) this.googleVisibilityChange.emit(!this.showGoogle()); }

  startDrag(event: DragEvent, task: Task, origin: CalendarPosition): void {
    if (this.isExternal(task) || this.savingMove() || !event.dataTransfer) { event.preventDefault(); return; }
    const context = this.google.store.taskContext(task.id);
    if (!context.original || (Object.keys(context.original) as (keyof Task)[]).some(key => JSON.stringify(context.original![key]) !== JSON.stringify(task[key]))) { event.preventDefault(); this.moveError.set('任務已更新，請重新查看後再拖曳。'); return; }
    this.endDrag();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const pointerOffset = origin.kind === 'time' ? Math.max(0, (event.clientY - rect.top) / this.hourHeight() * 60) : 0;
    this.drag = {task: structuredClone(task), context, origin, pointerOffset};
    this.draggedTaskId.set(task.id); this.moveNotice.set(''); this.moveError.set('');
    event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', task.title);
    this.dragScrollTimer = setInterval(() => this.scrollWhileDragging(), 60);
  }
  startAllDayDrag(event: DragEvent, task: Task, firstDay: string): void {
    const container = (event.currentTarget as HTMLElement).closest<HTMLElement>('.week-all-day');
    this.startDrag(event, task, {kind: 'all-day', day: container ? this.allDayAt(container, event.clientX) || firstDay : firstDay});
  }
  private allDayAt(container: HTMLElement, x: number): string {
    return [...container.querySelectorAll<HTMLElement>('.all-day-cell')].find(cell => { const rect = cell.getBoundingClientRect(); return x >= rect.left && x < rect.right; })?.dataset['date'] ?? '';
  }
  private timePosition(day: string, element: HTMLElement, y: number): CalendarPosition {
    return {kind: 'time', day, minute: snapCalendarMinute((y - element.getBoundingClientRect().top) / this.hourHeight() * 60 - (this.drag?.pointerOffset ?? 0))};
  }
  dragOver(event: DragEvent, position: CalendarPosition): void {
    if (!this.drag) return;
    event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    this.dropPosition.set(position); this.pointer = {x: event.clientX, y: event.clientY};
  }
  timeDragOver(event: DragEvent, day: string): void {
    const element = event.currentTarget as HTMLElement;
    this.dragOver(event, this.timePosition(day, element, event.clientY));
    if (this.drag) this.pointer = {x: event.clientX, y: event.clientY, timeDay: element};
  }
  allDayDragOver(event: DragEvent): void {
    const day = this.allDayAt(event.currentTarget as HTMLElement, event.clientX);
    if (day) this.dragOver(event, {kind: 'all-day', day});
  }
  timeDrop(event: DragEvent, day: string): void { void this.drop(event, this.timePosition(day, event.currentTarget as HTMLElement, event.clientY)); }
  allDayDrop(event: DragEvent): void {
    const day = this.allDayAt(event.currentTarget as HTMLElement, event.clientX);
    if (day) void this.drop(event, {kind: 'all-day', day});
  }
  async drop(event: DragEvent, target: CalendarPosition): Promise<void> {
    const drag = this.drag;
    if (!drag || this.savingMove()) return;
    event.preventDefault(); event.stopPropagation(); this.endDrag(); this.savingMove.set(true);
    try {
      const schedule = moveCalendarTask(drag.task, drag.origin, target);
      const task = {...drag.task, ...schedule};
      if (JSON.stringify(task) === JSON.stringify(drag.task)) return;
      const result = await this.google.store.saveTask(task, drag.context);
      if (!result.ok) { this.moveError.set(result.message.includes('這個任務已在另一個分頁') ? '任務已在其他分頁更新或刪除，未套用移動。請重新查看後再拖曳。' : '移動未儲存：' + result.message); return; }
      this.moveNotice.set(`已調整「${task.title}」的日期${target.kind === 'time' ? '與時間' : ''}。${result.persisted ? '' : '目前只保留於此分頁，請匯出備份。'}`);
    } catch (error) { this.moveError.set(error instanceof Error ? error.message : '無法移動任務，原時程已保留。'); }
    finally { this.savingMove.set(false); }
  }
  endDrag(): void {
    if (this.drag) this.ignoreClickUntil = Date.now() + 350;
    this.drag = undefined; this.pointer = undefined; this.draggedTaskId.set(''); this.dropPosition.set(null);
    clearInterval(this.dragScrollTimer); this.dragScrollTimer = undefined;
  }
  leaveCalendar(event: DragEvent): void {
    const element = event.currentTarget as HTMLElement, rect = element.getBoundingClientRect();
    if (!element.contains(event.relatedTarget as Node | null) && (event.clientX < rect.left || event.clientX >= rect.right || event.clientY < rect.top || event.clientY >= rect.bottom)) { this.dropPosition.set(null); this.pointer = undefined; }
  }
  private scrollWhileDragging(): void {
    const scroller = this.weekScroller()?.nativeElement, pointer = this.pointer;
    if (!this.drag || !scroller || !pointer?.timeDay) return;
    const rect = scroller.getBoundingClientRect();
    const headerHeight = scroller.querySelector<HTMLElement>('.week-sticky-head')?.getBoundingClientRect().height ?? 0;
    const vertical = pointer.y > rect.bottom - 45 ? 16 : pointer.y < rect.top + headerHeight + 35 ? -16 : 0;
    const horizontal = pointer.x > rect.right - 35 ? 16 : pointer.x < rect.left + 35 ? -16 : 0;
    if (vertical || horizontal) {
      scroller.scrollBy({top: vertical, left: horizontal, behavior: 'instant'});
      const element = scroller.ownerDocument.elementFromPoint(pointer.x, pointer.y)?.closest<HTMLElement>('.time-day');
      if (element?.dataset['date']) { this.pointer = {...pointer, timeDay: element}; this.dropPosition.set(this.timePosition(element.dataset['date'], element, pointer.y)); }
    }
  }

  category(id: string): Category {
    const source = this.google.visibleSources().find(source => 'google:' + source.id === id);
    if (source) return {id, name: 'Google・' + source.name, color: source.color as `#${string}`};
    return this.categories().find(category => category.id === id) ?? {id: '', name: '未分類', color: 'gray'};
  }

  isExternal(task: Task): boolean { return this.externalEntries().has(task.id); }
  openEntry(task: Task): void {
    if (this.drag || Date.now() < this.ignoreClickUntil) return;
    const external = this.externalEntries().get(task.id);
    if (external) this.readExternal.emit(external);
    else this.editTask.emit(task);
  }

  isDone(task: Task): boolean {
    return this.statuses().find(status => status.id === task.status)?.kind === 'done';
  }

  isAllDay(task: Task, day: string): boolean {
    const range = allDayRange(task);
    return !!range && range.start <= day && day <= range.end;
  }

  monthScheduleLabel(task: Task, day: string): string {
    if (this.isAllDay(task, day)) return this.isExternal(task) || task.startTime || task.dueTime ? '全天' : this.scheduleLabel(task, day);
    const event = this.days().find(date => date.key === day)?.timedEvents.find(event => event.task.id === task.id);
    if (!event) return '';
    if (event.milestone && (!task.startTime || !task.dueTime)) return minuteLabel(Math.floor(event.startMinute)) + (task.startDate === day && task.startTime ? ' 開始' : ' 截止');
    return `${minuteLabel(Math.floor(event.startMinute))} – ${minuteLabel(Math.floor(event.endMinute))}${event.label.includes('（時區轉換）') ? '（時區轉換）' : ''}`;
  }

  scheduleLabel(task: Task, day: string): string {
    if (this.isExternal(task)) {
      if (!task.startTime && !task.dueTime) return 'Google・全天';
      if (task.startDate === task.dueDate) return `${task.startTime} – ${task.dueTime}`;
      return day === task.startDate ? task.startTime + ' 開始' : day === task.dueDate ? task.dueTime + ' 結束' : 'Google・跨日活動';
    }
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
