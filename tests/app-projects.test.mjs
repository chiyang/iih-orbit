import '@angular/compiler';
import { createEnvironmentInjector, runInInjectionContext, signal, ɵChangeDetectionScheduler, ɵEffectScheduler } from '@angular/core';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import {JSDOM} from 'jsdom';
import {documentFromUrl, DOCUMENT_DRAG_TYPE} from '../src/app/document-data.ts';
import { COLUMNS } from '../src/app/models.ts';
import { reminderItems } from '../src/app/reminder-items.ts';
import { externalEvent } from '../src/app/google-data.ts';
import { readBrowseState, saveBrowseState } from '../src/app/browse-state.ts';

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('@angular/build/package.json'))('esbuild');
await mkdir('.angular', {recursive: true});
const directory = await mkdtemp(resolve('.angular/app-project-test-'));
const output = resolve(directory, 'app.mjs');
await build({stdin: {contents: "export {DocumentTasks} from './src/app/document-tasks.ts'; export {App} from './src/app/app.ts'; export {Settings} from './src/app/settings.ts'; export {BoardStore} from './src/app/board-store.ts'; export {UiPreferences} from './src/app/ui-preferences.ts'; export {StartupGuide} from './src/app/startup-guide.ts';", resolveDir: process.cwd()}, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: output, tsconfig: 'tsconfig.json'});
const { DocumentTasks, App, Settings, BoardStore, UiPreferences, StartupGuide } = await import(pathToFileURL(output).href);
after(() => rm(directory, {recursive: true, force: true}));

const task = {id: 'welcome-task', title: '迎新海報', description: '', projectId: 'welcome', categoryId: 'design', status: 'todo', priority: 'medium', startDate: '2026-10-08', startTime: '', dueDate: '2026-10-08', dueTime: '', subtasks: []};

function application(fresh = false) {
  const state = {version: 1, activeWorkspaceId: 'first', workspaces: [{version: 4, id: 'first', name: '學程工作', projects: [{id: 'welcome', name: '迎新活動'}, {id: 'website', name: '網站改版'}], categories: [{id: 'design', name: '設計', color: 'green'}], statuses: COLUMNS, tasks: [task, {...task, id: 'website-task', title: '網站首頁', projectId: 'website', status: 'done'}, {...task, id: 'daily', title: '日常任務', projectId: ''}]}, {version: 4, id: 'second', name: '個人生活', projects: [], categories: [], statuses: COLUMNS, tasks: []}]};
  const values = new Map(fresh ? [] : [['orbit-workspaces-v1', JSON.stringify(state)]]);
  globalThis.localStorage = {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key)};
  const store = new BoardStore();
  const effects = new Set();
  const scheduler = {add(effect) {effects.add(effect);}, schedule() {}, remove(effect) {effects.delete(effect);}};
  const injector = createEnvironmentInjector([DocumentTasks, {provide: BoardStore, useValue: store}, {provide: UiPreferences, useValue: {textSize: () => 'standard'}}, {provide: ɵEffectScheduler, useValue: scheduler}, {provide: ɵChangeDetectionScheduler, useValue: {notify() {}}}]);
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

test('桌面可收合及開啟左側欄，窄畫面沿用遮罩導覽並保留桌面的收合狀態', () => {
  const f = application(), app = f.app;
  try {
    assert.equal(app.sidebarVisible(), true);
    app.toggleSidebar(); assert.equal(app.sidebarVisible(), false); assert.equal(app.sidebarOpen(), false);
    app.toggleSidebar(); assert.equal(app.sidebarVisible(), true);
    app.toggleSidebar(); app.mobileViewport.set(true);
    assert.equal(app.sidebarVisible(), false);
    app.toggleSidebar(); assert.equal(app.sidebarVisible(), true); assert.equal(app.sidebarOpen(), true);
    app.escape(); assert.equal(app.sidebarVisible(), false); assert.equal(app.sidebarCollapsed(), true);
    app.toggleSidebar(); globalThis.window = {innerWidth: 1440}; app.resize();
    assert.equal(app.sidebarOpen(), false); assert.equal(app.sidebarVisible(), false);
    app.toggleSidebar(); assert.equal(app.sidebarVisible(), true);
    app.tasksOpen.set(true); app.narrowPanelViewport.set(true);
    assert.equal(app.sidebarVisible(), false);
    app.toggleSidebar(); assert.equal(app.sidebarVisible(), true);
    app.escape(); assert.equal(app.tasksOpen(), true); assert.equal(app.sidebarVisible(), false);
    app.tasksOpen.set(false); assert.equal(app.sidebarVisible(), true);
  } finally {delete globalThis.window; f.close();}
});

