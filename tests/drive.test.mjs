import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createBackup, readBackup} from '../src/app/backup-data.ts';
import {DEFAULT_APPEARANCE} from '../src/app/appearance-data.ts';
import {DEFAULT_GOOGLE, CALENDAR_SCOPE} from '../src/app/google-data.ts';
import {emptyWorkspace} from '../src/app/workspace-data.ts';
import {DEFAULT_DRIVE, DRIVE_SCOPE, DRIVE_SESSION_KEY, DRIVE_CONTROL_PREFIX, DriveCollectionDeleted, backupHash, checksum, createDriveDocument, readDriveDocument, readDriveFile, readDriveRuntime, readDriveSettings, syncHash, versionGraph, versionProperties} from '../src/app/drive-data.ts';
import {DriveApi} from '../src/app/drive-api.ts';
import {DriveEngine} from '../src/app/drive-engine.ts';
import {GoogleHttpError} from '../src/app/google-api.ts';
import {GOOGLE_SESSION_KEY, GoogleSessionBridge} from '../src/app/google-session.ts';
import {CalendarSyncCoordinator} from '../src/app/calendar-sync.ts';

const task = {id: 'task', title: '原始內容', description: '', projectId: '', categoryId: '', status: 'todo', priority: 'medium', startDate: '', startTime: '', dueDate: '', dueTime: '', subtasks: []};
const workspace = {...emptyWorkspace('workspace', '研究'), tasks: [task]};
const state = {version: 1, activeWorkspaceId: workspace.id, workspaces: [workspace]};
const backup = () => createBackup(state, 'full', [], DEFAULT_APPEARANCE);
function metadata(document, id = 'drive_' + crypto.randomUUID()) {
  return {id, name: 'Orbit.json', mimeType: 'application/json', createdTime: new Date().toISOString(), size: String(JSON.stringify(document).length), appProperties: versionProperties(document)};
}
function memory() {
  const values = new Map();
  return {values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key)};
}
function fixture() {
  let runtime = {}, local = backup(), revision = 'initial', uploads = 0;
  const documents = new Map();
  const repository = {read: async () => structuredClone(runtime), write: async (_, next) => {runtime = structuredClone(next);}};
  const api = {
    assertAvailable: async () => {},
    list: async () => [...documents].map(([id, d]) => readDriveFile(metadata(d, id))),
    generateId: async () => 'drive_' + crypto.randomUUID(),
    read: async file => structuredClone(documents.get(file.id)),
    save: async (document, id) => {uploads++; documents.set(id, structuredClone(document)); return readDriveFile(metadata(document, id));}
  };
  const board = {
    snapshot: async (kind, ids) => ({backup: createBackup(local.data, kind, ids, local.preferences ?? DEFAULT_APPEARANCE, local.google ?? DEFAULT_GOOGLE, false, local.reminders, local.drive), revision}),
    apply: async (document, expected) => {if (expected !== revision) throw new Error('本機已更新'); local = readBackup(document); revision = crypto.randomUUID();}
  };
  const engine = new DriveEngine(api, repository, board, 'account');
  return {engine, api, repository, board, documents, runtime: () => runtime, local: () => local, revision: () => revision, uploads: () => uploads, edit(title) {local.data.workspaces[0].tasks[0].title = title; revision = crypto.randomUUID();}, async branch(title) {const b = structuredClone(local); b.data.workspaces[0].tasks[0].title = title; const link = runtime.link; const d = await createDriveDocument(b, link.datasetId, [link.baseVersionId], 'sync'); documents.set('cloud_' + d.cloud.versionId, d); return d;}};
}

test('工作空間縮放模式隨 Drive 保存並改變同步版本，舊檔案的校驗保持相容', async () => {
  const original = backup();
  for (const formatVersion of [1, 2]) {
    const cloud = {formatVersion, datasetId: crypto.randomUUID(), versionId: crypto.randomUUID(), parents: [], purpose: 'sync', fileHash: await checksum(original), syncHash: await syncHash(original, formatVersion)};
    const legacy = await readDriveDocument({...original, cloud});
    assert.equal(Object.hasOwn(legacy.data.workspaces[0], 'headerCompact'), false);
    for (const headerCompact of [true, false]) {
      const changed = structuredClone(original); changed.data.workspaces[0].headerCompact = headerCompact;
      assert.notEqual(await backupHash(changed), await backupHash(original));
      assert.notEqual(await syncHash(changed, formatVersion), cloud.syncHash);
      const document = await createDriveDocument(changed);
      assert.equal((await readDriveDocument(document)).data.workspaces[0].headerCompact, headerCompact);
    }
  }
});

test('既有沒有封存旗標的 Drive 校驗仍相容，專案封存及分類順序會改變同步版本', async () => {
  const old = backup();
  old.appVersion = '1.5.0';
  old.data.workspaces[0].projects = [{id: 'legacy', name: '既有專案'}];
  const cloud = {formatVersion: 1, datasetId: crypto.randomUUID(), versionId: crypto.randomUUID(), parents: [], purpose: 'manual', fileHash: await checksum(old), syncHash: await syncHash(old, 1)};
  const decoded = await readDriveDocument({...old, cloud});
  assert.deepEqual(decoded.data.workspaces[0].projects, old.data.workspaces[0].projects);
  const archived = structuredClone(old); archived.data.workspaces[0].projects[0].archived = true;
  assert.notEqual(await syncHash(archived, 1), cloud.syncHash);
  const document = await createDriveDocument(archived);
  assert.equal((await readDriveDocument(document)).data.workspaces[0].projects[0].archived, true);
  archived.data.workspaces[0].categories = [{id: 'a', name: '分類一', color: 'green'}, {id: 'b', name: '分類二', color: 'blue'}];
  const before = await syncHash(archived, 1);
  archived.data.workspaces[0].categories.reverse();
  assert.notEqual(await syncHash(archived, 1), before);
});

