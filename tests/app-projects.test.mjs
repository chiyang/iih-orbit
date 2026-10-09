import '@angular/compiler';
import { createEnvironmentInjector, runInInjectionContext } from '@angular/core';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { COLUMNS } from '../src/app/models.ts';

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('@angular/build/package.json'))('esbuild');
await mkdir('.angular', {recursive: true});
const directory = await mkdtemp(resolve('.angular/app-project-test-'));
const output = resolve(directory, 'app.mjs');
await build({stdin: {contents: "export {App} from './src/app/app.ts'; export {Settings} from './src/app/settings.ts'; export {BoardStore} from './src/app/board-store.ts'; export {UiPreferences} from './src/app/ui-preferences.ts';", resolveDir: process.cwd()}, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: output, tsconfig: 'tsconfig.json'});
const { App, Settings, BoardStore, UiPreferences } = await import(pathToFileURL(output).href);
after(() => rm(directory, {recursive: true, force: true}));

const task = {id: 'welcome-task', title: '迎新海報', description: '', projectId: 'welcome', categoryId: 'design', status: 'todo', priority: 'medium', startDate: '2026-10-08', startTime: '', dueDate: '2026-10-08', dueTime: '', subtasks: []};

function application() {
  const state = {version: 1, activeWorkspaceId: 'first', workspaces: [{version: 4, id: 'first', name: '學程工作', projects: [{id: 'welcome', name: '迎新活動'}, {id: 'website', name: '網站改版'}], categories: [{id: 'design', name: '設計', color: 'green'}], statuses: COLUMNS, tasks: [task, {...task, id: 'website-task', title: '網站首頁', projectId: 'website', status: 'done'}, {...task, id: 'daily', title: '日常任務', projectId: ''}]}, {version: 4, id: 'second', name: '個人生活', projects: [], categories: [], statuses: COLUMNS, tasks: []}]};
  const values = new Map([['orbit-workspaces-v1', JSON.stringify(state)]]);
  globalThis.localStorage = {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key)};
  const store = new BoardStore();
  const injector = createEnvironmentInjector([{provide: BoardStore, useValue: store}, {provide: UiPreferences, useValue: {textSize: () => 'standard'}}]);
  // Only the viewport value is needed to construct the action controller; no DOM or browser is used.
  globalThis.window = {innerWidth: 1440};
  let app;
  try { app = runInInjectionContext(injector, () => new App()); }
  finally { delete globalThis.window; }
  const settings = runInInjectionContext(injector, () => new Settings());
  return {app, settings, store, close: () => { clearTimeout(app.toastTimer); injector.destroy(); }};
}

test('初始顯示所有專案，選擇單一專案會同步篩選看板、清單與日曆，搜尋不改動進度', () => {
  const {app, close} = application();
  try {
    assert.equal(app.selectedProgress().name, '所有專案');
    assert.equal(app.selectedProgress().percent, 33);
    assert.equal(app.visibleTasks().length, 3);
    app.selectProject('website');
    assert.deepEqual(app.columns().flatMap(column => column.tasks).map(item => item.id), ['website-task']);
    assert.deepEqual(app.sortedTasks().map(item => item.id), ['website-task']);
    assert.deepEqual(app.calendarTasks().map(item => item.id), ['website-task']);
    assert.equal(app.selectedProgress().percent, 100);
    app.query.set('沒有符合的名稱');
    assert.equal(app.visibleTasks().length, 0);
    assert.equal(app.selectedProgress().percent, 100);
    app.clearFilters();
    assert.equal(app.visibleTasks().length, 3);
    assert.equal(app.selectedProjectId(), 'all');
  } finally { close(); }
});

test('專案篩選期間新增任務預填歸屬，建立專案後各專案清單即時更新', async () => {
  const {app, store, close} = application();
  try {
    app.selectProject('welcome');
    app.openTask();
    assert.equal(app.draft.projectId, 'welcome');
    app.draft.title = '新生報到';
    await app.saveTask();
    assert.equal(store.tasks().at(-1).projectId, 'welcome');
    app.openProjects();
    app.projectDraft = '課程規劃';
    await app.saveProject();
    assert.equal(store.projects().at(-1).name, '課程規劃');
    assert.equal(app.progressExpanded(), true);
    assert.equal(app.progressRows().find(row => row.name === '課程規劃').percent, 0);
    assert.equal(store.categories().length, 1);
  } finally { close(); }
});

test('移除篩選中的專案及切換工作空間後，返回所有專案且任務仍保留', async () => {
  const {app, store, close} = application();
  try {
    app.selectProject('welcome');
    await store.deleteProject(store.projects()[0]);
    assert.equal(app.selectedProjectId(), 'all');
    assert.equal(app.visibleTasks().length, 3);
    assert.equal(store.tasks()[0].projectId, '');
    app.progressExpanded.set(true);
    app.selectProject('website');
    app.selectWorkspace('second');
    assert.equal(store.currentWorkspace().name, '個人生活');
    assert.equal(app.selectedProjectId(), 'all');
    assert.equal(app.progressExpanded(), false);
    assert.equal(app.selectedProgress().percent, 0);
    app.openTask();
    assert.equal(app.draft.projectId, '');
  } finally { close(); }
});

test('設定頁重置必須輸入正確文字，完成後通知介面並保留或還原外觀', async () => {
  const {settings, store, close} = application();
  try {
    let resets = 0;
    settings.resetDone.subscribe(() => resets++);
    await store.updateAppearance({theme: 'dark'});
    settings.beginReset('work');
    settings.confirmation = '錯誤文字';
    await settings.reset();
    assert.equal(store.tasks().length, 3);
    assert.equal(resets, 0);
    settings.confirmation = '清空工作資料';
    await settings.reset();
    assert.equal(store.tasks().length, 0);
    assert.equal(store.appearance().theme, 'dark');
    assert.equal(resets, 1);
    settings.beginReset('all');
    settings.confirmation = '重置整個 Orbit';
    await settings.reset();
    assert.equal(store.appearance().theme, 'light');
    assert.equal(resets, 2);
  } finally { close(); }
});

test('設定頁保留過期重置確認及錯誤訊息，拒絕刪除確認後更新的資料', async () => {
  const {settings, store, close} = application();
  try {
    settings.beginReset('all');
    settings.confirmation = '重置整個 Orbit';
    await store.updateAppearance({theme: 'dark'});
    await settings.reset();
    assert.equal(store.tasks().length, 3);
    assert.equal(settings.resetMode(), 'all');
    assert.match(settings.error(), /確認期間/);
  } finally { close(); }
});

test('分類及狀態自訂 HEX 輸入不完整時阻止儲存，修正後保留自訂色', async () => {
  const {app, store, close} = application();
  try {
    app.openCategories();
    app.categoryDraft.name = '自訂分類';
    app.setDraftColor('category', '#123');
    await app.saveCategory();
    assert.equal(store.categories().length, 1);
    assert.equal(app.categoryColorInvalid(), true);
    app.setDraftColor('category', '#123456');
    await app.saveCategory();
    assert.equal(store.categories().at(-1).color, '#123456');
    app.openStatuses();
    app.statusDraft.label = '自訂狀態';
    app.setDraftColor('status', 'red');
    await app.saveStatus();
    assert.equal(store.statuses().length, 5);
    app.setDraftColor('status', '#ffffff');
    await app.saveStatus();
    assert.equal(store.statuses().at(-1).color, '#ffffff');
  } finally { close(); }
});