test('手機來源拖曳先隱藏側欄遮罩並保留來源狀態，結束才真正關閉；桌面與非來源拖曳不受影響', () => {
  const f = application(), app = f.app;
  const drag = (types = [DOCUMENT_DRAG_TYPE]) => ({defaultPrevented: false, dataTransfer: {types}, target: {closest: () => ({})}});
  try {
    app.panelOverlay.set(true); app.mobileViewport.set(true); app.filesOpen.set(true);
    assert.equal(app.panelBlocking(), true);
    app.sourceDragStarted(drag(['text/plain'])); assert.equal(app.sourcePanelDragging(), false);
    app.sourceDragStarted(drag());
    assert.equal(app.sourcePanelDragging(), true); assert.equal(app.panelBlocking(), false); assert.equal(app.filesOpen(), true);
    app.sourceDragFinished(); assert.equal(app.sourcePanelDragging(), false); assert.equal(app.panelOpen(), false);
    app.filesOpen.set(true); app.panelOverlay.set(false); app.sourceDragStarted(drag());
    assert.equal(app.sourcePanelDragging(), false); app.sourceDragFinished(); assert.equal(app.filesOpen(), true);
    app.panelOverlay.set(true); app.sourceDragStarted({...drag(), defaultPrevented: true}); assert.equal(app.panelBlocking(), true);
  } finally {f.close();}
});

test('垃圾桶排除任務視圖、專案進度與側欄來源，還原及復原接回任務，精簡模式保留篩選', async () => {
  const f = application();
  try {
    const {app, store} = f;
    await app.toggleWorkspaceHeader(); app.projectFilter.set('welcome'); app.progressExpanded.set(true);
    await store.setTaskPinned('welcome-task', true);
    await store.deleteTask('welcome-task');
    assert.equal(app.visibleTasks().length, 0); assert.equal(app.selectedProgress().taskCount, 0);
    assert.equal(app.calendarTasks().length, 0); assert.equal(store.tasks().some(task => task.pinned), false);
    app.openTrash(); assert.equal(app.navigationTitle(), '垃圾桶');
    app.rememberBrowse(); const reopened = f.reopen();
    assert.equal(reopened.trashOpen(), true); assert.equal(reopened.headerCompact(), true);
    assert.equal(reopened.progressExpanded(), true); assert.equal(reopened.projectFilter(), 'welcome');
    await app.restoreTrashedTask(store.trashedTasks()[0]); assert.equal(store.trashedTasks().length, 0);
    await app.undoLastAction(); assert.equal(store.trashedTasks().length, 1);
    app.requestEmptyTrash(); assert.equal(app.modal(), 'empty-trash'); assert.equal(app.emptyTrashContext().tasks.length, 1);
    app.closeModal(); assert.equal(app.emptyTrashContext(), null); assert.equal(store.trashedTasks().length, 1);
    app.selectCategory('design'); assert.equal(app.trashOpen(), false); assert.equal(app.headerCompact(), true);
  } finally {f.close();}
});