test('Drive 偏好可攜，憑證和未知欄位不會進入完整備份，舊格式仍可讀取', async () => {
  const settings = {...DEFAULT_DRIVE, accountId: 'account', email: 'a@example.com', mode: 'sync', workspaceIds: [], token: 'discard', client_secret: 'discard'};
  const full = readBackup({...backup(), drive: settings, token: 'discard'});
  assert.equal(full.formatVersion, 5); assert.equal(full.drive.mode, 'sync');
  assert.equal(full.drive.token, undefined); assert.equal(full.drive.client_secret, undefined); assert.equal(full.token, undefined);
  for (const formatVersion of [1, 2, 3, 4]) assert.equal(readBackup({...full, formatVersion}).drive, undefined);
  assert.equal(readDriveSettings({...settings, kind: 'workspaces', workspaceIds: ['missing']}, ['workspace']), null);
  assert.equal(readDriveSettings({...settings, debounceSeconds: 0}, ['workspace']), null);
  const document = await createDriveDocument({...full, google: {...DEFAULT_GOOGLE, token: 'discard'}});
  assert.equal(JSON.stringify(document).includes('discard'), false);
});

test('待上傳狀態讀取校驗 payload、基準、範圍與識別碼，只保留公開執行欄位', async () => {
  const doc = await createDriveDocument(backup());
  const value = {link: {datasetId: doc.cloud.datasetId, kind: 'full', workspaceIds: [], baseVersionId: '', baseHash: '', secret: 'discard'}, pending: {fileId: '', document: doc}, token: 'discard'};
  const clean = await readDriveRuntime(value); assert.equal(clean.token, undefined); assert.equal(clean.link.secret, undefined);
  await assert.rejects(readDriveRuntime({...value, pending: {...value.pending, fileId: '../bad'}}), /識別碼/);
  await assert.rejects(readDriveRuntime({...value, link: {...value.link, baseHash: 'bad'}}), /基準/);
  for (const baseBackupHash of ['bad', '', null]) await assert.rejects(readDriveRuntime({...value, link: {...value.link, baseBackupHash}}), /基準/);
  const complete = await readDriveRuntime({...value, link: {...value.link, baseBackupHash: await backupHash(doc)}});
  assert.equal(complete.link.baseBackupHash, await backupHash(doc));
  await assert.rejects(readDriveRuntime({...value, link: {...value.link, kind: 'workspaces'}}), /基準/);
  const corrupt = structuredClone(value); corrupt.pending.document.data.workspaces[0].tasks[0].title = '修改'; await assert.rejects(readDriveRuntime(corrupt), /校驗/);
});

test('選定工作空間集合只上傳選定資料，範圍外新增任務不建立新版本', async () => {
  const f = fixture(); f.local().data.workspaces.push(emptyWorkspace('outside', '其他'));
  await f.engine.start('workspaces', ['workspace'], 'sync'); assert.equal(f.runtime().link.kind, 'workspaces'); assert.deepEqual([...f.documents.values()][0].data.workspaces.map(w => w.id), ['workspace']);
  f.local().data.workspaces[1].tasks.push({...task, id: 'outside-task'}); await f.engine.synchronize('sync'); assert.equal(f.uploads(), 1);
  f.edit('選定空間修改'); await f.engine.synchronize('sync'); assert.equal(f.uploads(), 2);
});

test('舊版本同步摘要保留原有計算，版本校驗仍偵測任務竄改', async () => {
  const b = backup();
  b.google.sources = [{id: 'source', accountId: 'account', calendarId: 'calendar', name: '來源', color: '#31584b', visible: true, workspaceIds: ['workspace']}];
  const original = await syncHash(b, 1), changed = structuredClone(b);
  changed.preferences.accent = '#123456'; changed.exportedAt = '2026-10-10T00:00:00Z';
  changed.google.clientId = '123-another.apps.googleusercontent.com'; changed.google.sources[0].id = 'other'; changed.google.sources[0].visible = false;
  assert.equal(await syncHash(changed, 1), original);
  changed.data.workspaces[0].tasks[0].title = '修改'; assert.notEqual(await syncHash(changed, 1), original);
  const doc = await createDriveDocument(b), corrupt = structuredClone(doc);
  corrupt.data.workspaces[0].tasks[0].title = '竄改'; await assert.rejects(readDriveDocument(corrupt), /校驗/);
  assert.equal((await readDriveDocument(doc)).cloud.fileHash, await checksum(readBackup(doc)));
});

