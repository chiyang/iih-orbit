import { versionGraph, type DriveFile } from './drive-data.ts';

export const DRIVE_VERSION_LIMIT = 8;

/** Keep immutable ancestry metadata even when old version files move to Trash. */
export function expiredDriveVersions(files: DriveFile[], protectedVersions: string[] = [], removedDatasets: string[] = []): DriveFile[] {
  const groups = new Map<string, DriveFile[]>(), protectedIds = new Set(protectedVersions), removedIds = new Set(removedDatasets);
  for (const file of files) {
    const group = groups.get(file.cloud.datasetId) ?? []; group.push(file); groups.set(file.cloud.datasetId, group);
  }
  const expired: DriveFile[] = [];
  for (const [id, group] of groups) {
    if (removedIds.has(id) || group.some(file => file.cloud.purpose === 'manual')) continue;
    const graph = versionGraph(group), live = group.filter(file => !file.trashed);
    // Leave unfinished uploads and unresolved choices intact until they are settled.
    if (graph.heads.length !== 1 || live.length <= DRIVE_VERSION_LIMIT || live.some(file => !file.size)) continue;
    const newest = live.sort((a, b) => Date.parse(b.createdTime) - Date.parse(a.createdTime) || b.cloud.versionId.localeCompare(a.cloud.versionId));
    const keep = new Set([graph.heads[0].cloud.versionId, ...newest.filter(file => file.id !== graph.heads[0].id).slice(0, DRIVE_VERSION_LIMIT - 1).map(file => file.cloud.versionId)]);
    expired.push(...newest.filter(file => !keep.has(file.cloud.versionId) && !protectedIds.has(file.cloud.versionId)).reverse());
  }
  return expired;
}
