import '@angular/compiler';
import { createEnvironmentInjector, runInInjectionContext, signal, ɵChangeDetectionScheduler, ɵEffectScheduler } from '@angular/core';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { COLUMNS } from '../src/app/models.ts';
import { reminderItems } from '../src/app/reminder-items.ts';
import { externalEvent } from '../src/app/google-data.ts';

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('@angular/build/package.json'))('esbuild');
await mkdir('.angular', {recursive: true});
const directory = await mkdtemp(resolve('.angular/app-project-test-'));
const output = resolve(directory, 'app.mjs');
await build({stdin: {contents: "export {App} from './src/app/app.ts'; export {Settings} from './src/app/settings.ts'; export {BoardStore} from './src/app/board-store.ts'; export {UiPreferences} from './src/app/ui-preferences.ts'; export {StartupGuide} from './src/app/startup-guide.ts';", resolveDir: process.cwd()}, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: output, tsconfig: 'tsconfig.json'});
const { App, Settings, BoardStore, UiPreferences, StartupGuide } = await import(pathToFileURL(output).href);
after(() => rm(directory, {recursive: true, force: true}));

const task = {id: 'welcome-task', title: '迎新海報', description: '', projectId: 'welcome', categoryId: 'design', status: 'todo', priority: 'medium', startDate: '2026-10-08', startTime: '', dueDate: '2026-10-08', dueTime: '', subtasks: []};

function application(fresh = false) {
  const state = {version: 1, activeWorkspaceId: 'first', workspaces: [{version: 4, id: 'first', name: '學程工作', projects: [{id: 'welcome', name: '迎新活動'}, {id: 'website', name: '網站改版'}], categories: [{id: 'design', name: '設計', color: 'green'}], statuses: COLUMNS, tasks: [task, {...task, id: 'website-task', title: '網站首頁', projectId: 'website', status: 'done'}, {...task, id: 'daily', title: '日常任務', projectId: ''}]}, {version: 4, id: 'second', name: '個人生活', projects: [], categories: [], statuses: COLUMNS, tasks: []}]};
  const values = new Map(fresh ? [] : [['orbit-workspaces-v1', JSON.stringify(state)]]);
  globalThis.localStorage = {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key)};
  const store = new BoardStore();
  const effects = new Set();
  const scheduler = {add(effect) {effects.add(effect);}, schedule() {}, remove(effect) {effects.delete(effect);}};
  const injector = createEnvironmentInjector([{provide: BoardStore, useValue: store}, {provide: UiPreferences, useValue: {textSize: () => 'standard'}}, {provide: ɵEffectScheduler, useValue: scheduler}, {provide: ɵChangeDetectionScheduler, useValue: {notify() {}}}]);
  // Only the viewport value is needed to construct the action controller; no DOM or browser is used.
  globalThis.window = {innerWidth: 1440};
  let app;
  globalThis.ngServerMode = true;
  try { app = runInInjectionContext(injector, () => new App()); }
  finally { delete globalThis.window; delete globalThis.ngServerMode; }
  const settings = runInInjectionContext(injector, () => new Settings());
  const flush = () => {for (let round = 0; round < 30 && [...effects].some(effect => effect.dirty); round++) for (const effect of effects) if (effect.dirty) effect.run();};
  const reopen = () => {
    globalThis.window = {innerWidth: 1440}; globalThis.ngServerMode = true;
    try {return runInInjectionContext(injector, () => new App());}
    finally {delete globalThis.window; delete globalThis.ngServerMode;}
  };
  return {app, settings, store, values, flush, reopen, guide: () => runInInjectionContext(injector, () => new StartupGuide()), close: () => { clearTimeout(app.toastTimer); injector.destroy(); }};
}

