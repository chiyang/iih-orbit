import assert from 'node:assert/strict';
import {test} from 'node:test';
import {checksum, createDriveDocument, versionProperties} from '../src/app/drive-data.ts';
import {DriveApi} from '../src/app/drive-api.ts';
import {backup, cloud} from './helpers/backup-cloud.mjs';

async function unreferenced(f, count = 3) {
  const dataset = crypto.randomUUID();
  for (let i = 0; i < count; i++) {
    const data = {application: 'iih-orbit-block', formatVersion: 1, kind: 'tasks', data: [{id: 'orphan-' + i}]}, hash = await checksum(data), time = new Date(f.now()).toISOString();
    const metadata = {id: 'unused_' + i, name: hash + '.json', mimeType: 'application/json', createdTime: time, modifiedTime: time, size: String(new TextEncoder().encode(JSON.stringify(data)).length), appProperties: {orbit: 'v1', type: 'block', dataset, hash}};
    f.files.set(metadata.id, {metadata, data});
  }
  return [...f.files.values()].filter(entry => entry.metadata.appProperties.type === 'block');
}

test('首次確認未引用才開始觀察，滿三十天才移至垃圾桶，包含精確邊界', async () => {
  const f = cloud(), blocks = await unreferenced(f); f.advance(100);
  assert.deepEqual(await f.api.cleanupBlocks(() => true, f.now()), {observed: 3, removed: 0, remaining: false});
  assert.ok(blocks.every(entry => entry.metadata.appProperties.type === 'orphan-block' && !entry.metadata.trashed));
  f.advance(30 - 1 / 86400000); assert.equal((await f.api.cleanupBlocks(() => true, f.now())).removed, 0);
  f.advance(1 / 86400000); assert.equal((await f.api.cleanupBlocks(() => true, f.now())).removed, 3);
  assert.ok(blocks.every(entry => entry.metadata.trashed));
  assert.equal((await f.api.cleanupBlocks(() => true, f.now())).removed, 0);
});

test('回收每批最多二十個，只處理 Orbit 區塊，下一批接續且不永久刪除', async () => {
  const f = cloud(), blocks = await unreferenced(f, 47);
  const unrelated = structuredClone(blocks[0]); unrelated.metadata.id = 'other_app'; unrelated.metadata.appProperties.orbit = 'another-app'; f.files.set(unrelated.metadata.id, unrelated);
  await f.api.cleanupBlocks(() => true, f.now()); f.advance(30);
  assert.deepEqual(await f.api.cleanupBlocks(() => true, f.now()), {observed: 0, removed: 20, remaining: true});
  assert.equal((await f.api.cleanupBlocks(() => true, f.now())).removed, 20);
  assert.equal((await f.api.cleanupBlocks(() => true, f.now())).removed, 7);
  assert.equal(f.files.has('other_app'), true); assert.equal(unrelated.metadata.trashed, undefined);
  assert.ok(blocks.every(entry => f.files.has(entry.metadata.id) && entry.metadata.trashed));
});

test('最新、分歧及垃圾桶內歷史版本仍使用的區塊不進入回收', async () => {
  const f = cloud(), original = await createDriveDocument(backup(2), undefined, [], 'sync');
  const first = await f.api.save(original, 'root_version');
  const edited = structuredClone(original); edited.data.workspaces[0].tasks[0].title = '分支一';
  await f.api.save(await createDriveDocument(edited, original.cloud.datasetId, [original.cloud.versionId], 'sync'), 'branch_first');
  edited.data.workspaces[0].tasks[0].title = '分支二';
  await f.api.save(await createDriveDocument(edited, original.cloud.datasetId, [original.cloud.versionId], 'sync'), 'branch_second');
  await f.api.trash(first); f.advance(100);
  assert.deepEqual(await f.api.cleanupBlocks(() => true, f.now()), {observed: 0, removed: 0, remaining: false});
  assert.ok([...f.files.values()].filter(entry => entry.metadata.appProperties.type === 'block').every(entry => !entry.metadata.trashed));
  assert.deepEqual(await new DriveApi(f.transport).read(first), original);
});

