import '@angular/compiler';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createBackup } from '../src/app/backup-data.ts';
import { DEFAULT_REMINDERS } from '../src/app/reminder-data.ts';
import { DEFAULT_DRIVE } from '../src/app/drive-data.ts';
import { DEFAULT_APPEARANCE } from '../src/app/appearance-data.ts';
import { documentFromUrl } from '../src/app/document-data.ts';
import {mailInformationSource} from '../src/app/mail-information-data.ts';

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('@angular/build/package.json'))('esbuild');
await mkdir('.angular', {recursive: true});
const directory = await mkdtemp(resolve('.angular/store-test-'));
const output = resolve(directory, 'store.mjs');
await build({entryPoints: ['src/app/board-store.ts'], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: output, tsconfig: 'tsconfig.json'});
const { BoardStore } = await import(pathToFileURL(output).href);
after(() => rm(directory, {recursive: true, force: true}));

const task = {id: 'task', title: '既有任務', description: '保留內容', categoryId: '', projectId: '', status: 'todo', priority: 'medium', startDate: '', startTime: '', dueDate: '', dueTime: '', subtasks: []};
const legacy = {version: 2, projectName: '原專案', categories: [], tasks: [task, {...task, id: 'done', status: 'done'}]};
const migratedTasks = legacy.tasks.map(item => ({...item, projectId: 'project-legacy'}));

test('直接拖放加入保留任務的混合順序與用途，其他任務先加入的來源仍排在末端', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const store = new BoardStore(), file = documentFromUrl('google-drive', 'https://docs.google.com/document/d/shared-order/edit', '既有來源');
  const mail = mailInformationSource({id: 'order-mail', subject: '郵件', from: 'sender@example.test', senderEmail: 'sender@example.test'}, 'me@example.test', 'account');
  await store.linkDocument('done', file);
  await store.saveTask(store.tasks()[0], store.taskContext('task'), undefined, [mail], [{documentId: mail.id, description: '既有郵件用途'}]);
  await store.linkDocument('task', file);
  assert.deepEqual(store.documentsForTask('task').map(item => item.id), [mail.id, file.id]);
  assert.deepEqual(store.descriptionsForTask('task').map(item => item.description), ['既有郵件用途', '']);
  assert.equal((await store.backupForExport('full')).formatVersion, 7);
});

test('連結用途與順序可一次儲存、重讀、復原與重做，重新加入清空用途，復原帶回原用途', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const store = new BoardStore(), file = documentFromUrl('google-drive', 'https://docs.google.com/document/d/notes/edit', '文件');
  const mail = mailInformationSource({id: 'notes-mail', subject: '郵件', from: 'sender@example.test', senderEmail: 'sender@example.test'}, 'me@example.test', 'account');
  const notes = description => [{documentId: file.id, description}, {documentId: mail.id, description: '參考郵件'}];
  await store.saveTask(store.tasks()[0], store.taskContext('task'), undefined, [mail, file], notes('原用途'));
  assert.deepEqual(store.documentsForTask('task').map(item => item.id), [mail.id, file.id]);
  const old = store.tasks()[0].updatedAt;
  await store.saveTask(store.tasks()[0], store.taskContext('task'), undefined, [file, mail], notes('新用途'));
  assert.equal(store.undoLabel(), '變更資訊連結'); assert.equal(store.tasks()[0].updatedAt >= old, true);
  assert.equal(new BoardStore().descriptionsForTask('task')[0].description, '新用途');
  assert.equal((await store.undo()).ok, true); assert.equal(store.descriptionsForTask('task')[1].description, '原用途');
  assert.deepEqual(store.documentsForTask('task').map(item => item.id), [mail.id, file.id]);
  assert.equal((await store.redo()).ok, true); assert.equal(store.descriptionsForTask('task')[0].description, '新用途');
  await store.saveTask(store.tasks()[0], store.taskContext('task'), undefined, [mail], [{documentId: mail.id, description: '參考郵件'}]);
  await store.linkDocument('task', file); assert.equal(store.descriptionsForTask('task')[1].description, '');
  await store.undo(); assert.equal(store.documentsForTask('task').length, 1);
  assert.equal((await store.undo()).ok, true); assert.equal(store.descriptionsForTask('task')[0].description, '新用途');
  await store.undo(); assert.equal(store.descriptionsForTask('task')[1].description, '原用途');
  await store.undo(); assert.equal(store.documentsForTask('task').length, 0);
  assert.equal(store.canRedo(), true); await store.redo(); assert.equal(store.descriptionsForTask('task')[1].description, '原用途');
});

test('連結用途草稿拒絕覆蓋另一分頁更新，另存新任務及備份副本保留用途但互不連動', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const store = new BoardStore(), file = documentFromUrl('google-drive', 'https://docs.google.com/document/d/notes/edit', '文件');
  await store.saveTask(store.tasks()[0], store.taskContext('task'), undefined, [file], [{documentId: file.id, description: '最初用途'}]);
  const other = new BoardStore(), context = other.taskContext('task');
  await store.saveTask(store.tasks()[0], store.taskContext('task'), undefined, [file], [{documentId: file.id, description: '另一分頁更新'}]);
  const failed = await other.saveTask(context.original, context, undefined, [file], [{documentId: file.id, description: '過期草稿'}]);
  assert.equal(failed.ok, false); assert.equal(new BoardStore().descriptionsForTask('task')[0].description, '另一分頁更新');
  other.refreshFromStorage(); const copy = {...context.original, id: 'copied-task'};
  assert.equal((await other.saveTask(copy, other.taskContext(copy.id), undefined, [file], [{documentId: file.id, description: '過期草稿'}])).ok, true);
  assert.equal(other.descriptionsForTask('task')[0].description, '另一分頁更新'); assert.equal(other.descriptionsForTask(copy.id)[0].description, '過期草稿');
  const exported = await other.backupForExport('workspaces', [other.currentWorkspace().id]); assert.equal(exported.formatVersion, 7);
  assert.equal((await other.importBackup(exported, other.revision())).ok, true);
  assert.equal(other.descriptionsForTask(other.tasks()[0].id)[0].description, '另一分頁更新');
});

test('資訊連結數量含 Drive 與郵件，移除／復原／垃圾桶與工作空間切換即時更新', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const store = new BoardStore(), originalWorkspace = store.currentWorkspace().id;
  const file = documentFromUrl('google-drive', 'https://docs.google.com/document/d/count-file/edit', '報告');
  const mail = mailInformationSource({id: 'count-mail', subject: '郵件', from: 'sender@example.test', senderEmail: 'sender@example.test'}, 'orbit@example.test', 'account');
  assert.equal(store.documentCount('task'), 0);
  await store.linkDocument('task', file); await store.linkDocument('task', mail); await store.linkDocument('task', file);
  assert.equal(store.documentCount('task'), 2); assert.equal(store.documentCount('done'), 0);
  await store.saveTask(store.tasks()[0], store.taskContext('task'), undefined, [mail]); assert.equal(store.documentCount('task'), 1);
  await store.undo(); assert.equal(store.documentCount('task'), 2);
  await store.deleteTask('task'); assert.equal(store.documentCount('task'), 0);
  await store.restoreTask('task'); assert.equal(store.documentCount('task'), 2);
  await store.saveWorkspace('', '另一個空間'); assert.equal(store.documentCount('task'), 0);
  store.switchWorkspace(originalWorkspace); assert.equal(store.documentCount('task'), 2);
  assert.equal(new BoardStore().documentCount('task'), 2);
  store.workspaceState.update(state => ({...state, workspaces: state.workspaces.map(workspace => workspace.id === originalWorkspace ? {...workspace, documentLinks: [...workspace.documentLinks, {...workspace.documentLinks.find(link => !link.removed), id: 'parallel-add'}]} : workspace)}));
  assert.equal(store.documentCount('task'), 2);
});

test('任務與多文件一次保存；新分頁、完整還原及工作空間副本保留雙向關聯', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const store = new BoardStore(), source = documentFromUrl('google-drive', 'https://docs.google.com/document/d/document-one/edit', '研究計畫');
  const second = documentFromUrl('pcloud', 'https://e.pcloud.link/publink/show?code=shared', '研究資料');
  assert.equal((await store.saveTask(store.tasks()[0], store.taskContext('task'), undefined, [source, second])).ok, true);
  assert.equal(store.documentsForTask('task').length, 2); assert.equal(store.tasksForDocument(source).length, 1);
  assert.equal(new BoardStore().documentsForTask('task').length, 2);
  const exported = await store.backupForExport('full'); assert.equal(exported.formatVersion, 7);
  assert.equal((await store.importBackup(exported, store.revision())).ok, true); assert.equal(store.documentsForTask('task').length, 2);
  const copied = await store.backupForExport('workspaces', [store.currentWorkspace().id]);
  assert.equal((await store.importBackup(copied, store.revision())).ok, true);
  assert.equal(store.tasksForDocument(source).length, 2); assert.equal(store.documents().length, 2);
});

test('文件草稿拒絕過期關聯，直接新增可保留另一分頁加入的其他文件', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const first = new BoardStore(), second = new BoardStore(), stale = second.taskContext('task');
  const source = documentFromUrl('google-drive', 'https://docs.google.com/document/d/document-one/edit', '研究計畫');
  const other = documentFromUrl('google-drive', 'https://docs.google.com/document/d/document-two/edit', '研究資料');
  await first.linkDocument('task', source);
  assert.equal((await second.saveTask(stale.original, stale, undefined, [other])).ok, false);
  second.refreshFromStorage(); assert.equal((await second.linkDocument('task', other)).ok, true);
  assert.equal(new BoardStore().documentsForTask('task').length, 2);
  const generation = second.generation(), context = second.taskContext('task');
  await second.importBackup(await second.backupForExport('full'), second.revision());
  assert.notEqual(second.generation(), generation); assert.equal((await second.linkDocument('task', source, context)).ok, false);
});

test('關聯復原與重做保留刪除記錄，重新加入使用新事件；垃圾桶清空不留下有效懸空關聯', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const store = new BoardStore(), source = documentFromUrl('google-drive', 'https://docs.google.com/document/d/document-one/edit', '研究計畫');
  await store.saveTask({...store.tasks()[0], title: '第一個編輯'});
  await store.linkDocument('task', source);
  const firstId = store.state().documentLinks[0].id;
  assert.equal(store.undoLabel(), '變更資訊連結'); assert.equal((await store.undo()).ok, true);
  assert.equal(store.documentsForTask('task').length, 0); assert.equal(store.state().documentLinks[0].removed, true);
  assert.equal(store.canRedo(), true); assert.equal((await store.redo()).ok, true);
  assert.equal(store.documentsForTask('task').length, 1); assert.notEqual(store.state().documentLinks.find(link => !link.removed).id, firstId);
  await store.undo(); assert.equal(store.canUndo(), true); await store.undo(); assert.equal(store.tasks()[0].title, '既有任務');
  await store.linkDocument('task', source); await store.deleteTask('task');
  assert.equal(store.tasksForDocument(source).length, 0); assert.equal(store.tasksForDocument(source, true).length, 1);
  assert.equal((await store.emptyTrash(store.trashContext())).ok, true);
  assert.equal(store.state().documentLinks.every(link => link.removed), true); assert.equal(store.documents().length, 1);
  assert.equal(new BoardStore().tasksForDocument(source, true).length, 0);
});