test('首次引導可以前後查看且不加入資料；完成接續第一個樣板空間，稍後建立仍可重開', async () => {
  const f = application(true);
  try {
    f.flush(); assert.equal(f.app.modal(), 'intro'); assert.equal(f.app.introFirstUse(), true);
    const guide = f.guide(); guide.busy = f.app.introSaving; guide.firstUse = f.app.introFirstUse;
    assert.match(guide.hint(), /只有一個空白空間/);
    guide.previous(); assert.equal(guide.step(), 0);
    guide.next(); guide.previous(); assert.equal(guide.step(), 0);
    for (let index = 1; index < guide.steps.length; index++) guide.next();
    assert.match(guide.hint(), /第一個工作空間/);
    assert.deepEqual(f.store.tasks(), []); assert.deepEqual(f.store.projects(), []); assert.deepEqual(f.store.categories(), []);
    let finishing;
    guide.finish.subscribe(() => {finishing = f.app.finishIntroduction();});
    guide.next(); guide.next(); await finishing; f.flush();
    assert.equal(f.app.modal(), 'workspaces'); assert.equal(f.app.firstWorkspaceDialog(), true); assert.equal(f.app.workspaceExamples, false);
    f.app.closeModal(); f.flush(); assert.equal(f.app.modal(), null);
    const reopened = f.reopen(); f.flush(); assert.equal(reopened.modal(), 'workspaces');
    f.app.openWorkspaces(); f.app.chooseWorkspaceTemplate({id: 'research', name: '研究計劃'});
    await f.app.saveWorkspace(); f.flush();
    assert.equal(f.store.workspaces().length, 1); assert.equal(f.store.currentWorkspace().name, '研究計劃');
    assert.equal(f.store.categories().length, 4); assert.deepEqual(f.store.tasks(), []); assert.equal(f.store.onboarding(), null);
    assert.equal(f.app.modal(), null); assert.equal(f.reopen().modal(), null);
  } finally {f.close();}
});

test('Escape 略過首次引導，空白選擇不建立同名專案；儲存失敗保留名稱供重試', async () => {
  const f = application(true);
  try {
    f.flush(); f.app.escape();
    for (let index = 0; index < 5; index++) await new Promise(resolve => setImmediate(resolve));
    f.flush(); assert.equal(f.app.modal(), 'workspaces'); assert.equal(f.store.onboarding(), 'workspace');
    await f.app.saveWorkspace(); assert.match(f.app.formError(), /名稱/); assert.equal(f.app.modal(), 'workspaces');
    f.app.workspaceDraft = '空白工作空間'; const write = localStorage.setItem;
    localStorage.setItem = () => {throw new Error('full');};
    try {await f.app.saveWorkspace();} finally {localStorage.setItem = write;}
    assert.equal(f.app.workspaceDraft, '空白工作空間'); assert.equal(f.app.modal(), 'workspaces'); assert.equal(f.store.onboarding(), 'workspace');
    await f.app.saveWorkspace(); f.flush();
    assert.equal(f.store.workspaces().length, 1); assert.deepEqual(f.store.projects(), []); assert.deepEqual(f.store.categories(), []); assert.deepEqual(f.store.tasks(), []);
    assert.equal(f.app.modal(), null); assert.equal(f.store.onboarding(), null);
  } finally {f.close();}
});

