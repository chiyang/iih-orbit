export type TaskStatus = string;
export type StatusKind = 'active' | 'done' | 'archived';
export type TaskScope = 'all' | 'active' | 'done' | 'archived';
export type Priority = 'high' | 'medium' | 'low';
export type CategoryColor = 'violet' | 'blue' | 'green' | 'orange' | 'pink' | 'gray' | `#${string}`;

export interface Category {
  id: string;
  name: string;
  color: CategoryColor;
}

export interface Subtask {
  id: string;
  title: string;
  done: boolean;
}

export interface Project {
  id: string;
  name: string;
  archived?: boolean;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  categoryId: string;
  projectId: string;
  status: TaskStatus;
  priority: Priority;
  startDate: string;
  startTime: string;
  dueDate: string;
  dueTime: string;
  subtasks: Subtask[];
  pinned?: boolean;
  /** Last content edit; absent for tasks saved before edit tracking was introduced. */
  updatedAt?: string;
  /** Retained in the workspace and backups while the task is in the trash. */
  deletedAt?: string;
  /** Legacy field retained only to read older backups; new copies have no source link. */
  calendarOrigin?: CalendarOrigin;
}

export interface CalendarMetadata {project: string; category: string; status: string; priority: Priority}
export interface CalendarOrigin {
  accountId: string;
  calendarId: string;
  eventId: string;
  metadata: CalendarMetadata;
  extra: string;
}
export interface CalendarTransfer {
  accountId: string;
  calendarId: string;
  eventId: string;
  taskId: string;
  original: string;
  body: string;
  metadata: CalendarMetadata;
  published: boolean;
}

export interface BoardState {
  version: 4;
  projects: Project[];
  categories: Category[];
  statuses: BoardStatus[];
  tasks: Task[];
  calendarTransfers?: CalendarTransfer[];
}

export interface BoardStatus {
  id: string;
  label: string;
  subtitle: string;
  color: CategoryColor;
  kind: StatusKind;
  hidden?: boolean;
}

export interface Workspace extends BoardState {
  id: string;
  name: string;
  headerCompact?: boolean;
}

export interface WorkspaceState {
  version: 1;
  activeWorkspaceId: string;
  workspaces: Workspace[];
}

export const COLUMNS: BoardStatus[] = [
  {id: 'todo', label: '待辦事項', subtitle: '準備好，下一步就出發', color: 'gray', kind: 'active', hidden: false},
  {id: 'progress', label: '進行中', subtitle: '好點子正在成形', color: 'violet', kind: 'active', hidden: false},
  {id: 'review', label: '待審核', subtitle: '最後確認，更靠近完成', color: 'orange', kind: 'active', hidden: false},
  {id: 'done', label: '已完成', subtitle: '每一步，都值得記錄', color: 'green', kind: 'done', hidden: false},
  {id: 'archived', label: '封存', subtitle: '保留紀錄，讓現在更專注', color: 'blue', kind: 'archived', hidden: true}
];

export const PRIORITIES: {id: Priority; label: string}[] = [
  {id: 'high', label: '高優先'},
  {id: 'medium', label: '中優先'},
  {id: 'low', label: '低優先'}
];

export const CATEGORY_COLORS: {id: CategoryColor; label: string}[] = [
  {id: 'violet', label: '紫色'},
  {id: 'blue', label: '藍色'},
  {id: 'green', label: '綠色'},
  {id: 'orange', label: '橘色'},
  {id: 'pink', label: '粉色'},
  {id: 'gray', label: '灰色'}
];