test('文件拖曳關聯拒絕刪除任務與無效來源，失敗不建立任務或半份關聯', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const store = new BoardStore(), source = documentFromUrl('google-drive', 'https://docs.google.com/document/d/document-one/edit', '研究計畫');
  assert.equal((await store.saveTask(store.tasks()[0], store.taskContext('task'), undefined, [{...source, url: 'javascript:alert(1)'}])).ok, false);
  assert.equal(store.documents().length, 0);
  const context = store.taskContext('task'); await store.deleteTask('task');
  assert.equal((await store.linkDocument('task', source, context)).ok, false); assert.equal(store.documents().length, 0);
});

test('登出只保留 Client ID 與雲端集合目的地並重置其他資料，舊分頁不能復活任務', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const store = new BoardStore(); await store.updateGoogle({clientId: '123-example.apps.googleusercontent.com', accountId: 'old-account', email: 'old@example.test'});
  await store.updateAppearance({theme: 'dark', accent: '#123456'}); await store.updateReminders({popupEnabled: false});
  const old = new BoardStore(), generation = store.generation(), dataset = crypto.randomUUID();
  const result = await store.logoutToCloud(store.google().clientId, dataset, store.revision(), generation);
  assert.equal(result.ok, true); assert.notEqual(store.generation(), generation); assert.equal(store.tasks().length, 0);
  assert.equal(store.google().clientId, '123-example.apps.googleusercontent.com'); assert.equal(store.google().accountId, ''); assert.equal(store.google().email, '');
  assert.deepEqual(store.appearance(), DEFAULT_APPEARANCE); assert.deepEqual(store.reminders(), DEFAULT_REMINDERS); assert.equal(store.drive().accountId, '');
  assert.deepEqual(new BoardStore().cloudResume(), {datasetId: dataset, cleanupPending: true}); assert.equal(store.onboarding(), null); assert.equal(store.canUndo(), false);
  assert.equal(store.currentWorkspace().name, '空白工作空間');
  assert.equal(store.projects().length, 0); assert.equal(store.categories().length, 0);
  assert.equal((await store.finishLogoutCleanup(dataset, store.generation())).ok, true); assert.deepEqual(new BoardStore().cloudResume(), {datasetId: dataset});
  assert.equal(Object.hasOwn(await store.backupForExport('full'), 'cloudResume'), false);
  assert.equal((await old.saveTask({...old.tasks()[0], title: '舊分頁草稿'})).ok, false);
  assert.equal(new BoardStore().tasks().length, 0);
  assert.equal((await store.finishCloudLogin(crypto.randomUUID(), store.generation())).ok, false);
  assert.equal((await store.finishCloudLogin(dataset, store.generation())).ok, true); assert.equal(new BoardStore().cloudResume(), undefined);
});

test('登出拒絕過期備份證明與儲存失敗，任務、Client ID、世代都保留', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const store = new BoardStore(); await store.updateGoogle({clientId: '123-example.apps.googleusercontent.com'});
  const revision = store.revision(), generation = store.generation(); await store.saveTask({...store.tasks()[0], title: '備份後的新修改'});
  assert.equal((await store.logoutToCloud(store.google().clientId, crypto.randomUUID(), revision, generation)).ok, false);
  const saved = localStorage.getItem('orbit-workspaces-v2'), write = localStorage.setItem;
  localStorage.setItem = () => {throw new Error('模擬儲存失敗');};
  const result = await store.logoutToCloud(store.google().clientId, crypto.randomUUID(), store.revision(), generation);
  localStorage.setItem = write;
  assert.equal(result.ok, false); assert.equal(localStorage.getItem('orbit-workspaces-v2'), saved); assert.equal(store.generation(), generation);
  assert.equal(store.tasks()[0].title, '備份後的新修改'); assert.equal(store.cloudResume(), undefined);
});

test('裝置名稱在本機保存，跨分頁沿用身份，匯入及遠端資料不取代本機名稱', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const first = new BoardStore(), revision = first.revision(), identity = first.device().id;
  assert.equal(first.setDeviceName('  我的手機  ').ok, true);
  assert.equal(first.revision(), revision); assert.deepEqual(new BoardStore().device(), {id: identity, name: '我的手機'});
  await first.saveTask({...first.tasks()[0], description: '手機修改'});
  const exported = await first.backupForExport('full');
  assert.deepEqual(exported.data.workspaces[0].tasks[0].editSource, first.device());
  assert.equal(Object.hasOwn(exported, 'device'), false);
  assert.equal(first.setDeviceName('').ok, false); assert.equal(first.setDeviceName('a'.repeat(61)).ok, false);
  const write = localStorage.setItem; localStorage.setItem = () => {throw new Error('full');};
  assert.equal(first.setDeviceName('無法保存').ok, false); assert.equal(first.device().name, '我的手機'); localStorage.setItem = write;
  first.setDeviceName('改名的手機');
  assert.equal((await first.importBackup(exported, first.revision())).ok, true);
  assert.equal(first.device().name, '改名的手機'); assert.equal(first.tasks()[0].editSource.name, '我的手機');
});

test('刪除保存垃圾桶內容、原順序與備份，還原保留釘選、子任務及時間', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const store = new BoardStore();
  await store.saveTask({...store.tasks()[0], pinned: true, subtasks: [{id: 'step', title: '保留步驟', done: true}]});
  const saved = structuredClone(store.tasks()[0]);
  await store.deleteTask(saved.id);
  assert.equal(store.tasks().some(item => item.id === saved.id), false);
  assert.equal(store.trashedTasks().length, 1); assert.ok(Number.isFinite(Date.parse(store.trashedTasks()[0].deletedAt)));
  const {deletedAt, ...retained} = store.trashedTasks()[0]; assert.deepEqual(retained, saved);
  assert.deepEqual(new BoardStore().trashedTasks(), store.trashedTasks());
  const backup = await store.backupForExport('full');
  assert.equal(backup.data.workspaces[0].tasks[0].deletedAt, deletedAt);
  await store.importBackup(backup, store.revision());
  assert.equal(store.trashedTasks().length, 1); assert.equal(store.canUndo(), false);
  await store.restoreTask(saved.id);
  assert.deepEqual(store.tasks()[0], saved); assert.deepEqual(store.trashedTasks(), []);
  assert.equal(store.undoLabel(), '還原任務'); await store.undo(); assert.equal(store.trashedTasks().length, 1);
});

test('垃圾桶隔離工作空間、拒絕過期清空與還原，清空失敗保留內容，成功後不能復原清空', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const store = new BoardStore(); await store.deleteTask('task');
  const stale = store.trashContext();
  await store.deleteTask('done'); assert.equal((await store.emptyTrash(stale)).ok, false);
  const context = store.trashContext(), restore = store.taskContext('task');
  const write = localStorage.setItem; localStorage.setItem = () => {throw new Error('full');};
  try { assert.equal((await store.emptyTrash(context)).ok, false); assert.equal(store.trashedTasks().length, 2); }
  finally { localStorage.setItem = write; }
  await store.saveWorkspace('', '另一個空間');
  const second = store.workspaces().find(item => item.name === '另一個空間'); store.switchWorkspace(second.id);
  await store.saveTask({...task, id: 'other'}); await store.deleteTask('other');
  assert.equal(store.trashedTasks().length, 1);
  assert.equal((await store.emptyTrash(context)).ok, true);
  assert.equal(store.trashedTasks().length, 1); assert.equal(store.canUndo(), true);
  store.switchWorkspace(context.workspaceId);
  assert.deepEqual(store.trashedTasks(), []); assert.equal(store.canUndo(), false);
  assert.equal((await store.restoreTask('task', restore)).ok, false);
  assert.equal((await store.undo()).ok, false);
  await store.resetData(false, store.revision()); assert.equal((await store.emptyTrash(context)).ok, false);
});

test('單筆徹底刪除只移除選定垃圾桶任務，保留其餘任務與共用文件並可重讀備份', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const store = new BoardStore(), source = documentFromUrl('google-drive', 'https://docs.google.com/document/d/purge-shared/edit', '共用文件');
  await store.saveTask({...store.tasks()[0], subtasks: [{id: 'step', title: '一起移除的子任務', done: false}]}, store.taskContext('task'), undefined, [source], [{documentId: source.id, description: '任務用途'}]);
  await store.linkDocument('done', source);
  await store.deleteTask('task'); const context = store.taskContext('task');
  await store.deleteTask('done');
  const retained = structuredClone(store.trashedTasks()[1]);
  await store.saveTask({...task, id: 'active'});
  assert.equal((await store.purgeTask('task', context)).ok, true);
  assert.deepEqual(store.trashedTasks(), [retained]); assert.deepEqual(store.tasks().map(item => item.id), ['active']);
  assert.equal(store.state().tasks.some(item => item.id === 'task'), false);
  assert.equal(store.state().documentLinks.filter(link => link.taskId === 'task').every(link => link.removed), true);
  assert.equal(store.documentsForTask('task').length, 0); assert.equal(store.documentsForTask('done').length, 1); assert.equal(store.documents().length, 1);
  assert.equal(store.canUndo(), false); assert.equal(store.canRedo(), false);
  const backup = await store.backupForExport('full');
  assert.equal(backup.data.workspaces[0].tasks.some(item => item.id === 'task'), false);
  assert.deepEqual(new BoardStore().trashedTasks(), [retained]);
  assert.equal((await store.purgeTask('task', context)).ok, false);
});

test('單筆徹底刪除保存失敗保留任務、修訂與復原重做，重試成功後無法帶回任務', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const store = new BoardStore();
  await store.deleteTask('task'); await store.restoreTask('task'); await store.undo();
  const context = store.taskContext('task'), before = structuredClone(store.workspaceState()), revision = store.revision();
  assert.equal(store.canUndo(), true); assert.equal(store.canRedo(), true);
  const write = localStorage.setItem; localStorage.setItem = () => {throw new Error('full');};
  try {
    const result = await store.purgeTask('task', context);
    assert.equal(result.ok, false); assert.match(result.message, /任務仍保留在垃圾桶/);
    assert.deepEqual(store.workspaceState(), before); assert.equal(store.revision(), revision);
    assert.equal(store.canUndo(), true); assert.equal(store.canRedo(), true);
  } finally {localStorage.setItem = write;}
  assert.equal((await store.purgeTask('task', context)).ok, true);
  assert.equal(store.canUndo(), false); assert.equal(store.canRedo(), false);
  assert.equal((await store.undo()).ok, false); assert.equal((await store.redo()).ok, false);
  assert.equal((await store.restoreTask('task', context)).ok, false);
  assert.equal(new BoardStore().state().tasks.some(item => item.id === 'task'), false);
});