test('問號引導完成、關閉及 Escape 均保留資料、篩選與側欄；背景儲存不阻止結束', async () => {
  const f = application();
  try {
    f.flush(); f.app.view.set('week'); f.app.calendarDate.set('2026-10-14');
    f.app.projectFilter.set('website'); f.app.categoryFilter.set('design'); f.app.query.set('網站');
    f.app.openMail(); f.flush();
    const workspaces = JSON.stringify(f.store.workspaces());
    const saved = f.values.get('orbit-workspaces-v1');
    const pendingWrites = f.store.pendingWrites;
    f.store.pendingWrites = signal(1);
    try {
      for (const action of ['finish', 'close', 'escape']) {
        f.app.openIntroduction(); f.flush();
        assert.equal(f.app.modal(), 'intro'); assert.equal(f.app.introFirstUse(), false);
        const guide = f.guide(); guide.firstUse = f.app.introFirstUse;
        assert.equal(guide.step(), 0); assert.doesNotMatch(guide.hint(), /目前只有一個空白空間/);
        let finishing;
        guide.finish.subscribe(() => {finishing = f.app.finishIntroduction();});
        for (let index = 1; index < guide.steps.length; index++) guide.next();
        assert.doesNotMatch(guide.hint(), /第一個工作空間/);
        if (action === 'finish') {guide.next(); await finishing;}
        else if (action === 'close') f.app.closeModal();
        else f.app.escape();
        f.flush();
        assert.equal(f.app.modal(), null); assert.equal(f.app.firstWorkspaceDialog(), false);
        assert.equal(f.store.onboarding(), null); assert.equal(JSON.stringify(f.store.workspaces()), workspaces);
        assert.equal(f.values.get('orbit-workspaces-v1'), saved); assert.equal(f.values.has('orbit-workspaces-v2'), false);
        assert.equal(f.app.view(), 'week'); assert.equal(f.app.calendarDate(), '2026-10-14');
        assert.equal(f.app.projectFilter(), 'website'); assert.equal(f.app.categoryFilter(), 'design');
        assert.equal(f.app.query(), '網站'); assert.equal(f.app.mailOpen(), true);
      }
    } finally {f.store.pendingWrites = pendingWrites;}
  } finally {f.close();}
});

test('延後建立第一個空間後，手動重看引導不改變首次進度；重新整理仍接續建立空間', async () => {
  const f = application(true);
  try {
    f.flush(); await f.app.finishIntroduction(); f.flush(); f.app.closeModal();
    const saved = f.values.get('orbit-workspaces-v2');
    f.app.openIntroduction(); f.flush(); assert.equal(f.app.introFirstUse(), false);
    await f.app.finishIntroduction(); f.flush();
    assert.equal(f.app.modal(), null); assert.equal(f.store.onboarding(), 'workspace');
    assert.equal(f.values.get('orbit-workspaces-v2'), saved); assert.equal(f.store.workspaces().length, 1);
    assert.deepEqual(f.store.projects(), []); assert.deepEqual(f.store.categories(), []); assert.deepEqual(f.store.tasks(), []);
    const reopened = f.reopen(); f.flush();
    assert.equal(reopened.modal(), 'workspaces'); assert.equal(reopened.firstWorkspaceDialog(), true);
  } finally {f.close();}
});

test('重新建立畫面保留視圖、月曆日期、篩選排序與右側欄；不同工作空間分開保存', () => {
  const f = application();
  try {
    f.app.view.set('week'); f.app.calendarDate.set('2027-01-03'); f.app.calendarScrollHour.set(13.5);
    f.app.projectFilter.set('website'); f.app.categoryFilter.set('design'); f.app.scope.set('done'); f.app.query.set('網站');
    f.app.sortKey.set('dueDate'); f.app.sortDirection.set('desc'); f.app.calendarShowGoogle.set(false); f.app.openMail(); f.flush();
    const restored = f.reopen();
    assert.equal(restored.view(), 'week'); assert.equal(restored.calendarDate(), '2027-01-03'); assert.equal(restored.calendarScrollHour(), 13.5);
    assert.equal(restored.projectFilter(), 'website'); assert.equal(restored.categoryFilter(), 'design'); assert.equal(restored.scope(), 'done'); assert.equal(restored.query(), '網站');
    assert.equal(restored.sortKey(), 'dueDate'); assert.equal(restored.sortDirection(), 'desc'); assert.equal(restored.calendarShowGoogle(), false); assert.equal(restored.mailOpen(), true);
    f.app.selectWorkspace('second'); f.flush(); assert.equal(f.app.view(), 'week'); assert.equal(f.app.query(), '');
    assert.equal(f.app.calendarShowGoogle(), false); assert.equal(f.app.mailOpen(), true);
    f.app.view.set('month'); f.app.calendarDate.set('2027-02-01'); f.flush();
    f.app.selectWorkspace('first'); f.flush(); assert.equal(f.app.view(), 'week'); assert.equal(f.app.calendarDate(), '2027-01-03'); assert.equal(f.app.projectFilter(), 'website');
    f.app.view.set('list'); f.app.rememberBrowse(); assert.equal(f.reopen().view(), 'list');
  } finally {f.close();}
});