test('編輯內容拖曳選取到遮罩不關閉，只有遮罩上的完整短按會關閉', () => {
  const f = application(), backdrop = {}, content = {};
  const event = (target = backdrop, patch = {}) => ({target, currentTarget: backdrop, pointerId: 1, button: 0, isPrimary: true, clientX: 20, clientY: 20, ...patch});
  try {
    const app = f.app; app.openTask('todo', task); app.draft.description = '尚未儲存的描述';
    app.startBackdropClick(event(content)); app.finishBackdropClick(event()); app.closeFromBackdrop(event());
    assert.equal(app.modal(), 'task'); assert.equal(app.draft.description, '尚未儲存的描述');
    app.startBackdropClick(event()); app.finishBackdropClick(event(content)); app.closeFromBackdrop(event()); assert.equal(app.modal(), 'task');
    app.startBackdropClick(event()); app.finishBackdropClick(event(backdrop, {clientX: 100})); app.closeFromBackdrop(event()); assert.equal(app.modal(), 'task');
    app.startBackdropClick(event(backdrop, {button: 2})); app.finishBackdropClick(event()); app.closeFromBackdrop(event()); assert.equal(app.modal(), 'task');
    app.startBackdropClick(event()); app.finishBackdropClick(event(backdrop, {pointerId: 2})); app.closeFromBackdrop(event()); assert.equal(app.modal(), 'task');
    app.startBackdropClick(event()); app.cancelBackdropClick(); app.finishBackdropClick(event()); app.closeFromBackdrop(event()); assert.equal(app.modal(), 'task');
    app.startBackdropClick(event()); app.finishBackdropClick(event(backdrop, {clientX: 22})); app.closeFromBackdrop(event()); assert.equal(app.modal(), null);
  } finally {f.close();}
});

test('登出開啟確認視窗不改資料，取消可關閉；同步登出期間遮罩與 Escape 不能關閉', () => {
  const f = application(), backdrop = {}, event = {target: backdrop, currentTarget: backdrop, pointerId: 1, button: 0, isPrimary: true, clientX: 20, clientY: 20};
  try {
    const before = structuredClone(f.store.workspaces()); f.app.openLogout();
    assert.equal(f.app.modal(), 'logout'); assert.deepEqual(f.store.workspaces(), before);
    f.app.closeModal(); assert.equal(f.app.modal(), null); assert.deepEqual(f.store.workspaces(), before);
    f.app.openLogout(); f.app.logoutSaving.set(true); f.app.escape(); assert.equal(f.app.modal(), 'logout');
    f.app.startBackdropClick(event); f.app.finishBackdropClick(event); f.app.closeFromBackdrop(event); assert.equal(f.app.modal(), 'logout');
    f.app.logoutSaving.set(false); f.app.escape(); assert.equal(f.app.modal(), null);
  } finally {f.close();}
});

test('週視圖範圍設定驗證起訖、只保存本機，重新開啟仍可讀取', async () => {
  const f = application(), preferences = f.settings.preferences;
  try {
    preferences.weekRange = signal({startHour: 8, endHour: 19}); preferences.weekRangeWarning = signal('');
    preferences.calendarWidth = signal('wide'); preferences.calendarWidthWarning = signal('');
    preferences.setWeekRange = range => UiPreferences.prototype.setWeekRange.call(preferences, range);
    f.settings.changeWeekRange('startHour', '6'); f.settings.changeWeekRange('endHour', '21'); f.settings.saveWeekRange();
    assert.deepEqual(preferences.weekRange(), {startHour: 6, endHour: 21}); assert.match(f.settings.weekRangeFeedback(), /已保存/);
    assert.deepEqual(JSON.parse(f.values.get('iih-orbit-calendar-display-v1')).range, {startHour: 6, endHour: 21});
    const backup = await f.store.backupForExport('full'); assert.equal(JSON.stringify(backup).includes('startHour'), false);
    f.settings.changeWeekRange('startHour', '22'); f.settings.saveWeekRange(); assert.match(preferences.weekRangeWarning(), /結束時間需晚於開始時間/);
    assert.deepEqual(preferences.weekRange(), {startHour: 6, endHour: 21}); assert.equal(f.settings.weekRangeFeedback(), '');
    preferences.setWeekRange({startHour: 0, endHour: 24}); assert.deepEqual(preferences.weekRange(), {startHour: 0, endHour: 24});
  } finally {f.close();}
});