test('觀察期間重新被引用會取消期限，再失去引用後重新觀察三十天', async () => {
  const f = cloud(), document = await createDriveDocument(backup(2), undefined, [], 'sync'), file = await f.api.save(document, 'reappearing_version');
  const saved = f.files.get(file.id); f.files.delete(file.id);
  await f.api.cleanupBlocks(() => true, f.now()); f.advance(30);
  f.files.set(file.id, saved); assert.equal((await f.api.cleanupBlocks(() => true, f.now())).removed, 0);
  const blocks = [...f.files.values()].filter(entry => entry.metadata.appProperties.type === 'orphan-block');
  assert.ok(blocks.every(entry => entry.metadata.appProperties.gcReferenced === '1' && !entry.metadata.trashed));
  assert.deepEqual(await new DriveApi(f.transport).read(file), document);
  f.files.delete(file.id); f.advance(5); await f.api.cleanupBlocks(() => true, f.now());
  f.advance(29); assert.equal((await f.api.cleanupBlocks(() => true, f.now())).removed, 0);
  f.advance(1); assert.equal((await f.api.cleanupBlocks(() => true, f.now())).removed, blocks.length);
});

test('新待上傳作業保護區塊，過期三十天後觀察並回收，長期離線重試從完整資料重建', async () => {
  const f = cloud(), document = await createDriveDocument(backup(2), undefined, [], 'sync');
  f.lose(); await assert.rejects(f.api.save(document, 'offline_pending'), /回覆遺失/);
  assert.equal((await f.api.list()).length, 0);
  assert.equal((await f.api.cleanupBlocks(() => true, f.now())).observed, 0);
  const old = [...f.files.values()].filter(entry => entry.metadata.appProperties.type === 'block');
  f.advance(31); await f.api.cleanupBlocks(() => true, f.now()); f.advance(30);
  assert.equal((await f.api.cleanupBlocks(() => true, f.now())).removed, old.length);
  const saved = await f.api.save(document, 'offline_pending');
  assert.equal((await f.api.list()).length, 1); assert.equal(saved.cloud.versionId, document.cloud.versionId);
  assert.deepEqual(await new DriveApi(f.transport).read(saved), document);
  assert.ok(old.every(entry => entry.metadata.trashed));
  const ids = f.files.get(saved.id).data.state.workspaces.flatMap(workspace => [workspace.metadata.id, ...workspace.tasks.map(ref => ref.id)]);
  assert.ok(ids.every(id => !old.some(entry => entry.metadata.id === id)));
});

test('清單或待上傳保護名單不完整時，不把任何區塊移至垃圾桶', async () => {
  const f = cloud(), blocks = await unreferenced(f); await f.api.cleanupBlocks(() => true, f.now()); f.advance(30);
  const request = f.transport.api;
  f.transport.api = async (path, params, options) => params?.q?.includes("value='version'") ? {files: [], incompleteSearch: true} : request(path, params, options);
  await assert.rejects(f.api.cleanupBlocks(() => true, f.now()), /未完整取得/);
  assert.ok(blocks.every(entry => !entry.metadata.trashed));
  f.transport.api = request;
  const document = await createDriveDocument(backup(1), undefined, [], 'sync'); f.lose(); await assert.rejects(f.api.save(document, 'bad_protection'));
  f.files.get('bad_protection').data.blocks = ['invalid'];
  await assert.rejects(f.api.cleanupBlocks(() => true, f.now()), /保護名單不完整/);
  assert.ok(blocks.every(entry => !entry.metadata.trashed));
});

test('刪除前的最後檢查收到新引用或連線改變時取消回收', async () => {
  const f = cloud(), document = await createDriveDocument(backup(1), undefined, [], 'sync'), file = await f.api.save(document, 'late_version');
  const saved = f.files.get(file.id); f.files.delete(file.id); await f.api.cleanupBlocks(() => true, f.now()); f.advance(30);
  const request = f.transport.api; let scans = 0;
  f.transport.api = async (path, params, options) => {
    if (params?.q?.includes("value='version'") && ++scans === 2) f.files.set(file.id, saved);
    return request(path, params, options);
  };
  assert.equal((await f.api.cleanupBlocks(() => true, f.now())).removed, 0);
  f.transport.api = request; f.files.delete(file.id); await f.api.cleanupBlocks(() => true, f.now()); f.advance(30);
  let current = true;
  f.transport.api = async (path, params, options) => {const result = await request(path, params, options); if (path.startsWith('files/file_') && !options?.method) current = false; return result;};
  await assert.rejects(f.api.cleanupBlocks(() => current, f.now()), /已變更/);
  assert.ok([...f.files.values()].filter(entry => entry.metadata.appProperties.type === 'orphan-block').every(entry => !entry.metadata.trashed));
});