test('瀏覽狀態排除已移除的篩選，新資料世代不接續舊畫面；指定一週不回到月初', async () => {
  const f = application();
  try {
    f.app.projectFilter.set('removed'); f.app.categoryFilter.set('removed'); f.flush();
    const restored = f.reopen(); assert.equal(restored.projectFilter(), 'all'); assert.equal(restored.categoryFilter(), 'all');
    f.app.openCalendarWeek('2026-10-18'); assert.equal(f.app.view(), 'week'); assert.equal(f.app.calendarDate(), '2026-10-18');
    f.app.openCalendarWeek('not-a-date'); assert.equal(f.app.calendarDate(), '2026-10-18');
    f.app.calendarScrollHour.set(13.5); f.app.calendarShowGoogle.set(false);
    f.app.openCalendarMonth('2027-01-07'); f.flush();
    assert.equal(f.app.view(), 'month'); assert.equal(f.app.calendarDate(), '2027-01-07');
    f.app.rememberBrowse();
    const month = f.reopen();
    assert.equal(month.view(), 'month'); assert.equal(month.calendarDate(), '2027-01-07');
    assert.equal(month.calendarScrollHour(), 13.5); assert.equal(month.calendarShowGoogle(), false);
    f.app.openCalendarMonth('not-a-date'); assert.equal(f.app.calendarDate(), '2027-01-07');
    f.flush(); await f.store.resetData(true, f.store.revision()); f.flush();
    assert.equal(f.app.view(), 'board'); assert.equal(f.app.query(), ''); assert.equal(f.app.mailOpen(), false);
  } finally {f.close();}
});

test('進入 Calendar 移轉先保存草稿，未改動任務不建立額外保存紀錄', async () => {
  const {app, store, close} = application();
  try {
    const revision = store.revision();
    app.openTask('todo', store.tasks()[0]); await app.saveTask(true);
    assert.equal(app.modal(), 'calendar-publish'); assert.equal(store.revision(), revision);
    app.returnCalendarTask(); app.draft.description = '移轉前新增描述'; await app.saveTask(true);
    assert.equal(app.modal(), 'calendar-publish'); assert.notEqual(store.revision(), revision);
    assert.equal(store.tasks()[0].description, '移轉前新增描述');
    assert.equal(app.taskEditContext().original.description, '移轉前新增描述');
  } finally { close(); }
});

test('移轉返回任務保留原編輯基準，另一分頁修改或刪除後不能覆寫或自動復活', async () => {
  for (const change of ['edit', 'delete']) {
    const {app, store, close} = application();
    const peer = new BoardStore();
    try {
      app.openTask('todo', store.tasks()[0]); await app.saveTask(true);
      const context = app.taskEditContext();
      if (change === 'edit') await peer.saveTask({...peer.tasks()[0], description: '另一分頁的新內容'});
      else await peer.deleteTask(peer.tasks()[0].id);
      store.refreshFromStorage(); app.returnCalendarTask();
      assert.equal(app.taskEditContext(), context); assert.equal(app.taskDraftConflict(), true);
      await app.saveTask();
      const current = store.tasks().find(item => item.id === task.id);
      assert.equal(change === 'edit' ? current.description : current, change === 'edit' ? '另一分頁的新內容' : undefined);
      assert.equal(app.modal(), 'task'); assert.match(app.formError(), /更新|刪除/);
    } finally { peer.ngOnDestroy(); close(); }
  }
});

