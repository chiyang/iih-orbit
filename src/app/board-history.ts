import type { BoardState } from './models.ts';

export const HISTORY_LIMIT = 50;
export interface BoardHistoryEntry {
  workspaceId: string;
  generation: string;
  label: string;
  before: BoardState;
  after: BoardState;
  undone?: boolean;
}

export function sameBoard(left: BoardState, right: BoardState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function boardChangeLabel(before: BoardState, after: BoardState): string {
  if (JSON.stringify(before.taskConflicts) !== JSON.stringify(after.taskConflicts)) return '選擇任務版本';
  for (const [key, label] of [['projects', '專案'], ['categories', '分類'], ['statuses', '狀態']] as const) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) return `變更${label}`;
  }
  const originals = new Map(before.tasks.map(task => [task.id, task]));
  if (after.tasks.some(task => !originals.has(task.id))) return '新增任務';
  if (before.tasks.length > after.tasks.length) return '撤銷任務建立';
  for (const task of after.tasks) {
    const old = originals.get(task.id)!;
    if (!old.deletedAt && task.deletedAt) return '移至垃圾桶';
    if (old.deletedAt && !task.deletedAt) return '還原任務';
    if (old.pinned !== task.pinned) return task.pinned ? '釘選任務' : '取消釘選';
    if (old.status !== task.status) return '移動任務';
    if (JSON.stringify(old) !== JSON.stringify(task)) return '編輯任務';
  }
  return '調整任務順序';
}
