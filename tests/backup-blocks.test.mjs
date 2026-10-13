import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createDriveDocument, readDriveDocument, readDriveFile, versionGraph} from '../src/app/drive-data.ts';
import {DriveApi} from '../src/app/drive-api.ts';
import {packBackup, readManifest, unpackBackup, verifiedBlock} from '../src/app/backup-blocks.ts';
import {changedWorkspaceRecords, joinWorkspaceRecords, splitWorkspaceRecords} from '../src/app/workspace-records.ts';

import {backup, cloud} from './helpers/backup-cloud.mjs';

test('本機紀錄拆解往返完整，修改一個任務只更新主任務紀錄及修訂索引', () => {
  const data = {formatVersion: 2, generation: 'generation', revision: 'before', updatedAt: '2026-10-13T00:00:00.000Z', state: backup(1000).data};
  const previous = splitWorkspaceRecords(data), next = structuredClone(data);
  next.revision = 'after'; next.state.workspaces[0].tasks[100].title = '修改';
  assert.deepEqual(joinWorkspaceRecords(previous).state, data.state);
  const changes = changedWorkspaceRecords(previous, splitWorkspaceRecords(next));
  assert.equal(changes.put.length, 2); assert.deepEqual(changes.remove, []);
  assert.ok(changes.put.some(record => record.key.includes('task-100')));
  const corrupt = new Map(previous); corrupt.delete(changes.put.find(record => record.key !== 'root').key);
  assert.throws(() => joinWorkspaceRecords(corrupt), /紀錄遺失/);
});

test('分塊往返保留設定、任務排序與內容，單一編輯只改一個穩定分組', async () => {
  const document = await createDriveDocument(backup(1000), undefined, [], 'sync'), packed = await packBackup(document);
  for (const entry of packed.manifest.state.workspaces) {entry.metadata.id = 'block_metadata'; entry.tasks.forEach((reference, i) => {reference.id = 'block_' + i;});}
  readManifest(packed.manifest, document.cloud);
  assert.deepEqual(await unpackBackup(packed.manifest, async reference => verifiedBlock(packed.blocks.get(reference.hash), reference.hash)), document);
  const edited = structuredClone(document); edited.data.workspaces[0].tasks[50].title = '新的內容';
  const changed = await packBackup(edited);
  assert.equal([...changed.blocks.keys()].filter(hash => !packed.blocks.has(hash)).length, 1);
  edited.data.workspaces[0].tasks.reverse();
  const reordered = await packBackup(edited);
  assert.deepEqual([...reordered.blocks.keys()].sort(), [...changed.blocks.keys()].sort());
});

test('保存新版索引前驗證區塊，冷讀取還原完整 JSON，第二版重用未變區塊', async () => {
  const f = cloud(), document = await createDriveDocument(backup(1000), undefined, [], 'sync');
  const first = await f.api.save(document, 'version_first');
  assert.equal(f.files.get(first.id).data.application, 'iih-orbit-chunked');
  const blocks = f.uploads.filter(upload => upload.type === 'block').length;
  assert.ok(blocks <= 65);
  const cold = new DriveApi(f.transport);
  assert.deepEqual(await cold.read(first), document);
  const edited = structuredClone(document); edited.data.workspaces[0].tasks[50].title = '修改一個任務';
  const second = await createDriveDocument(edited, document.cloud.datasetId, [document.cloud.versionId], 'sync');
  const start = f.uploads.length, saved = await f.api.save(second, 'version_second');
  assert.equal(f.uploads.slice(start).filter(upload => upload.type === 'block').length, 1);
  assert.equal(f.uploads.slice(start).filter(upload => upload.type === 'version').length, 1);
  assert.ok(f.uploads.slice(start).reduce((sum, upload) => sum + upload.bytes, 0) < new TextEncoder().encode(JSON.stringify(second)).length / 4);
  assert.deepEqual(await f.api.read(saved), second);
  const count = f.uploads.length; await f.api.save(second, 'version_second'); assert.equal(f.uploads.length, count);
});