test('專案封存分開列出，不計整體進度，任務仍可篩選並開啟；改名保留封存狀態', async () => {
  const {app, store, close} = application();
  try {
    app.openProjects();
    const project = store.projects().find(project => project.id === 'website');
    await app.toggleProjectArchived(project);
    assert.equal(app.overallProgress().percent, 0);
    assert.equal(app.activeProjectCount(), 1);
    assert.deepEqual(app.progressRows().map(row => row.id), ['welcome', '']);
    assert.deepEqual(app.archivedProgressRows().map(row => row.id), ['website']);
    assert.equal(app.visibleTasks().length, 3);
    app.selectProject('website');
    assert.equal(app.selectedProjectArchived(), true);
    assert.equal(app.selectedProgress().percent, 100);
    assert.equal(app.visibleTasks()[0].id, 'website-task');
    app.editProject(store.projects().find(project => project.id === 'website'));
    app.projectDraft = '已結案網站'; await app.saveProject();
    assert.equal(store.projects().find(project => project.id === 'website').archived, true);
    await app.toggleProjectArchived(store.projects().find(project => project.id === 'website'));
    assert.equal(app.selectedProjectArchived(), false);
    assert.equal(app.overallProgress().percent, 33);
  } finally { close(); }
});

test('所有專案下新增任務自動選擇同名或第一個未封存專案，舊未指定任務保留', async () => {
  const {app, store, close} = application();
  try {
    app.openTask(); assert.equal(app.draft.projectId, 'welcome');
    app.closeModal();
    await store.setProjectArchived(store.projects()[0], true);
    app.openTask(); assert.equal(app.draft.projectId, 'website');
    assert.equal(store.tasks().find(task => task.id === 'daily').projectId, '');
    app.closeModal(); app.openWorkspaces(); app.workspaceDraft = '新的工作空間'; await app.saveWorkspace();
    app.openTask(); assert.equal(app.draft.projectId, store.projects()[0].id);
    assert.equal(store.projects()[0].name, '新的工作空間');
    app.draft.title = '開始新任務'; await app.saveTask();
    assert.equal(store.tasks()[0].projectId, store.projects()[0].id);
  } finally { close(); }
});

test('樣板切換保留自訂名稱，改名中可返回建立工作空間，原空間內容不被修改', async () => {
  const {app, store, close} = application();
  try {
    app.openWorkspaces();
    app.chooseWorkspaceTemplate({id: 'administration', name: '學程行政'});
    assert.equal(app.workspaceDraft, '學程行政');
    app.chooseWorkspaceTemplate({id: 'research', name: '研究計劃'});
    assert.equal(app.workspaceDraft, '研究計劃');
    app.workspaceDraft = '我的教學工作';
    app.chooseWorkspaceTemplate({id: 'courses', name: '課程安排'});
    assert.equal(app.workspaceDraft, '我的教學工作');
    app.workspaceExamples = false;
    await Promise.all([app.saveWorkspace(), app.saveWorkspace()]);
    assert.equal(store.workspaces().filter(workspace => workspace.name === '我的教學工作').length, 1);
    assert.equal(store.tasks().length, 0); assert.equal(store.categories()[0].name, '授課安排');
    assert.equal(store.projects()[0].name, '我的教學工作');
    app.openWorkspaces(); app.editWorkspace(store.currentWorkspace());
    app.chooseWorkspaceTemplate({id: 'research', name: '研究計劃'});
    assert.equal(app.workspaceDraft, '我的教學工作');
    const original = structuredClone(store.currentWorkspace());
    app.workspaceDraft = '尚未儲存的改名'; app.openWorkspaces();
    assert.equal(app.workspaceEditingId(), ''); assert.equal(app.workspaceTemplateId(), 'blank'); assert.equal(app.workspaceDraft, '');
    assert.deepEqual(store.workspaces().find(workspace => workspace.id === original.id), original);
    app.workspaceDraft = '另一個工作空間'; await app.saveWorkspace();
    assert.notEqual(store.currentWorkspace().id, original.id); assert.equal(store.currentWorkspace().name, '另一個工作空間');
    assert.deepEqual(store.workspaces().find(workspace => workspace.id === original.id), original);
  } finally { close(); }
});

test('分類排序即時更新顯示順序，工作空間被取代時不操作新的分類', async () => {
  const {app, store, close} = application();
  try {
    await store.saveCategory({id: 'admin', name: '行政', color: 'blue'});
    app.openCategories(); await app.reorderCategory('admin', -1);
    assert.deepEqual(store.categories().map(category => category.id), ['admin', 'design']);
    const peer = new BoardStore();
    await peer.resetData(false, peer.revision()); store.refreshFromStorage();
    await app.reorderCategory('admin', 1);
    assert.match(app.categoryError(), /取代/);
    assert.equal(store.categories().length, 0);
  } finally { close(); }
});

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

