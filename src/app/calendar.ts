import { afterRenderEffect, Component, computed, DestroyRef, effect, ElementRef, HostListener, inject, input, linkedSignal, output, signal, untracked, viewChild } from '@angular/core';
import { BoardStatus, Category, COLUMNS, Task } from './models';
import { Icon } from './icon';
import { Tooltip } from './tooltip';
import { ThemeColor } from './theme-color';
import { dateKey, monthDates, parseDate, taskDateRange, validDate, weekDates } from './task-schedule';
import { allDayRange, HOUR_HEIGHT, layoutAllDayTasks, minuteLabel, timedEventsInRange, timedEventsOnDay } from './week-layout';
import { DEFAULT_WEEK_RANGE } from './calendar-display';
import { UiPreferences } from './ui-preferences';
import { GoogleCalendarService } from './google-calendar';
import { ExternalEvent, externalOccursOn } from './google-data';
import { CalendarPosition, moveCalendarTask, snapCalendarMinute } from './calendar-move';
import type { TaskEditContext } from './board-store';
import { GMAIL_MIME } from './gmail-data';
import { DOCUMENT_DRAG_TYPE } from './document-data';
import {readTaskLinkDrag, TASK_LINK_DRAG_TYPE} from './task-link-drag';

export interface CalendarCreate {
  date: string;
  time?: string;
}

