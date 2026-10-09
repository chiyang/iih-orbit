import '@angular/compiler';
import {createEnvironmentInjector, runInInjectionContext, signal} from '@angular/core';
import assert from 'node:assert/strict';
import {after, test} from 'node:test';
import {createRequire} from 'node:module';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {COLUMNS} from '../src/app/models.ts';

const require = createRequire(import.meta.url);
const {build} = createRequire(require.resolve('@angular/build/package.json'))('esbuild');
await mkdir('.angular', {recursive: true});
const directory = await mkdtemp(resolve('.angular/task-cell-test-'));
const output = resolve(directory, 'cells.mjs');
await build({stdin: {contents: "export {TaskCell} from './src/app/task-cell.ts'; export {BackupPanel} from './src/app/backup-panel.ts'; export {BoardStore} from './src/app/board-store.ts';", resolveDir: process.cwd()}, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: output, tsconfig: 'tsconfig.json'});
const {TaskCell, BackupPanel, BoardStore} = await import(pathToFileURL(output).href);
after(() => rm(directory, {recursive: true, force: true}));
const task = {id: 'task', title: '初始標題', description: '保留描述', projectId: '', categoryId: 'design', status: 'todo', priority: 'medium', startDate: '2026-10-09', startTime: '09:00', dueDate: '2026-10-12', dueTime: '17:00', subtasks: [{id: 'child', title: '保留子任務', done: true}]};
function fixture() {
  const workspace = {version: 4, id: 'first', name: '工作', projects: [{id: 'project', name: '專案'}], categories: [{id: 'design', name: '設計', color: 'green'}, {id: 'code', name: '程式', color: 'blue'}], statuses: COLUMNS, tasks: [task]};
  const values = new Map([['orbit-workspaces-v1', JSON.stringify({version: 1, activeWorkspaceId: 'first', workspaces: [workspace]})]]);
  globalThis.localStorage = {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key)};
  const store = new BoardStore();
  const injector = createEnvironmentInjector([{provide: BoardStore, useValue: store}]);
  const cell = runInInjectionContext(injector, () => new TaskCell());
  cell.task = signal(structuredClone(store.tasks()[0])); cell.field = signal('title'); cell.now = signal(new Date(2026, 9, 9, 12));
  const backup = runInInjectionContext(injector, () => new BackupPanel());
  return {cell, store, backup, close: () => { backup.ngOnDestroy(); injector.destroy(); }, refresh: field => {cell.task.set(structuredClone(store.tasks()[0])); cell.field.set(field);}};
}

test('清單原位儲存名稱、專案、分類、優先與狀態，保留其他任務內容', async () => {
  const f = fixture(), messages = [];
  try {
    f.cell.saved.subscribe(value => messages.push(value));
    for (const [field, value] of [['title', '  新名稱  '], ['projectId', 'project'], ['categoryId', 'code'], ['priority', 'high'], ['status', 'done']]) {
      f.refresh(field); f.cell.begin(); f.cell.value = value; await f.cell.save();
      assert.equal(f.cell.error(), ''); assert.equal(f.cell.editing(), false);
      assert.equal(f.store.tasks()[0][field], value.trim());
      assert.equal(f.store.tasks()[0].description, task.description);
      assert.deepEqual(f.store.tasks()[0].subtasks, task.subtasks);
    }
    assert.equal(messages.length, 5);
    f.refresh('status'); await f.cell.selectStatus('progress'); assert.equal(f.store.tasks()[0].status, 'progress');
  } finally { f.close(); }
});

test('日期原位編輯保留可選時間；取消時間或清除日期同步移除時間', async () => {
  const f = fixture();
  try {
    f.refresh('startDate'); f.cell.begin(); f.cell.value = '2026-10-10'; f.cell.time = '10:30'; await f.cell.save();
    assert.equal(f.store.tasks()[0].startDate, '2026-10-10'); assert.equal(f.store.tasks()[0].startTime, '10:30');
    f.refresh('dueDate'); f.cell.begin(); f.cell.value = '2026-10-11'; f.cell.time = '12:00'; await f.cell.save();
    assert.equal(f.store.tasks()[0].dueTime, '12:00'); assert.equal(f.store.tasks()[0].startTime, '10:30');
    f.refresh('dueDate'); f.cell.begin(); f.cell.toggleTime(false); await f.cell.save(); assert.equal(f.store.tasks()[0].dueTime, '');
    f.refresh('startDate'); f.cell.begin(); f.cell.value = ''; await f.cell.save();
    assert.equal(f.store.tasks()[0].startDate, ''); assert.equal(f.store.tasks()[0].startTime, '');
    f.refresh('startDate'); f.cell.begin(); f.cell.value = '2026-10-10'; f.cell.toggleTime(true); assert.equal(f.cell.time, '09:00');
    await f.cell.save(); assert.equal(f.store.tasks()[0].startTime, '09:00');
  } finally { f.close(); }
});

