import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createBackup} from '../src/app/backup-data.ts';
import {emptyWorkspace} from '../src/app/workspace-data.ts';
import {DEFAULT_APPEARANCE} from '../src/app/appearance-data.ts';
import {canonical, createDriveDocument, DriveCollectionDeleted, readDriveFile, versionGraph, versionProperties} from '../src/app/drive-data.ts';
import {driveCatalog, fileScope} from '../src/app/drive-catalog.ts';
import {DriveApi} from '../src/app/drive-api.ts';
import {GoogleHttpError} from '../src/app/google-api.ts';

const workspace = emptyWorkspace('workspace', '研究計畫');
const backup = (kind = 'full', name = workspace.name) => createBackup({version: 1, activeWorkspaceId: workspace.id, workspaces: [{...workspace, name}]}, kind, [workspace.id], DEFAULT_APPEARANCE);
function memoryDrive() {
  const files = new Map(), documents = new Map(), requests = [], patches = []; let nextId = 0;
  const transport = {
    async api(path, parameters = {}, options = {}) {
      requests.push({path, parameters, options});
      if (path === 'files/generateIds') return {ids: ['generated_' + ++nextId]};
      if (path === 'files') {
        if (options.method === 'POST') {
          const body = JSON.parse(options.body); files.set(body.id, {...body, createdTime: new Date().toISOString()}); return {id: body.id};
        }
        const type = /key='type' and value='([^']+)'/.exec(parameters.q)?.[1];
        const parent = /'([^']+)' in parents/.exec(parameters.q)?.[1];
        return {files: [...files.values()].filter(file => (!parameters.q.includes('trashed = false') || !file.trashed) && file.appProperties?.orbit === 'v1' && file.appProperties.type === type && (!parent || file.parents?.includes(parent))).map(file => structuredClone(file))};
      }
      const id = path.slice('files/'.length), file = files.get(id);
      if (!file) throw new GoogleHttpError(404);
      if (parameters.alt === 'media') return structuredClone(documents.get(id));
      if (options.method === 'PATCH') {
        patches.push(id); Object.assign(file, JSON.parse(options.body));
        if (parameters.removeParents) file.parents = (file.parents ?? []).filter(parent => !parameters.removeParents.split(',').includes(parent));
        if (parameters.addParents) file.parents = [...new Set([...(file.parents ?? []), parameters.addParents])];
      }
      return structuredClone(file);
    },
    async upload(url, options) {
      assert.equal(options.method, 'POST'); assert.match(url, /multipart/);
      const parts = [...options.body.matchAll(/\r\n\r\n(\{[^\r]*\})\r\n--/g)].map(match => JSON.parse(match[1]));
      assert.equal(parts.length, 2);
      const [metadata, document] = parts;
      if (files.has(metadata.id)) throw new GoogleHttpError(409);
      const file = {...metadata, createdTime: document.exportedAt, size: String(new TextEncoder().encode(JSON.stringify(document)).length)};
      files.set(file.id, file); documents.set(file.id, structuredClone(document)); return Response.json(file);
    }
  };
  const api = new DriveApi(transport);
  const root = {id: 'root_folder', name: 'IIH Orbit', mimeType: 'application/vnd.google-apps.folder', createdTime: '2026-10-01T00:00:00Z', appProperties: {orbit: 'v1', type: 'folder'}};
  files.set(root.id, root);
  return {api, transport, files, documents, requests, patches,
    put(document, id, time = document.exportedAt, legacy = false) {
      const properties = versionProperties(document);
      if (legacy) {delete properties.label; delete properties.counts;}
      const file = {id, name: 'iih-orbit-unknown.json', mimeType: 'application/json', createdTime: time, size: String(new TextEncoder().encode(JSON.stringify(document)).length), parents: [root.id], appProperties: properties};
      files.set(id, file); documents.set(id, structuredClone(document)); return readDriveFile(file);
    },
    path(id) {const file = files.get(id); return file.parents?.length ? this.path(file.parents[0]) + '/' + file.name : file.name;}
  };
}

async function history(f, count = 12, purpose = 'sync') {
  const dataset = crypto.randomUUID(), files = [];
  for (let i = 0; i < count; i++) {
    const document = await createDriveDocument(backup(), dataset, i ? [files[i - 1].cloud.versionId] : [], purpose);
    files.push(f.put(document, 'history_' + dataset + '_' + i, new Date(Date.UTC(2026, 9, 1, i)).toISOString()));
  }
  return files;
}