@Component({
  selector: 'app-calendar',
  imports: [Icon, ThemeColor, Tooltip],
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
  readonly selectedDate = input<string>();
  readonly savedScrollHour = input(7.75);
  readonly savedExpandAll = input(false);
  readonly expandAllChange = output<boolean>();
  readonly dateChange = output<string>();
  readonly scrollHourChange = output<number>();
  readonly weekRequested = output<string>();
  readonly monthRequested = output<string>();
  readonly showOrbit = input(true);
  readonly showGoogle = input(true);
  readonly deadlineFiltered = input(false);
  readonly orbitVisibilityChange = output<boolean>();
  readonly googleVisibilityChange = output<boolean>();
  readonly googleVisible = computed(() => this.showGoogle() && !this.deadlineFiltered());
  readonly editTask = output<Task>();
  readonly readExternal = output<ExternalEvent>();
  readonly createTask = output<CalendarCreate>();
  readonly busy = input(false);
  readonly taskDraggingChange = output<boolean>();
  readonly taskLinkTarget = signal<TaskEditContext | null>(null);
  readonly taskLinkPointer = signal<{x: number; y: number} | null>(null);
  readonly documentDragging = input(false);
  readonly documentDrop = output<{event: DragEvent; position?: CalendarPosition; taskId?: string}>();
  readonly documentLinkTaskId = signal('');
  readonly documentBlocked = signal(false);
  readonly mailDragging = input(false);
  readonly mailDrop = output<{event: DragEvent; position?: CalendarPosition; taskId?: string}>();
  readonly anchor = signal(new Date());
  readonly hoveredMonthWeek = signal<number | null>(null);
  readonly expandedDays = signal(new Set<string>());
  readonly expandAll = linkedSignal(() => this.savedExpandAll());
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
  readonly fullDayHours = signal(false);
  readonly widthMode = computed(() => this.preferences.calendarWidth?.() ?? 'wide');
  readonly weekRange = computed(() => this.fullDayHours() ? {startHour: 0, endHour: 24} : this.preferences.weekRange?.() ?? DEFAULT_WEEK_RANGE);
  readonly startMinute = computed(() => this.weekRange().startHour * 60);
  readonly endMinute = computed(() => this.weekRange().endHour * 60);
  readonly rangeMinutes = computed(() => this.endMinute() - this.startMinute());
  readonly weekRangeLabel = computed(() => `${minuteLabel(this.startMinute())}–${minuteLabel(this.endMinute())}`);
  readonly weekEndLabel = computed(() => minuteLabel(this.endMinute()));
  readonly hourHeight = computed(() => HOUR_HEIGHT * this.preferences.scale());
  readonly timelineHeight = computed(() => this.hourHeight() * this.rangeMinutes() / 60);
  readonly hours = computed(() => Array.from({length: this.weekRange().endHour - this.weekRange().startHour}, (_, index) => ({hour: this.weekRange().startHour + index, label: minuteLabel(this.startMinute() + index * 60)})));
  readonly slots = computed(() => Array.from({length: this.rangeMinutes() / 30}, (_, index) => ({minute: this.startMinute() + index * 30, label: minuteLabel(this.startMinute() + index * 30)})));
  readonly firstFocusMinute = computed(() => Math.max(this.startMinute(), Math.min(540, this.endMinute() - 30)));
  readonly nowMinute = computed(() => this.now().getHours() * 60 + this.now().getMinutes());
  readonly nowInRange = computed(() => this.nowMinute() >= this.startMinute() && this.nowMinute() < this.endMinute());
  readonly nowPosition = computed(() => this.minutePosition(this.nowMinute()));
  readonly externalEntries = computed(() => new Map(this.google.events().map(entry => [entry.task.id, entry])));
  readonly combinedTasks = computed(() => [
    ...(this.showOrbit() ? this.tasks() : []),
    ...(this.googleVisible() ? this.google.events().map(entry => entry.task) : [])
  ]);
  readonly days = computed(() => {
    const anchor = this.anchor();
    const dates = this.mode() === 'month' ? monthDates(anchor) : weekDates(anchor);
    const selected = dateKey(anchor);
    return dates.map((date, index) => {
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
        selected: key === selected,
        weekIndex: Math.floor(index / 7),
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
  readonly weekDays = computed(() => this.days().map((day, index) => ({...day, weekday: this.weekdays[index], timedEvents: timedEventsInRange(day.timedEvents, this.startMinute(), this.endMinute())})));
  readonly outsideWeekEvents = computed(() => this.days().flatMap((day, index) => {
    const visible = new Set(this.weekDays()[index].timedEvents.map(event => event.task.id));
    return day.timedEvents.filter(event => !visible.has(event.task.id)).map(event => ({day, event}));
  }));
  readonly allDayEvents = computed(() => layoutAllDayTasks(this.combinedTasks(), this.days().map(day => day.key)));
  readonly allDayRows = computed(() => Math.max(1, ...this.allDayEvents().map(event => event.row + 1)));
  readonly periodIds = computed(() => new Set(this.mode() === 'week'
    ? [...this.allDayEvents().map(event => event.task.id), ...this.days().flatMap(day => day.timedEvents.map(event => event.task.id))]
    : this.days().flatMap(day => day.tasks.map(task => task.id))));
  readonly periodTaskCount = computed(() => [...this.periodIds()].filter(id => !this.externalEntries().has(id)).length);
  readonly periodExternalCount = computed(() => [...this.periodIds()].filter(id => this.externalEntries().has(id)).length);
  private previousScroller?: HTMLDivElement;
  private previousAnchor?: Date;
  private previousHourHeight = HOUR_HEIGHT;
  private previousStartHour = DEFAULT_WEEK_RANGE.startHour;
  private scrollHour = DEFAULT_WEEK_RANGE.startHour;
  private drag?: {task: Task; context: TaskEditContext; origin: CalendarPosition; pointerOffset: number; token: string; mode: 'month' | 'week'; anchor: string};
  private pointer?: {x: number; y: number; timeDay?: HTMLElement};
  private dragScrollTimer?: ReturnType<typeof setInterval>;
  private ignoreClickUntil = 0;

  constructor() {
    effect(() => {
      const date = this.selectedDate(), parsed = date && validDate(date) ? parseDate(date) : null;
      if (parsed) untracked(() => { if (dateKey(this.anchor()) !== date) this.anchor.set(parsed); });
    });
    effect(() => {
      const anchor = this.anchor();
      untracked(() => { this.hoveredMonthWeek.set(null); this.google.setMonthRange(anchor); this.dateChange.emit(dateKey(anchor)); });
    });
    const timer = setInterval(() => this.now.set(new Date()), 60000);
    inject(DestroyRef).onDestroy(() => { clearInterval(timer); this.endDrag(); });
    effect(() => {
      const generation = this.google.store.generation(), workspace = this.google.store.currentWorkspace().id, mode = this.mode(), anchor = dateKey(this.anchor()), showOrbit = this.showOrbit(), busy = this.busy();
      untracked(() => { this.hoveredMonthWeek.set(null); if (this.drag && (busy || !showOrbit || this.drag.context.generation !== generation || this.drag.context.workspaceId !== workspace || this.drag.mode !== mode || this.drag.anchor !== anchor)) this.endDrag(); });
    });
    effect(() => { const dragging = this.mailDragging() || this.documentDragging(); untracked(() => { if (dragging && this.drag || !dragging && !this.drag) this.endDrag(); }); });
    afterRenderEffect(() => {
      const anchor = this.anchor();
      const hourHeight = this.hourHeight();
      const startHour = this.weekRange().startHour;
      const scroller = this.weekScroller()?.nativeElement;
      if (scroller) {
        const samePeriod = this.previousScroller === scroller && this.previousAnchor === anchor;
        const initialHour = this.previousScroller === scroller ? startHour : untracked(() => this.savedScrollHour());
        scroller.scrollTop = Math.max(0, (samePeriod ? this.scrollHour : initialHour) - startHour) * hourHeight;
        this.scrollHour = startHour + scroller.scrollTop / hourHeight;
        untracked(() => this.scrollHourChange.emit(this.scrollHour));
      }
      this.previousScroller = scroller;
      this.previousAnchor = anchor;
      this.previousHourHeight = hourHeight;
      this.previousStartHour = startHour;
    });
  }

  rememberScroll(): void {
    const scroller = this.weekScroller()?.nativeElement;
    if (scroller && this.hourHeight() === this.previousHourHeight && this.weekRange().startHour === this.previousStartHour) {
      this.scrollHour = this.previousStartHour + scroller.scrollTop / this.previousHourHeight;
      this.scrollHourChange.emit(this.scrollHour);
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
    const nextMinute = Math.min(this.endMinute() - 30, Math.max(this.startMinute(), minute + offset[1]));
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

  openWeek(date: string): void {
    if (this.mode() !== 'month' || this.drag || this.mailDragging() || this.documentDragging() || this.savingMove() || Date.now() < this.ignoreClickUntil || !date || !validDate(date)) return;
    this.weekRequested.emit(date);
  }

  openMonth(): void {
    if (this.mode() !== 'week' || this.drag || this.mailDragging() || this.documentDragging() || this.savingMove() || Date.now() < this.ignoreClickUntil) return;
    this.monthRequested.emit(dateKey(this.anchor()));
  }

  openWeekFromDay(event: MouseEvent, date: string): void {
    if (event.defaultPrevented || event.button !== 0 || (event.target as Element | null)?.closest?.('button, a, input, select, textarea, [role="button"]')) return;
    this.openWeek(date);
  }

  toggleDay(key: string): void {
    if (this.expandAll()) {
      this.expandedDays.set(new Set(this.days().filter(day => day.key !== key).map(day => day.key)));
      this.expandAll.set(false); this.expandAllChange.emit(false); return;
    }
    const expanded = new Set(this.expandedDays());
    if (expanded.has(key)) expanded.delete(key);
    else expanded.add(key);
    this.expandedDays.set(expanded);
  }
  dayExpanded(key: string): boolean { return this.expandAll() || this.expandedDays().has(key); }
  toggleAllDays(): void { const expand = !this.allDaysExpanded(); this.expandedDays.set(new Set()); this.expandAll.set(expand); this.expandAllChange.emit(expand); }
  toggleOrbit(): void { this.endDrag(); this.orbitVisibilityChange.emit(!this.showOrbit()); }
  toggleGoogle(): void { if (!this.deadlineFiltered()) this.googleVisibilityChange.emit(!this.showGoogle()); }
  toggleWidth(): void {this.endDrag(); this.preferences.setCalendarWidth(this.widthMode() === 'wide' ? 'standard' : 'wide');}
  toggleWeekHours(): void {this.endDrag(); this.fullDayHours.update(value => !value);}
  minutePosition(minute: number): number {return (minute - this.startMinute()) / this.rangeMinutes() * 100;}
  eventHeight(start: number, end: number): number {return (end - start) / this.rangeMinutes() * 100;}

  startDrag(event: DragEvent, task: Task, origin: CalendarPosition): void {
    if (!this.canDrag(task) || !event.dataTransfer) { event.preventDefault(); return; }
    const context = this.google.store.taskContext(task.id);
    if (!context.original || (Object.keys(context.original) as (keyof Task)[]).some(key => JSON.stringify(context.original![key]) !== JSON.stringify(task[key]))) { event.preventDefault(); this.moveError.set('任務已更新，請重新查看後再拖曳。'); return; }
    this.endDrag();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const pointerOffset = origin.kind === 'time' ? Math.max(0, (event.clientY - rect.top) / this.hourHeight() * 60) : 0;
    const token = crypto.randomUUID();
    this.drag = {task: structuredClone(task), context, origin, pointerOffset, token, mode: this.mode(), anchor: dateKey(this.anchor())};
    this.draggedTaskId.set(task.id); this.moveNotice.set(''); this.moveError.set('');
    event.dataTransfer.effectAllowed = 'all'; event.dataTransfer.setData('text/plain', task.title);
    event.dataTransfer.setData(TASK_LINK_DRAG_TYPE, JSON.stringify({token, taskId: task.id, generation: context.generation, workspaceId: context.workspaceId}));
    this.taskDraggingChange.emit(true);
    this.dragScrollTimer = setInterval(() => this.scrollWhileDragging(), 60);
  }
  canDrag(task: Task): boolean {return !this.busy() && !this.savingMove() && !this.google.store.pendingWrites() && !task.deletedAt && !this.isExternal(task) && !this.google.store.taskConflicts().some(entry => entry.workspace.id === this.google.store.currentWorkspace().id && entry.conflict.id === task.id);}
  private ownTaskEvent(event: DragEvent): boolean {return !!this.drag && !!event.dataTransfer?.types.includes(TASK_LINK_DRAG_TYPE);}
  private validTaskPayload(event: DragEvent): boolean {
    const data = readTaskLinkDrag(event.dataTransfer?.getData(TASK_LINK_DRAG_TYPE) ?? ''), drag = this.drag;
    return !!drag && !!data && data.token === drag.token && data.taskId === drag.task.id && data.generation === drag.context.generation && data.workspaceId === drag.context.workspaceId
      && data.generation === this.google.store.generation() && data.workspaceId === this.google.store.currentWorkspace().id && drag.mode === this.mode() && drag.anchor === dateKey(this.anchor()) && !this.busy();
  }
  private selectTaskLinkTarget(task: Task): boolean {
    let valid = this.canDrag(task) && task.id !== this.drag?.task.id;
    if (valid && this.taskLinkTarget()?.original?.id !== task.id) {
      const context = this.google.store.taskContext(task.id);
      valid = !!context.original && (Object.keys(context.original) as (keyof Task)[]).every(key => JSON.stringify(context.original![key]) === JSON.stringify(task[key]));
      if (valid) this.taskLinkTarget.set(context);
    }
    this.documentBlocked.set(!valid); this.dropPosition.set(null);
    if (!valid) this.taskLinkTarget.set(null);
    return valid;
  }
  startAllDayDrag(event: DragEvent, task: Task, firstDay: string): void {
    const container = (event.currentTarget as HTMLElement).closest<HTMLElement>('.week-all-day');
    this.startDrag(event, task, {kind: 'all-day', day: container ? this.allDayAt(container, event.clientX) || firstDay : firstDay});
  }
  private allDayAt(container: HTMLElement, x: number): string {
    return [...container.querySelectorAll<HTMLElement>('.all-day-cell')].find(cell => { const rect = cell.getBoundingClientRect(); return x >= rect.left && x < rect.right; })?.dataset['date'] ?? '';
  }
  private timePosition(day: string, element: HTMLElement, y: number): CalendarPosition {
    const minute = snapCalendarMinute(this.startMinute() + (y - element.getBoundingClientRect().top) / this.hourHeight() * 60 - (this.drag?.pointerOffset ?? 0));
    return {kind: 'time', day, minute: Math.max(this.startMinute(), Math.min(this.endMinute() - 15, minute))};
  }
  private documentEvent(event: DragEvent): boolean {return this.documentDragging() && !!event.dataTransfer?.types.includes(DOCUMENT_DRAG_TYPE);}
  private mailEvent(event: DragEvent): boolean {return this.mailDragging() && !!event.dataTransfer?.types.includes(GMAIL_MIME);}
  documentEntryOver(event: DragEvent, task: Task): void {
    if (this.ownTaskEvent(event)) {
      event.preventDefault(); event.stopPropagation(); const valid = this.selectTaskLinkTarget(task);
      if (event.dataTransfer) event.dataTransfer.dropEffect = valid ? 'link' : 'none';
      this.taskLinkPointer.set({x: event.clientX, y: event.clientY});
      const timeDay = (event.currentTarget as HTMLElement).closest?.<HTMLElement>('.time-day');
      this.pointer = {x: event.clientX, y: event.clientY, ...(timeDay ? {timeDay} : {})}; return;
    }
    if (!this.documentEvent(event) && !this.mailEvent(event)) return;
    event.preventDefault(); event.stopPropagation();
    const blocked = this.isExternal(task); if (event.dataTransfer) event.dataTransfer.dropEffect = blocked ? 'none' : 'copy';
    this.documentBlocked.set(blocked); this.documentLinkTaskId.set(blocked ? '' : task.id); this.dropPosition.set(null); this.pointer = undefined;
  }
  async documentEntryDrop(event: DragEvent, task: Task): Promise<void> {
    if (this.ownTaskEvent(event)) {
      event.preventDefault(); event.stopPropagation(); const drag = this.drag!, valid = this.validTaskPayload(event) && this.selectTaskLinkTarget(task), target = this.taskLinkTarget();
      this.endDrag();
      if (!valid || !target) return;
      if (this.google.store.relatedTaskIds(drag.task.id).includes(task.id)) {this.moveNotice.set('這兩個任務已經連結。'); return;}
      this.savingMove.set(true);
      try {
        const result = await this.google.store.linkTasks(drag.context, target);
        if (!result.ok) this.moveError.set('任務連結未儲存：' + result.message);
        else this.moveNotice.set(result.persisted ? '任務連結已建立，可復原。' : '任務連結只保留於此分頁，請匯出備份。');
      } catch {this.moveError.set('無法建立任務連結，原任務保留，請重試。');}
      finally {this.savingMove.set(false);}
      return;
    }
    if (!this.documentEvent(event) && !this.mailEvent(event)) return;
    event.preventDefault(); event.stopPropagation();
    if (!this.isExternal(task)) {if (this.documentEvent(event)) this.documentDrop.emit({event, taskId: task.id}); else this.mailDrop.emit({event, taskId: task.id});}
    this.endDrag(); this.ignoreClickUntil = Date.now() + 350;
  }
  dragOver(event: DragEvent, position: CalendarPosition): void {
    this.taskLinkTarget.set(null); this.taskLinkPointer.set(null); this.documentBlocked.set(false);
    if (this.documentEvent(event)) {
      event.preventDefault(); event.stopPropagation(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      this.documentBlocked.set(false); this.documentLinkTaskId.set(''); this.dropPosition.set(position); this.pointer = {x: event.clientX, y: event.clientY};
      return;
    }
    if (this.mailDragging() && event.dataTransfer?.types.includes(GMAIL_MIME)) {
      event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'copy'; this.documentBlocked.set(false); this.documentLinkTaskId.set(''); this.dropPosition.set(position); this.pointer = {x: event.clientX, y: event.clientY};
      return;
    }
    if (!this.ownTaskEvent(event)) return;
    event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    this.dropPosition.set(position); this.pointer = {x: event.clientX, y: event.clientY};
  }
  timeDragOver(event: DragEvent, day: string): void {
    const element = event.currentTarget as HTMLElement;
    this.dragOver(event, this.timePosition(day, element, event.clientY));
    if (this.drag || this.mailDragging() || this.documentDragging()) this.pointer = {x: event.clientX, y: event.clientY, timeDay: element};
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
    if (this.documentEvent(event)) {event.preventDefault(); event.stopPropagation(); this.documentDrop.emit({event, position: target}); this.endDrag(); this.ignoreClickUntil = Date.now() + 350; return;}
    if (this.mailDragging() && event.dataTransfer?.types.includes(GMAIL_MIME)) { this.mailDrop.emit({event, position: target}); this.endDrag(); this.ignoreClickUntil = Date.now() + 350; return; }
    const drag = this.drag;
    if (!drag || this.savingMove()) return;
    if (!this.validTaskPayload(event)) {event.preventDefault(); event.stopPropagation(); this.endDrag(); return;}
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
  @HostListener('window:pagehide')
  @HostListener('window:blur')
  endDrag(): void {
    if (this.drag) this.ignoreClickUntil = Date.now() + 350;
    if (this.drag) this.taskDraggingChange.emit(false);
    this.taskLinkTarget.set(null); this.taskLinkPointer.set(null);
    this.drag = undefined; this.pointer = undefined; this.draggedTaskId.set(''); this.dropPosition.set(null); this.documentLinkTaskId.set(''); this.documentBlocked.set(false);
    clearInterval(this.dragScrollTimer); this.dragScrollTimer = undefined;
  }
  leaveCalendar(event: DragEvent): void {
    const element = event.currentTarget as HTMLElement, rect = element.getBoundingClientRect();
    if (!element.contains(event.relatedTarget as Node | null) && (event.clientX < rect.left || event.clientX >= rect.right || event.clientY < rect.top || event.clientY >= rect.bottom)) { this.dropPosition.set(null); this.documentLinkTaskId.set(''); this.taskLinkTarget.set(null); this.taskLinkPointer.set(null); this.documentBlocked.set(false); this.pointer = undefined; }
  }
  private scrollWhileDragging(): void {
    const scroller = this.weekScroller()?.nativeElement, pointer = this.pointer;
    if ((!this.drag && !this.mailDragging() && !this.documentDragging()) || !scroller || !pointer?.timeDay) return;
    const rect = scroller.getBoundingClientRect();
    const headerHeight = scroller.querySelector<HTMLElement>('.week-sticky-head')?.getBoundingClientRect().height ?? 0;
    const vertical = pointer.y > rect.bottom - 45 ? 16 : pointer.y < rect.top + headerHeight + 35 ? -16 : 0;
    const horizontal = pointer.x > rect.right - 35 ? 16 : pointer.x < rect.left + 35 ? -16 : 0;
    if (vertical || horizontal) {
      scroller.scrollBy({top: vertical, left: horizontal, behavior: 'instant'});
      const hit = scroller.ownerDocument.elementFromPoint(pointer.x, pointer.y), taskId = hit?.closest<HTMLElement>('[data-orbit-task-id]')?.dataset['orbitTaskId'];
      const task = this.drag && taskId ? this.tasks().find(task => task.id === taskId) : undefined;
      if (task) {this.selectTaskLinkTarget(task); this.taskLinkPointer.set({x: pointer.x, y: pointer.y}); return;}
      this.taskLinkTarget.set(null); this.taskLinkPointer.set(null);
      const element = hit?.closest<HTMLElement>('.time-day');
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

  compactMonthScheduleLabel(task: Task, day: string): string {
    if (this.isAllDay(task, day)) return this.monthScheduleLabel(task, day);
    const event = this.days().find(date => date.key === day)?.timedEvents.find(event => event.task.id === task.id);
    return event ? minuteLabel(Math.floor(event.startMinute)) : '';
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