test('完整備份摘要包含外觀、提醒及公開 Google／Drive 設定，忽略匯出時間、版本與分頁選擇', async () => {
  const b = backup();
  b.data.workspaces.push(emptyWorkspace('second', '其他工作'));
  b.google.sources = [{id: 'source', accountId: 'account', calendarId: 'calendar', name: '月曆', color: '#31584b', visible: true, workspaceIds: ['workspace']}];
  const original = await backupHash(b), work = await syncHash(b, 1);
  const changed = structuredClone(b); changed.exportedAt = '2026-10-10T00:00:00Z'; changed.appVersion = '1.7.0'; changed.data.activeWorkspaceId = 'second';
  assert.equal(await backupHash(changed), original);
  for (const modify of [
    b => {b.preferences.accent = '#123456';}, b => {b.preferences.theme = 'dark';}, b => {b.preferences.textSize = 'compact';},
    b => {b.reminders.dueSoonDays = 7;}, b => {b.reminders.popupEnabled = false;}, b => {b.reminders.leadMinutes = 60;},
    b => {b.reminders.allDayTime = '08:00';}, b => {b.reminders.includeGoogle = false;},
    b => {b.google.clientId = '123-other.apps.googleusercontent.com';}, b => {b.google.refreshMinutes = 15;},
    b => {b.google.sources[0].name = '自訂月曆';}, b => {b.google.sources[0].color = '#3264ad';}, b => {b.google.sources[0].visible = false;},
    b => {b.drive.debounceSeconds = 30;}, b => {b.drive.pollMinutes = 15;}
  ]) {
    const next = structuredClone(b); modify(next);
    assert.notEqual(await backupHash(next), original);
    assert.equal(await syncHash(next, 1), work);
  }
});

test('全部資料手動備份與自動備份保存主題色及提醒，只有設定改動也建立新版本且不重複上傳', async () => {
  const f = fixture();
  await f.engine.start('full', [], 'backup');
  assert.equal(f.uploads(), 1);
  f.local().preferences = {textSize: 'extra-small', theme: 'dark', accent: '#3264ad'};
  await f.engine.synchronize('backup'); assert.equal(f.uploads(), 2);
  let latest = [...f.documents.values()].at(-1);
  assert.deepEqual((await readDriveDocument(latest)).preferences, f.local().preferences);
  assert.equal(f.runtime().link.baseBackupHash, await backupHash(latest));
  await f.engine.synchronize('backup'); assert.equal(f.uploads(), 2);
  f.local().reminders.leadMinutes = 60;
  f.local().google.refreshMinutes = 15;
  f.local().drive.debounceSeconds = 30;
  await f.engine.synchronize('backup'); assert.equal(f.uploads(), 3);
  latest = [...f.documents.values()].at(-1);
  assert.equal(latest.reminders.leadMinutes, 60); assert.equal(latest.google.refreshMinutes, 15); assert.equal(latest.drive.debounceSeconds, 30);
  await f.repository.write('account', await readDriveRuntime(f.runtime()));
  await f.engine.synchronize('backup'); assert.equal(f.uploads(), 3);
  f.local().preferences.accent = '#7951b0';
  await f.engine.manual('full', []);
  assert.equal([...f.documents.values()].at(-1).preferences.accent, '#7951b0');
});

test('選定工作空間自動備份不因整體設定及範圍外任務變動建立版本，但保存月曆來源顏色', async () => {
  const f = fixture(); f.local().data.workspaces.push(emptyWorkspace('outside', '其他'));
  f.local().google.sources = [{id: 'source', accountId: 'account', calendarId: 'calendar', name: '月曆', color: '#31584b', visible: true, workspaceIds: ['workspace']}];
  await f.engine.start('workspaces', ['workspace'], 'backup');
  f.local().preferences.accent = '#123456'; f.local().reminders.leadMinutes = 60; f.local().google.refreshMinutes = 15; f.local().drive.debounceSeconds = 30;
  f.local().data.activeWorkspaceId = 'outside'; f.local().data.workspaces[1].tasks.push({...task, id: 'outside-task'});
  await f.engine.synchronize('backup'); assert.equal(f.uploads(), 1);
  f.local().google.sources[0].color = '#3264ad';
  await f.engine.synchronize('backup'); assert.equal(f.uploads(), 2);
  const saved = [...f.documents.values()].at(-1);
  assert.equal(saved.preferences, undefined); assert.equal(saved.reminders, undefined); assert.equal(saved.drive, undefined);
  assert.equal(saved.calendarSources[0].color, '#3264ad');
  await f.engine.synchronize('backup'); assert.equal(f.uploads(), 2);
});

test('舊備份基準升級只追加一份版本，接續或拉取雲端後可依完整設定判斷備份改動', async () => {
  const f = fixture(); await f.engine.start('full', [], 'backup');
  const legacy = structuredClone(f.runtime()); delete legacy.link.baseBackupHash;
  await f.repository.write('account', await readDriveRuntime(legacy));
  await f.engine.synchronize('backup'); assert.equal(f.uploads(), 2);
  await f.engine.synchronize('backup'); assert.equal(f.uploads(), 2);
  const remoteBackup = structuredClone(f.local()); remoteBackup.preferences.accent = '#3264ad';
  const root = f.runtime().link;
  const remote = await createDriveDocument(remoteBackup, root.datasetId, [root.baseVersionId], 'backup');
  f.documents.set('cloud_settings', remote);
  // A remote settings change also applies when task content is identical.
  await f.engine.synchronize('sync');
  assert.equal(f.runtime().link.baseBackupHash, await backupHash(remote));
  assert.equal(f.local().preferences.accent, remote.preferences.accent);
  await f.engine.synchronize('backup'); assert.equal(f.uploads(), 2);
  const file = readDriveFile(metadata([...f.documents.values()].at(-1), [...f.documents.keys()].at(-1)));
  await f.engine.join(file, f.revision());
  assert.equal(f.runtime().link.baseBackupHash, await backupHash([...f.documents.values()].at(-1)));
});