test('自動清理保留最新加過去七份，手動備份保留，垃圾桶祖先仍可供舊裝置追溯', async () => {
  const f = memoryDrive(), versions = await history(f), manual = await history(f, 10, 'manual');
  const before = canonical([...f.documents]), result = await f.api.pruneHistory();
  assert.equal(result.removed, 4); assert.equal(canonical([...f.documents]), before);
  const automatic = result.files.filter(file => file.cloud.datasetId === versions[0].cloud.datasetId);
  assert.deepEqual(automatic.filter(file => !file.trashed).map(file => file.id), versions.slice(4).map(file => file.id));
  const graph = versionGraph(automatic);
  assert.equal(graph.heads[0].id, versions.at(-1).id); assert.equal(graph.descendant(versions.at(-1).cloud.versionId, versions[0].cloud.versionId), true);
  for (const file of versions.slice(0, 4)) {
    assert.equal(f.files.get(file.id).appProperties.type, 'deleted-version');
    assert.equal((await f.api.read(file)).cloud.versionId, file.cloud.versionId);
  }
  assert.equal(result.files.filter(file => !file.trashed && file.cloud.datasetId === manual[0].cloud.datasetId).length, 10);
  assert.equal((await f.api.pruneHistory()).removed, 0);
});

test('自動清理始終保留目前最新內容，時間偏差不會把 head 刪除', async () => {
  const f = memoryDrive(), versions = await history(f);
  f.files.get(versions.at(-1).id).createdTime = '2026-01-01T00:00:00Z';
  const result = await f.api.pruneHistory(), live = result.files.filter(file => !file.trashed);
  assert.equal(live.length, 8); assert.ok(live.some(file => file.id === versions.at(-1).id));
});

test('不同內容待選擇、空的待上傳檔案及正在刪除的集合不自動清理', async () => {
  for (const condition of ['branch', 'pending', 'removed']) {
    const f = memoryDrive(), versions = await history(f);
    if (condition === 'branch') f.put(await createDriveDocument(backup(), versions[0].cloud.datasetId, [versions[0].cloud.versionId], 'sync'), 'new_branch');
    if (condition === 'pending') f.files.get(versions.at(-1).id).size = '0';
    if (condition === 'removed') {const root = f.files.get(versions[0].id); root.trashed = true; root.appProperties.type = 'deleted-collection';}
    assert.equal((await f.api.pruneHistory()).removed, 0); assert.equal(f.patches.length, 0);
  }
});

test('本機基準及待上傳父版本暫時保留，處理完畢後回到八份', async () => {
  const f = memoryDrive(), versions = await history(f);
  const protectedVersions = versions.slice(0, 2).map(file => file.cloud.versionId);
  assert.equal((await f.api.pruneHistory(() => true, protectedVersions)).files.filter(file => !file.trashed).length, 10);
  for (const file of versions.slice(0, 2)) assert.equal(f.files.get(file.id).trashed, undefined);
  assert.equal((await f.api.pruneHistory()).files.filter(file => !file.trashed).length, 8);
});

test('自動清理逐份重查，期間出現新分支就保留所有未刪除版本', async () => {
  const f = memoryDrive(), versions = await history(f), api = f.transport.api;
  const branch = await createDriveDocument(backup(), versions[0].cloud.datasetId, [versions[0].cloud.versionId], 'sync');
  let inserted = false;
  f.transport.api = async (path, parameters, options) => {
    if (!inserted && path === 'files/' + versions[0].id) {inserted = true; f.put(branch, 'concurrent_branch');}
    return api(path, parameters, options);
  };
  assert.equal((await f.api.pruneHistory()).removed, 0); assert.equal(f.patches.length, 0);
  assert.equal(versionGraph(await f.api.list()).heads.length, 2);
});

test('清理部分失敗後可繼續，不重刪已完成檔案；讀取後失去連線不刪除', async () => {
  const f = memoryDrive(), versions = await history(f), api = f.transport.api; let failed = false;
  f.transport.api = async (path, parameters, options) => {
    if (!failed && path === 'files/' + versions[1].id && options?.method === 'PATCH') {failed = true; throw new Error('temporary failure');}
    return api(path, parameters, options);
  };
  await assert.rejects(f.api.pruneHistory(), /temporary failure/);
  assert.equal(f.files.get(versions[0].id).trashed, true); assert.equal((await f.api.pruneHistory()).removed, 3);
  assert.equal(f.patches.filter(id => id === versions[0].id).length, 1);
  const canceled = memoryDrive(); await history(canceled); let current = true; const read = canceled.api.list.bind(canceled.api);
  canceled.api.list = async () => {const files = await read(); current = false; return files;};
  await assert.rejects(canceled.api.pruneHistory(() => current), /連線或設定已變更/); assert.equal(canceled.patches.length, 0);
});

