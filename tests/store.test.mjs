import '@angular/compiler';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('@angular/build/package.json'))('esbuild');
await mkdir('.angular', {recursive: true});
const directory = await mkdtemp(resolve('.angular/store-test-'));
const output = resolve(directory, 'store.mjs');
await build({entryPoints: ['src/app/board-store.ts'], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: output, tsconfig: 'tsconfig.json'});
const { BoardStore } = await import(pathToFileURL(output).href);
after(() => rm(directory, {recursive: true, force: true}));

const task = {id: 'task', title: '既有任務', description: '保留內容', categoryId: '', status: 'todo', priority: 'medium', startDate: '', startTime: '', dueDate: '', dueTime: '', subtasks: []};
const legacy = {version: 2, projectName: '原專案', categories: [], tasks: [task, {...task, id: 'done', status: 'done'}]};

function storage(saved = {}, fail = false) {
  const values = new Map(Object.entries(saved));
  globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => {
      if (fail) throw new Error('Storage unavailable');
      values.set(key, value);
    }
  };
  return values;
}

test('儲存服務升級既有看板，保留舊儲存鍵與任務，封存不影響原有完成比例', () => {
  const original = JSON.stringify(legacy);
  const values = storage({'orbit-board-v1': original});
  const store = new BoardStore();
  assert.equal(store.workspaces().length, 1);
  assert.deepEqual(store.tasks(), legacy.tasks);
  assert.equal(store.statuses().at(-1).kind, 'archived');
  assert.equal(store.progress(), 50);
  assert.equal(values.get('orbit-board-v1'), original);
  assert.deepEqual(new BoardStore().tasks(), legacy.tasks);
});

test('建立、改名、切換與重新讀取工作空間，各自的任務分類狀態完全獨立', () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const store = new BoardStore();
  const original = structuredClone(store.currentWorkspace());
  store.saveWorkspace('', '研究計畫');
  const secondId = store.currentWorkspace().id;
  assert.deepEqual(store.tasks(), []);
  store.saveCategory({id: 'research', name: '研究', color: 'green'});
  store.saveStatus({id: 'waiting', label: '等待回覆', subtitle: '', color: 'pink', kind: 'active'});
  store.saveTask({...task, id: 'second', categoryId: 'research', status: 'waiting'});
  store.renameProject('實驗進度');
  store.saveWorkspace(secondId, '研究工作台');
  store.switchWorkspace(original.id);
  assert.deepEqual(store.currentWorkspace(), original);
  store.switchWorkspace(secondId);
  const reloaded = new BoardStore();
  assert.equal(reloaded.currentWorkspace().name, '研究工作台');
  assert.equal(reloaded.state().projectName, '實驗進度');
  assert.equal(reloaded.tasks()[0].categoryId, 'research');
  assert.equal(reloaded.tasks()[0].status, 'waiting');
  assert.equal(reloaded.workspaces()[0].tasks.length, 2);
});

test('封存與恢復會更新完成比例，自訂完成狀態的語意及儲存皆正確', () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const store = new BoardStore();
  store.moveTask('task', 'archived');
  assert.equal(store.tasks().length, 2);
  assert.equal(store.activeTasks().length, 1);
  assert.equal(store.progress(), 100);
  store.moveTask('task', 'todo');
  assert.equal(store.progress(), 50);
  store.saveStatus({id: 'shipped', label: '交付完成', subtitle: '', color: 'green', kind: 'done'});
  store.moveTask('task', 'shipped');
  assert.equal(store.completed(), 2);
  assert.equal(new BoardStore().progress(), 100);
});

test('調整自訂狀態順序及刪除使用中的狀態，保留任務並保存目的地', () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const store = new BoardStore();
  store.saveStatus({id: 'waiting', label: '等待回覆', subtitle: '', color: 'pink', kind: 'active'});
  store.moveTask('task', 'waiting');
  store.reorderStatus('waiting', -1);
  assert.equal(store.statuses().at(-2).id, 'waiting');
  store.deleteStatus('waiting', 'progress');
  assert.equal(store.tasks().find(item => item.id === 'task').status, 'progress');
  assert.equal(store.statuses().some(item => item.id === 'waiting'), false);
  assert.equal(new BoardStore().tasks().find(item => item.id === 'task').status, 'progress');
  const before = structuredClone(store.workspaceState());
  store.moveTask('task', 'missing');
  store.saveTask({...task, status: 'missing'});
  assert.deepEqual(store.workspaceState(), before);
});

test('刪除目前工作空間後選取保留的空間，最後一個工作空間不能刪除', () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const store = new BoardStore();
  const firstId = store.currentWorkspace().id;
  store.saveWorkspace('', '暫存');
  store.deleteWorkspace(store.currentWorkspace().id);
  assert.equal(store.currentWorkspace().id, firstId);
  assert.deepEqual(store.tasks(), legacy.tasks);
  store.deleteWorkspace(firstId);
  assert.equal(store.workspaces().length, 1);
  assert.equal(new BoardStore().currentWorkspace().id, firstId);
});

test('瀏覽器無法保存時保留記憶體內的操作與原始資料，顯示儲存提示', () => {
  const original = JSON.stringify(legacy);
  const values = storage({'orbit-board-v1': original}, true);
  const store = new BoardStore();
  assert.match(store.storageWarning(), /無法保存/);
  store.saveWorkspace('', '離線暫存');
  store.saveTask({...task, id: 'new'});
  assert.equal(store.tasks().length, 1);
  assert.match(store.storageWarning(), /無法儲存/);
  assert.equal(values.get('orbit-board-v1'), original);
});

test('隱藏設定依工作空間保存，重讀後保留且不改動任務或完成比例', () => {
  storage({'orbit-board-v1': JSON.stringify(legacy)});
  const store = new BoardStore();
  const firstId = store.currentWorkspace().id;
  const before = structuredClone(store.tasks());
  store.saveStatus({...store.statuses().find(status => status.id === 'todo'), hidden: true});
  store.saveStatus({...store.statuses().find(status => status.id === 'archived'), hidden: false});
  assert.deepEqual(store.tasks(), before);
  assert.equal(store.progress(), 50);
  store.saveWorkspace('', '獨立工作台');
  assert.equal(store.statuses().find(status => status.id === 'todo').hidden, false);
  assert.equal(store.statuses().find(status => status.id === 'archived').hidden, true);
  store.switchWorkspace(firstId);
  const reloaded = new BoardStore();
  assert.equal(reloaded.statuses().find(status => status.id === 'todo').hidden, true);
  assert.equal(reloaded.statuses().find(status => status.id === 'archived').hidden, false);
  assert.deepEqual(reloaded.tasks(), before);
});
