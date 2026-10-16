import { dateKey, validDate } from './task-schedule.ts';
import type { SortDirection, SortKey } from './task-schedule.ts';
import type { TaskScope } from './models.ts';
import type { DeadlineFilter } from './reminder-data.ts';
import type { ReminderTab } from './reminder-items.ts';
import {readOverviewSelection, type OverviewSelection} from './workspace-overview-data.ts';
import {readGanttRange, readGanttZoom, type GanttCompletion, type GanttDateRange, type GanttOrder, type GanttScale} from './gantt-data.ts';

export interface BrowseState {
  overviewOpen: boolean;
  overviewProject: string;
  overviewArchived: boolean;
  overviewSelection: OverviewSelection | null;
  view: 'board' | 'list' | 'month' | 'week' | 'gantt';
  scope: TaskScope;
  query: string;
  project: string;
  category: string;
  priority: string;
  pinnedOnly: boolean;
  recentOnly: boolean;
  deadline: DeadlineFilter;
  deadlineDays: number | null;
  sort: SortKey | null;
  direction: SortDirection;
  calendarDate: string;
  ganttDate: string;
  ganttScale: GanttScale;
  ganttZoom: number;
  ganttCompletion: GanttCompletion;
  ganttOrder: GanttOrder;
  ganttRange: GanttDateRange | null;
  ganttStatuses: string[];
  ganttCategories: string[];
  calendarScrollHour: number;
  showOrbit: boolean;
  showGoogle: boolean;
  progressExpanded: boolean;
  /** Legacy local value; the synchronized workspace value takes precedence. */
  headerCompact: boolean;
  trashOpen: boolean;
  panel: 'closed' | 'gmail' | 'reminders' | 'tasks' | 'files';
  panelTab: 'gmail' | 'reminders' | 'tasks' | 'files';
  reminderTab: ReminderTab;
}
const KEY = 'iih-orbit-browse-state-v1';
const choice = <T extends string | null>(value: unknown, values: readonly T[], fallback: T): T => values.includes(value as T) ? value as T : fallback;
const text = (value: unknown, fallback: string, limit = 300): string => typeof value === 'string' && value.length <= limit ? value : fallback;
const filterIds = (value: unknown): string[] => Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === 'string' && id.length <= 300))].slice(0, 200) : [];

export function readBrowseState(value: unknown): BrowseState {
  const s = value && typeof value === 'object' ? value as Partial<BrowseState> : {};
  const ganttRange = readGanttRange(s.ganttRange);
  const ganttDate = typeof s.ganttDate === 'string' && s.ganttDate && validDate(s.ganttDate) ? s.ganttDate : dateKey(new Date());
  return {
    overviewOpen: s.overviewOpen === true, overviewProject: text(s.overviewProject, 'all', 500), overviewArchived: s.overviewArchived === true, overviewSelection: readOverviewSelection(s.overviewSelection),
    view: choice(s.view, ['board', 'list', 'month', 'week', 'gantt'], 'board'),
    scope: choice(s.scope, ['all', 'active', 'done', 'archived'], 'all'),
    query: text(s.query, '', 1000), project: text(s.project, 'all'), category: text(s.category, 'all'),
    priority: choice(s.priority, ['all', 'high', 'medium', 'low'], 'all'),
    pinnedOnly: s.pinnedOnly === true, recentOnly: s.recentOnly === true,
    deadline: choice(s.deadline, ['all', 'unset', 'overdue', 'due-soon', 'this-week'], 'all'),
    deadlineDays: Number.isInteger(s.deadlineDays) && s.deadlineDays! >= 1 && s.deadlineDays! <= 30 ? s.deadlineDays! : null,
    sort: choice(s.sort, ['title', 'project', 'category', 'status', 'priority', 'startDate', 'dueDate', null], null),
    direction: choice(s.direction, ['asc', 'desc'], 'asc'),
    calendarDate: typeof s.calendarDate === 'string' && s.calendarDate && validDate(s.calendarDate) ? s.calendarDate : dateKey(new Date()),
    ganttDate: ganttRange && (ganttDate < ganttRange.start || ganttDate > ganttRange.end) ? ganttRange.start : ganttDate,
    ganttScale: choice(s.ganttScale, ['day', 'week', 'month'], 'day'),
    ganttZoom: readGanttZoom(s.ganttZoom),
    ganttCompletion: choice(s.ganttCompletion, ['all', 'done', 'pending'], 'all'),
    ganttOrder: choice(s.ganttOrder, ['start', 'end'], 'start'),
    ganttRange,
    ganttStatuses: filterIds(s.ganttStatuses), ganttCategories: filterIds(s.ganttCategories),
    calendarScrollHour: typeof s.calendarScrollHour === 'number' && Number.isFinite(s.calendarScrollHour) && s.calendarScrollHour >= 0 && s.calendarScrollHour <= 24 ? s.calendarScrollHour : 7.75,
    showOrbit: s.showOrbit !== false, showGoogle: s.showGoogle !== false, progressExpanded: s.progressExpanded === true,
    headerCompact: s.headerCompact === true, trashOpen: s.trashOpen === true,
    panel: choice(s.panel, ['closed', 'gmail', 'reminders', 'tasks', 'files'], 'closed'),
    panelTab: choice(s.panelTab, ['gmail', 'reminders', 'tasks', 'files'], choice(s.panel, ['gmail', 'reminders', 'tasks', 'files'], 'tasks')),
    reminderTab: choice(s.reminderTab, ['today', 'tomorrow', 'this-week', 'next-week', 'due-soon', 'overdue'], 'today')
  };
}

/** Browsing choices stay in this browser, outside work data and backups. */
export function loadBrowseState(generation: string, workspace: string, fallback?: BrowseState): BrowseState {
  try {
    const record = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    return readBrowseState(record?.generation === generation && record?.version === 1 ? record.workspaces?.[workspace] ?? fallback : fallback);
  } catch { return readBrowseState(fallback); }
}
export function saveBrowseState(generation: string, workspace: string, state: BrowseState): void {
  try {
    const record = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    const entries = record?.generation === generation && record?.version === 1 && record.workspaces && typeof record.workspaces === 'object' ? record.workspaces : {};
    const workspaces = Object.fromEntries([...Object.entries(entries).filter(([id]) => id !== workspace).slice(-49), [workspace, readBrowseState(state)]]);
    localStorage.setItem(KEY, JSON.stringify({version: 1, generation, workspaces}));
  } catch { /* The current view remains usable when browser storage is unavailable. */ }
}