test('單筆徹底刪除拒絕一般任務、遺失任務及另一分頁已還原或更新的舊確認', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const store = new BoardStore();
  assert.equal((await store.purgeTask('task')).ok, false); assert.equal((await store.purgeTask('missing')).ok, false);
  await store.deleteTask('task'); const context = store.taskContext('task'), peer = new BoardStore();
  await peer.restoreTask('task');
  assert.equal((await store.purgeTask('task', context)).ok, false);
  assert.equal(new BoardStore().tasks().some(item => item.id === 'task'), true);
  await peer.saveTask({...peer.tasks()[0], title: '另一分頁更新'}); await peer.deleteTask('task');
  assert.equal((await store.purgeTask('task', context)).ok, false);
  store.refreshFromStorage(); const fresh = store.taskContext('task');
  assert.equal((await store.purgeTask('task', {...fresh, informationKey: '過期資訊連結'})).ok, false);
  assert.equal((await store.purgeTask('task', {...fresh, documentLinks: [{id: 'missing', taskId: 'task', documentId: 'missing'}]})).ok, false);
  assert.equal((await store.purgeTask('task', fresh)).ok, true);
  assert.equal(store.state().tasks.find(item => item.id === 'done').title, '既有任務');
});

test('單筆徹底刪除鎖定確認的工作空間，保留另一空間同名識別與其操作紀錄，拒絕舊資料世代', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const store = new BoardStore(); await store.deleteTask('task');
  const context = store.taskContext('task');
  await store.saveWorkspace('', '另一個空間'); const second = store.currentWorkspace().id;
  await store.saveTask({...task}); await store.deleteTask('task');
  const other = structuredClone(store.state()), otherContext = store.taskContext('task');
  assert.equal((await store.purgeTask('task', context)).ok, true);
  assert.equal(store.currentWorkspace().id, second); assert.deepEqual(store.state(), other); assert.equal(store.canUndo(), true);
  store.switchWorkspace(context.workspaceId); assert.equal(store.canUndo(), false); assert.equal(store.state().tasks.some(item => item.id === 'task'), false);
  await store.resetData(false, store.revision()); const reset = structuredClone(store.workspaceState());
  assert.equal((await store.purgeTask('task', otherContext)).ok, false); assert.deepEqual(store.workspaceState(), reset);
});

test('單筆徹底刪除只阻擋目標任務的待解衝突，已解決衝突保留選擇紀錄但解除有效文件關聯', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const store = new BoardStore(), source = documentFromUrl('google-drive', 'https://docs.google.com/document/d/purge-conflict/edit', '參考文件');
  await store.linkDocument('task', source); await store.deleteTask('task'); await store.deleteTask('done');
  const backup = await store.backupForExport('full'), selected = backup.data.workspaces[0].tasks.find(item => item.id === 'task');
  backup.data.workspaces[0].taskConflicts = [{id: 'task', versions: [{key: 'first', task: structuredClone(selected)}, {key: 'second', task: {...selected, title: '另一份內容'}}]}];
  assert.equal((await store.importBackup(backup, store.revision())).ok, true);
  const blocked = await store.purgeTask('task'); assert.equal(blocked.ok, false); assert.match(blocked.message, /同步衝突/);
  assert.equal((await store.purgeTask('done')).ok, true); assert.equal(store.trashedTasks().length, 1);
  const resolved = await store.backupForExport('full'); resolved.data.workspaces[0].taskConflicts[0].resolved = 'first';
  assert.equal((await store.importBackup(resolved, store.revision())).ok, true);
  assert.equal((await store.purgeTask('task')).ok, true);
  assert.equal(store.state().taskConflicts[0].resolved, 'first'); assert.equal(store.documents().length, 1);
  assert.equal(store.state().documentLinks.every(link => link.removed), true); assert.equal(store.documentsForTask('task').length, 0);
  assert.equal(new BoardStore().state().tasks.length, 0);
});

test('多步復原與重做任務建立、編輯、移動、排序、釘選、刪除與管理分類專案狀態', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const store = new BoardStore(), original = structuredClone(store.state());
  await store.saveProject({id: 'project', name: '新專案'});
  await store.saveCategory({id: 'category', name: '新分類', color: 'green'});
  await store.saveStatus({id: 'new-status', label: '新狀態', subtitle: '', color: 'blue', kind: 'active'});
  await store.saveTask({...task, id: 'new', projectId: 'project', categoryId: 'category'});
  await store.saveTask({...store.tasks().find(item => item.id === 'new'), description: '編輯後'});
  await store.moveTask('new', 'progress'); await store.moveTask('task', 'todo', 'new');
  await store.setTaskPinned('new', true); await store.deleteTask('new');
  const final = structuredClone(store.state());
  const steps = store.history().length;
  for (let i = 0; i < steps; i++) {assert.equal(store.canUndo(), true); assert.equal((await store.undo()).ok, true);}
  assert.deepEqual(store.state(), original); assert.equal(store.canUndo(), false);
  for (let i = 0; i < steps; i++) {assert.equal(store.canRedo(), true); assert.equal((await store.redo()).ok, true);}
  assert.deepEqual(store.state(), final); assert.equal(store.canRedo(), false);
  for (let i = 0; i < steps; i++) await store.undo();
  assert.equal(new BoardStore().canUndo(), false);
  assert.equal(new BoardStore().canRedo(), false);
  await store.saveCategory({id: 'category', name: '新分類', color: 'green'});
  await store.saveTask({...store.tasks()[0], categoryId: 'category'});
  const before = structuredClone(store.state()); await store.deleteCategory('category'); await store.undo(); assert.deepEqual(store.state(), before);
});

test('復原不覆蓋跨分頁新內容、重置或其他空間，失敗與無變更操作不加入記錄', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const first = new BoardStore(), peer = new BoardStore();
  await first.saveTask({...first.tasks()[0], title: '自己的編輯'});
  await peer.saveTask({...peer.tasks()[1], title: '另一分頁的內容'});
  assert.equal((await first.undo()).ok, false); assert.equal(first.tasks()[0].title, '自己的編輯');
  assert.equal(first.tasks()[1].title, '另一分頁的內容'); assert.equal(first.canUndo(), false);
  const firstId = first.currentWorkspace().id; await first.saveWorkspace('', '第二空間'); const second = first.workspaces().find(item => item.name === '第二空間');
  first.switchWorkspace(second.id); assert.equal(first.canUndo(), false);
  await first.saveTask({...task, id: 'second-task'}); first.switchWorkspace(firstId); assert.equal(first.canUndo(), false);
  first.switchWorkspace(second.id); assert.equal(first.canUndo(), true); await first.undo(); assert.deepEqual(first.tasks(), []);
  await first.saveTask({...task, id: 'second-task'}); const count = first.history().length;
  await first.saveTask(first.tasks()[0]); assert.equal(first.history().length, count);
  assert.equal((await first.saveTask({...task, id: 'bad', projectId: 'missing'})).ok, false); assert.equal(first.history().length, count);
  await first.resetData(false, first.revision()); assert.equal(first.canUndo(), false);
});

test('復原記錄最多保留最近 50 步，儲存失敗時仍可復原本分頁的暫存修改', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const store = new BoardStore();
  for (let i = 1; i <= 55; i++) await store.saveTask({...store.tasks()[0], title: '修改 ' + i});
  for (let i = 0; i < 50; i++) assert.equal((await store.undo()).ok, true);
  assert.equal(store.tasks()[0].title, '修改 5'); assert.equal(store.canUndo(), false);
  for (let i = 0; i < 50; i++) assert.equal((await store.redo()).ok, true);
  assert.equal(store.tasks()[0].title, '修改 55'); assert.equal(store.canRedo(), false);
  const write = localStorage.setItem; localStorage.setItem = () => {throw new Error('full');};
  try {
    await store.saveTask({...store.tasks()[0], title: '暫存內容'}); assert.equal(store.canUndo(), true);
    const result = await store.undo(); assert.equal(result.ok, true); assert.equal(result.persisted, false); assert.equal(store.tasks()[0].title, '修改 55');
    const redo = await store.redo(); assert.equal(redo.ok, true); assert.equal(redo.persisted, false); assert.equal(store.tasks()[0].title, '暫存內容');
  } finally { localStorage.setItem = write; }
});

test('重做依序恢復，失敗與無變更不清除路徑，新修改只清除目前空間的重做', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const store = new BoardStore(), first = store.currentWorkspace().id;
  await store.setTaskPinned('task', true); await store.undo(); assert.equal(store.canRedo(), true);
  await store.saveTask(store.tasks()[0]); assert.equal(store.canRedo(), true);
  assert.equal((await store.saveTask({...store.tasks()[0], projectId: 'missing'})).ok, false); assert.equal(store.canRedo(), true);
  await store.saveWorkspace('', '第二空間'); const second = store.currentWorkspace().id;
  await store.saveTask({...task, id: 'second'}); await store.undo(); assert.equal(store.canRedo(), true);
  store.switchWorkspace(first); await store.saveTask({...store.tasks()[0], title: '新的修改'});
  assert.equal(store.canRedo(), false); assert.equal((await store.redo()).ok, false);
  store.switchWorkspace(second); assert.equal(store.canRedo(), true); await store.redo(); assert.equal(store.tasks()[0].id, 'second');
  await store.undo(); await store.resetData(false, store.revision()); assert.equal(store.canRedo(), false);
});

test('重做不覆蓋跨分頁內容，縮放設定不阻擋重做且不被快照覆蓋', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const store = new BoardStore(); await store.setTaskPinned('task', true); await store.undo();
  const peer = new BoardStore(); await peer.setWorkspaceHeaderCompact(true);
  store.refreshFromStorage(); assert.equal(store.canRedo(), true);
  await store.redo(); assert.equal(store.currentWorkspace().headerCompact, true); assert.equal(store.tasks()[0].pinned, true);
  await store.undo(); assert.equal(store.currentWorkspace().headerCompact, true);
  await peer.saveTask({...peer.tasks()[1], title: '另一分頁新內容'});
  assert.equal((await store.redo()).ok, false); assert.equal(store.tasks()[1].title, '另一分頁新內容');
  assert.equal(store.canRedo(), false); assert.equal(store.tasks()[0].pinned, undefined);
});

test('清空垃圾桶清除復原和重做紀錄，不能帶回已清空的任務', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const store = new BoardStore(); await store.deleteTask('task'); await store.restoreTask('task'); await store.undo();
  assert.equal(store.canRedo(), true); assert.equal(store.canUndo(), true);
  assert.equal((await store.emptyTrash(store.trashContext())).ok, true);
  assert.equal(store.canRedo(), false); assert.equal(store.canUndo(), false);
  assert.equal((await store.redo()).ok, false); assert.equal(store.state().tasks.some(task => task.id === 'task'), false);
});

test('工作空間縮放模式逐欄合併、各空間獨立並隨全部和選定備份往返，舊預設不虛構欄位', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const store = new BoardStore(), first = store.currentWorkspace().id, generation = store.generation();
  assert.equal(Object.hasOwn(store.currentWorkspace(), 'headerCompact'), false);
  const peer = new BoardStore(); await peer.saveTask({...peer.tasks()[0], title: '另一分頁編輯'});
  assert.equal((await store.setWorkspaceHeaderCompact(true)).ok, true);
  assert.equal(store.tasks()[0].title, '另一分頁編輯'); assert.equal(store.canUndo(), false);
  assert.equal(new BoardStore().currentWorkspace().headerCompact, true);
  await store.saveWorkspace('', '第二空間'); const second = store.currentWorkspace().id;
  await store.setWorkspaceHeaderCompact(false); store.switchWorkspace(first);
  assert.equal(store.currentWorkspace().headerCompact, true);
  const full = await store.backupForExport('full'), selected = await store.backupForExport('workspaces', [first]);
  assert.equal(full.data.workspaces.find(workspace => workspace.id === second).headerCompact, false);
  assert.equal(selected.data.workspaces[0].headerCompact, true);
  await store.importBackup(selected, store.revision()); assert.equal(store.workspaces().at(-1).headerCompact, true);
  await store.importBackup(full, store.revision()); assert.equal(store.workspaces().find(workspace => workspace.id === first).headerCompact, true);
  assert.equal((await store.setWorkspaceHeaderCompact(false, first, generation)).ok, false);
  assert.equal((await store.setWorkspaceHeaderCompact(false, 'missing')).ok, false);
  await store.setWorkspaceHeaderCompact(false, first);
  await store.setWorkspaceHeaderCompact(true, first, store.generation(), true);
  assert.equal(store.workspaces().find(workspace => workspace.id === first).headerCompact, false);
});