test('截止篩選連動看板、清單及日曆，排除完成與封存且不改動進度', async () => {
  const {app, store, close} = application();
  try {
    app.now.set(new Date(2026, 9, 9, 12));
    await store.saveTask({...store.tasks()[0], dueDate: '2026-10-11', dueTime: '10:00'});
    await store.saveTask({...task, id: 'near', title: '明天截止', projectId: '', dueDate: '2026-10-10', dueTime: '09:00'});
    await store.saveTask({...task, id: 'archive', projectId: '', status: 'archived'});
    const progress = app.overallProgress().percent;
    assert.deepEqual(app.deadlineCounts(), {overdue: 1, 'due-soon': 2});
    app.selectDeadline('due-soon');
    assert.deepEqual(app.sortedTasks().map(task => task.id), ['near', 'welcome-task']);
    assert.deepEqual(app.columns().flatMap(column => column.tasks).map(task => task.id), ['welcome-task', 'near']);
    assert.deepEqual(app.calendarTasks().map(task => task.id), ['welcome-task', 'near']);
    assert.equal(app.overallProgress().percent, progress); assert.equal(app.sortState('dueDate'), 'ascending');
    app.toggleSort('dueDate'); assert.deepEqual(app.sortedTasks().map(task => task.id), ['welcome-task', 'near']);
    app.sortKey.set(null); assert.equal(app.sortState('dueDate'), 'ascending');
    app.selectDeadline('overdue'); assert.deepEqual(app.visibleTasks().map(task => task.id), ['daily']);
    app.selectScope('done'); assert.equal(app.deadlineFilter(), 'all'); assert.equal(app.visibleTasks()[0].id, 'website-task');
    app.clearFilters(); assert.equal(app.deadlineFilter(), 'all'); assert.equal(app.visibleTasks().length, 5);
  } finally { close(); }
});

test('月曆來源選擇由主畫面保存，切換視圖、截止篩選與工作空間不重設顯示偏好', () => {
  const {app, close} = application();
  try {
    assert.equal(app.calendarShowGoogle(), true); assert.equal(app.calendarShowOrbit(), true);
    app.calendarShowGoogle.set(false); app.calendarShowOrbit.set(false);
    app.view.set('month'); app.selectDeadline('overdue'); app.view.set('week'); app.clearFilters();
    assert.equal(app.calendarShowGoogle(), false); assert.equal(app.calendarShowOrbit(), false);
    app.calendarShowGoogle.set(true); app.selectDeadline('due-soon'); app.selectWorkspace('second');
    assert.equal(app.deadlineFilter(), 'all'); assert.equal(app.calendarShowGoogle(), true); assert.equal(app.calendarShowOrbit(), false);
  } finally { close(); }
});

test('1、3、7、30 天快捷篩選與下拉選項一致，不改動已保存的預設提醒天數', async () => {
  const {app, store, close} = application();
  try {
    app.now.set(new Date(2026, 9, 9, 12));
    for (const days of [1, 3, 7, 30]) await store.saveTask({...task, id: 'due-' + days, startDate: '', dueDate: `2026-${days === 30 ? '11' : '10'}-${String(days === 30 ? 8 : 9 + days).padStart(2, '0')}`, dueTime: '12:00'});
    assert.deepEqual(app.deadlinePresets().map(preset => preset.count), [1, 2, 3, 4]);
    for (const days of [1, 3, 7, 30]) {
      app.selectDeadlineOption('due-' + days);
      assert.equal(app.effectiveDeadlineDays(), days); assert.equal(app.deadlineSelection(), 'due-' + days);
      assert.deepEqual(app.sortedTasks().map(task => task.id), [1, 3, 7, 30].filter(value => value <= days).map(value => 'due-' + value));
      assert.equal(store.reminders().dueSoonDays, 3);
    }
    app.selectDeadlineOption('due-soon'); assert.equal(app.effectiveDeadlineDays(), 3);
    app.openReminders('next-week'); assert.equal(app.modal(), null); assert.equal(app.remindersOpen(), true); assert.equal(app.reminderTab(), 'next-week');
    app.showReminderDeadline(7); assert.equal(app.modal(), null); assert.equal(app.view(), 'list'); assert.equal(app.effectiveDeadlineDays(), 7);
    app.clearFilters(); assert.equal(app.deadlineDays(), null);
  } finally { close(); }
});

