import type { BackupKind, OrbitBackup } from './backup-data.ts';
import { backupHash, createDriveDocument, DriveCollectionDeleted, syncHash, versionGraph } from './drive-data.ts';
import type { DriveDocument, DriveFile, DriveRuntime } from './drive-data.ts';
import type { DriveRepository } from './drive-repository.ts';
import { commonDriveAncestor, mergeDriveBackups } from './drive-merge.ts';

export interface DriveOperations {
  list(): Promise<DriveFile[]>;
  generateId(): Promise<string>;
  read(file: DriveFile): Promise<DriveDocument>;
  save(document: DriveDocument, id: string): Promise<DriveFile>;
  assertAvailable(datasetId: string): Promise<void>;
  cacheBaseline?(document: DriveDocument): Promise<void>;
}
export interface DriveBoard {
  snapshot(kind: BackupKind, ids: string[]): Promise<{backup: OrbitBackup; revision: string}>;
  apply(backup: OrbitBackup, revision: string, targets: string[]): Promise<void>;
}
export interface LogoutCheckpoint {datasetId: string; revision: string}
/** The caller owns a cross-tab lock. All async completions are fenced against account/reset changes. */
export class DriveEngine {
  private readonly api: DriveOperations;
  private readonly repository: DriveRepository;
  private readonly board: DriveBoard;
  private readonly key: string;
  private readonly current: () => boolean;
  private mergeAttempts = 0;
  constructor(api: DriveOperations, repository: DriveRepository, board: DriveBoard, key: string, current: () => boolean = () => true) {
    this.api = api; this.repository = repository; this.board = board; this.key = key; this.current = current;
  }
  private check(): void { if (!this.current()) throw new Error('Drive 帳號、資料或頁面已變更，本次操作已停止。'); }
  private async state(): Promise<DriveRuntime> {
    const state = await this.repository.read(this.key); this.check();
    if (state.base && this.api.cacheBaseline) {await this.api.cacheBaseline(state.base); this.check();}
    return state;
  }
  private async persist(state: DriveRuntime): Promise<void> { this.check(); await this.repository.write(this.key, state, this.current); this.check(); }
  private async queue(state: DriveRuntime, document: DriveDocument): Promise<void> {
    if (state.pending) throw new Error('仍有待上傳版本，請先完成重試。');
    state.pending = {fileId: '', document}; await this.persist(state);
  }
  private async upgradeBaseline(state: DriveRuntime, files: DriveFile[]): Promise<void> {
    const link = state.link!;
    if ((link.baseHashVersion ?? 0) >= 4) return;
    const baseline = files.find(file => file.cloud.versionId === link.baseVersionId);
    if (!baseline) throw new DriveCollectionDeleted(link.datasetId);
    const document = await this.api.read(baseline); this.check();
    state.base = document;
    link.baseHash = await syncHash(document);
    if (link.baseBackupHash !== undefined) link.baseBackupHash = await backupHash(document);
    link.baseHashVersion = 4; this.check(); await this.persist(state);
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
      state.base = pending.document;
    }
    state.lastSavedAt = new Date().toISOString(); delete state.pending; await this.persist(state);
  }
  async manual(kind: BackupKind, ids: string[]): Promise<void> {
    await this.flush();
    const {backup} = await this.board.snapshot(kind, ids); this.check();
    const document = await createDriveDocument(backup); this.check();
    const state = await this.state(); await this.queue(state, document); await this.flush();
  }
  async enableFullSync(requireEmpty = false): Promise<void> {
    const before = await this.state();
    if (!before.link) {await this.start('full', [], 'sync', requireEmpty); return;}
    await this.synchronize('sync');
    const state = await this.state();
    if (state.pending || state.conflict?.length) throw new Error('雲端仍有待上傳或待選擇的內容，請先完成處理再啟用完整同步。');
    if (state.link?.kind !== 'full') await this.start('full', [], 'sync');
  }
  async checkpointForLogout(mode: 'backup' | 'sync'): Promise<LogoutCheckpoint> {
    const original = await this.state();
    if (original.link?.kind !== 'full') throw new Error('全部工作空間的雲端備份尚未準備完成，本機資料保留，請重試同步。');
    await this.synchronize(mode);
    const state = await this.state(), link = state.link!;
    if (state.pending || state.conflict?.length) throw new Error('雲端還有待上傳或待選擇的內容，請先完成同步再登出。');
    const heads = versionGraph((await this.api.list()).filter(file => file.cloud.datasetId === link.datasetId)).heads; this.check();
    if (heads.length !== 1 || heads[0].cloud.versionId !== link.baseVersionId) {
      if (heads.length) {state.conflict = heads.map(file => file.cloud.versionId).sort(); await this.persist(state);}
      throw new Error('雲端資料又有更新，請先到遠端同步選擇要使用的內容，再登出。');
    }
    const snapshot = await this.board.snapshot('full', []); this.check();
    const document = await createDriveDocument(snapshot.backup, link.datasetId, [link.baseVersionId], mode); this.check();
    await this.queue(state, document); await this.flush();
    const saved = versionGraph((await this.api.list()).filter(file => file.cloud.datasetId === link.datasetId)).heads; this.check();
    if (saved.length !== 1 || saved[0].cloud.versionId !== document.cloud.versionId) {
      const latestState = await this.state();
      if (saved.length) {latestState.conflict = saved.map(file => file.cloud.versionId).sort(); await this.persist(latestState);}
      throw new Error('備份期間雲端又有更新，本機資料保留，請再同步一次。');
    }
    const verified = await this.api.read(saved[0]); this.check();
    await this.api.assertAvailable(link.datasetId); this.check();
    const expectedHash = await backupHash(snapshot.backup);
    if (verified.kind !== 'full' || verified.cloud.datasetId !== link.datasetId || verified.cloud.versionId !== document.cloud.versionId || await backupHash(verified) !== expectedHash) throw new Error('無法確認完整雲端備份，尚未登出，本機資料保留。');
    const latest = await this.board.snapshot('full', []); this.check();
    if (latest.revision !== snapshot.revision || await backupHash(latest.backup) !== expectedHash) throw new Error('備份後本機資料又有變更，尚未登出，請再試一次。');
    this.check();
    return {datasetId: link.datasetId, revision: snapshot.revision};
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
    delete state.base; delete state.mergeBase;
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
    state.link = {datasetId: document.cloud.datasetId, kind: document.kind, workspaceIds: document.kind === 'workspaces' ? document.data.workspaces.map(w => w.id) : [], baseVersionId: document.cloud.versionId, baseHash: await syncHash(document), baseHashVersion: 4, baseBackupHash: await backupHash(document)};
    state.base = document; delete state.mergeBase;
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
  private scope(backup: OrbitBackup, state: DriveRuntime): boolean {
    const link = state.link!;
    return backup.kind === link.kind && (link.kind === 'full' || (backup.data.workspaces.length === link.workspaceIds.length && backup.data.workspaces.every(workspace => link.workspaceIds.includes(workspace.id))));
  }
  private async mergeBaseline(state: DriveRuntime, files: DriveFile[], tips: string[]): Promise<DriveDocument | undefined> {
    const cached = [state.base, state.mergeBase].filter((document): document is DriveDocument => !!document);
    const complete = [...files];
    for (const document of cached) if (!complete.some(file => file.cloud.versionId === document.cloud.versionId)) complete.push({id: 'cached', name: '', createdTime: document.exportedAt, size: 0, kind: document.kind, cloud: document.cloud, trashed: true});
    const ancestor = commonDriveAncestor(complete, tips);
    if (!ancestor) return undefined;
    const cache = cached.find(document => document.cloud.versionId === ancestor.cloud.versionId);
    if (cache) {
      if (cache.cloud.fileHash !== ancestor.cloud.fileHash) throw new Error('雲端版本與本機整併基準不符，原有資料保留。');
      return cache;
    }
    // An old device without a cached base cannot assume deleted history is still readable.
    if (ancestor.trashed) return undefined;
    const document = await this.api.read(ancestor); this.check();
    return document;
  }
  private async markAfterMerge(document: DriveDocument): Promise<void> {
    const state = await this.state();
    const files = (await this.api.list()).filter(file => file.cloud.datasetId === document.cloud.datasetId); this.check();
    const graph = versionGraph(files);
    if (!graph.heads.length) throw new DriveCollectionDeleted(document.cloud.datasetId);
    if (graph.heads.length === 1 && graph.heads[0].cloud.versionId === document.cloud.versionId) {delete state.conflict; delete state.mergeBase;}
    else {
      const local = await this.board.snapshot(state.link!.kind, state.link!.workspaceIds); this.check();
      if (document.cloud.purpose === 'sync' && await this.autoMerge(state, local, files)) return;
      state.conflict = graph.heads.map(file => file.cloud.versionId).sort();
    }
    await this.persist(state);
  }
  private async publishMerge(state: DriveRuntime, backup: OrbitBackup, revision: string, heads: DriveFile[], purpose: 'backup' | 'sync'): Promise<void> {
    const link = state.link!, parents = heads.map(file => file.cloud.versionId).sort();
    const document = await createDriveDocument(backup, link.datasetId, parents, purpose); this.check();
    const latest = versionGraph((await this.api.list()).filter(file => file.cloud.datasetId === link.datasetId)); this.check();
    if (JSON.stringify(latest.heads.map(file => file.cloud.versionId).sort()) !== JSON.stringify(parents)) throw new Error('整併期間雲端已更新，本機及雲端副本保留，請再同步一次。');
    await this.api.assertAvailable(link.datasetId); this.check();
    await this.board.apply(backup, revision, link.workspaceIds); this.check();
    await this.queue(state, document); await this.flush();
    await this.markAfterMerge(document);
  }
  private async autoMerge(state: DriveRuntime, local: {backup: OrbitBackup; revision: string}, files: DriveFile[]): Promise<boolean> {
    // A busy cloud cannot cause an unbounded read/merge/upload loop.
    if (this.mergeAttempts >= 3) return false;
    this.mergeAttempts++;
    const link = state.link!, graph = versionGraph(files);
    if (!graph.heads.length || graph.heads.length > 20) return false;
    const base = await this.mergeBaseline(state, files, [...graph.heads.map(file => file.cloud.versionId), link.baseVersionId]);
    if (!base || !this.scope(base, state)) return false;
    const documents = await Promise.all(graph.heads.map(file => this.api.read(file))); this.check();
    if (documents.some(document => !this.scope(document, state))) return false;
    const result = mergeDriveBackups(base, [local.backup, ...documents], undefined, true);
    state.mergeBase = base;
    if (result.conflicts.length || !this.scope(result.backup, state)) {await this.persist(state); return false;}
    await this.publishMerge(state, result.backup, local.revision, graph.heads, 'sync');
    return true;
  }
  async synchronize(mode: 'backup' | 'sync'): Promise<void> {
    this.mergeAttempts = 0;
    await this.flush();
    let state = await this.state();
    if (!state.link) return;
    await this.api.assertAvailable(state.link.datasetId); this.check();
    if (state.conflict) {
      await this.refreshConflict(await this.api.list());
      state = await this.state();
      if (state.conflict && mode === 'backup') return;
    }
    const link = state.link!;
    const local = await this.board.snapshot(link.kind, link.workspaceIds); this.check();
    if (mode === 'backup') {
      const versions = (await this.api.list()).filter(file => file.cloud.datasetId === link.datasetId); this.check();
      if (!versions.some(file => file.cloud.versionId === link.baseVersionId)) throw new DriveCollectionDeleted(link.datasetId);
      if (await this.refreshConflict(versions)) return;
      await this.upgradeBaseline(state, versions);
      const localBackupHash = await backupHash(local.backup); this.check();
      // Old runtime records have no backup baseline. Preserve history and establish it once.
      if (localBackupHash !== link.baseBackupHash) { await this.queue(state, await createDriveDocument(local.backup, link.datasetId, link.baseVersionId ? [link.baseVersionId] : [], 'backup')); await this.flush(); }
      return;
    }
    const localHash = await syncHash(local.backup); this.check();
    const files = (await this.api.list()).filter(f => f.cloud.datasetId === link.datasetId); this.check();
    await this.refreshConflict(files);
    const graph = versionGraph(files), head = graph.heads[0];
    if (!head) throw new DriveCollectionDeleted(link.datasetId);
    if (files.some(file => file.trashed && file.cloud.versionId === link.baseVersionId) && !graph.heads.some(file => graph.descendant(file.cloud.versionId, link.baseVersionId))) return;
    // Read a legacy baseline once without rewriting the immutable version or its checksum.
    await this.upgradeBaseline(state, files);
    const dirty = localHash !== link.baseHash;
    const legacyHead = head.cloud.formatVersion < 4 && head.cloud.versionId !== link.baseVersionId && graph.heads.length === 1 ? await this.api.read(head) : undefined;
    const headHash = head.cloud.formatVersion >= 4 ? head.cloud.syncHash : head.cloud.versionId === link.baseVersionId ? link.baseHash : legacyHead ? await syncHash(legacyHead) : undefined;
    this.check();
    if (graph.heads.length === 1 && head.kind === link.kind && headHash === localHash) {
      if (head.cloud.versionId !== link.baseVersionId) { const document = legacyHead ?? await this.api.read(head); this.check(); state.base = document; link.baseBackupHash = await backupHash(document); this.check(); }
      link.baseVersionId = head.cloud.versionId; link.baseHash = localHash; link.baseHashVersion = 4; delete state.conflict; delete state.mergeBase; await this.persist(state); return;
    }
    if (graph.heads.length === 1 && head.cloud.versionId !== link.baseVersionId && !dirty && graph.descendant(head.cloud.versionId, link.baseVersionId)) {
      const document = legacyHead ?? await this.api.read(head); this.check();
      await this.api.assertAvailable(link.datasetId); this.check();
      if (document.kind !== link.kind || (link.kind === 'workspaces' && (document.data.workspaces.length !== link.workspaceIds.length || document.data.workspaces.some(w => !link.workspaceIds.includes(w.id))))) throw new Error('雲端集合範圍變更，請重新預覽並接續。');
      await this.board.apply(document, local.revision, link.workspaceIds); this.check();
      state.base = document;
      link.baseVersionId = head.cloud.versionId; link.baseHash = await syncHash(document); link.baseHashVersion = 4; link.baseBackupHash = await backupHash(document); delete state.conflict; delete state.mergeBase; await this.persist(state); return;
    }
    if ((graph.heads.length > 1 || head.cloud.versionId !== link.baseVersionId) && await this.autoMerge(state, local, files)) return;
    if (graph.heads.length === 1 && head.cloud.versionId === link.baseVersionId) {
      if (!dirty) return;
      state.mergeBase = state.base;
      await this.queue(state, await createDriveDocument(local.backup, link.datasetId, [link.baseVersionId], 'sync')); await this.flush();
    } else if (dirty && !graph.heads.some(f => f.cloud.formatVersion >= 4 && f.cloud.syncHash === localHash)) {
      // Save a local branch before asking the user to resolve two independently edited copies.
      await this.queue(state, await createDriveDocument(local.backup, link.datasetId, link.baseVersionId ? [link.baseVersionId] : [], 'sync')); await this.flush();
    }
    state = await this.state();
    const latestFiles = (await this.api.list()).filter(f => f.cloud.datasetId === link.datasetId); this.check();
    const latest = versionGraph(latestFiles);
    if (!latest.heads.length) throw new DriveCollectionDeleted(link.datasetId);
    if (latest.heads.length > 1 || (latest.heads.length === 1 && latest.heads[0].cloud.versionId !== state.link!.baseVersionId)) {
      const currentLocal = await this.board.snapshot(link.kind, link.workspaceIds); this.check();
      if (await this.autoMerge(state, currentLocal, latestFiles)) return;
      state.conflict = latest.heads.map(f => f.cloud.versionId).sort(); await this.persist(state);
    } else {delete state.conflict; delete state.mergeBase; await this.persist(state);}
  }
  async resolve(reviewedHeads: string[], cloudChoice?: DriveFile, expectedRevision?: string, purpose: 'backup' | 'sync' = 'sync'): Promise<void> {
    this.mergeAttempts = 0;
    await this.flush();
    let state = await this.state(); const link = state.link;
    if (!link || !state.conflict) throw new Error('目前沒有待確認的同步分歧。');
    await this.api.assertAvailable(link.datasetId); this.check();
    let files = (await this.api.list()).filter(f => f.cloud.datasetId === link.datasetId); this.check();
    let graph = versionGraph(files);
    if (JSON.stringify(graph.heads.map(f => f.cloud.versionId).sort()) !== JSON.stringify([...reviewedHeads].sort())) throw new Error('確認期間雲端版本已變更，請重新載入後選擇。');
    if (graph.heads.length > 20) throw new Error('此集合超過 20 個分支，請先匯入需要的副本，再建立新集合；舊版本會保留。');
    const local = await this.board.snapshot(link.kind, link.workspaceIds); this.check();
    const base = await this.mergeBaseline(state, files, [...graph.heads.map(file => file.cloud.versionId), link.baseVersionId]);
    if (base) state.mergeBase = base;
    let selected = local.backup;
    if (cloudChoice) {
      if (!expectedRevision || local.revision !== expectedRevision) throw new Error('確認期間本機資料已更新，請重新檢查後再選擇。');
      if (!graph.heads.some(f => f.id === cloudChoice.id)) throw new Error('請選擇目前的雲端分支。');
      selected = await this.api.read(cloudChoice); this.check();
      await this.api.assertAvailable(link.datasetId); this.check();
      const hash = await syncHash(local.backup);
      if (!graph.heads.some(f => f.cloud.formatVersion >= 4 && f.cloud.syncHash === hash)) {
        const branch = await createDriveDocument(local.backup, link.datasetId, link.baseVersionId ? [link.baseVersionId] : [], purpose);
        const expected = [...graph.heads.map(f => f.cloud.versionId).filter(id => !branch.cloud.parents.includes(id)), branch.cloud.versionId].sort();
        await this.queue(state, branch); await this.flush();
        state = await this.state();
        files = (await this.api.list()).filter(f => f.cloud.datasetId === link.datasetId); this.check();
        graph = versionGraph(files);
        const actual = graph.heads.map(f => f.cloud.versionId).sort();
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {state.conflict = actual; await this.persist(state); throw new Error('保存本機版本期間雲端已更新，請重新預覽後選擇。');}
      }
      if (selected.kind !== link.kind || (link.kind === 'workspaces' && (selected.data.workspaces.length !== link.workspaceIds.length || selected.data.workspaces.some(w => !link.workspaceIds.includes(w.id))))) throw new Error('雲端集合範圍不同，請改用匯入副本。');
    }
    if (base && this.scope(base, state)) {
      const documents = await Promise.all(graph.heads.map(file => cloudChoice && file.id === cloudChoice.id ? selected as DriveDocument
        : state.base?.cloud.versionId === file.cloud.versionId && state.base.cloud.fileHash === file.cloud.fileHash ? state.base : this.api.read(file))); this.check();
      if (documents.every(document => this.scope(document, state))) {
        const inputs = [local.backup, ...documents];
        const preferred = cloudChoice ? documents.findIndex(document => document.cloud.versionId === cloudChoice.cloud.versionId) + 1 : 0;
        selected = mergeDriveBackups(base, inputs, preferred).backup;
      }
    }
    if (!this.scope(selected, state)) throw new Error('整併後的工作空間範圍不同，請改用匯入副本。');
    await this.publishMerge(state, selected, local.revision, graph.heads, purpose);
  }
}