test('釘選逐欄合併跨分頁最新內容，重新載入及備份保留，刪除或重置後不復活', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const first = new BoardStore(), second = new BoardStore(), context = first.taskContext('task');
  await second.saveTask({...second.tasks()[0], title: '另一分頁的新內容'});
  const editedAt = second.tasks()[0].updatedAt;
  assert.equal((await first.setTaskPinned('task', true, context)).ok, true);
  assert.equal(first.tasks()[0].title, '另一分頁的新內容'); assert.equal(first.tasks()[0].updatedAt, editedAt);
  assert.equal(new BoardStore().tasks()[0].pinned, true);
  const backup = await first.backupForExport('full');
  assert.equal(backup.data.workspaces[0].tasks[0].pinned, true); assert.equal(backup.data.workspaces[0].tasks[0].updatedAt, editedAt);
  await first.setTaskPinned('task', false); assert.equal(first.tasks()[0].updatedAt, editedAt);
  await first.importBackup(backup, first.revision()); assert.equal(first.tasks()[0].pinned, true);
  const restoredContext = first.taskContext('task');
  await first.deleteTask('task'); assert.equal((await first.setTaskPinned('task', true, restoredContext)).ok, false);
  assert.equal(first.tasks().some(item => item.id === 'task'), false);
  await first.resetData(false, first.revision());
  assert.equal((await first.setTaskPinned('done', true, context)).ok, false); assert.deepEqual(first.tasks(), []);
});

test('內容編輯記錄時間，釘選及同欄排序保留時間，不幫未修改的舊任務補造紀錄', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const store = new BoardStore();
  await store.setTaskPinned('task', true); assert.equal(store.tasks()[0].updatedAt, undefined);
  await store.saveTask({...store.tasks()[0], description: '第一次修改'});
  const saved = structuredClone(store.tasks()[0]); assert.ok(Number.isFinite(Date.parse(saved.updatedAt)));
  await store.moveTask('task', 'todo'); await store.setTaskPinned('task', false);
  assert.equal(store.tasks().find(item => item.id === 'task').updatedAt, saved.updatedAt);
  assert.equal(store.tasks().find(item => item.id === 'done').updatedAt, undefined);
  await store.saveTask({...task, id: 'new'}); assert.ok(store.tasks().find(item => item.id === 'new').updatedAt);
  await store.moveTask('done', 'progress'); assert.ok(store.tasks().find(item => item.id === 'done').updatedAt);
  assert.equal(new BoardStore().tasks().find(item => item.id === 'task').updatedAt, saved.updatedAt);
});

test('首次使用只有空白工作空間，略過或完成引導後重新載入接續建立；空白選擇不產生專案', async () => {
  storage();
  const store = new BoardStore();
  assert.equal(store.workspaces().length, 1); assert.equal(store.onboarding(), 'guide');
  assert.deepEqual(store.tasks(), []); assert.deepEqual(store.projects(), []); assert.deepEqual(store.categories(), []);
  assert.equal(new BoardStore().onboarding(), 'guide');
  assert.equal((await store.createFirstWorkspace('提早建立')).ok, false);
  assert.equal((await store.finishIntroduction()).ok, true);
  assert.equal(new BoardStore().onboarding(), 'workspace');
  const backup = await store.backupForExport('full');
  assert.equal('onboarding' in backup, false); assert.equal('onboarding' in backup.data, false);
  assert.equal('onboarding' in backup.data.workspaces[0], false);
  assert.equal((await store.createFirstWorkspace('空白工作空間')).ok, true);
  assert.equal(store.workspaces().length, 1); assert.notEqual(store.currentWorkspace().id, 'workspace-default');
  assert.deepEqual(store.projects(), []); assert.deepEqual(store.categories(), []); assert.deepEqual(store.tasks(), []);
  assert.equal(new BoardStore().onboarding(), null);
  await store.resetData(true, store.revision()); assert.equal(new BoardStore().onboarding(), null);
});

test('第一個工作空間的樣板預設不加示範，明確勾選後才加入，全部匯入與雲端還原不帶引導', async () => {
  for (const includeExamples of [undefined, true]) {
    storage(); const store = new BoardStore(); await store.finishIntroduction();
    assert.equal((await store.createFirstWorkspace('研究空間', {templateId: 'research', includeExamples, now: new Date(2026, 9, 9)})).ok, true);
    assert.equal(store.workspaces().length, 1); assert.equal(store.categories().length, 4);
    assert.equal(store.projects()[0].name, '研究空間'); assert.equal(store.tasks().length > 0, includeExamples === true);
    assert.equal(store.onboarding(), null);
  }
  storage(); const store = new BoardStore(); await store.finishIntroduction();
  const blank = await store.backupForExport('full');
  await store.importBackup(blank, store.revision()); assert.equal(new BoardStore().onboarding(), null);
  storage(); const other = new BoardStore(); await other.finishIntroduction();
  await other.applyDriveBackup(blank, other.revision(), []); assert.equal(new BoardStore().onboarding(), null);
});

test('多個分頁建立第一個空間只成功一次；空白空間若已被使用，保留原資料並拒絕替換', async () => {
  storage(); const first = new BoardStore(); await first.finishIntroduction(); const second = new BoardStore();
  const results = await Promise.all([first.createFirstWorkspace('生活'), second.createFirstWorkspace('研究', {templateId: 'research'})]);
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(new BoardStore().workspaces().length, 1); assert.equal(new BoardStore().currentWorkspace().name, '生活');
  storage(); const pending = new BoardStore(); await pending.finishIntroduction(); const peer = new BoardStore();
  await peer.saveProject({id: 'new-project', name: '已開始的計畫'});
  assert.equal((await pending.createFirstWorkspace('覆蓋原資料')).ok, false);
  const saved = new BoardStore(); assert.equal(saved.projects()[0].name, '已開始的計畫'); assert.equal(saved.onboarding(), null);
});

test('第一個工作空間保存失敗保留空白狀態與建立步驟，可再重試', async () => {
  storage(); const store = new BoardStore(); await store.finishIntroduction(); const before = structuredClone(store.workspaceState());
  const write = localStorage.setItem;
  localStorage.setItem = () => {throw new Error('full');};
  try {
    const result = await store.createFirstWorkspace('生活', {templateId: 'students'});
    assert.equal(result.ok, false); assert.match(result.message, /第一個工作空間/);
    assert.deepEqual(store.workspaceState(), before); assert.equal(store.onboarding(), 'workspace');
    assert.equal(new BoardStore().onboarding(), 'workspace');
  } finally {localStorage.setItem = write;}
  assert.equal((await store.createFirstWorkspace('生活')).ok, true); assert.equal(new BoardStore().onboarding(), null);
});

test('稍後建立期間已設定的外部月曆與 Drive 範圍接續到第一個空間，不遺失連線設定', async () => {
  storage(); const store = new BoardStore(); await store.finishIntroduction();
  const previousId = store.currentWorkspace().id;
  assert.equal((await store.updateGoogle({clientId: '123-example.apps.googleusercontent.com'})).ok, true);
  assert.equal((await store.updateGoogle({accountId: 'account', email: 'a@example.com'})).ok, true);
  assert.equal((await store.saveCalendarSource({id: 'source', accountId: 'account', calendarId: 'calendar', name: '我的月曆', color: '#4385d8', visible: true, workspaceIds: [previousId]})).ok, true);
  assert.equal((await store.updateDrive({accountId: 'account', email: 'a@example.com', kind: 'workspaces', workspaceIds: [previousId]})).ok, true);
  assert.equal((await store.createFirstWorkspace('我的生活')).ok, true);
  assert.deepEqual(store.google().sources[0].workspaceIds, [store.currentWorkspace().id]);
  assert.deepEqual(store.drive().workspaceIds, [store.currentWorkspace().id]);
  assert.equal(store.google().email, 'a@example.com'); assert.equal(store.onboarding(), null);
});

test('既有資料與既有空白空間不重新引導；儲存內容損壞時不誤判為首次使用', () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const existing = new BoardStore(); assert.equal(existing.onboarding(), null); assert.deepEqual(existing.tasks(), migratedTasks);
  const empty = {version: 1, activeWorkspaceId: 'workspace-default', workspaces: [{version: 4, id: 'workspace-default', name: '空白工作空間', projects: [], categories: [], tasks: [], statuses: existing.statuses()}]};
  storage({'orbit-workspaces-v1': JSON.stringify(empty)}); assert.equal(new BoardStore().onboarding(), null);
  storage({'orbit-workspaces-v2': '{invalid'}); const corrupt = new BoardStore();
  assert.equal(corrupt.onboarding(), null); assert.ok(corrupt.storageWarning()); assert.equal(localStorage.getItem('orbit-workspaces-v2'), '{invalid');
});

test('提醒設定升級舊資料，跨分頁保存並與外觀修改合併，非法範圍不覆蓋資料', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const first = new BoardStore(), second = new BoardStore();
  assert.equal(first.reminders().dueSoonDays, 3);
  await Promise.all([first.updateReminders({dueSoonDays: 7}), second.updateAppearance({theme: 'dark'})]);
  first.refreshFromStorage(); second.refreshFromStorage();
  assert.equal(second.reminders().dueSoonDays, 7); assert.equal(first.appearance().theme, 'dark');
  assert.equal(new BoardStore().reminders().dueSoonDays, 7);
  assert.equal((await first.updateReminders({dueSoonDays: 0})).ok, false);
  assert.equal((await first.updateReminders({dueSoonDays: 2.5})).ok, false);
  assert.equal(first.reminders().dueSoonDays, 7); assert.equal(first.tasks().length, 2);
});

test('全部備份還原提醒範圍，工作空間匯入保留本機範圍，重置及舊備份有預設值', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const store = new BoardStore();
  await store.updateReminders({dueSoonDays: 10});
  const full = await store.backupForExport('full');
  assert.deepEqual(full.reminders, {...DEFAULT_REMINDERS, dueSoonDays: 10});
  const partial = await store.backupForExport('workspaces', [store.currentWorkspace().id]);
  assert.equal(partial.reminders, undefined);
  await store.updateReminders({dueSoonDays: 5});
  await store.importBackup(partial); assert.equal(store.reminders().dueSoonDays, 5);
  await store.importBackup(full, store.revision()); assert.equal(store.reminders().dueSoonDays, 10);
  await store.resetData(false, store.revision()); assert.equal(store.reminders().dueSoonDays, 10);
  await store.resetData(true, store.revision()); assert.equal(store.reminders().dueSoonDays, 3);
  await store.updateReminders({dueSoonDays: 8});
  delete full.reminders;
  await store.importBackup(full, store.revision()); assert.equal(store.reminders().dueSoonDays, 3);
});