test('訊息中心開啟最新任務，已刪除／完成、舊世代與編輯中草稿不被提醒覆蓋', async () => {
  const {app, store, close} = application();
  try {
    const item = reminderItems(store.currentWorkspace(), store.generation(), [])[0];
    await store.saveTask({...store.tasks()[0], title: '新的標題'});
    app.openReminders('tomorrow'); app.openReminder(item);
    assert.equal(app.modal(), 'task'); assert.equal(app.draft.title, '新的標題');
    app.draft.title = '未儲存草稿'; app.openReminders(); app.openReminder(item);
    assert.equal(app.modal(), 'task'); assert.equal(app.draft.title, '未儲存草稿');
    app.closeModal(); app.openReminders(); app.openReminder({...item, generation: 'old'}); assert.equal(app.modal(), null); assert.equal(app.remindersOpen(), true);
    await store.deleteTask(item.task.id); app.openReminder(item); assert.equal(app.modal(), null); assert.equal(app.remindersOpen(), true);
    const done = {...item, task: store.tasks().find(task => task.status === 'done')}; app.openReminder(done); assert.equal(app.modal(), null); assert.equal(app.remindersOpen(), true);
  } finally { close(); }
});

test('Google 提醒開啟唯讀活動，隱藏或解除綁定的來源不再開啟', async () => {
  const {app, store, close} = application();
  try {
    await store.updateGoogle({clientId: '123-example.apps.googleusercontent.com'});
    await store.updateGoogle({accountId: 'account'});
    await store.bindCalendar({id: 'source', accountId: 'account', calendarId: 'calendar', name: '月曆', color: '#345678', visible: true, workspaceIds: []}, 'first', true);
    const external = externalEvent(store.google().sources[0], {id: 'event', start: {date: '2026-10-10'}, end: {date: '2026-10-11'}});
    const item = reminderItems(store.currentWorkspace(), store.generation(), [external]).find(item => item.external);
    app.openReminders(); app.openReminder(item); assert.equal(app.modal(), 'external-event'); assert.equal(app.externalEntry(), external);
    app.closeModal(); await store.updateCalendarSource('source', {visible: false}); app.openReminders(); app.openReminder(item); assert.equal(app.modal(), null); assert.equal(app.remindersOpen(), true);
    await store.removeCalendarSource('source'); app.openReminder(item); assert.equal(app.modal(), null); assert.equal(app.remindersOpen(), true);
  } finally { close(); }
});

test('提醒範圍與目前時間即時更新篩選，跨午夜後全天截止任務變為逾期', async () => {
  const {app, settings, store, close} = application();
  try {
    app.now.set(new Date(2026, 9, 7, 12)); app.selectDeadline('due-soon');
    assert.equal(app.visibleTasks().length, 2);
    await settings.setDueSoonDays('1'); assert.equal(app.visibleTasks().length, 0);
    await settings.setDueSoonDays('3'); assert.equal(app.visibleTasks().length, 2);
    await settings.setDueSoonDays(''); assert.match(settings.error(), /1 到 30/); assert.equal(store.reminders().dueSoonDays, 3);
    app.now.set(new Date(2026, 9, 9)); assert.equal(app.visibleTasks().length, 0);
    app.selectDeadline('overdue'); assert.equal(app.visibleTasks().length, 2);
    app.selectWorkspace('second'); assert.equal(app.deadlineFilter(), 'all'); assert.equal(app.deadlineCounts().overdue, 0);
  } finally { close(); }
});

