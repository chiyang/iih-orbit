import type {BoardHistoryEntry} from './board-history.ts';
import type {Workspace} from './models.ts';

export interface DocumentCleanupCandidate {workspaceId: string; workspaceName: string; documentId: string; name: string; reasons: string[]}
/** Only true orphans are removable; event ancestry and every restorable snapshot stay intact. */
export function documentCleanupCandidates(workspaces: readonly Workspace[], history: readonly BoardHistoryEntry[], pending: ReadonlySet<string>): DocumentCleanupCandidate[] {
  const historyIds = new Set(history.flatMap(entry => [entry.before, entry.after].flatMap(board => board.documentSources?.map(source => source.id) ?? [])));
  const references = new Map<string, Set<string>>(), boards = new Map<string, Map<string, {active: boolean; reasons: Set<string>}>>();
  for (const workspace of workspaces) {
    const tasks = new Map(workspace.tasks.map(task => [task.id, task])), conflicts = new Set(workspace.taskConflicts?.map(conflict => conflict.id)), indexed = new Map<string, {active: boolean; reasons: Set<string>}>();
    const record = (id: string) => {if (!indexed.has(id)) indexed.set(id, {active: false, reasons: new Set()}); return indexed.get(id)!;};
    for (const link of workspace.documentLinks ?? []) {
      const item = record(link.documentId), task = tasks.get(link.taskId);
      if (!link.removed && task && !task.deletedAt) item.active = true;
      if (!link.removed && task?.deletedAt) item.reasons.add('垃圾桶中的任務');
      if (conflicts.has(link.taskId)) item.reasons.add('任務衝突候選');
      item.reasons.add('關聯與移除事件');
      if (!references.has(link.documentId)) references.set(link.documentId, new Set()); references.get(link.documentId)!.add(workspace.id);
    }
    for (const detail of workspace.documentDetails ?? []) record(detail.documentId).reasons.add('關聯與移除事件');
    for (const order of workspace.documentOrders ?? []) for (const id of order.documentIds) record(id).reasons.add('關聯與移除事件');
    boards.set(workspace.id, indexed);
  }
  const results: DocumentCleanupCandidate[] = [];
  for (const workspace of workspaces) for (const source of workspace.documentSources ?? []) {
    const record = boards.get(workspace.id)?.get(source.id); if (record?.active) continue;
    const reasons = new Set(record?.reasons);
    if (historyIds.has(source.id)) reasons.add('復原／重做紀錄');
    if (pending.has(source.id)) reasons.add('草稿或待接續的文件建立');
    if ([...references.get(source.id) ?? []].some(id => id !== workspace.id)) reasons.add('其他工作空間的關聯');
    results.push({workspaceId: workspace.id, workspaceName: workspace.name, documentId: source.id, name: source.name, reasons: [...reasons]});
  }
  return results;
}
