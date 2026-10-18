import {afterRenderEffect, Component, computed, DestroyRef, ElementRef, HostListener, inject, input, linkedSignal, output, signal, untracked, viewChild, viewChildren} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Icon} from './icon';
import {ThemeColor} from './theme-color';
import {UiPreferences} from './ui-preferences';
import {BoardStatus, Category, COLUMNS, Project, Task} from './models';
import {dateKey, isTaskOverdue, validDate} from './task-schedule';
import {GMAIL_MIME} from './gmail-data';
import {DOCUMENT_DRAG_TYPE} from './document-data';
import type {CalendarPosition} from './calendar-move';
import {civilDay, ganttAxis, ganttDayAtPosition, ganttDropPosition, ganttParts, ganttPosition, ganttRows, ganttSchedule, ganttSpan, ganttZoomScroll, moveGanttDate, readGanttRange, readGanttZoom, virtualRange, type GanttCompletion, type GanttDateRange, type GanttOrder, type GanttScale} from './gantt-data';
import {editGanttSchedule, type GanttEditKind} from './gantt-edit';

@Component({selector: 'app-gantt', imports: [FormsModule, Icon, ThemeColor], templateUrl: './gantt.html', styleUrl: './gantt.css'})
export class Gantt {
  readonly Math = Math;
  readonly preferences = inject(UiPreferences);
  readonly tasks = input.required<Task[]>();
  readonly statuses = input<BoardStatus[]>(COLUMNS);
  readonly projects = input<Project[]>([]);
  readonly categories = input<Category[]>([]);
  readonly now = input(new Date());
  readonly selectedDate = input(dateKey(new Date()));
  readonly scale = input<GanttScale>('day');
  readonly zoom = input(100);
  readonly completion = input<GanttCompletion>('all');
  readonly order = input<GanttOrder>('start');
  readonly range = input<GanttDateRange | null>(null);
  readonly statusFilter = input<string[]>([]);
  readonly categoryFilter = input<string[]>([]);
  readonly rangeStart = signal('');
  readonly rangeEnd = signal('');
  readonly rangeError = signal('');
  readonly advancedOpen = signal(false);
  readonly resetKey = input('');
  readonly dateChange = output<string>();
  readonly scaleChange = output<GanttScale>();
  readonly zoomChange = output<number>();
  readonly completionChange = output<GanttCompletion>();
  readonly orderChange = output<GanttOrder>();
  readonly rangeChange = output<GanttDateRange | null>();
  readonly statusFilterChange = output<string[]>();
  readonly categoryFilterChange = output<string[]>();
  readonly editTask = output<Task>();
  readonly scheduleChange = output<{task: Task; original: Task; context: string}>();
  readonly busy = input(false);
  readonly lockedTaskIds = input<string[]>([]);
  readonly scheduleMessage = signal('');
  readonly schedulePreview = signal<Task | null>(null);
  private gesture?: {pointerId: number; element: HTMLElement; original: Task; kind: GanttEditKind; day: number; x: number; y: number; lastX: number; moved: boolean; valid: boolean; context: string; axis: string};
  private scrollFrame = 0;
  private suppressClick = false;
  readonly documentDragging = input(false);
  readonly mailDragging = input(false);
  readonly documentDrop = output<{event: DragEvent; position?: CalendarPosition; taskId?: string; projectId?: string}>();
  readonly mailDrop = output<{event: DragEvent; position?: CalendarPosition; taskId?: string; projectId?: string}>();
  readonly sourceTarget = linkedSignal<{taskId?: string; position?: CalendarPosition; projectId?: string; left?: number} | null>(() => {
    this.documentDragging(); this.mailDragging(); this.resetKey(); this.scale(); this.selectedDate(); this.range(); return null;
  });
  readonly sourceHint = computed(() => {
    const target = this.sourceTarget();
    if (!target) return '';
    if (target.taskId) return '放開以加入資訊連結';
    const position = target.position;
    if (!position) return '';
    const minute = position.minute ?? 0, time = position.kind === 'time' ? ` ${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}（一小時）` : '（全天）';
    return '放開以建立任務：' + position.day + time;
  });
  readonly viewport = viewChild<ElementRef<HTMLElement>>('viewport');
  readonly names = viewChildren<ElementRef<HTMLButtonElement>>('taskName');
  readonly barTitles = viewChildren<ElementRef<HTMLElement>>('barTitle');
  private readonly titleWidths = signal(new Map<string, number>());
  readonly scrollTop = signal(0);
  readonly scrollLeft = signal(0);
  readonly viewportWidth = signal(900);
  readonly viewportHeight = signal(480);
  readonly rowHeight = computed(() => 48 * this.preferences.scale());
  readonly headerHeight = computed(() => 64 * this.preferences.scale());
  readonly labelWidth = computed(() => Math.min(244 * this.preferences.scale(), Math.max(136, this.viewportWidth() * 0.4)));
  readonly columnWidth = computed(() => ({day: 288, week: 196, month: 196}[this.scale()] * this.preferences.scale() * readGanttZoom(this.zoom()) / 100));
  readonly hourLabelStep = computed(() => [1, 2, 3, 6, 12, 24].find(step => this.columnWidth() / 24 * step >= 40 * this.preferences.scale()) ?? 24);
  readonly advancedCount = computed(() => Number(this.completion() !== 'all') + Number(this.zoom() !== 100) + Number(this.order() !== 'start') + Number(!!this.range()) + Number(!!this.selectedStatuses().length) + Number(!!this.selectedCategories().length));
  readonly axis = computed(() => ganttAxis(this.selectedDate(), this.scale(), this.range()));
  readonly axisWidth = computed(() => this.axis().units * this.columnWidth());
  readonly canvasWidth = computed(() => this.labelWidth() + this.axisWidth());
  readonly baseRows = computed(() => ganttRows(this.tasks(), this.projects(), this.statuses(), this.completion(), this.order(), this.range()));
  readonly selectedStatuses = computed(() => [...new Set(this.statusFilter().filter(id => this.statusMap().has(id)))]);
  readonly selectedCategories = computed(() => [...new Set(this.categoryFilter().filter(id => id === '' || this.categoryMap().has(id)))]);
  readonly legendFilterActive = computed(() => !!this.selectedStatuses().length || !!this.selectedCategories().length);
  readonly rows = computed(() => {
    if (!this.legendFilterActive()) return this.baseRows();
    const statuses = new Set(this.selectedStatuses()), categories = new Set(this.selectedCategories());
    const tasks = this.baseRows().flatMap(row => row.kind === 'task' && (!statuses.size || statuses.has(row.task.status)) && (!categories.size || categories.has(row.task.categoryId)) ? [row.task] : []);
    return ganttRows(tasks, this.projects(), this.statuses(), 'all', this.order());
  });
  readonly visibleTaskCount = computed(() => this.rows().filter(row => row.kind === 'task').length);
  readonly rowWindow = computed(() => virtualRange(this.rows().length, this.scrollTop(), this.viewportHeight() - this.headerHeight(), this.rowHeight()));
  readonly visibleRows = computed(() => this.rows().slice(this.rowWindow().start, this.rowWindow().end).map((row, index) => {
    const span = row.kind === 'task' ? ganttSpan(this.preview(row.task), this.axis(), this.columnWidth()) : null;
    const textWidth = this.titleWidths().get(row.id) ?? 0, padding = 8 * this.preferences.scale();
    const titleOutside = !!span && (span.marker || span.width < textWidth + padding * 2);
    const barWidth = span?.marker ? 28 : span?.width ?? 0, barLeft = (span?.left ?? 0) - (span?.marker ? 14 : 0);
    const rightSpace = this.axisWidth() - barLeft - barWidth - padding;
    const titleLeft = !span ? 0 : titleOutside
      ? (rightSpace >= textWidth || rightSpace >= barLeft - padding ? barWidth + padding : -textWidth - padding)
      : Math.min(Math.max(padding, this.scrollLeft() - span.left + padding), Math.max(padding, barWidth - textWidth - padding));
    return {row, index: this.rowWindow().start + index, span, titleOutside, titleLeft, futureStart: span ? Math.max(0, Math.min(span.width, this.pastBoundary() - span.left)) : 0, futureMarker: !!span?.marker && span.left >= this.pastBoundary()};
  }));
  readonly visibleColumns = computed(() => {
    const range = virtualRange(this.axis().count, this.scrollLeft() + this.axis().offset * this.columnWidth(), this.viewportWidth() - this.labelWidth(), this.columnWidth(), 1);
    return Array.from({length: range.end - range.start}, (_, offset) => {
      const index = range.start + offset, column = this.axis().column(index);
      const left = ganttPosition(column.start, this.axis(), this.columnWidth()), end = ganttPosition(column.end, this.axis(), this.columnWidth());
      return {...column, index, left, width: end - left, parts: ganttParts(column, this.scale()).map((part, hour) => ({...part, hour, left: ganttPosition(part.start, this.axis(), this.columnWidth()) - left, width: ganttPosition(part.end, this.axis(), this.columnWidth()) - ganttPosition(part.start, this.axis(), this.columnWidth())}))};
    });
  });
  readonly gridLines = computed(() => this.visibleColumns().flatMap(column => [
    {id: column.start + ':major', left: column.left, major: true},
    ...column.parts.slice(1).map(part => ({id: part.start + ':minor', left: column.left + part.left, major: false}))
  ]));
  readonly pastBoundary = computed(() => ganttPosition(civilDay(dateKey(this.now())), this.axis(), this.columnWidth()));
  readonly todayInRange = computed(() => {const range = this.range(), today = dateKey(this.now()); return !range || today >= range.start && today <= range.end;});
  readonly todayPosition = computed(() => {
    const today = civilDay(dateKey(this.now())), axis = this.axis();
    return today < axis.start || today >= axis.end ? null : ganttPosition(today, axis, this.columnWidth());
  });
  readonly statusMap = computed(() => new Map(this.statuses().map(status => [status.id, status])));
  readonly projectMap = computed(() => new Map(this.projects().map(project => [project.id, project.name])));
  readonly categoryMap = computed(() => new Map(this.categories().map(category => [category.id, category])));
  readonly legends = computed(() => {
    const usedStatuses = new Map<string, number>(), usedCategories = new Map<string, number>();
    for (const row of this.baseRows()) if (row.kind === 'task') {usedStatuses.set(row.task.status, (usedStatuses.get(row.task.status) ?? 0) + 1); usedCategories.set(row.task.categoryId, (usedCategories.get(row.task.categoryId) ?? 0) + 1);}
    return {
      statuses: this.statuses().filter(status => usedStatuses.has(status.id) || this.selectedStatuses().includes(status.id)).map(status => ({id: status.id, label: status.label, color: status.color, count: usedStatuses.get(status.id) ?? 0})),
      categories: [...this.categories().filter(category => usedCategories.has(category.id) || this.selectedCategories().includes(category.id)).map(category => ({id: category.id, label: category.name, color: category.color, count: usedCategories.get(category.id) ?? 0})), ...(usedCategories.has('') || this.selectedCategories().includes('') ? [{id: '', label: '未分類', color: 'gray', count: usedCategories.get('') ?? 0}] : [])]
    };
  });
  readonly activeLegendFilters = computed(() => ({statuses: this.legends().statuses.filter(entry => this.selectedStatuses().includes(entry.id)), categories: this.legends().categories.filter(entry => this.selectedCategories().includes(entry.id))}));
  readonly schedule = ganttSchedule;
  private pendingFocus = signal('');

