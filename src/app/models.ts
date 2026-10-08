export type TaskStatus = 'todo' | 'progress' | 'review' | 'done';
export type Priority = 'high' | 'medium' | 'low';
export type CategoryColor = 'violet' | 'blue' | 'green' | 'orange' | 'pink' | 'gray';

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

export interface Task {
  id: string;
  title: string;
  description: string;
  categoryId: string;
  status: TaskStatus;
  priority: Priority;
  assignee: string;
  dueDate: string;
  subtasks: Subtask[];
}

export interface BoardState {
  version: 1;
  projectName: string;
  categories: Category[];
  tasks: Task[];
}

export const COLUMNS: {id: TaskStatus; label: string; subtitle: string}[] = [
  {id: 'todo', label: '待辦事項', subtitle: '準備好，下一步就出發'},
  {id: 'progress', label: '進行中', subtitle: '好點子正在成形'},
  {id: 'review', label: '待審核', subtitle: '最後確認，更靠近完成'},
  {id: 'done', label: '已完成', subtitle: '每一步，都值得記錄'}
];

export const MEMBERS = [
  {id: 'me', name: '我', initials: 'YC', color: 'sage'},
  {id: 'mia', name: 'Mia Chen', initials: 'MC', color: 'peach'},
  {id: 'alex', name: 'Alex Lin', initials: 'AL', color: 'lavender'},
  {id: 'jamie', name: 'Jamie Wu', initials: 'JW', color: 'blue'}
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
