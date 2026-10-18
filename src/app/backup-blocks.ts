import { canonical, checksum, readDriveDocument, readVersion, validDriveId, type DriveDocument, type DriveVersion } from './drive-data.ts';
import type { Task, Workspace } from './models';

export const TASK_BUCKETS = 64;
export interface BackupBlock {application: 'iih-orbit-block'; formatVersion: 1; kind: 'workspace' | 'tasks'; data: unknown}
export interface BlockReference {id: string; hash: string}
export interface BackupManifest {
  application: 'iih-orbit-chunked'; formatVersion: 1;
  header: Omit<DriveDocument, 'data'>;
  state: {version: 1; activeWorkspaceId: string; workspaces: {id: string; metadata: BlockReference; tasks: BlockReference[]; order: string[]}[]};
}
export interface PackedBackup {manifest: BackupManifest; blocks: Map<string, BackupBlock>}
/** Wait for every started request, even on failure; never leave uploads running after returning. */
export async function mapBlocks<T, U>(items: T[], run: (item: T) => Promise<U>): Promise<U[]> {
  const result: U[] = new Array(items.length); let index = 0, failure: unknown;
  await Promise.all(Array.from({length: Math.min(4, items.length)}, async () => {
    while (index < items.length && failure === undefined) {
      const current = index++;
      try {result[current] = await run(items[current]);} catch (error) {failure = error;}
    }
  }));
  if (failure !== undefined) throw failure;
  return result;
}
const validHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function taskBucket(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  return (hash >>> 0) % TASK_BUCKETS;
}