  constructor() {
    afterRenderEffect(() => {
      const titles = this.barTitles(); this.preferences.scale(); this.tasks();
      const widths = new Map(titles.map(item => [item.nativeElement.dataset['taskId']!, item.nativeElement.scrollWidth]));
      untracked(() => {const previous = this.titleWidths(); if (widths.size !== previous.size || [...widths].some(([id, width]) => previous.get(id) !== width)) this.titleWidths.set(widths);});
    });
    afterRenderEffect(() => {
      const range = this.range();
      untracked(() => {this.rangeStart.set(range?.start ?? ''); this.rangeEnd.set(range?.end ?? ''); this.rangeError.set('');});
    });
    let observed: HTMLElement | undefined, observer: ResizeObserver | undefined;
    afterRenderEffect(() => {
      const element = this.viewport()?.nativeElement;
      if (!element || element === observed) return;
      observer?.disconnect(); observed = element;
      const measure = () => {this.viewportWidth.set(element.clientWidth); this.viewportHeight.set(element.clientHeight);};
      observer = new ResizeObserver(measure); observer.observe(element); measure();
    });
    let context = '', axisKey = '', rowSize = 0, viewportSize = 0, columnSize = 0;
    afterRenderEffect(() => {
      const element = this.viewport()?.nativeElement, nextContext = this.resetKey() + this.completion() + this.order() + JSON.stringify([this.range(), this.selectedStatuses(), this.selectedCategories()]), nextAxis = this.selectedDate() + this.scale(), size = this.rowHeight(), count = this.rows().length, width = this.viewportWidth(), columnWidth = this.columnWidth();
      if (!element) return;
      untracked(() => {
        if (context !== nextContext) element.scrollTop = 0;
        else if (rowSize && rowSize !== size) element.scrollTop = element.scrollTop / rowSize * size;
        element.scrollTop = Math.min(element.scrollTop, Math.max(0, count * size + this.headerHeight() - element.clientHeight));
        if (axisKey !== nextAxis || context !== nextContext || viewportSize !== width || rowSize !== size) this.centerAnchor(element);
        else if (columnSize && columnSize !== columnWidth) element.scrollLeft = ganttZoomScroll(this.axis(), columnSize, columnWidth, element.scrollLeft, element.clientWidth - this.labelWidth());
        context = nextContext; axisKey = nextAxis; rowSize = size; viewportSize = width; columnSize = columnWidth; this.scrolled();
      });
    });
    afterRenderEffect(() => {
      const id = this.pendingFocus(), buttons = this.names();
      if (!id) return;
      const button = buttons.find(item => item.nativeElement.dataset['taskId'] === id)?.nativeElement;
      if (button) {button.focus({preventScroll: true}); this.pendingFocus.set('');}
    });
    afterRenderEffect(() => {
      const context = this.resetKey(), axis = this.editAxis(), tasks = this.tasks(), busy = this.busy() || this.documentDragging() || this.mailDragging(), locked = this.lockedTaskIds();
      untracked(() => {const gesture = this.gesture; if (gesture && (busy || gesture.context !== context || gesture.axis !== axis || locked.includes(gesture.original.id) || JSON.stringify(tasks.find(task => task.id === gesture.original.id)) !== JSON.stringify(gesture.original))) this.cancelSchedule();});
    });
    inject(DestroyRef).onDestroy(() => {observer?.disconnect(); this.cancelSchedule();});
  }
  preview(task: Task): Task {const preview = this.schedulePreview(); return preview?.id === task.id ? preview : task;}
  canAdjust(task: Task): boolean {return !this.busy() && !this.documentDragging() && !this.mailDragging() && !task.deletedAt && !this.lockedTaskIds().includes(task.id);}
  private editAxis(): string {return JSON.stringify([this.selectedDate(), this.scale(), this.zoom(), this.range(), this.preferences.scale(), this.labelWidth(), this.completion(), this.order(), this.selectedStatuses(), this.selectedCategories()]);}
  private pointerDay(x: number): number {
    const viewport = this.viewport()!.nativeElement;
    return ganttDayAtPosition(x - viewport.getBoundingClientRect().left + viewport.scrollLeft - this.labelWidth(), this.axis(), this.columnWidth());
  }
  beginSchedule(event: PointerEvent, task: Task, kind: GanttEditKind): void {
    if (event.button !== 0 || event.isPrimary === false || !this.canAdjust(task) || this.documentDragging() || this.mailDragging() || !this.viewport()) return;
    this.cancelSchedule();
    this.suppressClick = false;
    const element = event.currentTarget as HTMLElement;
    this.gesture = {pointerId: event.pointerId, element, original: structuredClone(task), kind, day: this.pointerDay(event.clientX), x: event.clientX, y: event.clientY, lastX: event.clientX, moved: false, valid: true, context: this.resetKey(), axis: this.editAxis()};
    try {element.setPointerCapture(event.pointerId);} catch { /* Document listeners still support mouse input. */ }
    this.scheduleMessage.set(''); event.stopPropagation();
  }
  @HostListener('document:pointermove', ['$event'])
  moveSchedule(event: PointerEvent): void {
    const gesture = this.gesture;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    gesture.lastX = event.clientX;
    if (!gesture.moved && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 5) return;
    gesture.moved = true; event.preventDefault(); this.updateSchedulePreview(); this.startScroll();
  }
  private updateSchedulePreview(): void {
    const gesture = this.gesture; if (!gesture) return;
    try {
      const next = editGanttSchedule(gesture.original, gesture.kind, Math.round(this.pointerDay(gesture.lastX) - gesture.day));
      gesture.valid = true; this.schedulePreview.set(next); this.scheduleMessage.set(ganttSchedule(next) + ' · 放開儲存，Esc 取消');
    } catch (error) {gesture.valid = false; this.scheduleMessage.set(error instanceof Error ? error.message : '時程不合法，原內容保留。');}
  }
  private startScroll(): void {
    if (this.scrollFrame || typeof requestAnimationFrame === 'undefined') return;
    const frame = () => {
      this.scrollFrame = 0; const gesture = this.gesture, viewport = this.viewport()?.nativeElement;
      if (!gesture || !viewport) return;
      const bounds = viewport.getBoundingClientRect(), direction = gesture.lastX < bounds.left + this.labelWidth() + 28 ? -1 : gesture.lastX > bounds.right - 28 ? 1 : 0;
      if (direction) {viewport.scrollLeft += direction * 10; this.scrolled(); this.updateSchedulePreview();}
      this.scrollFrame = requestAnimationFrame(frame);
    };
    this.scrollFrame = requestAnimationFrame(frame);
  }
  @HostListener('document:pointerup', ['$event'])
  finishSchedule(event: PointerEvent): void {
    const gesture = this.gesture; if (!gesture || event.pointerId !== gesture.pointerId) return;
    const task = this.schedulePreview();
    const message = this.scheduleMessage();
    if (gesture.moved) {event.preventDefault(); this.suppressClick = true;}
    this.cancelSchedule();
    if (gesture.moved && !gesture.valid) this.scheduleMessage.set(message);
    if (gesture.moved && gesture.valid && task && JSON.stringify(task) !== JSON.stringify(gesture.original) && gesture.context === this.resetKey() && gesture.axis === this.editAxis() && this.canAdjust(gesture.original)) this.scheduleChange.emit({task, original: gesture.original, context: gesture.context});
  }
  @HostListener('document:pointercancel', ['$event'])
  pointerCancelled(event: PointerEvent): void {if (event.pointerId === this.gesture?.pointerId) this.cancelSchedule();}
  @HostListener('window:blur')
  cancelSchedule(): void {
    const gesture = this.gesture; this.gesture = undefined;
    if (gesture?.moved) this.suppressClick = true;
    if (this.scrollFrame && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(this.scrollFrame);
    this.scrollFrame = 0; this.schedulePreview.set(null); this.scheduleMessage.set('');
    if (gesture) try {if (gesture.element.hasPointerCapture(gesture.pointerId)) gesture.element.releasePointerCapture(gesture.pointerId);} catch { /* An unmounted bar has already released capture. */ }
  }
  @HostListener('document:keydown.escape', ['$event'])
  cancelScheduleKey(event: Event): void {if (this.gesture) {event.preventDefault(); event.stopPropagation(); this.suppressClick = true; this.cancelSchedule();}}
  scheduleKey(event: KeyboardEvent, task: Task, kind: GanttEditKind): void {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey || !this.canAdjust(task)) return;
    event.preventDefault(); event.stopPropagation();
    try {const changed = editGanttSchedule(task, kind, event.key === 'ArrowLeft' ? -1 : 1); this.scheduleMessage.set(''); this.scheduleChange.emit({task: changed, original: structuredClone(task), context: this.resetKey()});}
    catch (error) {this.scheduleMessage.set(error instanceof Error ? error.message : '時程不合法，原內容保留。');}
  }
  openBar(task: Task): void {if (this.suppressClick) {this.suppressClick = false; return;} this.editTask.emit(task);}
  status(task: Task): BoardStatus {return this.statusMap().get(task.status) ?? COLUMNS[0];}
  private sourceKind(event: DragEvent): 'document' | 'mail' | undefined {
    if (this.documentDragging() && event.dataTransfer?.types.includes(DOCUMENT_DRAG_TYPE)) return 'document';
    if (this.mailDragging() && event.dataTransfer?.types.includes(GMAIL_MIME)) return 'mail';
    return;
  }
  sourceOver(event: DragEvent): boolean {
    const element = event.target instanceof Element ? event.target : null, body = element?.closest<HTMLElement>('.gantt-body');
    if (!this.sourceKind(event) || !body) {this.sourceTarget.set(null); return false;}
    const bounds = body.getBoundingClientRect(), index = Math.floor((event.clientY - bounds.top) / this.rowHeight()), row = this.rows()[index];
    const link = element?.closest<HTMLElement>('[data-link-task-id]')?.dataset['linkTaskId'];
    if (link && (row?.kind !== 'task' || row.id !== link)) {this.sourceTarget.set(null); return false;}
    const projectId = row?.kind === 'task' ? row.task.projectId : row?.id.startsWith('project:') ? row.id.slice(8) : undefined;
    const x = event.clientX - bounds.left - this.labelWidth(), viewport = this.viewport()?.nativeElement;
    const onLabel = !!viewport && event.clientX < viewport.getBoundingClientRect().left + this.labelWidth();
    const position = onLabel ? {kind: 'all-day' as const, day: this.selectedDate()} : ganttDropPosition(x, this.axis(), this.columnWidth());
    if (!link && !position) {this.sourceTarget.set(null); return false;}
    this.sourceTarget.set(link ? {taskId: link} : {position, projectId, left: onLabel ? this.scrollLeft() : x});
    event.preventDefault(); event.stopPropagation(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; return true;
  }
  sourceLeave(event: DragEvent): void {
    if (!(event.relatedTarget instanceof Node) || !(event.currentTarget as HTMLElement).contains(event.relatedTarget)) this.sourceTarget.set(null);
  }
  dropSource(event: DragEvent): void {
    const kind = this.sourceKind(event);
    if (!kind || !this.sourceOver(event)) return;
    const target = this.sourceTarget(); this.sourceTarget.set(null);
    if (target) (kind === 'document' ? this.documentDrop : this.mailDrop).emit({event, position: target.position, taskId: target.taskId, projectId: target.projectId});
  }
  color(task: Task): string {return this.categoryMap().get(task.categoryId)?.color ?? 'gray';}
  colorLabel(task: Task): string {return '分類：' + (this.categoryMap().get(task.categoryId)?.name ?? '未分類');}
  project(task: Task): string {return this.projectMap().get(task.projectId) ?? '未指定專案';}
  overdue(task: Task): boolean {return isTaskOverdue(task, this.now(), this.statuses());}
  scrolled(): void {
    const element = this.viewport()?.nativeElement;
    if (element) {this.scrollTop.set(element.scrollTop); this.scrollLeft.set(element.scrollLeft);}
  }
  selectDate(value: string): void {const range = this.range(); if (value && validDate(value) && (!range || value >= range.start && value <= range.end)) this.dateChange.emit(value);}
  selectScale(value: GanttScale): void {this.scaleChange.emit(value);}
  selectZoom(value: number): void {this.zoomChange.emit(readGanttZoom(value));}
  zoomBy(direction: number): void {this.selectZoom(this.zoom() + direction * 25);}
  toggleStatus(id: string): void {if (this.statusMap().has(id)) {const selected = this.selectedStatuses(); this.statusFilterChange.emit(selected.includes(id) ? selected.filter(value => value !== id) : [...selected, id]);}}
  toggleCategory(id: string): void {if (id === '' || this.categoryMap().has(id)) {const selected = this.selectedCategories(); this.categoryFilterChange.emit(selected.includes(id) ? selected.filter(value => value !== id) : [...selected, id]);}}
  clearLegendFilters(): void {this.statusFilterChange.emit([]); this.categoryFilterChange.emit([]);}
  move(direction: number): void {if (!this.range()) this.dateChange.emit(moveGanttDate(this.selectedDate(), this.scale(), direction));}
  today(): void {if (!this.todayInRange()) return; this.dateChange.emit(dateKey(this.now())); const element = this.viewport()?.nativeElement; if (element) {this.centerAnchor(element); this.scrolled();}}
  applyRange(): void {
    const start = this.rangeStart(), end = this.rangeEnd(), range = readGanttRange({start, end});
    if (!range) {this.rangeError.set(start && end && start > end ? '結束日期不能早於開始日期。' : '請選擇有效的開始與結束日期。'); return;}
    this.rangeError.set(''); this.rangeChange.emit(range);
    this.dateChange.emit(this.selectedDate() >= start && this.selectedDate() <= end ? this.selectedDate() : start);
  }
  clearRange(): void {this.rangeStart.set(''); this.rangeEnd.set(''); this.rangeError.set(''); this.rangeChange.emit(null);}
  private centerAnchor(element: HTMLElement): void {
    const position = ganttPosition(civilDay(this.selectedDate()) + 0.5, this.axis(), this.columnWidth());
    element.scrollLeft = Math.max(0, position - (element.clientWidth - this.labelWidth()) * 0.35);
  }
  locate(task: Task): void {this.pendingFocus.set(task.id); const date = task.startDate || task.dueDate, range = this.range(); this.dateChange.emit(range ? date < range.start ? range.start : date > range.end ? range.end : date : date);}
  jump(index: number): void {const element = this.viewport()?.nativeElement; if (element) {element.scrollTop = index * this.rowHeight(); this.scrolled(); element.focus({preventScroll: true});}}
  rowKey(event: KeyboardEvent, index: number): void {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const rows = this.rows(), direction = event.key === 'ArrowUp' || event.key === 'End' ? -1 : 1;
    let next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : index + direction;
    while (next >= 0 && next < rows.length && rows[next].kind !== 'task') next += direction;
    const row = rows[next];
    if (!row || row.kind !== 'task') return;
    this.pendingFocus.set(row.id); this.jump(next);
  }
}