test('復原與重做快捷鍵保護表單及原生文字操作，只有工作區未忙碌時才攔截', async () => {
  const f = application();
  try {
    const {app, store} = f;
    await store.setTaskPinned('welcome-task', true);
    let prevented = 0;
    const event = {key: 'z', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, defaultPrevented: false, target: {closest: () => ({})}, preventDefault() {prevented++;}};
    app.undoKey(event); assert.equal(prevented, 0);
    event.target.closest = () => null; app.modal.set('task'); app.undoKey(event); assert.equal(prevented, 0); app.modal.set(null);
    app.undoKey({...event, shiftKey: true}); assert.equal(prevented, 0);
    app.undoKey(event); assert.equal(prevented, 1);
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(store.tasks()[0].pinned, undefined); assert.equal(store.canUndo(), false);
    assert.equal(store.canRedo(), true);
    event.target.closest = () => ({}); app.undoKey({...event, shiftKey: true}); assert.equal(prevented, 1);
    event.target.closest = () => null; app.modal.set('task'); app.undoKey({...event, key: 'y'}); assert.equal(prevented, 1); app.modal.set(null);
    app.undoKey({...event, ctrlKey: false, metaKey: true, shiftKey: true}); assert.equal(prevented, 2);
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(store.tasks()[0].pinned, true); assert.equal(store.canRedo(), false);
    await store.undo(); app.undoKey({...event, key: 'y'}); assert.equal(prevented, 3);
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(store.tasks()[0].pinned, true);
  } finally {f.close();}
});

test('舊本機精簡模式升級至工作空間，跨分頁更新及備份設定優先於本機瀏覽偏好', async () => {
  const f = application();
  try {
    const {store} = f;
    saveBrowseState(store.generation(), store.currentWorkspace().id, readBrowseState({headerCompact: true}));
    const reopened = f.reopen(); assert.equal(reopened.headerCompact(), true);
    f.flush(); for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(store.currentWorkspace().headerCompact, true);
    const peer = new BoardStore(); await peer.setWorkspaceHeaderCompact(false);
    store.refreshFromStorage(); assert.equal(reopened.headerCompact(), false);
    f.flush(); assert.equal(reopened.headerCompact(), false);
    await reopened.toggleWorkspaceHeader(); assert.equal(store.currentWorkspace().headerCompact, true);
    reopened.selectWorkspace('second'); f.flush(); assert.equal(reopened.headerCompact(), false);
    await reopened.toggleWorkspaceHeader(); assert.equal(reopened.headerCompact(), true);
    reopened.selectWorkspace('first'); f.flush(); assert.equal(reopened.headerCompact(), true);
    await reopened.toggleWorkspaceHeader(); assert.equal(reopened.headerCompact(), false);
    reopened.selectWorkspace('second'); f.flush(); assert.equal(reopened.headerCompact(), true);
  } finally {f.close();}
});

test('釘選與最近編輯 toggle 連動各視圖及原篩選，清除、重開與工作空間切換一致', async () => {
  const f = application();
  try {
    const {app, store} = f;
    await app.togglePin(store.tasks()[0]); assert.equal(store.tasks()[0].pinned, true);
    assert.equal(store.tasks()[0].updatedAt, undefined);
    await store.saveTask({...store.tasks()[0], description: '最新描述'});
    app.now.set(new Date()); app.pinnedOnly.set(true); app.recentOnly.set(true);
    assert.deepEqual(app.visibleTasks().map(item => item.id), ['welcome-task']);
    assert.deepEqual(app.sortedTasks().map(item => item.id), ['welcome-task']);
    assert.deepEqual(app.columns().flatMap(column => column.tasks).map(item => item.id), ['welcome-task']);
    assert.deepEqual(app.calendarTasks().map(item => item.id), ['welcome-task']);
    app.query.set('不存在'); assert.equal(app.visibleTasks().length, 0); app.query.set('');
    app.categoryFilter.set(''); assert.equal(app.visibleTasks().length, 0); app.categoryFilter.set('all');
    app.deadlineFilter.set('unset'); assert.equal(app.visibleTasks().length, 0); app.deadlineFilter.set('all');
    app.openTaskPanel(); app.rememberBrowse();
    const reopened = f.reopen();
    assert.equal(reopened.tasksOpen(), true); assert.equal(reopened.pinnedOnly(), true); assert.equal(reopened.recentOnly(), true);
    app.clearFilters(); assert.equal(app.pinnedOnly(), false); assert.equal(app.recentOnly(), false); assert.equal(app.hasFilters(), false);
    f.flush(); app.pinnedOnly.set(true); app.rememberBrowse(); store.switchWorkspace('second'); f.flush();
    assert.equal(app.pinnedOnly(), false); assert.equal(app.tasksOpen(), true); assert.equal(store.tasks().length, 0);
    store.switchWorkspace('first'); f.flush(); assert.equal(app.pinnedOnly(), true);
  } finally { f.close(); }
});