test('設定備份離線待上傳與重試保存原快照，之後再補上新的主題設定', async () => {
  const f = fixture(); await f.engine.start('full', [], 'backup');
  const save = f.api.save;
  f.local().preferences.accent = '#3264ad'; f.api.save = async () => {throw new Error('offline');};
  await assert.rejects(f.engine.synchronize('backup'), /offline/);
  assert.equal(f.runtime().pending.document.preferences.accent, '#3264ad');
  f.local().preferences.accent = '#7951b0'; f.api.save = save;
  await f.engine.synchronize('backup');
  assert.deepEqual([...f.documents.values()].map(document => document.preferences.accent), ['#31584b', '#3264ad', '#7951b0']);
  assert.equal(f.runtime().pending, undefined);
  await f.engine.synchronize('backup'); assert.equal(f.uploads(), 3);
});

test('版本圖辨識分支與合併，拒絕循環、重複版本相異內容，屬性不超過 Drive 限制', async () => {
  const root = await createDriveDocument(backup(), crypto.randomUUID(), [], 'sync');
  const a = await createDriveDocument(backup(), root.cloud.datasetId, [root.cloud.versionId], 'sync');
  const b = await createDriveDocument(backup(), root.cloud.datasetId, [root.cloud.versionId], 'sync');
  let files = [root, a, b].map(d => readDriveFile(metadata(d)));
  let graph = versionGraph(files); assert.equal(graph.heads.length, 2); assert.equal(graph.descendant(a.cloud.versionId, root.cloud.versionId), true);
  const merge = await createDriveDocument(backup(), root.cloud.datasetId, [a.cloud.versionId, b.cloud.versionId], 'sync');
  files.push(readDriveFile(metadata(merge))); assert.equal(versionGraph(files).heads.length, 1);
  assert.throws(() => versionGraph([...files, {...files[0], cloud: {...files[0].cloud, syncHash: 'f'.repeat(64)}}]), /矛盾/);
  const cycle = structuredClone(files); cycle[0].cloud.parents = [merge.cloud.versionId]; assert.throws(() => versionGraph(cycle), /循環/);
  const props = versionProperties({...root, cloud: {...root.cloud, parents: Array.from({length: 20}, () => crypto.randomUUID())}});
  assert.ok(Object.keys(props).length <= 30); for (const [key, value] of Object.entries(props)) assert.ok(new TextEncoder().encode(key + value).length <= 124);
});

test('自動同步追蹤本機任務與偏好修改，每次相同內容不重複上傳', async () => {
  const f = fixture(); await f.engine.start('full', [], 'sync');
  assert.equal(f.uploads(), 1); await f.engine.synchronize('sync'); assert.equal(f.uploads(), 1);
  f.edit('本機修改'); await f.engine.synchronize('sync'); assert.equal(f.uploads(), 2);
  f.local().preferences.theme = 'dark'; await f.engine.synchronize('sync'); assert.equal(f.uploads(), 3);
  await f.engine.synchronize('sync'); assert.equal(f.uploads(), 3);
  f.local().data.workspaces[0].headerCompact = true; await f.engine.synchronize('sync'); assert.equal(f.uploads(), 4);
  assert.equal([...f.documents.values()].at(-1).data.workspaces[0].headerCompact, true);
  await f.engine.synchronize('sync'); assert.equal(f.uploads(), 4);
  assert.equal(f.runtime().conflict, undefined); assert.equal(f.documents.size, 4);
});

test('自動備份集合的雲端基準已刪除且沒有標記時，不重新建立舊集合或丟失本機修改', async () => {
  const f = fixture(); await f.engine.start('full', [], 'backup'); const uploads = f.uploads();
  f.documents.clear(); f.edit('刪除雲端之後的本機修改');
  await assert.rejects(f.engine.synchronize('backup'), DriveCollectionDeleted);
  assert.equal(f.uploads(), uploads); assert.equal(f.runtime().pending, undefined); assert.equal(f.local().data.workspaces[0].tasks[0].title, '刪除雲端之後的本機修改');
});

test('只有雲端變更時拉取後不回傳重複版本，備份模式不套用雲端', async () => {
  const f = fixture(); await f.engine.start('full', [], 'sync');
  const remote = await f.branch('雲端更新');
  remote.data.workspaces[0].headerCompact = true;
  const compactRemote = await createDriveDocument(remote, remote.cloud.datasetId, remote.cloud.parents, 'sync');
  f.documents.delete('cloud_' + remote.cloud.versionId); f.documents.set('cloud_' + compactRemote.cloud.versionId, compactRemote);
  await f.engine.synchronize('backup'); assert.equal(f.local().data.workspaces[0].tasks[0].title, '原始內容');
  await f.engine.synchronize('sync'); assert.equal(f.local().data.workspaces[0].tasks[0].title, '雲端更新');
  assert.equal(f.local().data.workspaces[0].headerCompact, true);
  assert.equal(f.runtime().link.baseVersionId, compactRemote.cloud.versionId); await f.engine.synchronize('sync'); assert.equal(f.uploads(), 1);
});

