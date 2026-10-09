import { Component, computed, inject, input, linkedSignal, output } from '@angular/core';
import { Icon } from './icon';
import { DUE_DAY_PRESETS } from './reminder-data';
import { itemsForReminderTab, startWindow } from './reminder-items';
import type { ReminderItem, ReminderTab } from './reminder-items';
import { Reminders } from './reminders';
import { ThemeColor } from './theme-color';

type ReminderSource = 'all' | 'orbit' | 'google';
interface ReminderListFilters {source: ReminderSource; excludedCalendars: string[]}

@Component({selector: 'app-reminder-center', imports: [Icon, ThemeColor], templateUrl: './reminder-center.html', styleUrl: './reminder-center.css'})
export class ReminderCenter {
  readonly reminders = inject(Reminders);
  readonly initialTab = input<ReminderTab>('today');
  readonly activeTab = linkedSignal(() => this.initialTab());
  readonly dueDays = linkedSignal(() => this.reminders.store.reminders().dueSoonDays);
  readonly presets = DUE_DAY_PRESETS;
  private readonly filterContext = computed(() => JSON.stringify([this.reminders.store.generation(), this.reminders.store.currentWorkspace().id]));
  private readonly listFilters = linkedSignal(() => {
    this.filterContext();
    return {} as Partial<Record<ReminderTab, ReminderListFilters>>;
  });
  readonly sourceFilter = computed(() => this.listFilters()[this.activeTab()]?.source ?? 'all');
  readonly sources = [{id: 'all', label: '全部'}, {id: 'orbit', label: 'Orbit 任務'}, {id: 'google', label: 'Google 月曆'}] as const;
  readonly openItem = output<ReminderItem>();
  readonly openSettings = output<void>();
  readonly showDeadline = output<number>();
  readonly tabs = computed(() => ([
    {id: 'today', label: '今日開始'}, {id: 'tomorrow', label: '明天開始'}, {id: 'next-week', label: '下週開始'},
    {id: 'due-soon', label: `${this.dueDays()} 天內到期`}, {id: 'overdue', label: '已逾期'}
  ] as {id: ReminderTab; label: string}[]).map(tab => ({...tab, count: this.entries(tab.id).length})));
  readonly count = computed(() => new Set(this.tabs().flatMap(tab => this.entries(tab.id).map(item => item.id))).size);
  readonly listItems = computed(() => this.entries(this.activeTab()));
  readonly hasMixedSources = computed(() => this.listItems().some(item => item.external) && this.listItems().some(item => !item.external));
  readonly effectiveSource = computed(() => this.hasMixedSources() ? this.sourceFilter() : 'all');
  readonly calendars = computed(() => {
    const calendars = new Map<string, {id: string; name: string; color: string; count: number}>();
    for (const item of this.listItems()) {
      if (!item.external) continue;
      const source = item.external.source;
      const calendar = calendars.get(source.id);
      if (calendar) calendar.count++;
      else calendars.set(source.id, {id: source.id, name: source.name, color: source.color, count: 1});
    }
    return [...calendars.values()].sort((left, right) => left.name.localeCompare(right.name, 'zh-Hant-TW', {numeric: true}) || left.id.localeCompare(right.id));
  });
  readonly selectedCalendarIds = computed(() => {
    const excluded = this.listFilters()[this.activeTab()]?.excludedCalendars ?? [];
    // A hidden filter must not keep the sole remaining calendar hidden.
    return this.calendars().filter(calendar => this.calendars().length <= 1 || !excluded.includes(calendar.id)).map(calendar => calendar.id);
  });
  readonly showCalendarFilter = computed(() => this.calendars().length > 1 && this.effectiveSource() !== 'orbit');
  readonly visibleItems = computed(() => this.listItems().filter(item => {
    if (!item.external) return this.effectiveSource() !== 'google';
    return this.effectiveSource() !== 'orbit' && this.selectedCalendarIds().includes(item.external.source.id);
  }));
  readonly rangeLabel = computed(() => {
    const tab = this.activeTab();
    return tab === 'due-soon' ? `從現在起 ${this.dueDays()} 天內到期，依截止時間排序。`
      : tab === 'overdue' ? '待完成且已超過截止時間，依截止時間排序。'
      : startWindow(this.reminders.now(), tab).label;
  });

  private entries(tab: ReminderTab): ReminderItem[] {
    return itemsForReminderTab(this.reminders.items(), tab, this.reminders.now(), this.dueDays(), this.reminders.store.currentWorkspace());
  }
  selectSource(source: ReminderSource): void {
    if (!this.sources.some(option => option.id === source)) return;
    this.updateFilters({source});
  }
  toggleCalendar(id: string, selected: boolean): void {
    if (!this.calendars().some(calendar => calendar.id === id)) return;
    const excluded = this.listFilters()[this.activeTab()]?.excludedCalendars ?? [];
    this.updateFilters({excludedCalendars: selected ? excluded.filter(calendar => calendar !== id) : [...new Set([...excluded, id])]});
  }
  selectCalendars(all: boolean): void {
    this.updateFilters({excludedCalendars: all ? [] : this.calendars().map(calendar => calendar.id)});
  }
  clearFilters(): void { this.updateFilters({source: 'all', excludedCalendars: []}); }
  private updateFilters(patch: Partial<ReminderListFilters>): void {
    const tab = this.activeTab();
    this.listFilters.update(filters => ({...filters, [tab]: {...(filters[tab] ?? {source: 'all', excludedCalendars: []}), ...patch}}));
  }
  calendarFilterKeydown(event: KeyboardEvent): void {
    const menu = (event.currentTarget as HTMLElement).closest('details');
    if (event.key !== 'Escape' || !menu?.open) return;
    event.preventDefault(); event.stopPropagation(); menu.open = false; menu.querySelector('summary')?.focus();
  }
  open(item: ReminderItem): void {
    const current = this.reminders.resolve(item);
    if (current) this.openItem.emit(current);
  }
  dateLabel(item: ReminderItem): string {
    const deadline = this.activeTab() === 'due-soon' || this.activeTab() === 'overdue';
    const date = deadline ? item.task.dueDate : item.task.startDate;
    const time = deadline ? item.task.dueTime : item.task.startTime;
    return `${date.replaceAll('-', '/')} · ${time || (deadline ? '當天結束' : '全天')}${deadline ? ' 截止' : ' 開始'}`;
  }
  color(item: ReminderItem): string {
    return item.external?.source.color ?? this.reminders.store.categories().find(category => category.id === item.task.categoryId)?.color ?? 'gray';
  }
}