test('任務側欄與 Gmail／提醒互斥，保留主畫面篩選並開啟最新任務，Escape 及重新載入接續', async () => {
  const f = application();
  try {
    const {app, store} = f;
    app.query.set('網站'); app.view.set('list'); app.openTaskPanel();
    assert.equal(app.panelOpen(), true); assert.equal(app.tasksOpen(), true);
    app.openMail(); assert.equal(app.tasksOpen(), false); assert.equal(app.mailOpen(), true);
    app.openReminders(); assert.equal(app.mailOpen(), false); assert.equal(app.remindersOpen(), true);
    app.openTaskPanel(); assert.equal(app.remindersOpen(), false);
    assert.equal(app.query(), '網站'); assert.equal(app.view(), 'list');
    const old = structuredClone(store.tasks()[0]);
    await store.saveTask({...store.tasks()[0], title: '更新後的任務'});
    app.openPanelTask(old); assert.equal(app.draft.title, '更新後的任務'); assert.equal(app.tasksOpen(), true);
    app.escape(); assert.equal(app.modal(), null); assert.equal(app.tasksOpen(), true);
    app.rememberBrowse(); assert.equal(f.reopen().tasksOpen(), true);
    app.escape(); assert.equal(app.panelOpen(), false);
    app.togglePanel(); assert.equal(app.tasksOpen(), true); app.togglePanel(); assert.equal(app.panelOpen(), false);
    await store.deleteTask(old.id); app.openPanelTask(old); assert.equal(app.modal(), null); assert.match(app.toast(), /刪除/);
    app.openTask(); app.draft.title = '未儲存的草稿'; app.openTaskPanel(); app.openPanelTask(store.tasks()[0]);
    assert.equal(app.tasksOpen(), false); assert.equal(app.draft.title, '未儲存的草稿');
  } finally { f.close(); }
});

test('右側欄開關保留 Gmail 或提醒分頁，關閉後重新載入仍可接續，編輯中不切換', () => {
  const f = application();
  try {
    const {app} = f;
    app.togglePanel(); assert.equal(app.tasksOpen(), true);
    app.openMail(); app.togglePanel();
    assert.equal(app.panelOpen(), false); assert.equal(app.panelTab(), 'gmail');
    app.togglePanel(); assert.equal(app.mailOpen(), true); assert.equal(app.tasksOpen(), false);
    app.closePanel(); app.rememberBrowse();
    const reopened = f.reopen();
    assert.equal(reopened.panelOpen(), false); reopened.togglePanel(); assert.equal(reopened.mailOpen(), true);
    app.openReminders('next-week'); app.escape(); app.togglePanel();
    assert.equal(app.remindersOpen(), true); assert.equal(app.reminderTab(), 'next-week');
    app.openTask(); app.draft.title = '編輯中的任務'; app.togglePanel();
    assert.equal(app.remindersOpen(), true); assert.equal(app.draft.title, '編輯中的任務');
    app.closeModal(); app.closePanel(); app.rememberBrowse();
    const reminders = f.reopen(); reminders.togglePanel();
    assert.equal(reminders.remindersOpen(), true); assert.equal(reminders.reminderTab(), 'next-week');
  } finally { f.close(); }
});

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

