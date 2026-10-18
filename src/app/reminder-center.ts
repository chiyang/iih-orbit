import { Component, computed, effect, inject, input, linkedSignal, output, signal, untracked } from '@angular/core';
import { Icon } from './icon';
import { DUE_DAY_PRESETS } from './reminder-data';
import { inReminderWorkspace, reminderItemKey, startWindow } from './reminder-items';
import type { ReminderItem, ReminderTab } from './reminder-items';
import { Reminders } from './reminders';
import { ThemeColor } from './theme-color';
import type {ReminderHistoryEntry} from './reminder-history';

type ReminderSource = 'all' | 'orbit' | 'google';
interface ReminderListFilters {source: ReminderSource; excludedCalendars: string[]}

@Component({selector: 'app-reminder-center', imports: [Icon, ThemeColor], templateUrl: './reminder-center.html', styleUrl: './reminder-center.css'})
export class ReminderCenter {
  readonly reminders = inject(Reminders);
  readonly initialTab = input<ReminderTab>('today');
  readonly active = input(true);
  readonly visible = input(true);
  readonly activeTab = linkedSignal(() => this.initialTab());
  readonly dueDays = linkedSignal(() => this.reminders.store.reminders().dueSoonDays);
  readonly presets = DUE_DAY_PRESETS;
  readonly workspaceScope = signal<'all' | 'current'>('all');
  readonly historyMode = signal(false);
  readonly unreadOnly = signal(false);
  readonly historyLimit = linkedSignal(() => {this.workspaceScope(); this.unreadOnly(); this.reminders.store.generation(); return 30;});
  readonly historyEntries = computed(() => this.reminders.history().filter(entry => (this.workspaceScope() === 'all' || entry.workspaceIds.includes(this.reminders.store.currentWorkspace().id)) && (!this.unreadOnly() || entry.readAt === undefined)));
  readonly historyRows = computed(() => this.historyEntries().slice(0, this.historyLimit()).map(entry => ({entry, item: this.reminders.resolveHistory(entry)})));
  readonly unreadHistory = computed(() => this.historyEntries().filter(entry => entry.readAt === undefined));
  private readonly filterContext = computed(() => JSON.stringify([this.reminders.store.generation(), this.reminders.store.currentWorkspace().id, this.workspaceScope()]));
  private readonly newNoticeKeys = linkedSignal(() => {this.filterContext(); return new Set<string>();});
  readonly newItemIds = computed(() => new Set(this.reminders.summaryNotices().filter(notice => this.newNoticeKeys().has(notice.key)).map(notice => reminderItemKey(notice.item))));
  readonly itemKey = reminderItemKey;
  private readonly listFilters = linkedSignal(() => {
    this.filterContext();
    return {} as Partial<Record<ReminderTab, ReminderListFilters>>;
  });
  readonly sourceFilter = computed(() => this.listFilters()[this.activeTab()]?.source ?? 'all');
  readonly sources = [{id: 'all', label: '全部'}, {id: 'orbit', label: 'Orbit 任務'}, {id: 'google', label: 'Google 月曆'}] as const;
  readonly openItem = output<ReminderItem>();
  readonly openSettings = output<void>();
  readonly showDeadline = output<number>();
  readonly tabChange = output<ReminderTab>();
  readonly tabs = computed(() => ([
    {id: 'today', label: '今日開始'}, {id: 'tomorrow', label: '明天開始'}, {id: 'this-week', label: '本週任務'}, {id: 'next-week', label: '下週開始'},
    {id: 'due-soon', label: `${this.dueDays()} 天內到期`}, {id: 'overdue', label: '已逾期'}
  ] as {id: ReminderTab; label: string}[]).map(tab => ({...tab, count: this.entries(tab.id).length})));
  readonly count = computed(() => new Set(this.tabs().flatMap(tab => this.entries(tab.id).map(reminderItemKey))).size);
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

  constructor() {
    effect(() => {
      if (!this.active()) {untracked(() => this.newNoticeKeys.set(new Set())); return;}
      if (!this.visible() || !this.reminders.active() || this.historyMode()) return;
      const notices = this.reminders.summaryNotices().filter(notice => this.workspaceScope() === 'all' || inReminderWorkspace(notice.item, this.reminders.store.currentWorkspace().id)), unseen = new Set(this.reminders.unseenNotices().map(notice => notice.key));
      untracked(() => {
        // Keep this visit's new markers after the header count is acknowledged.
        this.newNoticeKeys.update(keys => new Set(notices.filter(notice => keys.has(notice.key) || unseen.has(notice.key)).map(notice => notice.key)));
        this.reminders.markViewed(notices.map(notice => notice.item));
      });
    });
  }

  private entries(tab: ReminderTab): ReminderItem[] {
    return this.reminders.entries(tab, this.workspaceScope(), this.dueDays());
  }
  selectTab(tab: ReminderTab): void {
    this.historyMode.set(false); this.activeTab.set(tab); this.tabChange.emit(tab);
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
  openHistory(entry: ReminderHistoryEntry): void {
    const current = this.reminders.resolveHistory(entry);
    if (current) {this.reminders.markHistoryRead([entry]); this.openItem.emit(current);}
  }
  showMoreHistory(): void {this.historyLimit.update(limit => limit + 30);}
  historyLabel(entry: ReminderHistoryEntry): string {return ({today: '今日安排', overdue: '已逾期', 'due-soon': '即將到期', upcoming: '近期安排'})[entry.stage];}
  historyTime(entry: ReminderHistoryEntry): string {return new Date(entry.at).toLocaleString('zh-TW', {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false});}
  historySchedule(entry: ReminderHistoryEntry): string {
    const deadline = entry.stage === 'overdue' || entry.stage === 'due-soon', date = deadline ? entry.dueDate : entry.startDate || entry.dueDate, time = deadline ? entry.dueTime : entry.startDate ? entry.startTime : entry.dueTime;
    return date ? `${date.replaceAll('-', '/')} · ${time || '全天'}${deadline ? ' 截止' : ''}` : '未設定日期';
  }
  dateLabel(item: ReminderItem): string {
    if (this.activeTab() === 'this-week') {
      const {startDate, startTime, dueDate, dueTime} = item.task;
      const format = (date: string, time: string) => `${date.replaceAll('-', '/')}${time ? ' · ' + time : ''}`;
      if (startDate && dueDate) {
        if (startDate === dueDate) return `${startDate.replaceAll('-', '/')} · ${startTime || dueTime ? `${startTime || '00:00'} — ${dueTime || '當天結束'}` : '全天'}`;
        return `${format(startDate, startTime)} — ${format(dueDate, dueTime)}`;
      }
      return startDate ? `${format(startDate, startTime)}${startTime ? '' : ' · 全天'} 開始`
        : `${format(dueDate, dueTime)}${dueTime ? '' : ' · 當天結束'} 截止`;
    }
    const deadline = this.activeTab() === 'due-soon' || this.activeTab() === 'overdue';
    const date = deadline ? item.task.dueDate : item.task.startDate;
    const time = deadline ? item.task.dueTime : item.task.startTime;
    return `${date.replaceAll('-', '/')} · ${time || (deadline ? '當天結束' : '全天')}${deadline ? ' 截止' : ' 開始'}`;
  }
  color(item: ReminderItem): string {
    return item.external?.source.color ?? this.reminders.store.workspaces().find(workspace => workspace.id === item.workspaceId)?.categories.find(category => category.id === item.task.categoryId)?.color ?? 'gray';
  }
}