test('兩端修改保存本機分支並暫停，使用本機內容產生合併版本，歷史仍保留', async () => {
  const f = fixture(); await f.engine.start('full', [], 'sync'); await f.branch('雲端內容'); f.edit('本機內容');
  await f.engine.synchronize('sync'); assert.equal(f.runtime().conflict.length, 2); assert.equal(f.documents.size, 3);
  assert.equal(f.local().data.workspaces[0].tasks[0].title, '本機內容');
  await f.engine.synchronize('sync'); assert.equal(f.uploads(), 2);
  const reviewed = f.runtime().conflict; await f.engine.resolve(reviewed);
  assert.equal(f.runtime().conflict, undefined); assert.equal(f.documents.size, 4);
  const graph = versionGraph(await f.api.list()); assert.equal(graph.heads.length, 1); assert.deepEqual(new Set(graph.heads[0].cloud.parents), new Set(reviewed));
});

test('選擇雲端前保存新的本機草稿；確認期間本機或雲端變更會拒絕覆蓋', async () => {
  const f = fixture(); await f.engine.start('full', [], 'sync'); const remote = await f.branch('雲端内容'); f.edit('本機內容');
  await f.engine.synchronize('sync'); const heads = [...f.runtime().conflict], choice = (await f.api.list()).find(file => file.cloud.versionId === remote.cloud.versionId);
  const old = f.revision(); f.edit('確認後修改'); await assert.rejects(f.engine.resolve(heads, choice, old), /本機資料已更新/);
  await f.engine.resolve(heads, choice, f.revision()); assert.equal(f.local().data.workspaces[0].tasks[0].title, '雲端内容');
  assert.ok([...f.documents.values()].some(d => d.data.workspaces[0].tasks[0].title === '確認後修改')); assert.equal(f.runtime().conflict, undefined);
  const other = fixture(); await other.engine.start('full', [], 'sync'); await other.branch('A'); other.edit('B'); await other.engine.synchronize('sync');
  const reviewed = [...other.runtime().conflict]; await other.branch('C'); await assert.rejects(other.engine.resolve(reviewed), /雲端版本已變更/);
});

test('上傳失敗、回應遺失後的重试沿用同一檔案 ID，排隊期間新修改仍会接續保存', async () => {
  const f = fixture(), save = f.api.save; let first = true;
  f.api.save = async (d, id) => {await save(d, id); if (first) {first = false; throw new Error('回應遺失');} return readDriveFile(metadata(d, id));};
  await assert.rejects(f.engine.start('full', [], 'sync'), /回應遺失/);
  const id = f.runtime().pending.fileId; f.edit('新的內容');
  await f.engine.flush(); assert.equal(f.documents.size, 1); assert.equal([...f.documents.keys()][0], id); assert.equal(f.runtime().pending, undefined);
  await f.engine.synchronize('sync'); assert.equal(f.documents.size, 2); assert.equal(f.local().data.workspaces[0].tasks[0].title, '新的內容');
});

test('帳號或資料世代變更後的延遲回覆不更新基準、不清除待上傳版本', async () => {
  const f = fixture(); let active = true, finish;
  f.api.save = () => new Promise(resolve => {finish = resolve;});
  const engine = new DriveEngine(f.api, f.repository, f.board, 'account', () => active);
  const operation = engine.start('full', [], 'sync');
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  active = false; finish({}); await assert.rejects(operation, /帳號、資料或頁面/);
  assert.ok(f.runtime().pending); assert.equal(f.runtime().link.baseVersionId, '');
});

test('接續集合只允許目前唯一分支，還原期間本機更新會保留原有資料', async () => {
  const source = fixture(); await source.engine.start('full', [], 'sync'); source.edit('來源'); await source.engine.synchronize('sync');
  const files = await source.api.list(), root = files.find(f => !f.cloud.parents.length), latest = versionGraph(files).heads[0];
  const target = fixture(); const engine = new DriveEngine(source.api, target.repository, target.board, 'target');
  await assert.rejects(engine.join(root, target.revision()), /雲端版本已更新/);
  const old = target.revision(); target.edit('保留修改'); await assert.rejects(engine.join(latest, old), /本機已更新/);
  await engine.join(latest, target.revision()); assert.equal(target.local().data.workspaces[0].tasks[0].title, '來源'); assert.equal(target.runtime().link.datasetId, latest.cloud.datasetId);
});

test('Drive multipart 上傳帶私有索引；已完成上傳的重試只校驗而不重建', async () => {
  const doc = await createDriveDocument(backup()), id = 'generated_file'; let uploaded = 0, exists = false;
  const transport = {
    api: async (path, params) => {
      if (params?.q?.includes("value='deleted-collection'")) return {files: []};
      if (path === 'files/' + id) {if (!exists) throw new GoogleHttpError(404); return params.alt === 'media' ? doc : metadata(doc, id);}
      if (path === 'files') return {files: [{id: 'folder_id'}]};
      throw new Error('unexpected request');
    },
    upload: async (url, options) => {uploaded++; assert.match(url, /uploadType=multipart/); assert.match(options.headers['Content-Type'], /multipart\/related/); assert.ok(options.body.includes('folder_id')); assert.ok(options.body.includes(doc.cloud.versionId)); exists = true; return Response.json(metadata(doc, id));}
  };
  const api = new DriveApi(transport); await api.save(doc, id); await api.save(doc, id); assert.equal(uploaded, 1);
  const corrupt = {...doc, data: {...doc.data, workspaces: []}}; transport.api = async () => corrupt; await assert.rejects(api.read(readDriveFile(metadata(doc, id))));
});