test('未設置截止日期包含只有開始日期的任務，遵守原狀態與其他篩選，重新整理保留', async () => {
  const f = application(), {app, store} = f;
  try {
    await store.saveTask({...task, id: 'undated', title: '沒有日期', categoryId: '', projectId: '', startDate: '', dueDate: ''});
    await store.saveTask({...task, id: 'start-only', title: '已安排開始', priority: 'high', dueDate: ''});
    await store.saveTask({...task, id: 'done-undated', status: 'done', dueDate: ''});
    await store.saveTask({...task, id: 'archived-undated', status: 'archived', dueDate: ''});
    const progress = app.overallProgress().percent;
    app.selectDeadlineOption('unset');
    assert.equal(app.scope(), 'all'); assert.equal(app.deadlineSelection(), 'unset'); assert.equal(app.effectiveSortKey(), null);
    assert.deepEqual(app.visibleTasks().map(task => task.id), ['undated', 'start-only', 'done-undated', 'archived-undated']);
    assert.deepEqual(app.sortedTasks().map(task => task.id), ['undated', 'start-only', 'done-undated', 'archived-undated']);
    assert.deepEqual(app.calendarTasks().map(task => task.id), ['undated', 'start-only', 'done-undated']);
    assert.deepEqual(app.columns().flatMap(column => column.tasks).map(task => task.id), ['undated', 'start-only', 'done-undated']);
    assert.equal(app.overallProgress().percent, progress);
    for (const [scope, ids] of [['active', ['undated', 'start-only']], ['done', ['done-undated']], ['archived', ['archived-undated']]]) {
      app.selectScope(scope); app.selectDeadlineOption('unset');
      assert.equal(app.scope(), scope); assert.deepEqual(app.visibleTasks().map(task => task.id), ids);
    }
    app.selectScope('all'); app.selectDeadlineOption('unset'); app.view.set('list');
    app.projectFilter.set('welcome'); app.categoryFilter.set('design'); app.priorityFilter.set('high'); app.query.set('已安排');
    assert.deepEqual(app.visibleTasks().map(task => task.id), ['start-only']);
    f.flush(); const restored = f.reopen();
    assert.equal(restored.deadlineSelection(), 'unset'); assert.equal(restored.view(), 'list');
    assert.deepEqual(restored.visibleTasks().map(task => task.id), ['start-only']);
    app.clearFilters(); assert.equal(app.deadlineSelection(), 'all'); assert.equal(app.visibleTasks().length, 7);
  } finally {f.close();}
});

