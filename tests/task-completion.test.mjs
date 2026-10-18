import '@angular/compiler';
import assert from 'node:assert/strict';
import {after, test} from 'node:test';
import {createRequire} from 'node:module';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readBoardState} from '../src/app/board-data.ts';
import {emptyWorkspace} from '../src/app/workspace-data.ts';
import {readCompletionEvents, recordCompletions, withCompletionEvents, mergeCompletionEvents} from '../src/app/task-completion-data.ts';
import {completionTrend, completionHistory, dailyCompletions} from '../src/app/completion-trend-data.ts';
import {createBackup, readBackup, copyWorkspaces} from '../src/app/backup-data.ts';
import {createDriveDocument, readDriveDocument, readDriveFile, versionProperties, checksum} from '../src/app/drive-data.ts';
import {mergeDriveBackups} from '../src/app/drive-merge.ts';
import {packBackup, readManifest, unpackBackup, verifiedBlock} from '../src/app/backup-blocks.ts';
import {splitWorkspaceRecords, joinWorkspaceRecords, changedWorkspaceRecords} from '../src/app/workspace-records.ts';

const require = createRequire(import.meta.url), {build} = createRequire(require.resolve('@angular/build/package.json'))('esbuild');
await mkdir('.angular', {recursive: true});
const directory = await mkdtemp(resolve('.angular/completion-test-')), output = resolve(directory, 'store.mjs');
await build({entryPoints: ['src/app/board-store.ts'], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: output, tsconfig: 'tsconfig.json'});
const {BoardStore} = await import(pathToFileURL(output).href);
after(() => rm(directory, {recursive: true, force: true}));
const task = (id = 'task', patch = {}) => ({id, title: id, description: '', projectId: 'project', categoryId: '', status: 'todo', priority: 'medium', startDate: '', startTime: '', dueDate: '', dueTime: '', subtasks: [], ...patch});
const workspace = (tasks = [task()]) => ({...emptyWorkspace('space', '工作'), projects: [{id: 'project', name: '原專案'}], tasks});
const event = (id, day, patch = {}) => ({id, taskId: 'task', kind: 'completed', at: day + 'T08:00:00.000Z', day, title: '完成當時的名稱', projectId: 'project', projectName: '原專案', ...patch});
const backup = board => createBackup({version: 1, activeWorkspaceId: board.id, workspaces: [board]}, 'full');
function storeFixture() {
  const values = new Map([['orbit-workspaces-v1', JSON.stringify({version: 1, activeWorkspaceId: 'space', workspaces: [workspace([task(), task('old-done', {status: 'done'})])]})]]);
  globalThis.localStorage = {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key)};
  globalThis.sessionStorage = {getItem: () => null, setItem() {}, removeItem() {}};
  return {store: new BoardStore(), values};
}

test('只記錄完成及重開，舊完成任務不回推，封存／刪除／還原不製造事件', () => {
  const original = workspace([task(), task('old-done', {status: 'done'})]);
  assert.equal(recordCompletions(original, original), original); assert.equal(readBoardState(original).completionEvents, undefined);
  const now = new Date(2026, 9, 17, 12), completed = recordCompletions(original, {...original, tasks: original.tasks.map(item => ({...item, status: 'done'}))}, now, () => 'first');
  assert.equal(completed.version, 7); assert.deepEqual(completed.completionEvents.map(item => [item.taskId, item.kind]), [['task', 'completed']]);
  const {id, name, ...board} = completed; assert.deepEqual(readBoardState(completed), board);
  const reopened = recordCompletions(completed, {...completed, tasks: completed.tasks.map(item => item.id === 'task' ? {...item, status: 'todo'} : item)}, now, () => 'reopen');
  assert.equal(reopened.completionEvents.at(-1).kind, 'reopened');
  const archived = recordCompletions(completed, {...completed, tasks: completed.tasks.map(item => ({...item, status: 'archived'}))});
  assert.equal(archived.completionEvents.length, 1);
  const trashed = {...completed, tasks: completed.tasks.map(item => ({...item, deletedAt: now.toISOString()}))};
  assert.equal(recordCompletions(completed, trashed).completionEvents.length, 1);
  assert.equal(recordCompletions(trashed, completed).completionEvents.length, 1);
  const created = recordCompletions(workspace([]), workspace([task('new-done', {status: 'done'})]));
  assert.equal(created.completionEvents[0].taskId, 'new-done');
});