test('備份摘要以工作空間名稱辨識，中文名稱與二十個父版本仍符合 Drive 屬性限制，舊索引相容', async () => {
  const document = await createDriveDocument(backup('workspaces', '跨領域研究👩‍🔬'.repeat(40)));
  document.cloud.parents = Array.from({length: 20}, () => crypto.randomUUID());
  const properties = versionProperties(document);
  assert.equal(Object.keys(properties).length, 30);
  for (const [key, value] of Object.entries(properties)) assert.ok(new TextEncoder().encode(key + value).length <= 124);
  assert.ok(properties.label.endsWith('…')); assert.equal(properties.counts, '1/0');
  const f = memoryDrive(), file = f.put(document, 'file_new'); assert.equal(fileScope(file), properties.label); assert.deepEqual(file.summary, {label: properties.label, workspaces: 1, tasks: 0});
  const old = f.put(document, 'file_old', undefined, true); assert.equal(old.summary, undefined); assert.equal(fileScope(old), '選定工作空間'); assert.deepEqual(old.cloud, file.cloud);
});

test('集合列表以最新版本分組、手動備份獨立，時間偏差不影響版本編號，分支保持可辨識', async () => {
  const f = memoryDrive(), root = await createDriveDocument(backup('workspaces'), crypto.randomUUID(), [], 'sync');
  const a = await createDriveDocument(backup('workspaces'), root.cloud.datasetId, [root.cloud.versionId], 'sync');
  const b = await createDriveDocument(backup('workspaces'), root.cloud.datasetId, [root.cloud.versionId], 'sync');
  const other = await createDriveDocument(backup(), crypto.randomUUID(), [], 'backup'), manual = await createDriveDocument(backup());
  const files = [f.put(root, 'file_root', '2026-10-20T00:00:00Z'), f.put(a, 'file_a', '2026-10-01T00:00:00Z'), f.put(b, 'file_b', '2026-10-02T00:00:00Z'), f.put(other, 'file_other'), f.put(manual, 'file_manual')];
  const catalog = driveCatalog(files, root.cloud.datasetId), group = catalog.collections[0];
  assert.equal(catalog.collections.length, 2); assert.equal(catalog.manual.length, 1); assert.equal(group.current, true); assert.equal(group.label, '研究計畫');
  assert.deepEqual(new Set(group.heads.map(file => file.id)), new Set(['file_a', 'file_b'])); assert.equal(group.history.length, 1); assert.equal(group.versions.get(root.cloud.versionId), 1);
  assert.ok(group.versions.get(a.cloud.versionId) > 1); assert.ok(group.versions.get(b.cloud.versionId) > 1); assert.equal(group.startedAt, files[0].createdTime);
  const merge = await createDriveDocument(backup('workspaces'), root.cloud.datasetId, [a.cloud.versionId, b.cloud.versionId], 'sync');
  const merged = driveCatalog([...files, f.put(merge, 'file_merge', '2026-09-30T00:00:00Z')], root.cloud.datasetId).collections[0];
  assert.equal(merged.heads.length, 1); assert.equal(merged.versions.get(merge.cloud.versionId), 4); assert.equal(merged.history.length, 3);
  const cycle = structuredClone(files); cycle[0].cloud.parents = [a.cloud.versionId];
  const invalid = driveCatalog(cycle, root.cloud.datasetId).collections[0]; assert.match(invalid.warning, /循環/); assert.equal(invalid.heads.length, 0); assert.equal(invalid.history.length, 3);
});

test('新同步資料、手動及自動備份直接存入對應子資料夾，重新上傳同一識別碼不建立重複檔案', async () => {
  const f = memoryDrive();
  for (const purpose of ['manual', 'backup', 'sync']) {
    const document = await createDriveDocument(backup('workspaces'), crypto.randomUUID(), [], purpose);
    const id = 'file_' + purpose; await f.api.save(document, id);
    const path = f.path(id);
    assert.ok(path.startsWith(purpose === 'sync' ? 'IIH Orbit/同步資料/' : 'IIH Orbit/歷史備份/' + (purpose === 'manual' ? '手動備份/' : '自動備份/')));
    assert.ok(path.includes('研究計畫')); const count = f.files.size; await f.api.save(document, id); assert.equal(f.files.size, count);
  }
});