test('中斷留下的空檔只補完同一個待上傳版本；相同內容但不同版本識別仍拒絕覆寫', async () => {
  const doc = await createDriveDocument(backup()), id = 'empty_file'; let patched = 0;
  const transport = {api: async () => ({...metadata(doc, id), size: '0'}), upload: async (url, options) => {patched++; assert.match(url, /empty_file.*uploadType=media/); assert.equal(options.method, 'PATCH'); assert.deepEqual(JSON.parse(options.body), doc); return Response.json(metadata(doc, id));}};
  const request = transport.api; transport.api = async (path, params) => params?.q?.includes("value='deleted-collection'") ? {files: []} : request(path, params);
  await new DriveApi(transport).save(doc, id); assert.equal(patched, 1);
  const other = await createDriveDocument(readBackup(doc));
  assert.equal(other.cloud.fileHash, doc.cloud.fileHash); assert.notEqual(other.cloud.versionId, doc.cloud.versionId);
  await assert.rejects(new DriveApi(transport).save(other, id), /上傳結果不符/); assert.equal(patched, 1);
});

test('選擇雲端時若保存本機新分支期間另一裝置又修改，保留本機且要求重新預覽', async () => {
  const f = fixture(); await f.engine.start('full', [], 'sync'); const remote = await f.branch('原先雲端'); f.edit('原先本機'); await f.engine.synchronize('sync');
  const reviewed = [...f.runtime().conflict], choice = (await f.api.list()).find(file => file.cloud.versionId === remote.cloud.versionId);
  f.edit('新本機草稿'); const save = f.api.save;
  f.api.save = async (d, id) => {const result = await save(d, id); const newRemote = await createDriveDocument(backup(), remote.cloud.datasetId, [remote.cloud.versionId], 'sync'); f.documents.set('remote_' + newRemote.cloud.versionId, newRemote); return result;};
  await assert.rejects(f.engine.resolve(reviewed, choice, f.revision()), /雲端已更新/);
  assert.equal(f.local().data.workspaces[0].tasks[0].title, '新本機草稿'); assert.ok([...f.documents.values()].some(d => d.data.workspaces[0].tasks[0].title === '新本機草稿')); assert.ok(f.runtime().conflict);
});

test('Drive 409 completed retry 校驗內容、403 不寫入；垃圾桶操作禁止單獨刪除目前同步資料', async () => {
  const doc = await createDriveDocument(backup()); let reads = 0, patched = false;
  const api = new DriveApi({api: async (path, params, options) => {
    if (params?.q?.includes("value='deleted-collection'")) return {files: []};
    if (path === 'files') return {files: [{id: 'folder_id'}]};
    if (params.alt === 'media') return doc;
    if (options?.method === 'PATCH') {patched = true; return {id: 'file_id', trashed: true};}
    if (++reads === 1) throw new GoogleHttpError(404);
    return metadata(doc, 'file_id');
  }, upload: async () => {throw new GoogleHttpError(409);}});
  await api.save(doc, 'file_id'); await api.trash(readDriveFile(metadata(doc, 'file_id'))); assert.equal(patched, true);
  const sync = await createDriveDocument(backup(), crypto.randomUUID(), [], 'sync');
  const readonly = new DriveApi({api: async (path, params) => path === 'files' ? {files: params.q.includes("value='version'") ? [metadata(sync, 'sync_id')] : []} : metadata(sync, 'sync_id'), upload: async () => {throw new Error('unused');}});
  await assert.rejects(readonly.trash(readDriveFile(metadata(sync, 'sync_id'))), /目前的雲端資料/);
});

test('Drive 清單分頁不完整或重複游標拒絕同步；內容與索引不符拒絕還原', async () => {
  const doc = await createDriveDocument(backup()), file = readDriveFile(metadata(doc));
  const repeated = new DriveApi({api: async () => ({files: [], nextPageToken: 'same'}), upload: async () => {}});
  await assert.rejects(repeated.list(), /分頁異常/);
  const incomplete = new DriveApi({api: async () => ({files: [], incompleteSearch: true}), upload: async () => {}}); await assert.rejects(incomplete.list(), /未完整取得/);
  const wrong = new DriveApi({api: async () => doc, upload: async () => {}}); await assert.rejects(wrong.read({...file, cloud: {...file.cloud, versionId: crypto.randomUUID()}}), /索引不符/);
});