test('正式儲存、拖移、復原重做與重新載入皆保留事件；失敗的狀態變更不記錄', async t => {
  t.mock.timers.enable({apis: ['Date'], now: new Date(2026, 9, 17, 12).getTime()});
  const {store} = storeFixture(); let restored;
  try {
    assert.equal((await store.moveTask('task', 'missing')).ok, false); assert.equal(store.currentWorkspace().completionEvents, undefined);
    assert.equal((await store.moveTask('task', 'done')).ok, true);
    t.mock.timers.tick(1000); assert.equal((await store.undo()).ok, true); t.mock.timers.tick(1000); assert.equal((await store.redo()).ok, true);
    assert.deepEqual(store.currentWorkspace().completionEvents.map(item => item.kind), ['completed', 'reopened', 'completed']);
    await store.saveTask({...store.tasks().find(item => item.id === 'task'), title: '更名'});
    assert.equal(store.currentWorkspace().completionEvents.length, 3);
    assert.equal(store.currentWorkspace().completionEvents[0].title, 'task');
    await store.deleteTask('task'); await store.restoreTask('task'); await store.deleteTask('task'); await store.purgeTask('task');
    assert.equal(store.currentWorkspace().completionEvents.length, 3); assert.equal(dailyCompletions(store.currentWorkspace().completionEvents).length, 1);
    restored = new BoardStore(); assert.deepEqual(restored.currentWorkspace().completionEvents, store.currentWorkspace().completionEvents);
    assert.equal((await restored.backupForExport('full')).formatVersion, 8);
  } finally {restored?.ngOnDestroy(); store.ngOnDestroy();}
});

test('匯入備份只保留原歷史，舊檔已完成任務不當作今天完成', async () => {
  const {store} = storeFixture();
  try {
    const input = backup(withCompletionEvents(workspace([task('task', {status: 'done'})]), [event('past', '2026-10-01')]));
    assert.equal((await store.importBackup(input, store.revision())).ok, true);
    assert.deepEqual(store.currentWorkspace().completionEvents, input.data.workspaces[0].completionEvents);
    const legacy = backup(workspace([task('old', {status: 'done'})]));
    assert.equal((await store.importBackup(legacy, store.revision())).ok, true);
    assert.equal(store.currentWorkspace().completionEvents, undefined);
  } finally {store.ngOnDestroy();}
});

test('讀到另一分頁較新資料後，完成歷史保存失敗仍可安全重試；失敗後再有外部修改則阻止覆寫', async () => {
  const {store} = storeFixture(), other = new BoardStore(), write = localStorage.setItem;
  try {
    await other.moveTask('task', 'done');
    localStorage.setItem = () => {throw new Error('quota');};
    const failed = await store.moveTask('old-done', 'todo'); assert.equal(failed.ok, true); assert.equal(failed.persisted, false);
    localStorage.setItem = write;
    const retry = await store.moveTask('old-done', 'todo'); assert.equal(retry.ok, true); assert.equal(retry.persisted, true);
    assert.equal(store.currentWorkspace().completionEvents.length, 2);
    localStorage.setItem = () => {throw new Error('quota');}; await store.moveTask('old-done', 'done'); localStorage.setItem = write;
    await other.moveTask('task', 'todo');
    assert.equal((await store.moveTask('old-done', 'done')).ok, false);
  } finally {localStorage.setItem = write; other.ngOnDestroy(); store.ngOnDestroy();}
});