test('整理既有檔案保留兩個同步分支，祖先移入歷史，手動與自動備份分開；內容與版本關係不變且整理可重複', async () => {
  const f = memoryDrive(), root = await createDriveDocument(backup('workspaces'), crypto.randomUUID(), [], 'sync');
  const a = await createDriveDocument(backup('workspaces'), root.cloud.datasetId, [root.cloud.versionId], 'sync');
  const b = await createDriveDocument(backup('workspaces'), root.cloud.datasetId, [root.cloud.versionId], 'sync');
  const manual = await createDriveDocument(backup()), auto = await createDriveDocument(backup(), crypto.randomUUID(), [], 'backup');
  f.put(root, 'file_root', undefined, true); f.put(a, 'file_a', undefined, true); f.put(b, 'file_b', undefined, true); f.put(manual, 'file_manual', undefined, true); f.put(auto, 'file_auto', undefined, true);
  const before = canonical([...f.documents]);
  const result = await f.api.organize(); assert.equal(result.changed, 5); assert.equal(canonical([...f.documents]), before);
  assert.match(f.path('file_root'), /^IIH Orbit\/歷史備份\/同步歷史\//);
  for (const id of ['file_a', 'file_b']) assert.match(f.path(id), /^IIH Orbit\/同步資料\/同步資料－研究計畫/);
  assert.match(f.path('file_manual'), /^IIH Orbit\/歷史備份\/手動備份\//); assert.match(f.path('file_auto'), /^IIH Orbit\/歷史備份\/自動備份\//);
  const group = result.files.filter(file => file.cloud.datasetId === root.cloud.datasetId); assert.equal(versionGraph(group).heads.length, 2);
  for (const file of result.files) assert.equal((await f.api.read(file)).cloud.versionId, file.cloud.versionId);
  const readsBefore = f.requests.length, patchesBefore = f.patches.length;
  assert.equal((await f.api.organize()).changed, 0); assert.equal(f.patches.length, patchesBefore);
  assert.equal(f.requests.slice(readsBefore).filter(request => request.path.startsWith('files/file_')).length, 0);
});

test('整理只處理指定集合，空的待上傳檔案保留；回覆後連線失效與版本被改動都不搬移', async () => {
  const f = memoryDrive(), one = await createDriveDocument(backup(), crypto.randomUUID(), [], 'sync');
  const two = await createDriveDocument(backup(), crypto.randomUUID(), [], 'sync');
  f.put(one, 'file_one'); f.put(two, 'file_two'); const pending = await createDriveDocument(backup()); f.put(pending, 'file_pending'); f.files.get('file_pending').size = '0';
  await f.api.organize(() => true, one.cloud.datasetId); assert.ok(f.path('file_one').startsWith('IIH Orbit/同步資料/')); assert.deepEqual(f.files.get('file_two').parents, ['root_folder']); assert.deepEqual(f.files.get('file_pending').parents, ['root_folder']);
  const requests = f.transport.api; let current = true;
  f.transport.api = async (...args) => {const result = await requests(...args); current = false; return result;};
  const count = f.patches.length; await assert.rejects(f.api.organize(() => current), /設定已變更/); assert.equal(f.patches.length, count);
  f.transport.api = async (...args) => {const result = await requests(...args); if (args[0] === 'files/file_two' && !args[2]?.method) result.appProperties.hash = 'a'.repeat(64); return result;};
  await assert.rejects(f.api.organize(() => true, two.cloud.datasetId), /版本已變更/); assert.equal(f.patches.length, count);
});

test('資料夾查詢不完整時停止建立，整理遇到循環版本不移動任何檔案', async () => {
  const f = memoryDrive(), document = await createDriveDocument(backup());
  const request = f.transport.api;
  f.transport.api = async (...args) => args[0] === 'files' && args[1]?.q?.includes('google-apps.folder') ? {files: [], incompleteSearch: true} : request(...args);
  await assert.rejects(f.api.save(document, 'file_new'), /資料夾清單不完整/); assert.equal(f.files.size, 1);
  f.transport.api = request;
  const root = await createDriveDocument(backup(), crypto.randomUUID(), [], 'sync'), child = await createDriveDocument(backup(), root.cloud.datasetId, [root.cloud.versionId], 'sync');
  root.cloud.parents = [child.cloud.versionId]; f.put(root, 'file_root'); f.put(child, 'file_child');
  await assert.rejects(f.api.organize(), /循環/); assert.equal(f.patches.length, 0); assert.equal(f.files.size, 3);
});

test('整個集合移至垃圾桶，含歷史與全部分支，留下刪除標記且不影響其他集合或原始 JSON', async () => {
  const f = memoryDrive(), root = await createDriveDocument(backup(), crypto.randomUUID(), [], 'sync');
  const a = await createDriveDocument(backup(), root.cloud.datasetId, [root.cloud.versionId], 'sync');
  const b = await createDriveDocument(backup(), root.cloud.datasetId, [root.cloud.versionId], 'sync');
  const other = await createDriveDocument(backup(), crypto.randomUUID(), [], 'backup');
  f.put(root, 'file_root'); f.put(a, 'file_branch_a'); f.put(b, 'file_branch_b'); f.put(other, 'file_other');
  const before = canonical([...f.documents]), plan = await f.api.planCollection(root.cloud.datasetId); let detached = false;
  assert.equal(plan.files.length, 3);
  assert.equal(await f.api.trashCollection(plan, () => true, async () => {assert.equal(f.patches.length, 0); detached = true;}), 3);
  assert.equal(detached, true); assert.equal(canonical([...f.documents]), before);
  assert.equal((await f.api.list()).length, 1); assert.equal(f.files.get('file_other').trashed, undefined);
  const markers = await f.api.removals(); assert.equal(markers.length, 1); assert.equal(markers[0].trashed, true); assert.equal(markers[0].cloud.datasetId, root.cloud.datasetId);
  for (const id of ['file_root', 'file_branch_a', 'file_branch_b']) assert.equal(f.files.get(id).trashed, true);
  await assert.rejects(f.api.assertAvailable(root.cloud.datasetId), DriveCollectionDeleted);
  const next = await createDriveDocument(backup(), root.cloud.datasetId, [a.cloud.versionId], 'sync');
  await assert.rejects(f.api.save(next, 'file_revived'), DriveCollectionDeleted); assert.equal(f.files.has('file_revived'), false);
  await f.api.assertAvailable(other.cloud.datasetId);
});

test('確認期間新增分支拒絕全部刪除；連線失效與關閉本機處理失敗都不寫入 Drive', async () => {
  const f = memoryDrive(), root = await createDriveDocument(backup(), crypto.randomUUID(), [], 'backup'); f.put(root, 'file_root');
  const plan = await f.api.planCollection(root.cloud.datasetId), child = await createDriveDocument(backup(), root.cloud.datasetId, [root.cloud.versionId], 'backup');
  f.put(child, 'file_child'); let stopped = false;
  await assert.rejects(f.api.trashCollection(plan, () => true, async () => {stopped = true;}), /確認期間雲端集合已更新/);
  assert.equal(stopped, false); assert.equal(f.patches.length, 0);
  const fresh = await f.api.planCollection(root.cloud.datasetId); let current = true;
  await assert.rejects(f.api.trashCollection(fresh, () => current, async () => {current = false;}), /刪除已停止/); assert.equal(f.patches.length, 0);
  await assert.rejects(f.api.trashCollection(fresh, () => true, async () => {throw new Error('本機設定無法保存');}), /本機設定無法保存/); assert.equal(f.patches.length, 0);
});

test('刪除部分失敗可以重新確認並繼續；垃圾桶中的集合標記仍禁止同步，整理不移動剩餘檔案', async () => {
  const f = memoryDrive(), root = await createDriveDocument(backup(), crypto.randomUUID(), [], 'sync');
  const child = await createDriveDocument(backup(), root.cloud.datasetId, [root.cloud.versionId], 'sync'); f.put(root, 'file_root'); f.put(child, 'file_child');
  const request = f.transport.api; let fail = true;
  f.transport.api = async (...args) => {if (args[0] === 'files/file_child' && args[2]?.method === 'PATCH' && fail) throw new GoogleHttpError(403); return request(...args);};
  const plan = await f.api.planCollection(root.cloud.datasetId);
  await assert.rejects(f.api.trashCollection(plan, () => true, async () => {}), GoogleHttpError);
  assert.equal((await f.api.list()).length, 1); assert.equal((await f.api.removals()).length, 1); assert.equal(f.files.get('file_child').trashed, undefined);
  const catalog = driveCatalog(await f.api.list(), undefined, (await f.api.removals()).map(file => file.cloud.datasetId)); assert.equal(catalog.collections[0].deleting, true);
  const moves = f.patches.length; await f.api.organize(); assert.equal(f.patches.length, moves);
  await assert.rejects(f.api.assertAvailable(root.cloud.datasetId), DriveCollectionDeleted);
  fail = false; const reviewed = await f.api.planCollection(root.cloud.datasetId); assert.equal(reviewed.files.filter(file => !file.trashed).length, 1);
  assert.equal(await f.api.trashCollection(reviewed, () => true, async () => {}), 1); assert.equal((await f.api.list()).length, 0);
  assert.equal(await f.api.trashCollection(reviewed, () => true, async () => {}), 0);
});

test('刪除開始後另一裝置寫入新版本，保留未確認的新檔並要求重試，不能假裝全部成功', async () => {
  const f = memoryDrive(), root = await createDriveDocument(backup(), crypto.randomUUID(), [], 'sync'); f.put(root, 'file_root');
  const late = await createDriveDocument(backup(), root.cloud.datasetId, [root.cloud.versionId], 'sync');
  const request = f.transport.api; let injected = false;
  f.transport.api = async (...args) => {
    const response = await request(...args);
    if (args[0] === 'files/file_root' && args[2]?.method === 'PATCH' && !injected) {injected = true; f.put(late, 'file_late');}
    return response;
  };
  const plan = await f.api.planCollection(root.cloud.datasetId);
  await assert.rejects(f.api.trashCollection(plan, () => true, async () => {}), /仍有未刪除/);
  assert.equal(f.files.get('file_late').trashed, undefined); assert.equal((await f.api.removals()).length, 1);
  const fresh = await f.api.planCollection(root.cloud.datasetId); assert.equal(await f.api.trashCollection(fresh, () => true, async () => {}), 1);
});

test('獨立備份刪除有身分校驗與連線柵欄，已刪除檔案重試不重新上傳，也不刪除自動集合單一版本', async () => {
  const f = memoryDrive(), document = await createDriveDocument(backup()), file = f.put(document, 'file_manual');
  await assert.rejects(f.api.trash(file, () => false), /刪除已停止/); assert.equal(f.patches.length, 0);
  await f.api.trash(file); assert.equal(f.files.get(file.id).trashed, true); await f.api.trash(file); assert.equal(f.patches.length, 1);
  await assert.rejects(f.api.save(document, file.id), DriveCollectionDeleted);
  const automatic = await createDriveDocument(backup(), crypto.randomUUID(), [], 'backup'), autoFile = f.put(automatic, 'file_auto');
  await assert.rejects(f.api.trash(autoFile), /目前的雲端資料/); assert.equal(f.files.get(autoFile.id).trashed, undefined);
});

test('過去備份逐份刪除後只剩目前內容，刪除紀錄保留連續關係且不顯示、不整理、不復活', async () => {
  const f = memoryDrive(), root = await createDriveDocument(backup(), crypto.randomUUID(), [], 'sync');
  const middle = await createDriveDocument(backup(), root.cloud.datasetId, [root.cloud.versionId], 'sync');
  const latest = await createDriveDocument(backup(), root.cloud.datasetId, [middle.cloud.versionId], 'sync');
  const rootFile = f.put(root, 'file_root'), middleFile = f.put(middle, 'file_middle'), latestFile = f.put(latest, 'file_latest');
  const original = structuredClone(f.documents.get(middleFile.id));
  await f.api.trash(middleFile); await f.api.trash(rootFile);
  assert.equal(f.files.get(middleFile.id).trashed, true); assert.equal(f.files.get(middleFile.id).appProperties.type, 'deleted-version');
  assert.deepEqual(f.documents.get(middleFile.id), original); assert.equal((await f.api.removals()).length, 0);
  const listed = await f.api.list(), graph = versionGraph(listed), catalog = driveCatalog(listed, root.cloud.datasetId);
  assert.deepEqual(graph.heads.map(file => file.id), [latestFile.id]); assert.equal(graph.descendant(latest.cloud.versionId, root.cloud.versionId), true);
  assert.equal(catalog.collections.length, 1); assert.equal(catalog.collections[0].history.length, 0);
  const oldPatches = f.patches.filter(id => id === middleFile.id).length;
  await f.api.organize(); assert.equal(f.patches.filter(id => id === middleFile.id).length, oldPatches);
  const next = await createDriveDocument(backup(), root.cloud.datasetId, [latest.cloud.versionId], 'sync');
  await f.api.save(next, 'file_next'); await f.api.trash(middleFile);
  assert.deepEqual(versionGraph(await f.api.list()).heads.map(file => file.id), ['file_next']);
  assert.equal(f.patches.filter(id => id === middleFile.id).length, oldPatches);
});

test('逐份刪除之後仍能刪除全部雲端資料，留下停止同步標記而不誤把過去備份當成整份刪除', async () => {
  const f = memoryDrive(), root = await createDriveDocument(backup(), crypto.randomUUID(), [], 'backup');
  const latest = await createDriveDocument(backup(), root.cloud.datasetId, [root.cloud.versionId], 'backup');
  const old = f.put(root, 'file_root'); f.put(latest, 'file_latest'); await f.api.trash(old);
  assert.equal((await f.api.removals()).length, 0); await f.api.assertAvailable(root.cloud.datasetId);
  const plan = await f.api.planCollection(root.cloud.datasetId); let stopped = false;
  assert.equal(await f.api.trashCollection(plan, () => true, async () => {stopped = true;}), 1);
  assert.equal(stopped, true); assert.equal(f.files.get('file_latest').appProperties.type, 'deleted-collection');
  assert.equal((await f.api.removals()).length, 1); assert.deepEqual(driveCatalog(await f.api.list()).collections, []);
  await assert.rejects(f.api.assertAvailable(root.cloud.datasetId), DriveCollectionDeleted);
});

test('過去備份刪除重查目前內容、身分與連線，不允許刪除待選擇的最新內容', async () => {
  const f = memoryDrive(), root = await createDriveDocument(backup(), crypto.randomUUID(), [], 'sync');
  const a = await createDriveDocument(backup(), root.cloud.datasetId, [root.cloud.versionId], 'sync');
  const b = await createDriveDocument(backup(), root.cloud.datasetId, [root.cloud.versionId], 'sync');
  const old = f.put(root, 'file_root'), first = f.put(a, 'file_a'); f.put(b, 'file_b');
  await assert.rejects(f.api.trash(first), /目前的雲端資料/); assert.equal(f.patches.length, 0);
  const altered = structuredClone(old); altered.cloud.fileHash = 'a'.repeat(64);
  await assert.rejects(f.api.trash(altered), /備份已變更/); assert.equal(f.patches.length, 0);
  let current = true; const request = f.transport.api;
  f.transport.api = async (...args) => {const result = await request(...args); if (args[0] === 'files') current = false; return result;};
  await assert.rejects(f.api.trash(old, () => current), /刪除已停止/); assert.equal(f.patches.length, 0);
});

test('逐份刪除已確認的待選擇內容，保留另一份、祖先與刪除紀錄，最後一份不能誤刪', async () => {
  for (const purpose of ['backup', 'sync']) {
    const f = memoryDrive(), root = await createDriveDocument(backup(), crypto.randomUUID(), [], purpose);
    const a = await createDriveDocument(backup(), root.cloud.datasetId, [root.cloud.versionId], purpose);
    const b = await createDriveDocument(backup(), root.cloud.datasetId, [root.cloud.versionId], purpose);
    const old = f.put(root, 'file_root'), first = f.put(a, 'file_a'), remaining = f.put(b, 'file_b');
    const heads = [a.cloud.versionId, b.cloud.versionId], original = structuredClone(f.documents.get(first.id));
    await f.api.trash(first, () => true, heads);
    assert.equal(f.files.get(first.id).trashed, true); assert.equal(f.files.get(first.id).appProperties.type, 'deleted-version');
    assert.deepEqual(f.documents.get(first.id), original); assert.equal(f.files.get(old.id).trashed, undefined);
    const listed = await f.api.list(), graph = versionGraph(listed), catalog = driveCatalog(listed).collections[0];
    assert.deepEqual(graph.heads.map(file => file.id), [remaining.id]); assert.deepEqual(catalog.history.map(file => file.id), [old.id]);
    assert.equal(graph.descendant(remaining.cloud.versionId, root.cloud.versionId), true); assert.equal((await f.api.removals()).length, 0);
    await f.api.assertAvailable(root.cloud.datasetId); await f.api.trash(first, () => true, heads); assert.equal(f.patches.length, 1);
    await assert.rejects(f.api.trash(remaining, () => true, heads), /已變更/); assert.equal(f.patches.length, 1);
    await assert.rejects(f.api.trash(remaining), /目前的雲端資料/); assert.equal(f.patches.length, 1);
  }
});

test('刪除待選擇內容前重查所有分支，新增、刪除或接續版本及斷線都拒絕舊確認', async () => {
  for (const change of ['added', 'removed', 'continued', 'disconnected']) {
    const f = memoryDrive(), root = await createDriveDocument(backup(), crypto.randomUUID(), [], 'backup');
    const a = await createDriveDocument(backup(), root.cloud.datasetId, [root.cloud.versionId], 'backup');
    const b = await createDriveDocument(backup(), root.cloud.datasetId, [root.cloud.versionId], 'backup');
    f.put(root, 'file_root'); const first = f.put(a, 'file_a'), second = f.put(b, 'file_b'), heads = [a.cloud.versionId, b.cloud.versionId];
    let current = true;
    if (change === 'added') f.put(await createDriveDocument(backup(), root.cloud.datasetId, [root.cloud.versionId], 'backup'), 'file_new');
    if (change === 'removed') await f.api.trash(second, () => true, heads);
    if (change === 'continued') f.put(await createDriveDocument(backup(), root.cloud.datasetId, [a.cloud.versionId], 'backup'), 'file_new');
    if (change === 'disconnected') {
      const request = f.transport.api;
      f.transport.api = async (...args) => {const result = await request(...args); if (args[0] === 'files') current = false; return result;};
    }
    const count = f.patches.length;
    await assert.rejects(f.api.trash(first, () => current, heads), change === 'disconnected' ? /刪除已停止/ : /已變更/);
    assert.equal(f.patches.length, count); assert.equal(f.files.get(first.id).trashed, undefined);
  }
});

test('另一裝置刪除分支後刷新舊分歧，保留各自本機內容，剩餘內容仍可確認套用', async () => {
  const {DriveEngine} = await import('../src/app/drive-engine.ts');
  const f = memoryDrive(), runtimes = new Map(), local = new Map([['a', backup()], ['b', backup()]]), revisions = new Map([['a', 'a'], ['b', 'b']]);
  const repository = {read: async key => structuredClone(runtimes.get(key) ?? {}), write: async (key, state) => {runtimes.set(key, structuredClone(state));}};
  const board = key => ({snapshot: async () => ({backup: structuredClone(local.get(key)), revision: revisions.get(key)}), apply: async (document, revision) => {assert.equal(revision, revisions.get(key)); local.set(key, structuredClone(document)); revisions.set(key, crypto.randomUUID());}});
  const a = new DriveEngine(f.api, repository, board('a'), 'a'), b = new DriveEngine(f.api, repository, board('b'), 'b');
  await a.start('full', [], 'sync'); runtimes.set('b', structuredClone(runtimes.get('a')));
  local.get('a').data.workspaces[0].name = '裝置 A 修改'; revisions.set('a', 'a2'); await a.synchronize('sync');
  local.get('b').data.workspaces[0].name = '裝置 B 修改'; revisions.set('b', 'b2'); await b.synchronize('sync'); await a.synchronize('sync');
  assert.equal(runtimes.get('a').conflict.length, 2); assert.equal(runtimes.get('b').conflict.length, 2);
  const heads = versionGraph(await f.api.list()).heads, kept = heads.find(file => file.cloud.versionId === runtimes.get('a').link.baseVersionId);
  const removed = heads.find(file => file.cloud.versionId === runtimes.get('b').link.baseVersionId);
  await f.api.trash(removed, () => true, heads.map(file => file.cloud.versionId)); const count = f.patches.length;
  await a.synchronize('sync'); assert.equal(runtimes.get('a').conflict, undefined); assert.equal(f.patches.length, count);
  await b.synchronize('sync'); assert.deepEqual(runtimes.get('b').conflict, [kept.cloud.versionId]); assert.equal(local.get('b').data.workspaces[0].name, '裝置 B 修改');
  delete runtimes.get('b').conflict;
  const before = (await f.api.list()).length; await b.synchronize('backup');
  assert.deepEqual(runtimes.get('b').conflict, [kept.cloud.versionId]); assert.equal((await f.api.list()).length, before);
  await b.resolve([kept.cloud.versionId], kept, revisions.get('b')); assert.equal(runtimes.get('b').conflict, undefined);
  assert.equal(local.get('b').data.workspaces[0].name, '裝置 A 修改'); assert.equal(f.files.get(removed.id).trashed, true);
});

test('另一裝置仍停在較早內容時，刪除中間備份後仍能接收最新資料且不產生同步衝突', async () => {
  const {DriveEngine} = await import('../src/app/drive-engine.ts');
  const f = memoryDrive(), runtimes = new Map(), local = new Map([['a', backup()], ['b', backup()]]), revisions = new Map([['a', 'a'], ['b', 'b']]);
  const repository = {read: async key => structuredClone(runtimes.get(key) ?? {}), write: async (key, state) => {runtimes.set(key, structuredClone(state));}};
  const board = key => ({snapshot: async () => ({backup: structuredClone(local.get(key)), revision: revisions.get(key)}), apply: async (document, revision) => {assert.equal(revision, revisions.get(key)); local.set(key, structuredClone(document)); revisions.set(key, crypto.randomUUID());}});
  const a = new DriveEngine(f.api, repository, board('a'), 'a'), b = new DriveEngine(f.api, repository, board('b'), 'b');
  await a.start('full', [], 'sync'); runtimes.set('b', structuredClone(runtimes.get('a')));
  const root = (await f.api.list())[0];
  local.get('a').data.workspaces[0].name = '第二份'; revisions.set('a', 'a2'); await a.synchronize('sync');
  const middle = versionGraph(await f.api.list()).heads[0];
  local.get('a').data.workspaces[0].name = '最新內容'; revisions.set('a', 'a3'); await a.synchronize('sync');
  await f.api.trash(middle); await f.api.trash(root);
  const before = (await f.api.list()).filter(file => !file.trashed).length;
  await b.synchronize('sync'); assert.equal(local.get('b').data.workspaces[0].name, '最新內容'); assert.equal(runtimes.get('b').conflict, undefined);
  await b.synchronize('sync'); assert.equal((await f.api.list()).filter(file => !file.trashed).length, before);
  local.get('b').preferences = {...DEFAULT_APPEARANCE, theme: 'dark', accent: '#3264ad'}; revisions.set('b', 'b2'); await b.synchronize('sync');
  await a.synchronize('sync'); assert.equal(local.get('a').preferences.accent, '#3264ad'); assert.equal(runtimes.get('a').conflict, undefined);
});