test('部分垃圾桶寫入失敗後可重試，不重複移動已完成的區塊', async () => {
  const f = cloud(), blocks = await unreferenced(f); await f.api.cleanupBlocks(() => true, f.now()); f.advance(30);
  const request = f.transport.api; let moves = 0, failed = false;
  f.transport.api = async (path, params, options) => {
    if (options?.method === 'PATCH' && JSON.parse(options.body).trashed && ++moves === 2 && !failed) {failed = true; throw new Error('暫時寫入失敗');}
    return request(path, params, options);
  };
  await assert.rejects(f.api.cleanupBlocks(() => true, f.now()), /暫時/);
  assert.equal(blocks.filter(entry => entry.metadata.trashed).length, 1);
  assert.equal((await f.api.cleanupBlocks(() => true, f.now())).removed, 2); assert.equal(moves, 4);
});

test('發布前所選區塊被隔離時重建引用，發布回覆遺失後重試保持相同版本', async () => {
  const f = cloud(), document = await createDriveDocument(backup(2), undefined, [], 'sync');
  const upload = f.transport.upload, request = f.transport.api; let quarantined, failReply = true;
  f.transport.upload = async (url, options) => {
    const result = await upload(url, options);
    if (!quarantined && options.method === 'PATCH' && JSON.parse(options.body).application === 'iih-orbit-chunked') {
      const id = f.files.get('racing_version').data.state.workspaces[0].tasks[0].id; quarantined = f.files.get(id);
      quarantined.metadata.appProperties = {...quarantined.metadata.appProperties, type: 'orphan-block', gcToken: crypto.randomUUID()};
    }
    return result;
  };
  f.transport.api = async (path, params, options) => {
    const result = await request(path, params, options);
    if (failReply && path === 'files/racing_version' && options?.method === 'PATCH' && JSON.parse(options.body).appProperties?.type === 'version') {failReply = false; throw new Error('發布回覆遺失');}
    return result;
  };
  await assert.rejects(f.api.save(document, 'racing_version'), /發布回覆遺失/);
  const count = f.uploads.length, saved = await f.api.save(document, 'racing_version');
  assert.equal(f.uploads.length, count); assert.equal((await f.api.list()).length, 1);
  assert.ok(f.files.get(saved.id).data.state.workspaces[0].tasks.every(ref => ref.id !== quarantined.metadata.id));
  assert.deepEqual(await new DriveApi(f.transport).read(saved), document);
});

test('舊空版本升級至隱藏待上傳索引，沿用識別並完整發布', async () => {
  const f = cloud(), document = await createDriveDocument(backup(1), undefined, [], 'sync'), time = new Date(f.now()).toISOString();
  f.files.set('old_empty', {metadata: {id: 'old_empty', name: 'Orbit.json', mimeType: 'application/json', createdTime: time, modifiedTime: time, size: '0', appProperties: versionProperties(document)}, data: null});
  const saved = await f.api.save(document, 'old_empty');
  assert.equal(saved.id, 'old_empty'); assert.deepEqual(await new DriveApi(f.transport).read(saved), document);
});

test('回收使用 Drive 的時間，裝置時鐘偏差不提前縮短三十天觀察期', async t => {
  const f = cloud(), blocks = await unreferenced(f); await f.api.cleanupBlocks();
  t.mock.timers.enable({apis: ['Date'], now: new Date('2099-01-01T00:00:00Z')});
  try {
    assert.equal((await f.api.cleanupBlocks()).removed, 0);
    f.advance(29); assert.equal((await f.api.cleanupBlocks()).removed, 0);
    f.advance(1); assert.equal((await f.api.cleanupBlocks()).removed, blocks.length);
  } finally {t.mock.timers.reset();}
});