test('每日先依任務去重再篩選原專案；改名、移動或永久刪除不改寫歷史', () => {
  const events = [event('first', '2026-10-15'), event('reopen', '2026-10-15', {kind: 'reopened'}), event('again', '2026-10-15', {at: '2026-10-15T09:00:00.000Z', projectId: 'other', projectName: '新專案'}), event('next-day', '2026-10-16')];
  const board = withCompletionEvents(workspace([task('task', {title: '新名稱', projectId: '', status: 'todo'})]), events);
  assert.equal(dailyCompletions(events).length, 2);
  const rows = completionHistory(board, 'project', '2026-10-01', '2026-10-17');
  assert.equal(rows.length, 2); assert.equal(rows[0].event.title, '完成當時的名稱'); assert.equal(rows[0].task.title, '新名稱');
  assert.equal(completionHistory(board, 'other', '2026-10-01', '2026-10-17').length, 0);
  assert.equal(completionTrend({...board, tasks: []}, new Date(2026, 9, 17), 'project').total, 2);
});

test('7／30／90 天與週彙整使用本機日期、週日到週六；開始記錄前不填假零值', () => {
  const board = withCompletionEvents(workspace(), [event('a', '2026-10-03'), event('b', '2026-10-04'), event('c', '2026-10-10'), event('d', '2026-10-17')]);
  const now = new Date(2026, 9, 17, 23, 59);
  assert.equal(completionTrend(board, now, 'all', 7).total, 1);
  const daily = completionTrend(board, now, 'all', 30), weekly = completionTrend(board, now, 'all', 90, true);
  assert.equal(daily.buckets.length, 15); assert.equal(daily.start, '2026-10-03'); assert.equal(daily.today, 1);
  assert.deepEqual(weekly.buckets.map(item => [item.start, item.end, item.count]), [['2026-10-03', '2026-10-03', 1], ['2026-10-04', '2026-10-10', 2], ['2026-10-11', '2026-10-17', 1]]);
  assert.equal(weekly.total, daily.total); assert.equal(completionTrend(workspace(), now).buckets.length, 0);
  const crossYear = withCompletionEvents(workspace(), [event('year', '2025-12-31')]);
  assert.equal(completionTrend(crossYear, new Date(2026, 0, 2), 'all', 7).buckets.length, 3);
});

test('完成歷史完整驗證格式、日期、重複事件及版本；保留正確的本機跨日', () => {
  const valid = event('ok', '2026-10-17');
  for (const value of [{...valid, day: '2026-02-30'}, {...valid, day: '2000-01-01'}, {...valid, at: 'yesterday'}, {...valid, kind: 'done'}, {...valid, title: ''}]) assert.equal(readCompletionEvents([value]), null);
  assert.equal(readCompletionEvents([valid, valid]), null);
  assert.ok(readCompletionEvents([{...valid, day: '2026-10-18'}]));
  assert.equal(readBoardState({...workspace(), completionEvents: [valid]}), null);
  assert.equal(readBoardState({...withCompletionEvents(workspace(), []), completionEvents: undefined}), null);
  const current = backup(withCompletionEvents(workspace(), [valid]));
  assert.throws(() => readBackup({...current, formatVersion: 7}), /新版/);
  assert.deepEqual(readBackup(current), current);
});