test('提示設定跨分頁逐欄合併、全部備份往返、重置保留或還原，非法選項拒絕', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const first = new BoardStore(), second = new BoardStore();
  await Promise.all([first.updateReminders({leadMinutes: 60, allDayTime: '08:30'}), second.updateReminders({popupEnabled: false, includeGoogle: false})]);
  first.refreshFromStorage(); second.refreshFromStorage();
  const preferences = {...DEFAULT_REMINDERS, leadMinutes: 60, allDayTime: '08:30', popupEnabled: false, includeGoogle: false};
  assert.deepEqual(first.reminders(), preferences); assert.deepEqual(second.reminders(), preferences);
  assert.equal((await first.updateReminders({leadMinutes: 10})).ok, false);
  assert.equal((await first.updateReminders({allDayTime: '24:00'})).ok, false);
  const full = await first.backupForExport('full'); assert.deepEqual(full.reminders, preferences);
  await first.updateReminders(DEFAULT_REMINDERS); await first.importBackup(full, first.revision()); assert.deepEqual(first.reminders(), preferences);
  localStorage.setItem('orbit-reminder-delivery-v1', '[]');
  await first.resetData(false, first.revision()); assert.deepEqual(first.reminders(), preferences); assert.equal(localStorage.getItem('orbit-reminder-delivery-v1'), null);
  await first.resetData(true, first.revision()); assert.deepEqual(first.reminders(), DEFAULT_REMINDERS);
});

function memoryStorage() {
  const values = new Map();
  return {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key)};
}

function storage(saved = {}, fail = false) {
  const values = new Map(Object.entries(saved));
  globalThis.sessionStorage = memoryStorage();
  globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    removeItem: key => values.delete(key),
    setItem: (key, value) => {
      if (fail) throw new Error('Storage unavailable');
      values.set(key, value);
    }
  };
  return values;
}

test('Google 設定與不同工作空間的月曆綁定依序合併，任務及進度不變', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const first = new BoardStore();
  await first.updateGoogle({clientId: '123-example.apps.googleusercontent.com', accountId: 'account', email: 'a@example.com'});
  // A changed Client ID intentionally starts with no account; authorization then sets it.
  await first.updateGoogle({accountId: 'account', email: 'a@example.com'});
  const workspaceId = first.currentWorkspace().id;
  await first.saveWorkspace('', '其他');
  const secondWorkspace = first.currentWorkspace().id;
  const second = new BoardStore();
  const source = {id: 'source', accountId: 'account', calendarId: 'calendar', name: '學程月曆', color: '#759acb', workspaceIds: [], visible: true};
  await first.bindCalendar(source, workspaceId, true);
  await second.bindCalendar({...source, id: 'other-source'}, secondWorkspace, true);
  await first.updateGoogle({refreshMinutes: 15});
  await second.updateAppearance({theme: 'dark'});
  first.refreshFromStorage();
  assert.equal(first.google().sources.length, 1);
  assert.deepEqual(first.google().sources[0].workspaceIds, [workspaceId, secondWorkspace]);
  assert.equal(first.google().refreshMinutes, 15);
  assert.equal(first.appearance().theme, 'dark');
  first.switchWorkspace(workspaceId);
  assert.equal(first.tasks().length, 2);
  assert.equal(first.progress(), 50);
  await first.deleteWorkspace(secondWorkspace);
  assert.deepEqual(first.google().sources[0].workspaceIds, [workspaceId]);
});

test('工作空間副本重建月曆綁定，全部還原暫停排程，重置清空來源但保留或清除 Client ID', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const store = new BoardStore();
  await store.updateGoogle({clientId: '123-example.apps.googleusercontent.com'});
  await store.updateGoogle({accountId: 'account', email: 'a@example.com'});
  const workspaceId = store.currentWorkspace().id;
  await store.bindCalendar({id: 'source', accountId: 'account', calendarId: 'calendar', name: '學程月曆', color: '#123456', workspaceIds: [], visible: true}, workspaceId, true);
  const selected = await store.backupForExport('workspaces', [workspaceId]);
  await store.importBackup(selected);
  const copied = store.currentWorkspace().id;
  assert.notEqual(copied, workspaceId);
  assert.notEqual(store.google().sources[1].id, 'source');
  assert.deepEqual(store.google().sources[1].workspaceIds, [copied]);
  assert.equal(store.google().sources[1].calendarId, 'calendar');
  const portable = await store.backupForExport('workspaces', [copied], true);
  portable.google.clientId = '456-portable.apps.googleusercontent.com';
  await store.importBackup(portable);
  assert.equal(store.google().clientId, '123-example.apps.googleusercontent.com');
  await store.importBackup(portable, undefined, true);
  assert.equal(store.google().clientId, portable.google.clientId);
  assert.equal(store.google().refreshMinutes, 0);
  const full = await store.backupForExport('full');
  await store.importBackup(full, store.revision());
  assert.equal(store.google().refreshMinutes, 0);
  assert.equal(store.google().clientId, full.google.clientId);
  await store.resetData(false, store.revision());
  assert.equal(store.google().sources.length, 0);
  assert.equal(store.google().clientId, full.google.clientId);
  await store.resetData(true, store.revision());
  assert.equal(store.google().clientId, '');
});

test('儲存服務升級既有看板，保留舊儲存鍵與任務，封存不影響原有完成比例', async () => {
  const original = JSON.stringify(legacy);
  const values = storage({'orbit-board-v1': original});
  const store = new BoardStore();
  assert.equal(store.workspaces().length, 1);
  assert.deepEqual(store.tasks(), migratedTasks);
  assert.equal(store.statuses().at(-1).kind, 'archived');
  assert.equal(store.progress(), 50);
  assert.equal(values.get('orbit-board-v1'), original);
  assert.deepEqual(new BoardStore().tasks(), migratedTasks);
});

test('建立、改名、切換與重新讀取工作空間，各自的任務分類狀態完全獨立', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const store = new BoardStore();
  const original = structuredClone(store.currentWorkspace());
  await store.saveWorkspace('', '研究計畫');
  const secondId = store.currentWorkspace().id;
  assert.deepEqual(store.tasks(), []);
  await store.saveCategory({id: 'research', name: '研究', color: 'green'});
  await store.saveStatus({id: 'waiting', label: '等待回覆', subtitle: '', color: 'pink', kind: 'active'});
  await store.saveTask({...task, id: 'second', categoryId: 'research', status: 'waiting'});
  await store.saveProject({id: 'experiment', name: '實驗進度'});
  await store.saveWorkspace(secondId, '研究工作台');
  store.switchWorkspace(original.id);
  assert.deepEqual(store.currentWorkspace(), original);
  store.switchWorkspace(secondId);
  const reloaded = new BoardStore();
  assert.equal(reloaded.currentWorkspace().name, '研究工作台');
  assert.deepEqual(reloaded.projects().map(project => project.name), ['研究計畫', '實驗進度']);
  assert.equal(reloaded.tasks()[0].categoryId, 'research');
  assert.equal(reloaded.tasks()[0].status, 'waiting');
  assert.equal(reloaded.workspaces()[0].tasks.length, 2);
});

test('封存與恢復會更新完成比例，自訂完成狀態的語意及儲存皆正確', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const store = new BoardStore();
  await store.moveTask('task', 'archived');
  assert.equal(store.tasks().length, 2);
  assert.equal(store.activeTasks().length, 1);
  assert.equal(store.progress(), 100);
  await store.moveTask('task', 'todo');
  assert.equal(store.progress(), 50);
  await store.saveStatus({id: 'shipped', label: '交付完成', subtitle: '', color: 'green', kind: 'done'});
  await store.moveTask('task', 'shipped');
  assert.equal(store.completed(), 2);
  assert.equal(new BoardStore().progress(), 100);
});

test('調整自訂狀態順序及刪除使用中的狀態，保留任務並保存目的地', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const store = new BoardStore();
  await store.saveStatus({id: 'waiting', label: '等待回覆', subtitle: '', color: 'pink', kind: 'active'});
  await store.moveTask('task', 'waiting');
  await store.reorderStatus('waiting', -1);
  assert.equal(store.statuses().at(-2).id, 'waiting');
  await store.deleteStatus('waiting', 'progress');
  assert.equal(store.tasks().find(item => item.id === 'task').status, 'progress');
  assert.equal(store.statuses().some(item => item.id === 'waiting'), false);
  assert.equal(new BoardStore().tasks().find(item => item.id === 'task').status, 'progress');
  const before = structuredClone(store.workspaceState());
  await store.moveTask('task', 'missing');
  await store.saveTask({...task, status: 'missing'});
  assert.deepEqual(store.workspaceState(), before);
});

test('刪除目前工作空間後選取保留的空間，最後一個工作空間不能刪除', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const store = new BoardStore();
  const firstId = store.currentWorkspace().id;
  await store.saveWorkspace('', '暫存');
  await store.deleteWorkspace(store.currentWorkspace().id);
  assert.equal(store.currentWorkspace().id, firstId);
  assert.deepEqual(store.tasks(), migratedTasks);
  await store.deleteWorkspace(firstId);
  assert.equal(store.workspaces().length, 1);
  assert.equal(new BoardStore().currentWorkspace().id, firstId);
});

test('瀏覽器無法保存時保留記憶體內的操作與原始資料，顯示儲存提示', async () => {
  const original = JSON.stringify(legacy);
  const values = storage({'orbit-board-v1': original}, true);
  const store = new BoardStore();
  await store.saveWorkspace('', '離線暫存');
  await store.saveTask({...task, id: 'new'});
  assert.equal(store.tasks().length, 1);
  assert.match(store.storageWarning(), /無法儲存/);
  assert.equal(values.get('orbit-board-v1'), original);
});

test('隱藏設定依工作空間保存，重讀後保留且不改動任務或完成比例', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const store = new BoardStore();
  const firstId = store.currentWorkspace().id;
  const before = structuredClone(store.tasks());
  await store.saveStatus({...store.statuses().find(status => status.id === 'todo'), hidden: true});
  await store.saveStatus({...store.statuses().find(status => status.id === 'archived'), hidden: false});
  assert.deepEqual(store.tasks(), before);
  assert.equal(store.progress(), 50);
  await store.saveWorkspace('', '獨立工作台');
  assert.equal(store.statuses().find(status => status.id === 'todo').hidden, false);
  assert.equal(store.statuses().find(status => status.id === 'archived').hidden, true);
  store.switchWorkspace(firstId);
  const reloaded = new BoardStore();
  assert.equal(reloaded.statuses().find(status => status.id === 'todo').hidden, true);
  assert.equal(reloaded.statuses().find(status => status.id === 'archived').hidden, false);
  assert.deepEqual(reloaded.tasks(), before);
});