/** Stable ID buckets keep task reordering and edits out of unchanged blocks. */
export async function packBackup(document: DriveDocument, hashBlock: (block: BackupBlock) => Promise<string> = checksum): Promise<PackedBackup> {
  const {data, ...header} = document, blocks = new Map<string, BackupBlock>();
  const add = async (kind: BackupBlock['kind'], data: unknown): Promise<BlockReference> => {
    const block: BackupBlock = {application: 'iih-orbit-block', formatVersion: 1, kind, data};
    const hash = await hashBlock(block); blocks.set(hash, block); return {id: '', hash};
  };
  const workspaces: BackupManifest['state']['workspaces'] = [];
  for (const workspace of data.workspaces) {
    const {tasks, ...metadata} = workspace, buckets = new Map<number, Task[]>();
    for (const task of tasks) {const bucket = taskBucket(task.id); if (!buckets.has(bucket)) buckets.set(bucket, []); buckets.get(bucket)!.push(task);}
    const references: BlockReference[] = [];
    for (const [, tasks] of [...buckets].sort(([a], [b]) => a - b)) references.push(await add('tasks', [...tasks].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
    workspaces.push({id: workspace.id, metadata: await add('workspace', metadata), tasks: references, order: tasks.map(task => task.id)});
  }
  return {manifest: {application: 'iih-orbit-chunked', formatVersion: 1, header, state: {version: 1, activeWorkspaceId: data.activeWorkspaceId, workspaces}}, blocks};
}

export function readManifest(value: unknown, expected: DriveVersion): BackupManifest {
  const m = value as BackupManifest;
  if (!m || m.application !== 'iih-orbit-chunked' || m.formatVersion !== 1 || !m.header || ![5, 6, 7, 8].includes(expected.formatVersion)
    || canonical(readVersion(m.header.cloud)) !== canonical(expected) || m.header.application !== 'iih-orbit' || !m.state || m.state.version !== 1
    || typeof m.state.activeWorkspaceId !== 'string' || !Array.isArray(m.state.workspaces) || !m.state.workspaces.length || m.state.workspaces.length > 10000) throw new Error('雲端備份索引不完整，原有資料保留。');
  const reference = (r: BlockReference): boolean => !!r && validDriveId(r.id) && validHash(r.hash);
  for (const workspace of m.state.workspaces) {
    if (!workspace || typeof workspace.id !== 'string' || !workspace.id || !reference(workspace.metadata) || !Array.isArray(workspace.tasks)
      || workspace.tasks.length > TASK_BUCKETS || !workspace.tasks.every(reference) || !Array.isArray(workspace.order) || workspace.order.length > 100000
      || workspace.order.some(id => typeof id !== 'string' || !id) || new Set(workspace.order).size !== workspace.order.length
      || new Set(workspace.tasks.map(r => r.hash)).size !== workspace.tasks.length) throw new Error('雲端備份區塊參照不完整，原有資料保留。');
  }
  if (new Set(m.state.workspaces.map(w => w.id)).size !== m.state.workspaces.length || !m.state.workspaces.some(w => w.id === m.state.activeWorkspaceId)) throw new Error('雲端備份工作空間索引不合法。');
  return m;
}
export async function verifiedBlock(value: unknown, hash: string, kind?: BackupBlock['kind']): Promise<BackupBlock> {
  const block = value as BackupBlock;
  if (new TextEncoder().encode(JSON.stringify(value)).length > 20 * 1024 * 1024) throw new Error('雲端資料區塊超過 20 MB，原有資料保留。');
  if (!block || block.application !== 'iih-orbit-block' || block.formatVersion !== 1 || !['workspace', 'tasks'].includes(block.kind)
    || kind && block.kind !== kind || await checksum(block) !== hash) throw new Error('雲端資料區塊校驗不符，原有資料保留。');
  return block;
}

export async function unpackBackup(manifest: BackupManifest, read: (reference: BlockReference) => Promise<BackupBlock>): Promise<DriveDocument> {
  const workspaces: Workspace[] = [];
  for (const entry of manifest.state.workspaces) {
    const metadata = await read(entry.metadata);
    if (metadata.kind !== 'workspace' || !metadata.data || typeof metadata.data !== 'object' || (metadata.data as Workspace).id !== entry.id || Object.hasOwn(metadata.data, 'tasks')) throw new Error('雲端工作空間區塊與索引不符。');
    const parts = await mapBlocks(entry.tasks, read), tasks = new Map<string, Task>();
    for (const block of parts) {
      if (block.kind !== 'tasks' || !Array.isArray(block.data)) throw new Error('雲端任務區塊格式不符。');
      for (const task of block.data as Task[]) {if (!task || typeof task.id !== 'string' || tasks.has(task.id)) throw new Error('雲端任務識別重複或不完整。'); tasks.set(task.id, task);}
    }
    if (tasks.size !== entry.order.length || entry.order.some(id => !tasks.has(id))) throw new Error('雲端任務清單與區塊不符。');
    workspaces.push({...metadata.data as Workspace, tasks: entry.order.map(id => tasks.get(id)!)});
  }
  const document = {...manifest.header, data: {version: 1 as const, activeWorkspaceId: manifest.state.activeWorkspaceId, workspaces}};
  if (new TextEncoder().encode(JSON.stringify(document)).length > 20 * 1024 * 1024) throw new Error('完整備份超過 20 MB，原有資料保留。');
  return readDriveDocument(document);
}

/** A bounded cache avoids hashing identical blocks again without weakening content checks. */
export class BlockHashes {
  private readonly hashes = new Map<string, string>();
  private bytes = 0;
  async hash(block: BackupBlock): Promise<string> {
    const key = canonical(block), cached = this.hashes.get(key);
    if (cached) return cached;
    const hash = await checksum(block);
    if (!this.hashes.has(key)) {this.hashes.set(key, hash); this.bytes += key.length * 2;}
    while (this.hashes.size > 256 || this.bytes > 8 * 1024 * 1024) {const oldest = this.hashes.keys().next().value!; this.bytes -= oldest.length * 2; this.hashes.delete(oldest);}
    return hash;
  }
  clear(): void {this.hashes.clear(); this.bytes = 0;}
}
