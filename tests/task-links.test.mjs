import '@angular/compiler';
import assert from 'node:assert/strict';
import {after, test} from 'node:test';
import {createRequire} from 'node:module';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {emptyWorkspace} from '../src/app/workspace-data.ts';
import {readBoardState} from '../src/app/board-data.ts';
import {createBackup, readBackup, copyWorkspaces} from '../src/app/backup-data.ts';
import {mergeTaskLinks, readTaskLinks, relatedTaskIds, setRelatedTasks, taskLinkPairs, withTaskLinks} from '../src/app/task-links-data.ts';
import {mergeDriveBackups} from '../src/app/drive-merge.ts';
import {createDriveDocument, readDriveDocument, readDriveFile, versionProperties} from '../src/app/drive-data.ts';
import {packBackup, readManifest, unpackBackup, verifiedBlock} from '../src/app/backup-blocks.ts';
import {splitWorkspaceRecords, joinWorkspaceRecords} from '../src/app/workspace-records.ts';
import {recordCompletions} from '../src/app/task-completion-data.ts';
const require = createRequire(import.meta.url), {build} = createRequire(require.resolve('@angular/build/package.json'))('esbuild');
await mkdir('.angular', {recursive: true}); const directory = await mkdtemp(resolve('.angular/task-links-test-')), output = resolve(directory, 'store.mjs');
await build({entryPoints: ['src/app/board-store.ts'], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: output, tsconfig: 'tsconfig.json'});
const {BoardStore} = await import(pathToFileURL(output).href); after(() => rm(directory, {recursive: true, force: true}));
const task = id => ({id, title: '任務 ' + id, description: '', projectId: '', categoryId: '', status: 'todo', priority: 'medium', startDate: '', startTime: '', dueDate: '', dueTime: '', subtasks: []});
const workspace = () => ({...emptyWorkspace('space', '工作'), projects: [], tasks: ['a', 'b', 'c'].map(task)});
const backup = board => createBackup({version: 1, activeWorkspaceId: board.id, workspaces: [board]}, 'full');
function fixture() {
  const values = new Map([['orbit-workspaces-v1', JSON.stringify({version: 1, activeWorkspaceId: 'space', workspaces: [workspace()]})]]); let failure = false;
  globalThis.localStorage = {getItem: key => values.get(key) ?? null, setItem(key, value) {if (failure) throw new Error('quota'); values.set(key, value);}, removeItem: key => values.delete(key)};
  globalThis.sessionStorage = {getItem: () => null, setItem() {}, removeItem() {}};
  return {store: new BoardStore(), values, fail: () => {failure = true;}};
}
test('相關任務為雙向唯一配對，拒絕自己、缺失及非法邊，保留移除標記', () => {
  const original = workspace(), linked = setRelatedTasks(original, 'b', ['a'], () => 'link');
  assert.equal(linked.version, 8); assert.deepEqual(linked.taskLinks, [{id: 'link', taskIds: ['a', 'b']}]); assert.deepEqual(relatedTaskIds(linked, 'a'), ['b']);
  assert.equal(setRelatedTasks(linked, 'a', ['b']), linked); assert.equal(readBoardState(linked).taskLinks.length, 1);
  const removed = setRelatedTasks(linked, 'a', []); assert.equal(removed.taskLinks[0].removed, true); assert.deepEqual(relatedTaskIds(removed, 'b'), []);
  for (const ids of [['a'], ['missing'], ['b', 'b']]) assert.throws(() => setRelatedTasks(original, 'a', ids));
  const validIds = new Set(['a', 'b']);
  for (const value of [[{id: 'x', taskIds: ['b', 'a']}], [{id: 'x', taskIds: ['a', 'a']}], [{id: 'x', taskIds: ['a', 'missing']}], [{id: 'x', taskIds: ['a', 'b'], removed: false}], [linked.taskLinks[0], linked.taskLinks[0]]]) assert.equal(readTaskLinks(value, validIds), null);
  assert.ok(readTaskLinks([{id: 'retired', taskIds: ['a', 'missing'], removed: true}], validIds));
  assert.equal(readBoardState({...original, taskLinks: linked.taskLinks}), null); assert.equal(readBoardState({...linked, taskLinks: undefined}), null);
});
test('儲存任務與雙向連結原子生效，更新兩端編輯時間，復原重做使用新事件不復活已移除事件', async () => {
  const f = fixture(), store = f.store; const stale = store.taskContext('b');
  try {
    assert.equal((await store.linkTasks(store.taskContext('a'), store.taskContext('b'))).ok, true);
    assert.deepEqual(store.relatedTaskIds('a'), ['b']); assert.deepEqual(store.relatedTaskIds('b'), ['a']); assert.ok(store.tasks().find(task => task.id === 'b').updatedAt);
    assert.equal((await store.saveTask({...stale.original, title: '過期草稿'}, stale, undefined, undefined, undefined, [])).ok, false);
    const context = store.taskContext('a'); assert.equal((await store.saveTask({...context.original, title: '新名稱'}, context, undefined, undefined, undefined, [])).ok, true);
    const removedId = store.state().taskLinks[0].id; assert.equal(store.state().taskLinks[0].removed, true);
    assert.equal((await store.undo()).ok, true); assert.deepEqual(store.relatedTaskIds('a'), ['b']); assert.ok(store.state().taskLinks.find(link => !link.removed).id !== removedId); assert.equal(store.state().taskLinks.find(link => link.id === removedId).removed, true);
    assert.equal((await store.redo()).ok, true); assert.deepEqual(store.relatedTaskIds('a'), []);
    assert.equal((await store.undo()).ok, true); assert.equal((await store.undo()).ok, true); assert.deepEqual(store.relatedTaskIds('a'), []);
    assert.equal((await store.redo()).ok, true); assert.deepEqual(store.relatedTaskIds('a'), ['b']);
    assert.equal(new BoardStore().state().taskLinks.length, store.state().taskLinks.length);
  } finally {store.ngOnDestroy();}
});
test('垃圾桶還原保留連結，永久移除任一端退役關聯且不刪其他任務或完成歷史', async () => {
  const {store} = fixture();
  try {
    await store.linkTasks(store.taskContext('a'), store.taskContext('b')); await store.deleteTask('b'); assert.deepEqual(store.relatedTaskIds('a'), ['b']);
    await store.restoreTask('b'); assert.deepEqual(store.relatedTaskIds('b'), ['a']);
    await store.moveTask('b', 'done'); assert.equal(store.state().version, 8); assert.equal(store.state().completionEvents.length, 1);
    await store.deleteTask('b'); const purged = await store.purgeTask('b'); assert.equal(purged.ok, true);
    assert.deepEqual(store.relatedTaskIds('a'), []); assert.equal(store.state().taskLinks[0].removed, true); assert.equal(store.state().completionEvents.length, 1); assert.ok(store.tasks().find(task => task.id === 'a')); assert.ok(readBoardState(store.state()));
  } finally {store.ngOnDestroy();}
});
test('並行新增及移除採事件聯集，舊裝置與重複同步不復活已移除關聯', () => {
  const original = workspace(), base = backup(original), a = setRelatedTasks(original, 'a', ['b'], () => 'a'), b = setRelatedTasks(original, 'a', ['c'], () => 'b');
  const merged = mergeDriveBackups(base, [backup(a), backup(b)], 0); assert.deepEqual(relatedTaskIds(merged.backup.data.workspaces[0], 'a'), ['b', 'c']);
  const removed = setRelatedTasks(a, 'a', []), stale = mergeDriveBackups(base, [backup(removed), backup(a)], 0).backup.data.workspaces[0]; assert.deepEqual(relatedTaskIds(stale, 'a'), []); assert.equal(stale.taskLinks[0].removed, true);
  const changed = {...original, tasks: original.tasks.map(task => task.id === 'c' ? {...task, title: '另一裝置的變更'} : task)};
  const oldBranch = mergeDriveBackups(base, [backup(removed), backup(changed)], 0).backup.data.workspaces[0]; assert.equal(oldBranch.version, 8); assert.equal(oldBranch.taskLinks[0].removed, true); assert.equal(oldBranch.tasks.find(task => task.id === 'c').title, '另一裝置的變更');
  assert.deepEqual(taskLinkPairs(mergeDriveBackups(base, [backup(oldBranch), backup(a)], 0).backup.data.workspaces[0]), []);
  assert.throws(() => mergeTaskLinks([[{id: 'same', taskIds: ['a', 'b']}], [{id: 'same', taskIds: ['a', 'c']}]]), /識別/);
});
test('副本重新配置兩端及退役事件身份，JSON／Drive v9 分塊及本機逐筆紀錄往返完整', async () => {
  let board = setRelatedTasks(workspace(), 'a', ['b'], () => 'live'); board = withTaskLinks(board, [...board.taskLinks, {id: 'retired', taskIds: ['a', 'removed'], removed: true}]);
  let serial = 0; const copied = copyWorkspaces([board], () => 'copy-' + serial++)[0]; assert.ok(readBoardState(copied)); assert.notEqual(copied.taskLinks[0].id, 'live'); assert.equal(copied.taskLinks.some(link => link.taskIds.includes('a') || link.taskIds.includes('removed')), false);
  const current = backup(board); assert.equal(current.formatVersion, 9); assert.deepEqual(readBackup(current), current); assert.throws(() => readBackup({...current, formatVersion: 8}), /新版/);
  const data = {formatVersion: 2, generation: 'generation', revision: 'revision', updatedAt: new Date().toISOString(), state: current.data};
  const records = splitWorkspaceRecords(data); assert.ok([...records.keys()].some(key => key.includes('taskLinks') && key.includes('live'))); assert.deepEqual(joinWorkspaceRecords(records).state, current.data);
  const document = await createDriveDocument(current, undefined, [], 'sync'); assert.equal(document.cloud.formatVersion, 9); assert.equal((await readDriveDocument(document)).data.workspaces[0].taskLinks.length, 2);
  assert.equal(readDriveFile({id: 'drive_test', name: 'Orbit', mimeType: 'application/json', createdTime: document.exportedAt, appProperties: versionProperties(document)}).cloud.formatVersion, 9);
  const packed = await packBackup(document); for (const entry of packed.manifest.state.workspaces) {entry.metadata.id = 'metadata'; entry.tasks.forEach((ref, index) => {ref.id = 'bucket_' + index;});}
  readManifest(packed.manifest, document.cloud); const restored = await unpackBackup(packed.manifest, async ref => verifiedBlock(packed.blocks.get(ref.hash), ref.hash)); assert.deepEqual(restored.data, document.data);
  const completion = recordCompletions(board, {...board, tasks: board.tasks.map(task => task.id === 'a' ? {...task, status: 'done'} : task)}); assert.equal(completion.version, 8); assert.deepEqual(completion.taskLinks, board.taskLinks);
});
test('過期拖曳、不同空間與自己不能連結，儲存失敗不部分寫入任務或關聯', async () => {
  const f = fixture(), store = f.store;
  try {
    const a = store.taskContext('a'), b = store.taskContext('b'); assert.equal((await store.linkTasks(a, a)).ok, false); assert.equal((await store.linkTasks(a, {...b, workspaceId: 'other'})).ok, false);
    await store.saveTask({...a.original, title: '已更新'}, a); assert.equal((await store.linkTasks(a, b)).ok, false); assert.deepEqual(store.relatedTaskIds('a'), []);
    const before = f.values.get('orbit-workspaces-v2'); f.fail(); const result = await store.linkTasks(store.taskContext('a'), store.taskContext('b'));
    assert.equal(result.ok, true); assert.equal(result.persisted, false); assert.equal(f.values.get('orbit-workspaces-v2'), before); assert.deepEqual(store.relatedTaskIds('a'), ['b']);
  } finally {store.ngOnDestroy();}
});