test('兩個未重新整理的分頁修改不同任務，保存時讀取最新資料而不互相覆蓋', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const first = new BoardStore();
  const second = new BoardStore();
  await first.saveTask({...first.tasks()[0], title: '分頁 A 修改'});
  await second.saveTask({...second.tasks()[1], title: '分頁 B 修改'});
  first.refreshFromStorage();
  assert.deepEqual(first.tasks().map(task => task.title), ['分頁 A 修改', '分頁 B 修改']);
  assert.deepEqual(new BoardStore().tasks(), first.tasks());
});

test('同一任務的過期草稿拒絕覆蓋，外部刪除也不會被草稿偷偷復活', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const first = new BoardStore();
  const second = new BoardStore();
  const context = second.taskContext('task');
  const draft = {...second.tasks()[0], title: '舊草稿'};
  await first.saveTask({...first.tasks()[0], title: '另一分頁最新修改'});
  second.refreshFromStorage();
  const result = await second.saveTask(draft, context);
  assert.equal(result.ok, false);
  assert.match(result.message, /草稿已保留/);
  assert.equal(new BoardStore().tasks()[0].title, '另一分頁最新修改');
  await first.deleteTask('task');
  assert.equal((await second.saveTask(draft, context)).ok, false);
  assert.equal(new BoardStore().tasks().some(task => task.id === 'task'), false);
});

test('不同分頁保留自己的工作空間，切換不會寫入或跳轉其他分頁', async () => {
  const values = storage({'orbit-board-v1': JSON.stringify(legacy)});
  const first = new BoardStore();
  await first.saveWorkspace('', '第二空間');
  globalThis.sessionStorage = memoryStorage();
  const second = new BoardStore();
  const before = values.get('orbit-workspaces-v2');
  second.switchWorkspace(second.workspaces()[1].id);
  assert.equal(values.get('orbit-workspaces-v2'), before);
  await first.saveProject({id: 'experiment', name: '原空間更新'});
  second.refreshFromStorage();
  assert.equal(second.currentWorkspace().name, '第二空間');
  assert.equal(first.currentWorkspace().name, '第二空間');
  first.switchWorkspace(first.workspaces()[0].id);
  await first.saveProject({id: 'experiment', name: '第一空間更新'});
  second.refreshFromStorage();
  assert.notEqual(first.currentWorkspace().id, second.currentWorkspace().id);
  assert.equal(second.workspaces()[0].projects.at(-1).name, '第一空間更新');
});

test('外部分頁刪除目的狀態或任務後，移動與狀態刪除明確失敗而不改動最新資料', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const first = new BoardStore();
  const second = new BoardStore();
  await first.deleteStatus('progress', 'todo');
  const afterStatusDeletion = structuredClone(new BoardStore().workspaceState());
  assert.equal((await second.moveTask('task', 'progress')).ok, false);
  assert.equal((await second.deleteStatus('todo', 'progress')).ok, false);
  assert.deepEqual(new BoardStore().workspaceState(), afterStatusDeletion);
  await first.deleteTask('task');
  assert.equal((await second.moveTask('task', 'done')).ok, false);
  assert.equal(new BoardStore().tasks().some(task => task.id === 'task'), false);
});

test('工作空間備份可重複匯入為獨立副本，其他資料保留', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const store = new BoardStore();
  const original = structuredClone(store.workspaces()[0]);
  const backup = createBackup(store.workspaceState(), 'workspaces', [original.id], 'small');
  assert.equal((await store.importBackup(backup)).ok, true);
  assert.equal((await store.importBackup(backup)).ok, true);
  assert.equal(store.workspaces().length, 3);
  assert.deepEqual(store.workspaces()[0], original);
  assert.equal(new Set(store.workspaces().map(workspace => workspace.id)).size, 3);
  assert.equal(new Set(store.workspaces().map(workspace => workspace.tasks[0].id)).size, 3);
});

test('全部匯入要求確認版本，期間新增資料會阻止覆蓋，成功後拒絕舊世代草稿', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const first = new BoardStore();
  const second = new BoardStore();
  const context = second.taskContext('task');
  const backup = createBackup(first.workspaceState(), 'full', [], 'standard');
  const confirmed = first.revision();
  assert.equal((await first.importBackup(backup)).ok, false);
  await second.saveTask({...task, id: 'added'});
  assert.equal((await first.importBackup(backup, confirmed)).ok, false);
  assert.equal(new BoardStore().tasks().length, 3);
  first.refreshFromStorage();
  assert.equal((await first.importBackup(backup, first.revision())).ok, true);
  assert.equal(new BoardStore().tasks().length, 2);
  assert.equal((await second.saveTask({...task, title: '舊草稿'}, context)).ok, false);
  assert.equal(new BoardStore().tasks()[0].title, task.title);
});

test('匯入保存失敗時不套用新資料，並保留原儲存內容', async () => {
  const values = storage({'orbit-board-v1': JSON.stringify(legacy)}, true);
  const store = new BoardStore();
  const before = structuredClone(store.workspaceState());
  const backup = createBackup(before, 'workspaces', [before.activeWorkspaceId], 'small');
  const result = await store.importBackup(backup);
  assert.equal(result.ok, false);
  assert.deepEqual(store.workspaceState(), before);
  assert.equal(values.get('orbit-workspaces-v2'), undefined);
  assert.equal(values.get('orbit-board-v1'), JSON.stringify(legacy));
});

test('儲存失敗後的後續修改不丟掉已暫存內容，可完整匯出', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)}, true);
  const store = new BoardStore();
  await store.saveTask({...task, id: 'temporary'});
  await store.saveProject({id: 'temporary-project', name: '暫存名稱'});
  const snapshot = await store.snapshotForExport();
  assert.equal(snapshot.workspaces[0].tasks.length, 3);
  assert.equal(snapshot.workspaces[0].projects.at(-1).name, '暫存名稱');
  assert.equal(store.hasUnsavedChanges(), true);
});

test('專案新增、任務歸屬與改名皆可儲存，分類共用，移除專案仍保留最新任務', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const first = new BoardStore();
  await first.saveProject({id: 'welcome', name: '迎新活動'});
  await first.saveCategory({id: 'admin', name: '行政', color: 'green'});
  await first.saveTask({...first.tasks()[0], projectId: 'welcome', categoryId: 'admin'});
  const second = new BoardStore();
  const draftContext = second.taskContext('task');
  await first.saveProject({id: 'welcome', name: '新生迎新'});
  assert.equal(new BoardStore().projects().find(project => project.id === 'welcome').name, '新生迎新');
  await second.saveTask({...second.tasks()[0], title: '最新任務內容'});
  await first.deleteProject(first.projects().find(project => project.id === 'welcome'));
  const reloaded = new BoardStore();
  assert.equal(reloaded.tasks()[0].projectId, '');
  assert.equal(reloaded.tasks()[0].title, '最新任務內容');
  assert.equal(reloaded.tasks()[0].categoryId, 'admin');
  assert.equal(reloaded.tasks().length, 2);
  assert.equal((await second.saveTask({...task, projectId: 'welcome'}, draftContext)).ok, false);
});

test('專案改名偵測過期表單，拒絕同名與未知專案的任務；新工作空間建立同名預設專案', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const first = new BoardStore();
  const second = new BoardStore();
  const original = {...second.projects()[0]};
  await first.saveProject({...original, name: '新名稱'});
  second.refreshFromStorage();
  assert.equal((await second.saveProject({...original, name: '過期名稱'}, original)).ok, false);
  assert.equal((await second.saveProject({id: 'duplicate', name: '新名稱'}, null)).ok, false);
  assert.equal((await second.saveTask({...task, id: 'unknown', projectId: 'missing'})).ok, false);
  assert.equal(new BoardStore().projects()[0].name, '新名稱');
  await first.saveWorkspace('', '新的空間');
  assert.equal(first.projects().length, 1);
  assert.equal(first.projects()[0].name, '新的空間');
  assert.deepEqual(first.tasks(), []);
});

test('專案封存與還原跨分頁持久保存，保留最新任務並拒絕過期專案操作', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const first = new BoardStore(), second = new BoardStore();
  const original = {...first.projects()[0]};
  await second.saveTask({...second.tasks()[0], title: '其他分頁的新內容'});
  assert.equal((await first.setProjectArchived(original, true)).ok, true);
  second.refreshFromStorage();
  assert.equal(second.projects()[0].archived, true);
  assert.equal(second.progress(), 0);
  assert.equal(second.tasks()[0].title, '其他分頁的新內容');
  assert.equal(second.tasks().length, 2);
  assert.equal((await first.saveProject({...original, name: '過期改名'}, original)).ok, false);
  assert.equal((await first.setProjectArchived(original, false)).ok, false);
  assert.equal((await second.saveProject({id: original.id, name: '已結案專案'})).ok, true);
  assert.equal(second.projects()[0].archived, true);
  const archived = {...second.projects()[0]};
  const backup = await second.backupForExport('full');
  assert.equal(backup.data.workspaces[0].projects[0].archived, true);
  await second.setProjectArchived(archived, false);
  assert.equal(new BoardStore().progress(), 50);
  await second.importBackup(backup, second.revision());
  assert.equal(new BoardStore().projects()[0].archived, true);
  assert.equal(new BoardStore().progress(), 0);
});

test('分類排序合併其他分頁的最新分類內容、任務與新增分類，邊界不遺失資料', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const first = new BoardStore();
  for (const id of ['a', 'b', 'c']) await first.saveCategory({id, name: id.toUpperCase(), color: 'green'});
  await first.saveTask({...first.tasks()[0], categoryId: 'b'});
  const second = new BoardStore();
  await second.saveCategory({id: 'b', name: '新分類名稱', color: '#123456'});
  await second.saveCategory({id: 'd', name: '新增分類', color: 'blue'});
  await second.saveTask({...second.tasks()[0], title: '最新任務'});
  await first.reorderCategory('b', -1);
  second.refreshFromStorage();
  assert.deepEqual(second.categories().map(category => category.id), ['b', 'a', 'c', 'd']);
  assert.equal(second.categories()[0].name, '新分類名稱');
  assert.equal(second.categories()[0].color, '#123456');
  assert.equal(second.tasks()[0].title, '最新任務');
  assert.equal(second.tasks()[0].categoryId, 'b');
  await first.reorderCategory('b', -1); await first.reorderCategory('d', 1); await first.reorderCategory('missing', 1);
  assert.deepEqual(new BoardStore().categories().map(category => category.id), ['b', 'a', 'c', 'd']);
  const exported = await first.backupForExport('workspaces', [first.currentWorkspace().id]);
  await first.importBackup(exported);
  assert.deepEqual(first.categories().map(category => category.name), ['新分類名稱', 'A', 'C', '新增分類']);
  const replacement = new BoardStore();
  await replacement.resetData(false, replacement.revision());
  assert.equal((await first.reorderCategory(first.categories()[0].id, 1)).ok, false);
});