test('空名稱、錯誤日期時間與反向日期不寫入，取消及未更改儲存也不產生版本', async () => {
  const f = fixture();
  try {
    const revision = f.store.revision();
    f.cell.begin(); f.cell.value = ' '; await f.cell.save(); assert.match(f.cell.error(), /名稱/); assert.equal(f.cell.editing(), true);
    f.refresh('startDate'); f.cell.begin(); f.cell.value = '2026-10-13'; await f.cell.save(); assert.match(f.cell.error(), /不能早於/);
    f.cell.value = '2026-02-30'; await f.cell.save(); assert.match(f.cell.error(), /有效的日期/);
    f.cell.value = '2026-10-10'; f.cell.time = '25:00'; await f.cell.save(); assert.match(f.cell.error(), /有效的時間/);
    f.cell.time = ''; await f.cell.save(); assert.match(f.cell.error(), /選擇時間/);
    f.cell.cancel(); assert.equal(f.cell.editing(), false);
    f.refresh('title'); f.cell.begin(); await f.cell.save(); assert.equal(f.cell.editing(), false);
    assert.equal(f.store.revision(), revision); assert.deepEqual(f.store.tasks()[0], task);
  } finally { f.close(); }
});

test('跨分頁更新保留原位草稿，載入最新後只改選定欄位，任務刪除不會復活', async () => {
  const f = fixture();
  try {
    f.refresh('priority'); f.cell.begin(); f.cell.value = 'high';
    const otherTab = new BoardStore();
    await otherTab.saveTask({...otherTab.tasks()[0], title: '另一分頁的新名稱'});
    await f.cell.save(); assert.match(f.cell.error(), /另一個分頁/); assert.equal(f.cell.value, 'high'); assert.equal(f.cell.editing(), true);
    f.cell.reload(); f.cell.value = 'high'; await f.cell.save(); assert.equal(f.store.tasks()[0].title, '另一分頁的新名稱'); assert.equal(f.store.tasks()[0].priority, 'high');
    f.refresh('title'); f.cell.begin(); f.cell.value = '不能復活'; await f.store.deleteTask(task.id); await f.cell.save();
    assert.match(f.cell.error(), /刪除/); assert.equal(f.store.tasks().length, 0); f.cell.reload(); assert.match(f.cell.error(), /已刪除/);
  } finally { f.close(); }
});

test('分類與專案刪除、資料重置會阻止舊原位草稿寫回', async () => {
  const f = fixture();
  try {
    f.refresh('projectId'); f.cell.begin(); f.cell.value = 'project'; await f.store.deleteProject(f.store.projects()[0]); await f.cell.save(); assert.match(f.cell.error(), /專案/);
    f.refresh('categoryId'); f.cell.begin(); f.cell.value = 'code'; await f.store.deleteCategory('code'); await f.cell.save(); assert.match(f.cell.error(), /分類/);
    f.refresh('title'); f.cell.begin(); f.cell.value = '舊草稿'; await f.store.resetData(false, f.store.revision()); await f.cell.save();
    assert.ok(f.cell.error()); assert.equal(f.store.tasks().length, 0); assert.equal(f.cell.value, '舊草稿');
    f.cell.reload(); assert.match(f.cell.error(), /資料已變更/);
  } finally { f.close(); }
});

test('設定內備份工作空間匯入新增副本，成功後清掉預覽避免重複執行', async () => {
  const f = fixture(); let restored = 0;
  try {
    f.backup.restored.subscribe(() => restored++);
    f.backup.importPreview.set(await f.store.backupForExport('workspaces', ['first']));
    await f.backup.executeImport(); assert.equal(f.store.workspaces().length, 2); assert.equal(restored, 1);
    assert.equal(f.backup.importPreview(), null); assert.match(f.backup.message(), /已新增/);
    await f.backup.executeImport(); assert.equal(f.store.workspaces().length, 2);
  } finally { f.close(); }
});

test('設定內全部還原需確認文字與版本；其他分頁變更後必須重查範圍', async () => {
  const f = fixture();
  try {
    f.backup.importPreview.set(await f.store.backupForExport('full'));
    await f.backup.executeImport(); assert.equal(f.backup.importPreview().kind, 'full');
    f.backup.prepareFullImport(); f.backup.importConfirmation = '取代全部資料';
    await f.store.saveTask({...f.store.tasks()[0], title: '確認後的更新'});
    await f.backup.executeImport(); assert.ok(f.backup.backupError()); assert.equal(f.store.tasks()[0].title, '確認後的更新');
    f.backup.prepareFullImport(); f.backup.importConfirmation = '取代全部資料'; await f.backup.executeImport();
    assert.equal(f.store.tasks()[0].title, task.title); assert.equal(f.backup.importPreview(), null);
  } finally { f.close(); }
});

test('備份讀取遇到無效檔案保留原資料，關閉設定後遲到讀取不再套用預覽', async () => {
  const f = fixture();
  try {
    const revision = f.store.revision();
    await f.backup.readImportFile({target: {value: 'file', files: [{size: 4, name: 'bad.json', text: async () => 'bad'}]}});
    assert.match(f.backup.backupError(), /有效的 JSON/); assert.equal(f.store.revision(), revision);
    const data = await f.store.backupForExport('full'); let release;
    const reading = f.backup.readImportFile({target: {value: 'file', files: [{size: 4, name: 'good.json', text: () => new Promise(resolve => {release = resolve;})}]}});
    f.backup.ngOnDestroy(); release(JSON.stringify(data)); await reading;
    assert.equal(f.backup.importPreview(), null); assert.equal(f.store.revision(), revision);
  } finally { f.close(); }
});