test('大於 5 MB 使用 resumable，非 Google 上傳網址不接收憑證', async () => {
  const b = backup();
  b.data.workspaces[0].tasks = Array.from({length: 90}, (_, i) => ({...task, id: 'task-' + i, description: '字'.repeat(21000)}));
  const doc = await createDriveDocument(b), urls = [];
  const transport = {api: async (path, params) => {if (params?.q?.includes("value='deleted-collection'")) return {files: []}; if (path === 'files') return {files: [{id: 'folder_id'}]}; throw new GoogleHttpError(404);}, upload: async (url, options) => {urls.push(url); return options.method === 'POST' ? new Response(null, {headers: {Location: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=one'}}) : Response.json(metadata(doc, 'big_file'));}};
  await new DriveApi(transport).save(doc, 'big_file'); assert.equal(urls.length, 2); assert.match(urls[0], /resumable/);
  transport.upload = async () => new Response(null, {headers: {Location: 'https://example.com/steal'}}); await assert.rejects(new DriveApi(transport).save(doc, 'big_file'), /位址不合法/);
});

test('Drive 與 Calendar 憑證命名空間獨立，解除 Drive 不會使月曆憑證失效', () => {
  const local = memory(), sessions = memory(), context = {clientId: '123-example.apps.googleusercontent.com', generation: 'generation', accountId: 'account'};
  function bridge(options) {
    let current;
    const b = new GoogleSessionBridge(sessions, local, undefined, {current: () => current, pendingNonce: () => '', busy: () => false, receive: s => {current = s;}, clear: () => {current = undefined;}, warning: () => {}}, options);
    b.activate(context); return {b, set: value => {current = value; b.remember(value);}, get: () => current};
  }
  const calendar = bridge(), drive = bridge({scope: DRIVE_SCOPE, storageKey: DRIVE_SESSION_KEY, controlPrefix: DRIVE_CONTROL_PREFIX});
  const credential = (scope, nonce) => ({version: 1, id: crypto.randomUUID(), clientId: context.clientId, generation: context.generation, account: {id: 'account', email: 'a@example.com'}, scope, token: 'token-' + scope.split('/').at(-1), nonce, expiresAt: Date.now() + 3600000});
  calendar.set(credential(CALENDAR_SCOPE, calendar.b.currentNonce())); drive.set(credential(DRIVE_SCOPE, drive.b.currentNonce()));
  drive.b.invalidate('Drive disconnect'); calendar.b.verify(); assert.ok(calendar.get()); assert.ok(sessions.getItem(GOOGLE_SESSION_KEY)); assert.equal(sessions.getItem(DRIVE_SESSION_KEY), null);
  assert.equal([...local.values.values()].join('').includes('token'), false); calendar.b.close(); drive.b.close();
});

test('Drive 同步與 Calendar 使用不同鎖，同源 Drive 分頁不能重複執行且狀態一致', async () => {
  const local = memory(), atomic = async callback => callback(), ns = {storagePrefix: 'drive:', lockPrefix: 'drive-run:', label: 'Drive'};
  let firstKeys = [], secondKeys = [], finish;
  const first = new CalendarSyncCoordinator(local, atomic, keys => {firstKeys = keys;}, undefined, undefined, 10000, ns);
  const second = new CalendarSyncCoordinator(local, atomic, keys => {secondKeys = keys;}, undefined, undefined, 10000, ns);
  const calendar = new CalendarSyncCoordinator(local, atomic, () => {});
  try {
    first.activate('account'); second.activate('account'); calendar.activate('account');
    const running = first.run('account', ['drive'], () => new Promise(resolve => {finish = resolve;}));
    while (!finish) await new Promise(resolve => setImmediate(resolve));
    second.refresh(); assert.deepEqual(firstKeys, ['drive']); assert.deepEqual(secondKeys, ['drive']);
    assert.equal(await second.run('account', ['drive'], async () => {throw new Error('duplicate');}), false);
    assert.equal(await calendar.run('account', ['calendar'], async () => {}), true);
    finish(); await running; second.refresh(); assert.deepEqual(secondKeys, []);
  } finally {first.close(); second.close(); calendar.close();}
});

test('新版同步摘要包含外觀、提醒與月曆顯示，忽略授權連線、裝置儲存頻率及分頁選擇', async () => {
  const b = backup(); b.data.workspaces.push(emptyWorkspace('second', '其他工作'));
  b.google.sources = [{id: 'source', accountId: 'account', calendarId: 'calendar', name: '行事曆', color: '#31584b', visible: true, workspaceIds: ['workspace', 'second']}];
  const original = await syncHash(b);
  for (const modify of [
    b => {b.preferences.theme = 'dark';}, b => {b.preferences.accent = '#3264ad';}, b => {b.preferences.textSize = 'compact';},
    b => {b.reminders.dueSoonDays = 7;}, b => {b.reminders.leadMinutes = 60;}, b => {b.reminders.popupEnabled = false;},
    b => {b.reminders.includeGoogle = false;}, b => {b.reminders.allDayTime = '08:30';}, b => {b.google.refreshMinutes = 1;},
    b => {b.google.sources[0].name = '研究行事曆';}, b => {b.google.sources[0].color = '#7951b0';}, b => {b.google.sources[0].visible = false;}
  ]) {const changed = structuredClone(b); modify(changed); assert.notEqual(await syncHash(changed), original);}
  const local = structuredClone(b);
  local.google.clientId = '456-local.apps.googleusercontent.com'; local.google.accountId = 'local'; local.google.email = 'local@example.com';
  local.drive = {...local.drive, accountId: 'drive', email: 'drive@example.com', mode: 'off', debounceSeconds: 60, pollMinutes: 15};
  local.google.sources[0].id = 'another-source'; local.google.sources[0].workspaceIds.reverse();
  local.exportedAt = '2026-10-10T00:00:00Z'; local.appVersion = 'later'; local.data.activeWorkspaceId = 'second';
  assert.equal(await syncHash(local), original);
  const selected = createBackup(b.data, 'workspaces', ['workspace'], b.preferences, b.google, false, b.reminders, b.drive);
  const globals = structuredClone(selected); globals.preferences = {...b.preferences, theme: 'dark'}; globals.reminders = {...b.reminders, leadMinutes: 60}; globals.google = {...b.google, sources: []};
  assert.equal(await syncHash(selected), await syncHash(globals));
});

test('新版雲端摘要可辨識格式且維持索引上限，舊檔原校驗可讀取，新檔設定竄改會被拒絕', async () => {
  const b = backup(), old = {...b, cloud: {formatVersion: 1, datasetId: crypto.randomUUID(), versionId: crypto.randomUUID(), parents: [], purpose: 'sync', fileHash: await checksum(b), syncHash: await syncHash(b, 1)}};
  assert.deepEqual(await readDriveDocument(old), old); assert.deepEqual(readDriveFile(metadata(old)).cloud, old.cloud);
  const document = await createDriveDocument(b, old.cloud.datasetId, Array.from({length: 20}, () => crypto.randomUUID()), 'sync');
  const properties = versionProperties(document); assert.equal(Object.keys(properties).length, 30); assert.match(properties.syncHash, /^v2:/);
  assert.deepEqual(readDriveFile(metadata(document)).cloud, document.cloud); assert.deepEqual(await readDriveDocument(document), document);
  const corrupted = structuredClone(document); corrupted.preferences.accent = '#3264ad'; corrupted.cloud.fileHash = await checksum(readBackup(corrupted));
  await assert.rejects(readDriveDocument(corrupted), /校驗/);
  const unknown = metadata(document); unknown.appProperties.syncHash = 'v3:' + document.cloud.syncHash;
  assert.throws(() => readDriveFile(unknown));
});

test('舊同步基準升級一次便追蹤設定，舊內容與校驗不改寫，偏好修改追加相容的新版本', async () => {
  const f = fixture(), b = backup();
  const old = {...b, cloud: {formatVersion: 1, datasetId: crypto.randomUUID(), versionId: crypto.randomUUID(), parents: [], purpose: 'sync', fileHash: await checksum(b), syncHash: await syncHash(b, 1)}};
  f.documents.set('legacy_drive', structuredClone(old)); await f.engine.join(readDriveFile(metadata(old, 'legacy_drive')), f.revision());
  const runtime = structuredClone(f.runtime()); delete runtime.link.baseHashVersion; runtime.link.baseHash = old.cloud.syncHash;
  await f.repository.write('account', await readDriveRuntime(runtime)); let reads = 0; const read = f.api.read;
  f.api.read = async file => {reads++; return read(file);};
  await f.engine.synchronize('sync'); assert.equal(f.runtime().link.baseHashVersion, 2); assert.equal(f.uploads(), 0); assert.equal(reads, 1);
  await f.engine.synchronize('sync'); assert.equal(reads, 1); assert.equal(f.uploads(), 0);
  f.local().preferences.accent = '#3264ad'; await f.engine.synchronize('sync'); assert.equal(f.uploads(), 1);
  const latest = [...f.documents.values()].at(-1); assert.equal(latest.cloud.formatVersion, 2); assert.deepEqual(latest.cloud.parents, [old.cloud.versionId]);
  assert.deepEqual(f.documents.get('legacy_drive'), old); assert.deepEqual(await readDriveDocument(old), old);
  assert.equal((await readDriveRuntime(f.runtime())).link.baseHashVersion, 2);
});

test('兩台裝置只改設定也會保存分歧，使用雲端設定前保留本機版本，解決後不重複回傳', async () => {
  const f = fixture(); await f.engine.start('full', [], 'sync'); const base = f.runtime().link;
  const b = structuredClone(f.local()); b.preferences.accent = '#7951b0'; b.reminders.leadMinutes = 60;
  const remote = await createDriveDocument(b, base.datasetId, [base.baseVersionId], 'sync'); f.documents.set('remote_prefs', remote);
  f.local().preferences.accent = '#3264ad'; await f.engine.synchronize('sync');
  assert.equal(f.local().preferences.accent, '#3264ad'); assert.equal(f.runtime().conflict.length, 2);
  assert.ok([...f.documents.values()].some(document => document.preferences.accent === '#3264ad')); assert.deepEqual(f.documents.get('remote_prefs'), remote);
  const reviewed = [...f.runtime().conflict]; await f.engine.resolve(reviewed, readDriveFile(metadata(remote, 'remote_prefs')), f.revision());
  assert.deepEqual(f.local().preferences, b.preferences); assert.deepEqual(f.local().reminders, b.reminders); assert.equal(f.runtime().conflict, undefined);
  const count = f.uploads(); await f.engine.synchronize('sync'); assert.equal(f.uploads(), count); assert.ok(f.documents.has('remote_prefs'));
});

test('舊格式雲端只改設定且工作摘要相同時仍會接收，僅下載一次，不回傳多餘版本', async () => {
  const f = fixture(), b = backup();
  const root = {...b, cloud: {formatVersion: 1, datasetId: crypto.randomUUID(), versionId: crypto.randomUUID(), parents: [], purpose: 'sync', fileHash: await checksum(b), syncHash: await syncHash(b, 1)}};
  f.documents.set('legacy_root', root); await f.engine.join(readDriveFile(metadata(root, 'legacy_root')), f.revision());
  const content = structuredClone(b); content.preferences.accent = '#7951b0'; content.reminders.leadMinutes = 60;
  const child = {...content, cloud: {...root.cloud, versionId: crypto.randomUUID(), parents: [root.cloud.versionId], fileHash: await checksum(content), syncHash: await syncHash(content, 1)}};
  assert.equal(child.cloud.syncHash, root.cloud.syncHash); f.documents.set('legacy_child', child);
  let reads = 0; const read = f.api.read; f.api.read = async file => {reads++; return read(file);};
  await f.engine.synchronize('sync'); assert.deepEqual(f.local().preferences, content.preferences); assert.deepEqual(f.local().reminders, content.reminders);
  assert.equal(f.runtime().link.baseVersionId, child.cloud.versionId); assert.equal(reads, 1); assert.equal(f.uploads(), 0);
  await f.engine.synchronize('sync'); assert.equal(reads, 1); assert.equal(f.uploads(), 0); assert.deepEqual(await readDriveDocument(child), child);
});