test('建立樣板工作空間合併同時的本機修改，停用示範可建立只有分類專案的空間', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const first = new BoardStore(), second = new BoardStore();
  const originalId = first.currentWorkspace().id;
  const create = first.saveWorkspace('', '研究工作台', {templateId: 'research', now: new Date(2026, 9, 9)});
  await second.saveTask({...second.tasks()[0], title: '仍應保留的更新'});
  assert.equal((await create).ok, true);
  assert.equal(first.currentWorkspace().name, '研究工作台');
  assert.equal(first.projects()[0].name, '研究工作台');
  assert.equal(first.tasks().length, 5);
  assert.ok(first.tasks().every(task => task.projectId && task.startDate >= '2026-10-04' && task.dueDate <= '2026-10-10'));
  assert.equal(first.workspaces().find(workspace => workspace.id === originalId).tasks[0].title, '仍應保留的更新');
  await first.saveWorkspace('', '教學工作', {templateId: 'courses', includeExamples: false});
  assert.equal(first.tasks().length, 0); assert.equal(first.categories().length, 4); assert.equal(first.projects().length, 2);
  const saved = structuredClone(first.currentWorkspace());
  const result = await first.saveWorkspace('', '未知樣板', {templateId: 'unknown'});
  assert.equal(result.ok, false); assert.deepEqual(first.currentWorkspace(), saved);
  await first.saveWorkspace(saved.id, '修改名稱', {templateId: 'research'});
  assert.equal(first.categories()[0].name, '授課安排');
  assert.equal(first.projects()[0].name, saved.name);
});

test('舊字體偏好升級，兩分頁修改不同外觀欄位並保存任務不會互相覆蓋', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy), 'orbit-text-size-v1': 'small'});
  const first = new BoardStore(), second = new BoardStore();
  assert.equal(first.appearance().textSize, 'small');
  await Promise.all([first.updateAppearance({theme: 'dark'}), second.updateAppearance({accent: '#3366aa'})]);
  await first.moveTask('task', 'progress');
  second.refreshFromStorage();
  assert.deepEqual(second.appearance(), {textSize: 'small', theme: 'dark', accent: '#3366aa'});
  assert.equal(second.tasks().find(task => task.id === 'task').status, 'progress');
  assert.deepEqual(new BoardStore().appearance(), second.appearance());
});

test('清空工作資料保留外觀，移除舊來源且重新載入不復活範例；其他分頁拒絕過期草稿', async () => {
  const values = storage({'orbit-board-v1': JSON.stringify(legacy), 'orbit-board-v1-backup': 'old', 'orbit-text-size-v1': 'small', 'another-app': 'keep'});
  const first = new BoardStore();
  await first.updateAppearance({theme: 'dark', accent: '#3366aa'});
  const second = new BoardStore(), context = second.taskContext('task');
  const oldGeneration = first.generation();
  assert.equal((await first.resetData(false, first.revision())).ok, true);
  assert.notEqual(first.generation(), oldGeneration);
  assert.equal(first.workspaces().length, 1);
  assert.equal(first.tasks().length, 0);
  assert.equal(values.has('orbit-board-v1'), false);
  assert.equal(values.has('orbit-board-v1-backup'), false);
  assert.equal(values.has('orbit-text-size-v1'), false);
  assert.equal(values.get('another-app'), 'keep');
  assert.deepEqual(new BoardStore().tasks(), []);
  assert.deepEqual(new BoardStore().appearance(), {textSize: 'small', theme: 'dark', accent: '#3366aa'});
  assert.equal((await second.saveTask({...context.original, title: '過期任務'}, context)).ok, false);
  assert.equal(second.tasks().length, 0);
});

test('重置整個 Orbit 也還原外觀，其他分頁同步新世代與空白工作空間', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const first = new BoardStore();
  await first.updateAppearance({theme: 'dark', textSize: 'extra-small', accent: '#ff00ff'});
  const second = new BoardStore();
  assert.equal((await first.resetData(true, first.revision())).ok, true);
  second.refreshFromStorage();
  assert.equal(second.tasks().length, 0);
  assert.deepEqual(second.appearance(), {textSize: 'standard', theme: 'light', accent: '#31584b'});
  assert.equal(second.generation(), first.generation());
  assert.match(second.syncNotice(), /重置/);
});

test('重置確認期間任何資料或設定更新都拒絕覆蓋；未刷新分頁不能把偏好寫回新世代', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const first = new BoardStore(), second = new BoardStore();
  const confirmed = first.revision();
  await second.updateAppearance({theme: 'dark'});
  assert.equal((await first.resetData(true, confirmed)).ok, false);
  assert.equal(first.tasks().length, 2);
  first.refreshFromStorage();
  assert.equal((await first.resetData(true, first.revision())).ok, true);
  assert.equal((await second.updateAppearance({accent: '#112233'})).ok, false);
  assert.equal(new BoardStore().appearance().accent, '#31584b');
});

test('儲存失敗時不執行重置或清理舊來源，外觀暫存仍可完整匯出', async () => {
  const values = storage({'orbit-board-v1': JSON.stringify(legacy)}, true);
  const store = new BoardStore();
  await store.updateAppearance({theme: 'dark', accent: '#3366aa'});
  assert.equal(store.hasUnsavedChanges(), true);
  const backup = await store.backupForExport('full');
  assert.equal(Object.hasOwn(backup.preferences, 'theme'), false); assert.equal(backup.preferences.accent, '#3366aa');
  assert.equal(backup.data.workspaces[0].tasks.length, 2);
  assert.equal((await store.resetData(true, store.revision())).ok, false);
  assert.equal(values.has('orbit-board-v1'), true);
  assert.equal(store.tasks().length, 2);
  assert.equal(store.appearance().theme, 'dark');
});

test('全部備份原子還原主題色與自訂顏色，保留本機深淺主題，工作空間副本不改全域設定', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const store = new BoardStore();
  await store.updateAppearance({theme: 'dark', accent: '#3366aa', textSize: 'compact'});
  await store.saveCategory({id: 'custom', name: '自訂', color: '#123456'});
  await store.saveStatus({...store.statuses()[0], color: '#ffffff'});
  const backup = await store.backupForExport('full');
  await store.updateAppearance({theme: 'light'});
  assert.equal((await store.importBackup(backup, store.revision())).ok, true);
  assert.equal(store.appearance().theme, 'light');
  assert.equal(store.categories()[0].color, '#123456');
  const workspaceBackup = await store.backupForExport('workspaces', [store.currentWorkspace().id]);
  await store.updateAppearance({theme: 'light'});
  assert.equal((await store.importBackup(workspaceBackup)).ok, true);
  assert.equal(store.appearance().theme, 'light');
  assert.equal(store.categories()[0].color, '#123456');
});

test('深淺主題與字級保存在本機及同來源分頁，新舊完整備份與同步都保留目前選擇', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const first = new BoardStore(), second = new BoardStore();
  await first.updateAppearance({textSize: 'extra-large'});
  second.refreshFromStorage();
  assert.equal(second.appearance().textSize, 'extra-large');
  assert.equal(new BoardStore().appearance().textSize, 'extra-large');
  const exported = await first.backupForExport('full');
  assert.equal(Object.hasOwn(exported.preferences, 'textSize'), false);
  assert.equal(Object.hasOwn(exported.preferences, 'theme'), false);
  for (const theme of ['light', 'dark', 'system']) {
    await first.updateAppearance({theme}); second.refreshFromStorage(); assert.equal(second.appearance().theme, theme);
    for (const formatVersion of [1, 2, 3, 4, 5]) {
      const old = {...structuredClone(exported), formatVersion, preferences: {textSize: 'compact', theme: theme === 'dark' ? 'light' : 'dark', accent: '#3264ad'}};
      assert.equal((await first.importBackup(old, first.revision())).ok, true);
      assert.deepEqual(first.appearance(), {textSize: 'extra-large', theme, accent: '#3264ad'});
      const snapshot = await first.driveSnapshot('full', []);
      assert.equal(Object.hasOwn(snapshot.backup.preferences, 'textSize'), false); assert.equal(Object.hasOwn(snapshot.backup.preferences, 'theme'), false);
      assert.equal((await first.applyDriveBackup(old, snapshot.revision, [])).ok, true);
      assert.deepEqual(first.appearance(), {textSize: 'extra-large', theme, accent: '#3264ad'});
    }
  }
  const withoutPreferences = structuredClone(exported); delete withoutPreferences.preferences;
  assert.equal((await first.importBackup(withoutPreferences, first.revision())).ok, true);
  assert.equal(first.appearance().textSize, 'extra-large');
  assert.equal(new BoardStore().appearance().textSize, 'extra-large');
  assert.equal(new BoardStore().appearance().theme, 'system');
});

test('非法自訂顏色與外觀設定拒絕儲存，不更動任務或外觀', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const store = new BoardStore();
  assert.equal((await store.saveCategory({id: 'bad', name: '壞色碼', color: 'red'})).ok, false);
  assert.equal((await store.updateAppearance({accent: 'url(example)'})).ok, false);
  assert.equal((await store.updateAppearance({theme: 'other'})).ok, false);
  assert.equal(store.tasks().length, 2);
  assert.equal(store.appearance().accent, '#31584b');
});

test('Drive 全部同步套用外觀、提醒與月曆設定，保留 Google 連線及 Drive 控制設定', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const store = new BoardStore(), id = store.currentWorkspace().id;
  await store.updateAppearance({theme: 'dark', accent: '#3264ad', textSize: 'compact'}); await store.updateReminders({leadMinutes: 60});
  await store.updateGoogle({clientId: '123-local.apps.googleusercontent.com'});
  await store.updateGoogle({accountId: 'local', email: 'local@example.com', refreshMinutes: 15});
  await store.updateDrive({accountId: 'drive', email: 'drive@example.com', mode: 'sync'});
  const snapshot = await store.driveSnapshot('full', []), remote = structuredClone(snapshot.backup);
  remote.data.workspaces[0].tasks[0].title = '雲端更新'; remote.data.workspaces[0].headerCompact = true; remote.preferences = {theme: 'light', accent: '#7951b0', textSize: 'extra-small'}; remote.reminders.leadMinutes = 15;
  remote.google = {...remote.google, clientId: '456-remote.apps.googleusercontent.com', accountId: 'remote', email: 'remote@example.com', refreshMinutes: 1, sources: [{id: 'remote-source', accountId: 'remote', calendarId: 'calendar', name: '研究行事曆', color: '#31584b', visible: true, workspaceIds: [id]}]};
  assert.equal((await store.applyDriveBackup(remote, snapshot.revision, [])).ok, true);
  assert.equal(store.tasks()[0].title, '雲端更新'); assert.deepEqual(store.appearance(), {...remote.preferences, theme: 'dark', textSize: 'compact'}); assert.deepEqual(store.reminders(), remote.reminders);
  assert.equal(store.currentWorkspace().headerCompact, true);
  assert.equal(store.google().clientId, '123-local.apps.googleusercontent.com'); assert.equal(store.google().accountId, 'local'); assert.equal(store.google().refreshMinutes, 1);
  assert.equal(store.google().email, 'local@example.com'); assert.deepEqual(store.drive(), snapshot.backup.drive);
  assert.equal(store.google().sources[0].calendarId, 'calendar'); assert.notEqual(store.google().sources[0].id, 'remote-source'); assert.equal(store.drive().accountId, 'drive');
});

