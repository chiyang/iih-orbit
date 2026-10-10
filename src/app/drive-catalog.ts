import { versionGraph, type DriveFile } from './drive-data.ts';

export interface DriveCollection {
  id: string;
  label: string;
  purposeLabel: string;
  startedAt: string;
  updatedAt: string;
  current: boolean;
  heads: DriveFile[];
  history: DriveFile[];
  versions: Map<string, number>;
  warning: string;
  deleting: boolean;
}
const byDate = (a: DriveFile, b: DriveFile): number => Date.parse(a.createdTime) - Date.parse(b.createdTime) || a.cloud.versionId.localeCompare(b.cloud.versionId);
export function fileScope(file: DriveFile): string {
  return file.summary?.label || (file.kind === 'full' ? '全部資料' : '選定工作空間');
}
/** Display ordinals follow ancestry; dates only order unrelated branches. */
function numberVersions(files: DriveFile[]): Map<string, number> {
  const unique = new Map(files.map(f => [f.cloud.versionId, f]));
  const counts = new Map<string, number>(), children = new Map<string, DriveFile[]>();
  for (const file of unique.values()) {
    const parents = file.cloud.parents.filter(id => unique.has(id)); counts.set(file.cloud.versionId, parents.length);
    for (const parent of parents) {const items = children.get(parent) ?? []; items.push(file); children.set(parent, items);}
  }
  const queue = [...unique.values()].filter(f => !counts.get(f.cloud.versionId)).sort(byDate), versions = new Map<string, number>();
  for (let i = 0; i < queue.length; i++) {
    const file = queue[i]; versions.set(file.cloud.versionId, versions.size + 1);
    for (const child of (children.get(file.cloud.versionId) ?? []).sort(byDate)) {
      const id = child.cloud.versionId, count = counts.get(id)! - 1; counts.set(id, count);
      if (!count) queue.push(child);
    }
  }
  return versions;
}
export function driveCatalog(files: DriveFile[], currentId?: string, removedIds: string[] = []): {collections: DriveCollection[]; manual: DriveFile[]} {
  const grouped = new Map<string, DriveFile[]>(), manual: DriveFile[] = [];
  for (const file of files) {
    if (file.cloud.purpose === 'manual') {if (!file.trashed) manual.push(file); continue;}
    const group = grouped.get(file.cloud.datasetId) ?? []; group.push(file); grouped.set(file.cloud.datasetId, group);
  }
  const collections: DriveCollection[] = [];
  for (const [id, group] of grouped) {
    const ordered = group.filter(file => !file.trashed).sort(byDate); if (!ordered.length) continue;
    let heads: DriveFile[] = [], warning = '';
    try {heads = versionGraph(group).heads.sort(byDate).reverse();}
    catch (error) {warning = error instanceof Error ? error.message : '版本關係無法辨識，請重新載入。';}
    const versions = warning ? new Map(ordered.map((f, i) => [f.cloud.versionId, i + 1])) : numberVersions(group);
    const headIds = new Set(heads.map(f => f.cloud.versionId));
    const latest = heads[0] ?? ordered.at(-1)!;
    const first = ordered.find(f => !f.cloud.parents.some(parent => versions.has(parent))) ?? ordered[0];
    collections.push({id, label: fileScope(latest), purposeLabel: latest.cloud.purpose === 'backup' ? '自動備份' : '自動同步', startedAt: first.createdTime, updatedAt: latest.createdTime, current: id === currentId,
      heads, history: group.filter(f => !f.trashed && !headIds.has(f.cloud.versionId)).sort((a, b) => versions.get(b.cloud.versionId)! - versions.get(a.cloud.versionId)!), versions, warning, deleting: removedIds.includes(id)});
  }
  collections.sort((a, b) => Number(b.current) - Number(a.current) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id));
  return {collections, manual: manual.sort(byDate).reverse()};
}