test('本週篩選連動各視圖與其他條件，重新整理保留選擇，週日自動換週', async () => {
  const f = application(), {app, store} = f;
  try {
    app.now.set(new Date(2026, 9, 7, 12));
    await store.saveTask({...task, id: 'ongoing', startDate: '2026-09-30', dueDate: '2026-10-12', priority: 'high'});
    await store.saveTask({...task, id: 'deadline-only', startDate: '', dueDate: '2026-10-04'});
    await store.saveTask({...task, id: 'next-week', startDate: '2026-10-11', dueDate: '2026-10-11'});
    await store.saveTask({...task, id: 'archived', status: 'archived'});
    const progress = app.overallProgress().percent;
    app.scope.set('done'); app.selectDeadlineOption('this-week');
    const ids = ['welcome-task', 'daily', 'ongoing', 'deadline-only'];
    assert.equal(app.scope(), 'active'); assert.equal(app.deadlineSelection(), 'this-week'); assert.equal(app.thisWeekCount(), 4);
    assert.deepEqual(app.visibleTasks().map(task => task.id), ids);
    assert.deepEqual(app.calendarTasks().map(task => task.id), ids);
    assert.deepEqual(app.columns().flatMap(column => column.tasks).map(task => task.id), ids);
    assert.deepEqual(app.sortedTasks().map(task => task.id), ['ongoing', 'welcome-task', 'daily', 'deadline-only']);
    assert.equal(app.overallProgress().percent, progress);
    app.projectFilter.set('welcome'); app.categoryFilter.set('design'); app.priorityFilter.set('high'); app.query.set('迎新');
    assert.deepEqual(app.visibleTasks().map(task => task.id), ['ongoing']);
    app.openReminders('this-week'); f.flush();
    const restored = f.reopen(); restored.now.set(app.now());
    assert.equal(restored.deadlineFilter(), 'this-week'); assert.equal(restored.reminderTab(), 'this-week');
    assert.equal(restored.remindersOpen(), true); assert.deepEqual(restored.visibleTasks().map(task => task.id), ['ongoing']);
    app.clearFilters(); app.selectDeadline('this-week'); app.now.set(new Date(2026, 9, 11));
    assert.deepEqual(app.visibleTasks().map(task => task.id), ['ongoing', 'next-week']);
    assert.equal(app.thisWeekCount(), 2);
    app.selectDeadline('all'); assert.equal(app.deadlineFilter(), 'all'); assert.equal(app.scope(), 'active');
  } finally {f.close();}
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
    key('ArrowRight'); assert.equal(settings.activeTab(), 'drive-files'); assert.match(focused, /drive-files/);
    key('ArrowRight'); assert.equal(settings.activeTab(), 'drive'); assert.match(focused, /drive/);
    settings.beginReset('all'); settings.confirmation = '重置整個 Orbit';
    key('End'); assert.equal(settings.activeTab(), 'reset');
    key('ArrowRight'); assert.equal(settings.activeTab(), 'appearance');
    key('ArrowLeft'); assert.equal(settings.activeTab(), 'reset');
    key('Home'); assert.equal(settings.activeTab(), 'appearance');
    assert.equal(settings.confirmation, '重置整個 Orbit'); assert.equal(settings.resetMode(), 'all'); assert.equal(prevented, 7);
    app.openSettings('drive-files'); assert.equal(app.settingsTab(), 'drive-files');
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

test('多功能側欄入口切到提示對應內容，同頁可關閉；新郵件清除搜尋並顯示收件匣', () => {
  const f = application(), calls = [];
  try {
    const {app} = f;
    Object.defineProperty(app, 'mailTasks', {value: {gmail: {search: value => calls.push(['search', value]), applyLabels: value => calls.push(['labels', value])}}});
    app.query.set('主畫面篩選'); app.openMail(); app.activatePanel({target: 'tasks'});
    assert.equal(app.mailOpen(), false); assert.equal(app.tasksOpen(), true);
    app.activatePanel({target: 'tasks'}); assert.equal(app.panelOpen(), false);
    app.activatePanel({target: 'toggle'}); assert.equal(app.tasksOpen(), true);
    app.activatePanel({target: 'reminders', tab: 'overdue'}); assert.equal(app.tasksOpen(), false); assert.equal(app.remindersOpen(), true); assert.equal(app.reminderTab(), 'overdue');
    app.activatePanel({target: 'gmail'}); assert.equal(app.mailOpen(), true); assert.equal(app.remindersOpen(), false);
    assert.deepEqual(calls, [['search', ''], ['labels', ['INBOX']]]); assert.equal(app.query(), '主畫面篩選');
    app.modal.set('task'); app.activatePanel({target: 'tasks'}); assert.equal(app.mailOpen(), true);
  } finally {f.close();}
});

test('檔案獨立分頁與任務／Gmail／提醒互斥，重新開啟保存分頁與原篩選', () => {
  const f = application();
  try {const app = f.app; app.projectFilter.set('welcome'); app.openFiles(); assert.equal(app.filesOpen(), true); assert.equal(app.panelTab(), 'files'); assert.equal(app.panelOpen(), true); assert.equal(app.tasksOpen(), false); assert.equal(app.mailOpen(), false); assert.equal(app.remindersOpen(), false); app.rememberBrowse(); const reopen = f.reopen(); assert.equal(reopen.filesOpen(), true); assert.equal(reopen.projectFilter(), 'welcome'); app.closePanel(); assert.equal(app.panelOpen(), false); app.togglePanel(); assert.equal(app.filesOpen(), true); app.openTaskPanel(); assert.equal(app.filesOpen(), false); app.openMail(); assert.equal(app.filesOpen(), false); app.openFiles(); app.openReminders(); assert.equal(app.filesOpen(), false);} finally {f.close();}
});

test('看板邊緣 placeholder 保持落點；中央關聯與空欄新增，工具列不接受檔案', async () => {
  const f = application(), dom = new JSDOM('<div class="kanban-column" data-status="todo"><div class="document-board-placeholder"></div><article class="task-card" data-task-id="welcome-task"><span>task</span></article></div><header></header>'), previousElement = globalThis.Element, previousNode = globalThis.Node;
  globalThis.Element = dom.window.Element; globalThis.Node = dom.window.Node;
  const card = dom.window.document.querySelector('article'), placeholder = dom.window.document.querySelector('.document-board-placeholder'), data = new Map();
  const transfer = {types: [DOCUMENT_DRAG_TYPE], setData: (key, value) => data.set(key, value), getData: key => data.get(key), dropEffect: 'none'};
  const event = (target, y) => ({target, currentTarget: target, clientY: y, clientX: 150, dataTransfer: transfer, preventDefault() {}, stopPropagation() {}});
  const source = documentFromUrl('google-drive', 'https://docs.google.com/document/d/file/edit', '檔案');
  try {
    card.getBoundingClientRect = () => ({top: 100, bottom: 300, height: 200}); placeholder.getBoundingClientRect = () => ({top: 0, bottom: 0});
    f.app.documentTasks.start({...event(null, 20)}, source, () => true); f.app.documentTasks.notice.set('上一筆操作已完成');
    f.app.documentOver(event(card.querySelector('span'), 200)); assert.equal(f.app.documentLinks('welcome-task'), true);
    f.app.documentOver(event(card, 105)); assert.equal(f.app.documentCreates('welcome-task', 'todo'), true);
    // The displayed placeholder shifts the card down. Dropping inside it must preserve insertion.
    placeholder.getBoundingClientRect = () => ({top: 100, bottom: 170}); card.getBoundingClientRect = () => ({top: 180, bottom: 380, height: 200});
    await f.app.dropDocument(event(placeholder, 150)); assert.equal(f.app.modal(), null); assert.equal(f.store.tasks()[0].title, '檔案'); assert.equal(f.store.documentsForTask(f.store.tasks()[0].id)[0].id, source.id);
    f.app.documentTasks.start(event(null, 20), source, () => true); f.app.documentOver(event(dom.window.document.querySelector('header'), 20)); assert.equal(f.app.documentTasks.position(), null);
  } finally {globalThis.Element = previousElement; globalThis.Node = previousNode; dom.window.close(); f.close();}
});

test('郵件看板與清單中央關聯、邊緣新增，placeholder 位移不改變落點', async () => {
  const f = application(), dom = new JSDOM('<div class="kanban-column"><div class="mail-board-placeholder"></div><article class="task-card" data-task-id="welcome-task"><span>task</span></article></div><table><thead><tr><th>標題</th></tr></thead><tbody><tr class="task-row" data-task-id="daily"><td>任務</td></tr></tbody></table>'), previousNode = globalThis.Node;
  globalThis.Node = dom.window.Node;
  const board = dom.window.document.querySelector('.kanban-column'), card = board.querySelector('article'), placeholder = board.querySelector('.mail-board-placeholder'), list = dom.window.document.querySelector('table'), row = list.querySelector('.task-row'), drops = [];
  const mail = {boardPosition: signal(null), dragging: signal(true), over: () => true, drop: async (...args) => drops.push(args), undoContext: () => null};
  Object.defineProperty(f.app, 'mailTasks', {value: mail});
  const event = (currentTarget, target, y) => ({currentTarget, target, clientY: y});
  try {
    card.getBoundingClientRect = () => ({top: 100, height: 200}); placeholder.getBoundingClientRect = () => ({top: 0, bottom: 0});
    f.app.boardMailOver(event(board, card, 200), COLUMNS[0]); assert.equal(f.app.mailLinks('welcome-task'), true); assert.equal(f.app.mailCreates(undefined, 'todo'), false);
    await f.app.dropBoardMail(event(board, card, 200), COLUMNS[0]); assert.equal(drops[0][4], 'welcome-task');
    f.app.boardMailOver(event(board, card, 105), COLUMNS[0]); assert.equal(f.app.mailCreates('welcome-task', 'todo'), true);
    placeholder.getBoundingClientRect = () => ({top: 100, bottom: 170}); card.getBoundingClientRect = () => ({top: 180, height: 200});
    await f.app.dropBoardMail(event(board, placeholder, 150), COLUMNS[0]); assert.equal(drops[1][3], 'welcome-task'); assert.equal(drops[1][4], undefined);
    row.getBoundingClientRect = () => ({top: 100, height: 50}); f.app.listMailOver(event(list, row, 125)); assert.equal(f.app.mailLinks('daily'), true);
    await f.app.dropListMail(event(list, row, 125)); assert.equal(drops[2][4], 'daily');
    f.app.listMailOver(event(list, row, 101)); assert.equal(f.app.mailCreates('daily'), true);
    assert.equal(f.app.listMailOver(event(list, list.querySelector('th'), 20)), false); assert.equal(mail.boardPosition(), null);
  } finally {globalThis.Node = previousNode; dom.window.close(); f.close();}
});
