import type { BoardState } from './models.ts';
import { indexTaskInformation } from './document-data.ts';
import {taskLinkPairs} from './task-links-data.ts';

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
  const content = (board: BoardState) => {
    const {version, documentSources, documentLinks, documentDetails, documentOrders, completionEvents, taskLinks, ...fields} = board;
    const tasks = new Set(board.tasks.map(task => task.id));
    const documents = [...indexTaskInformation(board)].filter(([task]) => tasks.has(task)).sort(([a], [b]) => a.localeCompare(b));
    const relations = taskLinkPairs(board);
    return {...fields, ...(documents.length ? {documents} : {}), ...(relations.length ? {relations} : {})};
  };
  return JSON.stringify(content(left)) === JSON.stringify(content(right));
}

export function boardChangeLabel(before: BoardState, after: BoardState): string {
  if (JSON.stringify(before.taskConflicts) !== JSON.stringify(after.taskConflicts)) return '選擇任務版本';
  if (JSON.stringify(taskLinkPairs(before)) !== JSON.stringify(taskLinkPairs(after))) return '變更相關任務';
  for (const [key, label] of [['projects', '專案'], ['categories', '分類'], ['statuses', '狀態']] as const) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) return `變更${label}`;
  }
  const originals = new Map(before.tasks.map(task => [task.id, task]));
  if (after.tasks.some(task => !originals.has(task.id))) return '新增任務';
  if (['documentLinks', 'documentDetails', 'documentOrders'].some(key => JSON.stringify(before[key as keyof BoardState]) !== JSON.stringify(after[key as keyof BoardState]))) return '變更資訊連結';
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