test('區塊失敗不發布索引，回覆遺失後重試重用已上傳區塊及版本識別', async () => {
  const f = cloud(), document = await createDriveDocument(backup(2), undefined, [], 'sync');
  f.fail(true); await assert.rejects(f.api.save(document, 'retry_version'), /中斷/);
  assert.equal(f.files.get('retry_version').metadata.appProperties.type, 'pending-version'); assert.equal((await f.api.list()).length, 0);
  f.fail(false); f.lose(); await assert.rejects(f.api.save(document, 'retry_version'), /遺失/);
  const blocks = f.uploads.filter(upload => upload.type === 'block').length;
  await f.api.save(document, 'retry_version');
  assert.equal(f.uploads.filter(upload => upload.type === 'block').length, document.data.workspaces[0].tasks.length + 1);
  assert.ok(blocks >= 1 && blocks <= 3);
  assert.equal((await f.api.list()).length, 1);
});

test('缺少或竄改區塊不套用，區塊快取依帳號隔離，歷史版本仍完整可讀', async () => {
  const f = cloud(), document = await createDriveDocument(backup(2), undefined, [], 'sync'), file = await f.api.save(document, 'version_safe');
  const reference = f.files.get(file.id).data.state.workspaces[0].tasks[0];
  const block = f.files.get(reference.id); block.data.data[0].title = '竄改';
  await assert.rejects(new DriveApi(f.transport).read(file), /校驗/);
  f.switch(); await assert.rejects(f.api.read(file), /校驗/);
  f.files.delete(reference.id); await assert.rejects(new DriveApi(f.transport).read(file), /missing/);
});

test('手動雲端備份沿用獨立完整 JSON，新舊內容均接受原始校驗', async () => {
  const f = cloud(), document = await createDriveDocument(backup(2)), file = await f.api.save(document, 'manual_full');
  assert.equal(document.cloud.formatVersion, 4); assert.equal(f.files.get(file.id).data.application, 'iih-orbit');
  assert.equal(f.uploads.filter(upload => upload.type === 'block').length, 0);
  assert.deepEqual(await f.api.read(file), await readDriveDocument(document));
  assert.equal(versionGraph([readDriveFile(f.files.get(file.id).metadata)]).heads.length, 1);
});


test('一萬個任務的單筆修改只新增一個區塊，已驗證基準可減少下載', async t => {
  const f = cloud(), document = await createDriveDocument(backup(10000, 40), undefined, [], 'sync');
  await f.api.save(document, 'large_first');
  const edited = structuredClone(document); edited.data.workspaces[0].tasks[5000].title = '修改一個任務';
  const next = await createDriveDocument(edited, document.cloud.datasetId, [document.cloud.versionId], 'sync'), start = f.uploads.length;
  const saved = await f.api.save(next, 'large_second'), uploads = f.uploads.slice(start);
  const bytes = uploads.reduce((sum, upload) => sum + upload.bytes, 0), full = new TextEncoder().encode(JSON.stringify(next)).length;
  assert.equal(uploads.filter(upload => upload.type === 'block').length, 1); assert.equal(uploads.length, 3); assert.ok(bytes < full / 10);
  const receiver = new DriveApi(f.transport); await receiver.cacheBaseline(document);
  const readStart = f.reads.length; assert.deepEqual(await receiver.read(saved), next);
  assert.equal(f.reads.slice(readStart).filter(read => read.type === 'block').length, 1);
  t.diagnostic(JSON.stringify({tasks: 10000, fullJSONBytes: full, incrementalJSONBytes: bytes, incrementalBlocks: 1, savedPercent: Number((100 * (1 - bytes / full)).toFixed(2))}));
});

test('跨版本保留共同區塊，整理及清理歷史後保留版本仍可冷讀', async () => {
  const f = cloud(); let parent, dataset = crypto.randomUUID(), last;
  for (let i = 0; i < 10; i++) {
    const content = backup(2); content.data.workspaces[0].tasks[0].title = '歷史 ' + i;
    const document = await createDriveDocument(content, dataset, parent ? [parent] : [], 'sync');
    last = await f.api.save(document, 'history_' + i); parent = document.cloud.versionId;
  }
  const blocks = [...f.files.values()].filter(entry => entry.metadata.appProperties.type === 'block');
  await f.api.organize(); const retained = await f.api.pruneHistory(); assert.equal(retained.removed, 2);
  assert.ok(blocks.every(entry => !entry.metadata.trashed));
  for (const file of retained.files.filter(file => !file.trashed)) await new DriveApi(f.transport).read(file);
  const oldest = retained.files.find(file => file.id === 'history_0'); await new DriveApi(f.transport).read(oldest);
  assert.equal((await new DriveApi(f.transport).read(last)).data.workspaces[0].tasks[0].title, '歷史 9');
});