test('側欄入口直接開啟月曆設定，設定分頁支援左右鍵與首末頁，切換保留重置草稿', () => {
  const {app, settings, close} = application();
  try {
    app.sidebarOpen.set(true); app.openSettings('calendar');
    assert.equal(app.modal(), 'settings'); assert.equal(app.settingsTab(), 'calendar'); assert.equal(app.sidebarOpen(), false);
    settings.initialTab = signal('calendar'); assert.equal(settings.activeTab(), 'calendar');
    let focused = '', prevented = 0;
    const key = name => settings.tabKeydown({key: name, preventDefault() { prevented++; }, currentTarget: {closest: () => ({querySelector: selector => ({focus() { focused = selector; }})})}});
    key('ArrowRight'); assert.equal(settings.activeTab(), 'gmail'); assert.match(focused, /gmail/);
    key('ArrowRight'); assert.equal(settings.activeTab(), 'drive'); assert.match(focused, /drive/);
    settings.beginReset('all'); settings.confirmation = '重置整個 Orbit';
    key('End'); assert.equal(settings.activeTab(), 'reset');
    key('ArrowRight'); assert.equal(settings.activeTab(), 'appearance');
    key('ArrowLeft'); assert.equal(settings.activeTab(), 'reset');
    key('Home'); assert.equal(settings.activeTab(), 'appearance');
    assert.equal(settings.confirmation, '重置整個 Orbit'); assert.equal(settings.resetMode(), 'all'); assert.equal(prevented, 6);
    app.openSettings(); assert.equal(app.settingsTab(), 'appearance');
  } finally { close(); }
});

test('主題快捷鍵循環淺色、深色及跟隨系統，其他外觀與工作資料保留', async () => {
  const {store, close} = application();
  const preferences = {theme: () => store.appearance().theme, setTheme: mode => store.updateAppearance({theme: mode})};
  try {
    for (const expected of ['dark', 'system', 'light']) {
      await UiPreferences.prototype.cycleTheme.call(preferences);
      assert.equal(store.appearance().theme, expected);
      assert.equal(store.appearance().textSize, 'standard'); assert.equal(store.tasks().length, 3);
    }
  } finally { close(); }
});

test('右下角訊息中心在開關任務及設定後保持開啟，Escape 先關中央視窗', () => {
  const {app, store, close} = application();
  try {
    app.toggleReminders(); assert.equal(app.remindersOpen(), true); assert.equal(app.modal(), null);
    const item = reminderItems(store.currentWorkspace(), store.generation(), [])[0];
    app.openReminder(item); assert.equal(app.modal(), 'task'); assert.equal(app.remindersOpen(), true);
    app.escape(); assert.equal(app.modal(), null); assert.equal(app.remindersOpen(), true);
    app.openReminder({...item, task: store.tasks().find(task => task.id === 'daily')});
    assert.equal(app.draft.id, 'daily'); assert.equal(app.remindersOpen(), true);
    app.closeModal(); app.openBackup(); assert.equal(app.modal(), 'settings'); assert.equal(app.settingsTab(), 'data');
    assert.equal(app.remindersOpen(), true); app.closeModal(); app.escape(); assert.equal(app.remindersOpen(), false);
    app.toggleReminders(); app.toggleReminders(); assert.equal(app.remindersOpen(), false);
  } finally { close(); }
});

test('清單空白處或列上 Enter 開啟任務，欄位控制與其鍵盤事件不誤觸', () => {
  const {app, store, close} = application();
  try {
    const current = store.tasks()[0];
    app.openListTask({type: 'click', target: {closest: () => ({})}}, current); assert.equal(app.modal(), null);
    app.openListTask({type: 'click', target: {closest: () => null}}, current); assert.equal(app.modal(), 'task');
    app.closeModal(); const row = {closest: () => null}; let prevented = false;
    app.openListTask({type: 'keydown', target: row, currentTarget: {}, preventDefault() {prevented = true;}}, current); assert.equal(app.modal(), null);
    app.openListTask({type: 'keydown', target: row, currentTarget: row, preventDefault() {prevented = true;}}, current);
    assert.equal(prevented, true); assert.equal(app.modal(), 'task');
  } finally { close(); }
});
