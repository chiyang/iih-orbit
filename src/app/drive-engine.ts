import type { BackupKind, OrbitBackup } from './backup-data.ts';
import { backupHash, createDriveDocument, DriveCollectionDeleted, syncHash, versionGraph } from './drive-data.ts';
import type { DriveDocument, DriveFile, DriveRuntime } from './drive-data.ts';
import type { DriveRepository } from './drive-repository.ts';

export interface DriveOperations {
  list(): Promise<DriveFile[]>;
  generateId(): Promise<string>;
  read(file: DriveFile): Promise<DriveDocument>;
  save(document: DriveDocument, id: string): Promise<DriveFile>;
  assertAvailable(datasetId: string): Promise<void>;
}
export interface DriveBoard {
  snapshot(kind: BackupKind, ids: string[]): Promise<{backup: OrbitBackup; revision: string}>;
  apply(backup: OrbitBackup, revision: string, targets: string[]): Promise<void>;
}
/** The caller owns a cross-tab lock. All async completions are fenced against account/reset changes. */
export class DriveEngine {
  private readonly api: DriveOperations;
  private readonly repository: DriveRepository;
  private readonly board: DriveBoard;
  private readonly key: string;
  private readonly current: () => boolean;
  constructor(api: DriveOperations, repository: DriveRepository, board: DriveBoard, key: string, current: () => boolean = () => true) {
    this.api = api; this.repository = repository; this.board = board; this.key = key; this.current = current;
  }
  private check(): void { if (!this.current()) throw new Error('Drive 帳號、資料或頁面已變更，本次操作已停止。'); }
  private async state(): Promise<DriveRuntime> { const state = await this.repository.read(this.key); this.check(); return state; }
  private async persist(state: DriveRuntime): Promise<void> { this.check(); await this.repository.write(this.key, state, this.current); this.check(); }
  private async queue(state: DriveRuntime, document: DriveDocument): Promise<void> {
    if (state.pending) throw new Error('仍有待上傳版本，請先完成重試。');
    state.pending = {fileId: '', document}; await this.persist(state);
  }
  async flush(): Promise<void> {
    const state = await this.state(), pending = state.pending;
    if (!pending) return;
    await this.api.assertAvailable(pending.document.cloud.datasetId); this.check();
    if (!pending.fileId) { pending.fileId = await this.api.generateId(); await this.persist(state); }
    await this.api.save(pending.document, pending.fileId); this.check();
    await this.api.assertAvailable(pending.document.cloud.datasetId); this.check();
    if (state.link?.datasetId === pending.document.cloud.datasetId) {
      state.link.baseVersionId = pending.document.cloud.versionId; state.link.baseHash = pending.document.cloud.syncHash;
      state.link.baseHashVersion = pending.document.cloud.formatVersion;
      state.link.baseBackupHash = await backupHash(pending.document); this.check();
    }
    state.lastSavedAt = new Date().toISOString(); delete state.pending; await this.persist(state);
  }
  async manual(kind: BackupKind, ids: string[]): Promise<void> {
    await this.flush();
    const {backup} = await this.board.snapshot(kind, ids); this.check();
    const document = await createDriveDocument(backup); this.check();
    const state = await this.state(); await this.queue(state, document); await this.flush();
  }
  async start(kind: BackupKind, ids: string[], mode: 'backup' | 'sync', requireEmpty = false): Promise<void> {
    await this.flush();
    if (requireEmpty) {
      const files = await this.api.list(); this.check();
      if (files.some(file => !file.trashed)) throw new Error('Drive 已有雲端資料，請先查看並使用；需要另一份時再選「另建一份」。');
    }
    const {backup} = await this.board.snapshot(kind, ids); this.check();
    const document = await createDriveDocument(backup, crypto.randomUUID(), [], mode); this.check();
    const state = await this.state();
    state.link = {datasetId: document.cloud.datasetId, kind, workspaceIds: kind === 'workspaces' ? [...ids] : [], baseVersionId: '', baseHash: ''};
    delete state.conflict;
    await this.queue(state, document); await this.flush();
  }
  async join(file: DriveFile, expectedRevision: string, reviewedHeads?: string[]): Promise<void> {
    if (file.cloud.purpose === 'manual') throw new Error('手動備份請使用還原或新增副本；同步請選擇自動集合的最新版本。');
    const state = await this.state();
    await this.api.assertAvailable(file.cloud.datasetId); this.check();
    if (state.pending) throw new Error('仍有待上傳版本，請先完成重試後再接續雲端集合。');
    const files = (await this.api.list()).filter(f => f.cloud.datasetId === file.cloud.datasetId); this.check();
    const graph = versionGraph(files);
    const actualHeads = graph.heads.map(head => head.cloud.versionId).sort();
    if (!graph.heads.some(head => head.id === file.id) || (reviewedHeads ? JSON.stringify(actualHeads) !== JSON.stringify([...reviewedHeads].sort()) : graph.heads.length !== 1)) throw new Error('雲端版本已更新或有分歧，請重新選擇最新版本。');
    if (graph.heads.length > 20) throw new Error('這份資料有超過 20 份不同內容，請先保留需要的副本或刪除不需要的內容。');
    const document = await this.api.read(file); this.check();
    const latest = versionGraph((await this.api.list()).filter(value => value.cloud.datasetId === file.cloud.datasetId)); this.check();
    if (JSON.stringify(latest.heads.map(head => head.cloud.versionId).sort()) !== JSON.stringify(actualHeads)) throw new Error('確認期間雲端資料已更新，請重新查看後使用。');
    await this.api.assertAvailable(file.cloud.datasetId); this.check();
    await this.board.apply(document, expectedRevision, document.data.workspaces.map(w => w.id)); this.check();
    state.link = {datasetId: document.cloud.datasetId, kind: document.kind, workspaceIds: document.kind === 'workspaces' ? document.data.workspaces.map(w => w.id) : [], baseVersionId: document.cloud.versionId, baseHash: await syncHash(document), baseHashVersion: 2, baseBackupHash: await backupHash(document)};
    delete state.conflict; await this.persist(state);
    if (graph.heads.length > 1) {
      await this.queue(state, await createDriveDocument(document, document.cloud.datasetId, actualHeads, 'sync'));
      await this.flush();
      const after = versionGraph((await this.api.list()).filter(value => value.cloud.datasetId === file.cloud.datasetId)); this.check();
      const saved = await this.state();
      if (after.heads.length !== 1 || after.heads[0].cloud.versionId !== saved.link!.baseVersionId) {saved.conflict = after.heads.map(head => head.cloud.versionId).sort(); await this.persist(saved);}
    }
  }
  async refreshConflict(files: DriveFile[]): Promise<boolean> {
    const state = await this.state(), link = state.link;
    if (!link) return false;
    const group = files.filter(file => file.cloud.datasetId === link.datasetId);
    const deletedBase = group.some(file => file.trashed && file.cloud.versionId === link.baseVersionId);
    if (!state.conflict && !deletedBase) return false;
    const graph = versionGraph(group);
    if (!graph.heads.length) return !!state.conflict;
    const discardedBase = deletedBase && !graph.heads.some(head => graph.descendant(head.cloud.versionId, link.baseVersionId));
    if (!state.conflict && !discardedBase) return false;
    const previous = JSON.stringify(state.conflict);
    if (graph.heads.length === 1 && graph.heads[0].cloud.versionId === link.baseVersionId) delete state.conflict;
    else state.conflict = graph.heads.map(head => head.cloud.versionId).sort();
    // A remaining remote branch still needs an explicit choice before replacing local data.
    if (JSON.stringify(state.conflict) !== previous) await this.persist(state);
    return !!state.conflict;
  }
  async synchronize(mode: 'backup' | 'sync'): Promise<void> {
    await this.flush();
    let state = await this.state();
    if (!state.link) return;
    await this.api.assertAvailable(state.link.datasetId); this.check();
    if (state.conflict) {
      await this.refreshConflict(await this.api.list());
      state = await this.state();
      if (state.conflict) return;
    }
    const link = state.link!;
    const local = await this.board.snapshot(link.kind, link.workspaceIds); this.check();
    if (mode === 'backup') {
      const versions = (await this.api.list()).filter(file => file.cloud.datasetId === link.datasetId); this.check();
      if (!versions.some(file => file.cloud.versionId === link.baseVersionId)) throw new DriveCollectionDeleted(link.datasetId);
      if (await this.refreshConflict(versions)) return;
      const localBackupHash = await backupHash(local.backup); this.check();
      // Old runtime records have no backup baseline. Preserve history and establish it once.
      if (localBackupHash !== link.baseBackupHash) { await this.queue(state, await createDriveDocument(local.backup, link.datasetId, link.baseVersionId ? [link.baseVersionId] : [], 'backup')); await this.flush(); }
      return;
    }
    const localHash = await syncHash(local.backup); this.check();
    const files = (await this.api.list()).filter(f => f.cloud.datasetId === link.datasetId); this.check();
    if (await this.refreshConflict(files)) return;
    const graph = versionGraph(files), head = graph.heads[0];
    if (!head) throw new DriveCollectionDeleted(link.datasetId);
    // Read a legacy baseline once without rewriting the immutable version or its checksum.
    if (link.baseHashVersion !== 2) {
      const baseline = files.find(file => file.cloud.versionId === link.baseVersionId);
      if (!baseline) throw new DriveCollectionDeleted(link.datasetId);
      link.baseHash = await syncHash(await this.api.read(baseline)); this.check(); link.baseHashVersion = 2;
    }
    const dirty = localHash !== link.baseHash;
    const legacyHead = head.cloud.formatVersion === 1 && head.cloud.versionId !== link.baseVersionId && graph.heads.length === 1 ? await this.api.read(head) : undefined;
    const headHash = head.cloud.formatVersion === 2 ? head.cloud.syncHash : head.cloud.versionId === link.baseVersionId ? link.baseHash : legacyHead ? await syncHash(legacyHead) : undefined;
    this.check();
    if (graph.heads.length === 1 && head.kind === link.kind && headHash === localHash) {
      if (head.cloud.versionId !== link.baseVersionId) { const document = legacyHead ?? await this.api.read(head); this.check(); link.baseBackupHash = await backupHash(document); this.check(); }
      link.baseVersionId = head.cloud.versionId; link.baseHash = localHash; link.baseHashVersion = 2; await this.persist(state); return;
    }
    if (graph.heads.length === 1 && head.cloud.versionId !== link.baseVersionId && !dirty && graph.descendant(head.cloud.versionId, link.baseVersionId)) {
      const document = legacyHead ?? await this.api.read(head); this.check();
      await this.api.assertAvailable(link.datasetId); this.check();
      if (document.kind !== link.kind || (link.kind === 'workspaces' && (document.data.workspaces.length !== link.workspaceIds.length || document.data.workspaces.some(w => !link.workspaceIds.includes(w.id))))) throw new Error('雲端集合範圍變更，請重新預覽並接續。');
      await this.board.apply(document, local.revision, link.workspaceIds); this.check();
      link.baseVersionId = head.cloud.versionId; link.baseHash = await syncHash(document); link.baseHashVersion = 2; link.baseBackupHash = await backupHash(document); await this.persist(state); return;
    }
    if (graph.heads.length === 1 && head.cloud.versionId === link.baseVersionId) {
      if (!dirty) return;
      await this.queue(state, await createDriveDocument(local.backup, link.datasetId, [link.baseVersionId], 'sync')); await this.flush();
    } else if (dirty && !graph.heads.some(f => f.cloud.formatVersion === 2 && f.cloud.syncHash === localHash)) {
      // Save a local branch before asking the user to resolve two independently edited copies.
      await this.queue(state, await createDriveDocument(local.backup, link.datasetId, link.baseVersionId ? [link.baseVersionId] : [], 'sync')); await this.flush();
    }
    state = await this.state();
    const latest = versionGraph((await this.api.list()).filter(f => f.cloud.datasetId === link.datasetId)); this.check();
    if (latest.heads.length > 1 || (latest.heads.length === 1 && latest.heads[0].cloud.versionId !== state.link!.baseVersionId)) {
      state.conflict = latest.heads.map(f => f.cloud.versionId).sort(); await this.persist(state);
    }
  }
  async resolve(reviewedHeads: string[], cloudChoice?: DriveFile, expectedRevision?: string, purpose: 'backup' | 'sync' = 'sync'): Promise<void> {
    await this.flush();
    let state = await this.state(); const link = state.link;
    if (!link || !state.conflict) throw new Error('目前沒有待確認的同步分歧。');
    await this.api.assertAvailable(link.datasetId); this.check();
    let graph = versionGraph((await this.api.list()).filter(f => f.cloud.datasetId === link.datasetId)); this.check();
    if (JSON.stringify(graph.heads.map(f => f.cloud.versionId).sort()) !== JSON.stringify([...reviewedHeads].sort())) throw new Error('確認期間雲端版本已變更，請重新載入後選擇。');
    if (graph.heads.length > 20) throw new Error('此集合超過 20 個分支，請先匯入需要的副本，再建立新集合；舊版本會保留。');
    const local = await this.board.snapshot(link.kind, link.workspaceIds); this.check();
    let selected = local.backup;
    if (cloudChoice) {
      if (!expectedRevision || local.revision !== expectedRevision) throw new Error('確認期間本機資料已更新，請重新檢查後再選擇。');
      if (!graph.heads.some(f => f.id === cloudChoice.id)) throw new Error('請選擇目前的雲端分支。');
      selected = await this.api.read(cloudChoice); this.check();
      await this.api.assertAvailable(link.datasetId); this.check();
      const hash = await syncHash(local.backup);
      if (!graph.heads.some(f => f.cloud.formatVersion === 2 && f.cloud.syncHash === hash)) {
        const branch = await createDriveDocument(local.backup, link.datasetId, link.baseVersionId ? [link.baseVersionId] : [], purpose);
        const expected = [...graph.heads.map(f => f.cloud.versionId).filter(id => !branch.cloud.parents.includes(id)), branch.cloud.versionId].sort();
        await this.queue(state, branch); await this.flush();
        state = await this.state();
        graph = versionGraph((await this.api.list()).filter(f => f.cloud.datasetId === link.datasetId)); this.check();
        const actual = graph.heads.map(f => f.cloud.versionId).sort();
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {state.conflict = actual; await this.persist(state); throw new Error('保存本機版本期間雲端已更新，請重新預覽後選擇。');}
      }
      if (selected.kind !== link.kind || (link.kind === 'workspaces' && (selected.data.workspaces.length !== link.workspaceIds.length || selected.data.workspaces.some(w => !link.workspaceIds.includes(w.id))))) throw new Error('雲端集合範圍不同，請改用匯入副本。');
      await this.board.apply(selected, local.revision, link.workspaceIds); this.check();
    }
    const document = await createDriveDocument(selected, link.datasetId, graph.heads.map(f => f.cloud.versionId), purpose); this.check();
    await this.queue(state, document); await this.flush();
    state = await this.state();
    const after = versionGraph((await this.api.list()).filter(f => f.cloud.datasetId === link.datasetId)); this.check();
    if (after.heads.length === 1 && after.heads[0].cloud.versionId === document.cloud.versionId) delete state.conflict;
    else state.conflict = after.heads.map(f => f.cloud.versionId).sort();
    await this.persist(state);
  }
}
