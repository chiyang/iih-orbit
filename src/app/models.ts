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
  /** Origin of the last content edit; the device preference itself stays local. */
  editSource?: DeviceIdentity;
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
  version: 4 | 5 | 6;
  projects: Project[];
  categories: Category[];
  statuses: BoardStatus[];
  tasks: Task[];
  calendarTransfers?: CalendarTransfer[];
  taskConflicts?: TaskConflict[];
  documentSources?: DocumentSource[];
  documentLinks?: DocumentLink[];
  documentDetails?: DocumentDetail[];
  documentOrders?: DocumentOrder[];
}

export type DocumentProvider = 'google-drive' | 'gmail' | 'pcloud' | 'microsoft-365';
/** Stable source identity and last known display information; never file contents or credentials. */
export interface DocumentSource {
  id: string;
  provider: DocumentProvider;
  sourceScope: string;
  fileId?: string;
  locator?: string;
  url: string;
  name: string;
  location?: string;
  mimeType?: string;
}
/** Each addition has its own identity. Removals are permanent for that addition. */
export interface DocumentLink {id: string; taskId: string; documentId: string; removed?: true}
/** A task/source description belongs to the observed lifetime of that relation. */
export interface DocumentDetail {id: string; taskId: string; documentId: string; linkIds: string[]; description: string}
export interface DocumentOrder {id: string; documentIds: string[]}
export interface DocumentDescription {documentId: string; description: string}

export interface DeviceIdentity {id: string; name: string}
export interface TaskConflictSource extends Partial<DeviceIdentity> {updatedAt?: string}
export interface TaskConflictVersion {key: string; task: Task | null; source?: TaskConflictSource}
/** Resolved records remain as ancestry markers so stale devices cannot reopen an old choice. */
export interface TaskConflict {id: string; versions: TaskConflictVersion[]; resolved?: string}

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
