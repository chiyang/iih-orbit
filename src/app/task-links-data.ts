import type {BoardState, TaskLink} from './models.ts';
import {withCompletionEvents} from './task-completion-data.ts';

export const taskLinkPair = (first: string, second: string): [string, string] => [first, second].sort() as [string, string];
const pairKey = (ids: readonly string[]) => JSON.stringify(ids);
export function readTaskLinks(value: unknown, taskIds: Set<string>): TaskLink[] | null {
  if (!Array.isArray(value) || value.length > 200000) return null;
  const links: TaskLink[] = [];
  for (const link of value) {
    if (!link || typeof link.id !== 'string' || !link.id || link.id.length > 500 || !Array.isArray(link.taskIds) || link.taskIds.length !== 2
      || !link.taskIds.every((id: unknown) => typeof id === 'string' && !!id && id.length <= 1000) || link.taskIds[0] >= link.taskIds[1]
      || link.removed !== undefined && link.removed !== true || !link.removed && link.taskIds.some((id: string) => !taskIds.has(id))) return null;
    links.push({id: link.id, taskIds: [...link.taskIds] as [string, string], ...(link.removed ? {removed: true} : {})});
  }
  return new Set(links.map(link => link.id)).size === links.length ? links : null;
}
export function mergeTaskLinks(groups: readonly (readonly TaskLink[])[]): TaskLink[] {
  const links = new Map<string, TaskLink>();
  for (const group of groups) for (const link of group) {
    const previous = links.get(link.id);
    if (previous && pairKey(previous.taskIds) !== pairKey(link.taskIds)) throw new Error('相關任務的連結識別重複且內容不同，原資料保留。');
    links.set(link.id, {id: link.id, taskIds: [...link.taskIds], ...(previous?.removed || link.removed ? {removed: true} : {})});
  }
  return [...links.values()].sort((a, b) => a.id.localeCompare(b.id));
}
export function withTaskLinks<T extends BoardState>(board: T, links: TaskLink[]): T {return {...withCompletionEvents(board, board.completionEvents ?? []), version: 8, taskLinks: links};}
export function relatedTaskIds(board: BoardState, taskId: string): string[] {
  return [...new Set(board.taskLinks?.flatMap(link => !link.removed && link.taskIds.includes(taskId) ? link.taskIds.filter(id => id !== taskId) : []) ?? [])].sort();
}
export function relatedTasksKey(board: BoardState, taskId: string): string {return JSON.stringify((board.taskLinks ?? []).filter(link => link.taskIds.includes(taskId)).sort((a, b) => a.id.localeCompare(b.id)));}
export function taskLinkPairs(board: BoardState): string[] {return [...new Set(board.taskLinks?.filter(link => !link.removed).map(link => pairKey(link.taskIds)) ?? [])].sort();}
export function indexRelatedTasks(board: BoardState): Map<string, string[]> {
  const pairs = new Map<string, Set<string>>();
  for (const link of board.taskLinks ?? []) if (!link.removed) for (const id of link.taskIds) {if (!pairs.has(id)) pairs.set(id, new Set()); pairs.get(id)!.add(link.taskIds.find(other => other !== id)!);}
  return new Map([...pairs].map(([id, related]) => [id, [...related].sort()]));
}
export function setRelatedTasks<T extends BoardState>(board: T, taskId: string, selected: readonly string[], newId: () => string = () => crypto.randomUUID()): T {
  if (selected.length > 1000 || selected.includes(taskId) || new Set(selected).size !== selected.length) throw new Error('請選擇不同的相關任務，不能連結任務本身。');
  const task = board.tasks.find(task => task.id === taskId), previous = new Set(relatedTaskIds(board, taskId));
  if (!task || task.deletedAt) throw new Error('原任務已移除，無法建立連結。');
  for (const id of selected) if (!board.tasks.some(task => task.id === id && (!task.deletedAt || previous.has(id)))) throw new Error('相關任務已更新或移除，請重新選擇。');
  if (selected.length === previous.size && selected.every(id => previous.has(id))) return board;
  const wanted = new Set(selected), links = (board.taskLinks ?? []).map(link => !link.removed && link.taskIds.includes(taskId) && !wanted.has(link.taskIds.find(id => id !== taskId)!) ? {...link, removed: true as const} : link);
  for (const id of selected) if (!previous.has(id)) links.push({id: newId(), taskIds: taskLinkPair(taskId, id)});
  return withTaskLinks(board, links);
}
/** Purging either endpoint retires the relation; trash keeps it available for restoration. */
export function reconcileTaskLinks<T extends BoardState>(board: T): T {
  if (!board.taskLinks) return board;
  const ids = new Set([...board.tasks.map(task => task.id), ...board.taskConflicts?.map(conflict => conflict.id) ?? []]);
  return {...board, taskLinks: board.taskLinks.map(link => !link.removed && link.taskIds.some(id => !ids.has(id)) ? {...link, removed: true as const} : link)};
}
export function restoreTaskLinks<T extends BoardState>(current: BoardState, target: T): T {
  if (!current.taskLinks && !target.taskLinks) return target;
  const wanted = new Set(taskLinkPairs(target)), links = mergeTaskLinks([current.taskLinks ?? [], target.taskLinks ?? []]).map(link => wanted.has(pairKey(link.taskIds)) ? link : {...link, removed: true as const});
  const active = new Set(links.filter(link => !link.removed).map(link => pairKey(link.taskIds)));
  for (const key of wanted) if (!active.has(key)) links.push({id: crypto.randomUUID(), taskIds: JSON.parse(key)});
  return reconcileTaskLinks(withTaskLinks(target, links));
}