test('跨裝置同時完成與不同任務變更，歷史聯集合併且重複同步不膨脹、不製造新完成', () => {
  const original = workspace([task(), task('other')]), base = backup(original);
  const a = backup(recordCompletions(original, {...original, tasks: original.tasks.map(item => ({...item, status: 'done'}))}, new Date(2026, 9, 16, 12), (() => {let n = 0; return () => 'a-' + n++;})()));
  const b = backup(recordCompletions(original, {...original, tasks: original.tasks.map(item => item.id === 'task' ? {...item, status: 'done', title: '另一裝置修改'} : item)}, new Date(2026, 9, 16, 13), () => 'b'));
  const merged = mergeDriveBackups(base, [a, b], undefined, true);
  assert.deepEqual(merged.conflicts, []); assert.equal(merged.backup.formatVersion, 8);
  const board = merged.backup.data.workspaces[0]; assert.equal(board.completionEvents.length, 3); assert.equal(dailyCompletions(board.completionEvents).length, 2);
  assert.equal(mergeDriveBackups(base, [merged.backup, a, b], undefined, true).backup.data.workspaces[0].completionEvents.length, 3);
  const without = structuredClone(merged.backup); without.data.workspaces[0].completionEvents = [];
  assert.equal(mergeDriveBackups(merged.backup, [without, merged.backup], undefined, true).backup.data.workspaces[0].completionEvents.length, 3);
  assert.throws(() => mergeCompletionEvents([[event('same', '2026-10-16')], [event('same', '2026-10-17')]]), /事件識別/);
});

test('匯入工作空間副本重建歷史與已刪任務的識別，仍保持同任務去重', () => {
  const original = withCompletionEvents(workspace([]), [event('first', '2026-10-16'), event('again', '2026-10-16', {at: '2026-10-16T09:00:00.000Z'})]);
  let index = 0; const copy = copyWorkspaces([original], () => 'copy-' + index++)[0];
  assert.notEqual(copy.id, original.id); assert.notEqual(copy.completionEvents[0].id, 'first'); assert.notEqual(copy.completionEvents[0].taskId, 'task');
  assert.equal(copy.completionEvents[0].taskId, copy.completionEvents[1].taskId); assert.equal(dailyCompletions(copy.completionEvents).length, 1);
  assert.equal(copy.completionEvents[0].projectId, copy.projects[0].id); assert.equal(copy.completionEvents[0].day, '2026-10-16');
});

test('IndexedDB 紀錄拆解保留獨立事件，JSON／Drive 分塊與 v8 校驗往返完整', async () => {
  const board = withCompletionEvents(workspace(), [event('one', '2026-10-16')]), current = backup(board);
  const data = {formatVersion: 2, generation: 'g', revision: 'r', updatedAt: '2026-10-17T00:00:00.000Z', state: current.data};
  const records = splitWorkspaceRecords(data); assert.deepEqual(joinWorkspaceRecords(records).state, current.data);
  const next = structuredClone(data); next.revision = 'next'; next.state.workspaces[0].completionEvents.push(event('two', '2026-10-17'));
  const changes = changedWorkspaceRecords(records, splitWorkspaceRecords(next));
  assert.ok(changes.put.some(record => record.key.includes('completionEvents') && record.key.includes('two'))); assert.equal(changes.remove.length, 0);
  const document = await createDriveDocument(current, undefined, [], 'sync');
  assert.equal(document.cloud.formatVersion, 8); assert.equal((await readDriveDocument(document)).data.workspaces[0].completionEvents.length, 1);
  const metadata = readDriveFile({id: 'drive_test', name: 'Orbit', mimeType: 'application/json', createdTime: document.exportedAt, appProperties: versionProperties(document)});
  assert.equal(metadata.cloud.formatVersion, 8);
  const packed = await packBackup(document);
  for (const entry of packed.manifest.state.workspaces) {entry.metadata.id = 'metadata'; entry.tasks.forEach((ref, index) => {ref.id = 'bucket_' + index;});}
  readManifest(packed.manifest, document.cloud);
  assert.deepEqual(await unpackBackup(packed.manifest, async reference => verifiedBlock(packed.blocks.get(reference.hash), reference.hash)), document);
  const tampered = structuredClone(document); tampered.data.workspaces[0].completionEvents[0].title = '遭到修改';
  await assert.rejects(readDriveDocument(tampered), /校驗/);
  assert.notEqual(await checksum(tampered), await checksum(document));
});
