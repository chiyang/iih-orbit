import '@angular/compiler';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createBackup } from '../src/app/backup-data.ts';
import { DEFAULT_REMINDERS } from '../src/app/reminder-data.ts';

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
  assert.equal(reloaded.projects()[0].name, '實驗進度');
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

test('專案改名偵測過期表單，拒絕同名與未知專案的任務；新工作空間不建立多餘專案', async () => {
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
  assert.deepEqual(first.projects(), []);
  assert.deepEqual(first.tasks(), []);
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
  assert.equal(backup.preferences.theme, 'dark');
  assert.equal(backup.data.workspaces[0].tasks.length, 2);
  assert.equal((await store.resetData(true, store.revision())).ok, false);
  assert.equal(values.has('orbit-board-v1'), true);
  assert.equal(store.tasks().length, 2);
  assert.equal(store.appearance().theme, 'dark');
});

test('全部備份原子還原外觀與自訂顏色，工作空間副本保留顏色但不改全域設定', async () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const store = new BoardStore();
  await store.updateAppearance({theme: 'dark', accent: '#3366aa', textSize: 'compact'});
  await store.saveCategory({id: 'custom', name: '自訂', color: '#123456'});
  await store.saveStatus({...store.statuses()[0], color: '#ffffff'});
  const backup = await store.backupForExport('full');
  await store.updateAppearance({theme: 'light'});
  assert.equal((await store.importBackup(backup, store.revision())).ok, true);
  assert.equal(store.appearance().theme, 'dark');
  assert.equal(store.categories()[0].color, '#123456');
  const workspaceBackup = await store.backupForExport('workspaces', [store.currentWorkspace().id]);
  await store.updateAppearance({theme: 'light'});
  assert.equal((await store.importBackup(workspaceBackup)).ok, true);
  assert.equal(store.appearance().theme, 'light');
  assert.equal(store.categories()[0].color, '#123456');
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