test('Drive 全部資料備份包含各項設定，全部還原套用主題色與提醒並先關閉雲端自動處理', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const store = new BoardStore(), id = store.currentWorkspace().id;
  const appearance = {theme: 'dark', accent: '#3264ad', textSize: 'extra-small'};
  const reminders = {...DEFAULT_REMINDERS, dueSoonDays: 7, leadMinutes: 60, allDayTime: '08:30', popupEnabled: false, includeGoogle: false};
  await store.updateAppearance(appearance); await store.updateReminders(reminders);
  await store.updateGoogle({clientId: '123-local.apps.googleusercontent.com'});
  await store.updateGoogle({accountId: 'calendar-account', email: 'calendar@example.com', refreshMinutes: 15});
  await store.saveCalendarSource({id: 'source', accountId: 'calendar-account', calendarId: 'calendar', name: '學程月曆', color: '#7951b0', visible: false, workspaceIds: [id]});
  await store.updateDrive({accountId: 'drive-account', email: 'drive@example.com', mode: 'backup', debounceSeconds: 30, pollMinutes: 15});
  const {backup} = await store.driveSnapshot('full', []);
  assert.deepEqual(backup.preferences, {accent: appearance.accent}); assert.deepEqual(backup.reminders, reminders);
  assert.deepEqual(backup.google, store.google()); assert.deepEqual(backup.drive, store.drive());
  await store.updateAppearance({accent: '#31584b', theme: 'light', textSize: 'standard'}); await store.updateReminders(DEFAULT_REMINDERS);
  assert.equal((await store.importBackup(backup, store.revision())).ok, true);
  assert.deepEqual(store.appearance(), {...appearance, theme: 'light', textSize: 'standard'}); assert.deepEqual(store.reminders(), reminders);
  assert.deepEqual(store.google(), {...backup.google, refreshMinutes: 0});
  assert.deepEqual(store.drive(), {...backup.drive, mode: 'off'});
  assert.deepEqual(new BoardStore().appearance(), {...appearance, theme: 'light', textSize: 'standard'});
  const selected = (await store.driveSnapshot('workspaces', [id])).backup;
  assert.equal(selected.preferences, undefined); assert.equal(selected.reminders, undefined); assert.equal(selected.drive, undefined);
  assert.deepEqual(selected.calendarSources, backup.google.sources);
});

test('Drive 選定範圍套用保留其他空間與整體偏好，同步來源名稱且拒絕過期確認及儲存失敗', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const store = new BoardStore(), first = store.currentWorkspace().id;
  await store.saveWorkspace('', '保留的空間'); const second = store.currentWorkspace().id;
  await store.setWorkspaceHeaderCompact(false);
  await store.updateGoogle({clientId: '123-local.apps.googleusercontent.com', accountId: 'account', email: 'a@example.com'});
  await store.saveCalendarSource({id: 'local-source', accountId: 'account', calendarId: 'calendar', name: '自訂名稱', color: '#123456', visible: false, workspaceIds: [first, second]});
  const snapshot = await store.driveSnapshot('workspaces', [first]), remote = structuredClone(snapshot.backup);
  remote.data.workspaces[0].name = '雲端研究'; remote.data.workspaces[0].headerCompact = true; remote.calendarSources[0].id = 'remote-source'; remote.calendarSources[0].name = '遠端名稱';
  await store.updateAppearance({theme: 'dark'}); assert.equal((await store.applyDriveBackup(remote, snapshot.revision, [first])).ok, false);
  assert.equal((await store.applyDriveBackup(remote, store.revision(), [first])).ok, true);
  assert.equal(store.workspaces().find(w => w.id === second).name, '保留的空間'); assert.equal(store.workspaces().find(w => w.id === first).name, '雲端研究');
  assert.equal(store.workspaces().find(w => w.id === second).headerCompact, false); assert.equal(store.workspaces().find(w => w.id === first).headerCompact, true);
  const source = store.google().sources[0]; assert.equal(source.id, 'local-source'); assert.equal(source.name, '遠端名稱'); assert.equal(source.visible, false); assert.deepEqual(new Set(source.workspaceIds), new Set([first, second]));
  assert.equal(store.appearance().theme, 'dark');
  const original = globalThis.localStorage.setItem;
  globalThis.localStorage.setItem = () => {throw new Error('quota');};
  try {remote.data.workspaces[0].name = '不能套用'; assert.equal((await store.applyDriveBackup(remote, store.revision(), [first])).ok, false); assert.equal(store.workspaces().find(w => w.id === first).name, '雲端研究');}
  finally {globalThis.localStorage.setItem = original;}
});

test('Drive 設定跨分頁保存，刪除同步範圍空間會關閉自動處理，完整匯入與重置均暫停 Drive', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const store = new BoardStore(), original = store.currentWorkspace().id;
  await store.saveWorkspace('', '其他空間');
  await store.updateDrive({accountId: 'account', email: 'a@example.com', kind: 'workspaces', workspaceIds: [original], mode: 'sync'});
  const peer = new BoardStore(); assert.equal(peer.drive().mode, 'sync');
  const full = await store.backupForExport('full');
  await store.deleteWorkspace(original); peer.refreshFromStorage(); assert.equal(peer.drive().mode, 'off'); assert.deepEqual(peer.drive().workspaceIds, []);
  assert.equal((await store.importBackup(full, store.revision())).ok, true); assert.equal(store.drive().mode, 'off'); assert.equal(store.drive().email, 'a@example.com');
  await store.updateDrive({mode: 'backup'}); await store.resetData(false, store.revision()); assert.equal(store.drive().mode, 'off'); assert.deepEqual(store.drive().workspaceIds, []);
  await store.resetData(true, store.revision()); assert.deepEqual(store.drive(), DEFAULT_DRIVE);
});

test('Drive 同步缺少舊設定時保留本機偏好，完整設定寫入失敗時不部分套用外觀或提醒', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)}); const store = new BoardStore();
  await store.updateAppearance({theme: 'dark', accent: '#3264ad', textSize: 'compact'}); await store.updateReminders({leadMinutes: 60});
  const appearance = structuredClone(store.appearance()), reminders = structuredClone(store.reminders());
  const snapshot = await store.driveSnapshot('full', []), old = structuredClone(snapshot.backup); delete old.preferences; delete old.reminders;
  assert.equal((await store.applyDriveBackup(old, snapshot.revision, [])).ok, true); assert.deepEqual(store.appearance(), appearance); assert.deepEqual(store.reminders(), reminders);
  const remote = structuredClone(snapshot.backup); remote.preferences = {...appearance, theme: 'light', accent: '#7951b0'}; remote.reminders.leadMinutes = 30; remote.data.workspaces[0].tasks[0].title = '寫入失敗的資料';
  const workspaces = structuredClone(store.workspaces()), write = localStorage.setItem;
  localStorage.setItem = () => {throw new Error('quota');};
  try {assert.equal((await store.applyDriveBackup(remote, store.revision(), [])).ok, false); assert.deepEqual(store.appearance(), appearance); assert.deepEqual(store.reminders(), reminders); assert.deepEqual(store.workspaces(), workspaces);}
  finally {localStorage.setItem = write;}
});

test('來源整理只移除真孤立記錄，保留事件、垃圾桶與任務修改時間', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const seed = new BoardStore().workspaceState(), workspace = seed.workspaces[0];
  const sources = ['orphan', 'removed', 'trash'].map(id => documentFromUrl('google-drive', 'https://drive.google.com/file/d/' + id + '/view', id));
  workspace.version = 5; workspace.documentSources = sources; workspace.tasks[1].deletedAt = '2026-10-15T00:00:00.000Z';
  workspace.documentLinks = [{id: 'removed-event', taskId: 'task', documentId: sources[1].id, removed: true}, {id: 'trash-event', taskId: 'done', documentId: sources[2].id}];
  storage({'orbit-workspaces-v1': JSON.stringify(seed)});
  const store = new BoardStore(), tasks = JSON.stringify(store.state().tasks), links = JSON.stringify(store.state().documentLinks);
  assert.equal(store.documentCleanupPreview().filter(item => !item.reasons.length).length, 1);
  const result = await store.cleanUnusedDocumentSources(); assert.equal(result.ok, true); assert.equal(result.removed, 1);
  assert.deepEqual(store.state().documentSources.map(source => source.id), sources.slice(1).map(source => source.id));
  assert.equal(JSON.stringify(store.state().tasks), tasks); assert.equal(JSON.stringify(store.state().documentLinks), links);
  assert.equal(new BoardStore().state().documentSources.length, 2);
});

test('來源整理保護復原／重做及即時草稿／未完成建立的引用', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const seed = new BoardStore().workspaceState(), file = documentFromUrl('google-drive', 'https://drive.google.com/file/d/protected-orphan/view', '保護來源');
  Object.assign(seed.workspaces[0], {version: 5, documentSources: [file], documentLinks: []}); storage({'orbit-workspaces-v1': JSON.stringify(seed)});
  const store = new BoardStore(), release = store.protectDocumentSources(() => new Set([file.id]));
  assert.match(store.documentCleanupPreview()[0].reasons.join(), /草稿/); assert.equal((await store.cleanUnusedDocumentSources()).ok, false);
  release(); await store.saveTask({...store.tasks()[0], description: '建立可復原的版本'});
  assert.match(store.documentCleanupPreview()[0].reasons.join(), /復原/); assert.equal((await store.cleanUnusedDocumentSources()).ok, false);
  assert.equal((await store.undo()).ok, true); assert.equal(store.state().documentSources[0].id, file.id);
});

test('來源清理在寫入鎖內重讀，其他分頁剛新增引用時取消；保存失敗保留來源', async () => {
  const seedOrphan = () => {
    storage({'orbit-board-v1': JSON.stringify(legacy)}); const seed = new BoardStore().workspaceState(), file = documentFromUrl('google-drive', 'https://drive.google.com/file/d/racing-orphan/view', '來源');
    Object.assign(seed.workspaces[0], {version: 5, documentSources: [file], documentLinks: []}); storage({'orbit-workspaces-v1': JSON.stringify(seed)}); return file;
  };
  const file = seedOrphan(), first = new BoardStore(), second = new BoardStore();
  assert.equal(first.documentCleanupPreview()[0].reasons.length, 0); await second.linkDocument('task', file);
  assert.equal((await first.cleanUnusedDocumentSources()).ok, false); assert.equal(new BoardStore().documentsForTask('task')[0].id, file.id);
  seedOrphan(); const failed = new BoardStore(), original = JSON.stringify(failed.workspaceState()), write = localStorage.setItem;
  localStorage.setItem = () => {throw new Error('quota');};
  try {assert.equal((await failed.cleanUnusedDocumentSources()).ok, false); assert.equal(JSON.stringify(failed.workspaceState()), original);} finally {localStorage.setItem = write;}
});

test('建立文件的關聯要求成功持久保存，且在寫入鎖內再驗證來源', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)}); const store = new BoardStore(), source = documentFromUrl('google-drive', 'https://drive.google.com/file/d/created-source/view', '已建立');
  const context = store.taskContext('task'), before = JSON.stringify(store.workspaceState());
  assert.equal((await store.linkDocument('task', source, context, {requirePersistence: true, verify: () => {throw new Error('來源已變更');}})).ok, false);
  assert.equal(JSON.stringify(store.workspaceState()), before);
  const write = localStorage.setItem; localStorage.setItem = () => {throw new Error('quota');};
  try {assert.equal((await store.linkDocument('task', source, context, {requirePersistence: true})).ok, false); assert.equal(JSON.stringify(store.workspaceState()), before);} finally {localStorage.setItem = write;}
});
