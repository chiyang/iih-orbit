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
import {BOARD_TASK_DRAG_TYPE, TASK_LINK_DRAG_TYPE} from '../src/app/task-link-drag.ts';
import {editGanttSchedule} from '../src/app/gantt-edit.ts';
import {Dialog} from '@angular/cdk/dialog';
import {Subject} from 'rxjs';

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('@angular/build/package.json'))('esbuild');
await mkdir('.angular', {recursive: true});
const directory = await mkdtemp(resolve('.angular/app-project-test-'));
const output = resolve(directory, 'app.mjs');
await build({stdin: {contents: "export {DocumentTasks} from './src/app/document-tasks.ts'; export {App} from './src/app/app.ts'; export {Settings} from './src/app/settings.ts'; export {BoardStore} from './src/app/board-store.ts'; export {UiPreferences} from './src/app/ui-preferences.ts'; export {StartupGuide} from './src/app/startup-guide.ts';", resolveDir: process.cwd()}, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: output, tsconfig: 'tsconfig.json'});
const { DocumentTasks, App, Settings, BoardStore, UiPreferences, StartupGuide } = await import(pathToFileURL(output).href);
after(() => rm(directory, {recursive: true, force: true}));

const task = {id: 'welcome-task', title: '迎新海報', description: '', projectId: 'welcome', categoryId: 'design', status: 'todo', priority: 'medium', startDate: '2026-10-08', startTime: '', dueDate: '2026-10-08', dueTime: '', subtasks: []};

test('相關任務草稿可恢復及取消，只有儲存才建立雙向跨專案連結', async () => {
  const f = application(), {app, store} = f;
  try {
    app.openTask('todo', store.tasks()[0]); app.draftRelatedTasks.set(['website-task']); app.flushLocalTaskDraft();
    assert.deepEqual(store.relatedTaskIds('welcome-task'), []); app.closeModal();
    app.openTask('todo', store.tasks()[0]); assert.ok(app.localTaskDraftRecovery()); app.restoreLocalTaskDraft(); assert.deepEqual(app.draftRelatedTasks(), ['website-task']);
    app.cancelTaskEdit(); assert.deepEqual(store.relatedTaskIds('welcome-task'), []);
    app.openTask('todo', store.tasks()[0]); app.draftRelatedTasks.set(['website-task']); await app.saveTask();
    assert.equal(app.modal(), null); assert.deepEqual(store.relatedTaskIds('welcome-task'), ['website-task']); assert.deepEqual(store.relatedTaskIds('website-task'), ['welcome-task']);
    app.openTask('done', store.tasks().find(task => task.id === 'website-task')); app.draftRelatedTasks.set([]); app.cancelTaskEdit(); assert.deepEqual(store.relatedTaskIds('welcome-task'), ['website-task']);
  } finally {f.close();}
});

test('選取連結不開啟任務、不移動卡片，切換視圖及 Esc 取消，拒絕偽造拖曳', async () => {
  const f = application(), {app, store} = f;
  try {
    f.flush(); const before = store.tasks().map(task => [task.id, task.status, task.projectId]);
    const source = store.tasks()[0], target = store.tasks()[1];
    app.beginTaskLink(source); await app.linkSelectedTask(target); assert.equal(app.modal(), null); assert.deepEqual(store.relatedTaskIds(source.id), [target.id]); assert.deepEqual(store.tasks().map(task => [task.id, task.status, task.projectId]), before);
    app.beginTaskLink(store.tasks()[0]); app.escape(); assert.equal(app.taskLinkSource(), null);
    app.beginTaskLink(store.tasks()[0]); app.view.set('list'); f.flush(); assert.equal(app.taskLinkSource(), null);
    const payload = new Map(), event = {dataTransfer: {types: [TASK_LINK_DRAG_TYPE], setData: (type, value) => payload.set(type, value), getData: type => payload.get(type)}, preventDefault() {}, stopPropagation() {}};
    app.startTaskLinkDrag(event, store.tasks()[0]); assert.ok(payload.get(TASK_LINK_DRAG_TYPE)); payload.set(TASK_LINK_DRAG_TYPE, JSON.stringify({...JSON.parse(payload.get(TASK_LINK_DRAG_TYPE)), token: 'forged'}));
    app.dropTaskLink(event, store.tasks()[2]); assert.deepEqual(store.relatedTaskIds('daily'), []); assert.equal(app.taskLinkSource(), null);
    app.startTaskLinkDrag(event, store.tasks()[0]); app.dropTaskLink(event, store.tasks()[2]);
    await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(store.relatedTaskIds('daily'), ['welcome-task']); assert.equal(app.modal(), null);
    app.endTaskLinkDrag(); app.openTask('todo', store.tasks()[0]); assert.equal(app.modal(), null);
  } finally {f.close();}
});

test('相關任務開啟最新名稱並保護未保存草稿，文件建立及 Calendar 移轉不跳過連結保存', async () => {
  const f = application(), {app, store} = f;
  try {
    await store.linkTasks(store.taskContext('welcome-task'), store.taskContext('daily'));
    app.openTask('todo', store.tasks()[0]); app.draft.description = '尚未儲存'; app.openRelatedTask('daily'); assert.equal(app.draft.id, 'welcome-task'); assert.match(app.formError(), /先儲存/); app.cancelTaskEdit();
    await store.saveTask({...store.tasks().find(task => task.id === 'daily'), title: '最新名稱'});
    app.openTask('todo', store.tasks()[0]); app.openRelatedTask('daily'); assert.equal(app.draft.title, '最新名稱'); app.cancelTaskEdit();
    let opened = 0; app.openDocumentCreation = async () => {opened++;};
    app.openTask('todo', store.tasks()[0]); app.draftRelatedTasks.set(['daily', 'website-task']); await app.requestDocumentCreation(); assert.equal(app.documentCreationPrompt(), true); assert.equal(opened, 0);
    await app.saveTask(false, true); assert.equal(opened, 1); assert.deepEqual(store.relatedTaskIds('website-task'), ['welcome-task']); app.cancelTaskEdit();
    app.openTask('todo', store.tasks()[0]); app.draftRelatedTasks.set([]); await app.saveTask(true); assert.equal(app.modal(), 'calendar-publish'); assert.deepEqual(store.relatedTaskIds('welcome-task'), []);
  } finally {f.close();}
});

test('甘特日期變更不開啟編輯器並可復原重做，過期日期草稿及篩選脈絡不覆寫新資料', async () => {
  const f = application(), {app, store} = f;
  try {
    const original = {...store.tasks()[0], startTime: '09:15', dueDate: '2026-10-10', dueTime: '16:45'}; await store.saveTask(original);
    const source = structuredClone(store.tasks()[0]), context = app.ganttContext(), next = editGanttSchedule(source, 'move', 2);
    await app.adjustGanttSchedule({task: next, original: source, context}); assert.equal(app.modal(), null); assert.equal(store.tasks()[0].startDate, '2026-10-10'); assert.equal(store.tasks()[0].startTime, '09:15'); assert.equal(store.tasks()[0].dueTime, '16:45');
    await store.undo(); assert.equal(store.tasks()[0].dueDate, '2026-10-10'); await store.redo(); assert.equal(store.tasks()[0].dueDate, '2026-10-12');
    const current = structuredClone(store.tasks()[0]); await app.adjustGanttSchedule({task: editGanttSchedule(source, 'move', 4), original: source, context}); assert.deepEqual(store.tasks()[0], current);
    app.query.set('其他篩選'); await app.adjustGanttSchedule({task: editGanttSchedule(current, 'end', 1), original: current, context}); assert.deepEqual(store.tasks()[0], current);
  } finally {f.close();}
});

function application(fresh = false, providers = [], prepareStore = () => {}) {
  const state = {version: 1, activeWorkspaceId: 'first', workspaces: [{version: 4, id: 'first', name: '學程工作', projects: [{id: 'welcome', name: '迎新活動'}, {id: 'website', name: '網站改版'}], categories: [{id: 'design', name: '設計', color: 'green'}], statuses: COLUMNS, tasks: [task, {...task, id: 'website-task', title: '網站首頁', projectId: 'website', status: 'done'}, {...task, id: 'daily', title: '日常任務', projectId: ''}]}, {version: 4, id: 'second', name: '個人生活', projects: [], categories: [], statuses: COLUMNS, tasks: []}]};
  const values = new Map(fresh ? [] : [['orbit-workspaces-v1', JSON.stringify(state)]]);
  globalThis.localStorage = {get length() {return values.size;}, key: index => [...values.keys()][index] ?? null, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key)};
  const store = new BoardStore();
  prepareStore(store);
  const effects = new Set();
  const scheduler = {add(effect) {effects.add(effect);}, schedule() {}, remove(effect) {effects.delete(effect);}};
  const injector = createEnvironmentInjector([DocumentTasks, {provide: BoardStore, useValue: store}, {provide: UiPreferences, useValue: {textSize: () => 'standard'}}, {provide: ɵEffectScheduler, useValue: scheduler}, {provide: ɵChangeDetectionScheduler, useValue: {notify() {}}}, ...providers]);
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

test('右側欄可拉寬至 800px，拖曳與鍵盤共用邊界；縮小視窗保留原寬度偏好', () => {
  const f = application(), app = f.app;
  try {
    f.flush(); const before = structuredClone(f.store.workspaceState());
    app.tasksOpen.set(true);
    app.startPanelResize({preventDefault() {}, currentTarget: {setPointerCapture() {}}, pointerId: 1});
    app.resizePanel({clientX: 400}); assert.equal(app.effectivePanelWidth(), 800); assert.equal(app.compactNavigation(), true);
    app.finishPanelResize(); assert.equal(f.values.get('orbit-side-panel-width-v1'), '800'); assert.equal(f.reopen().panelWidth(), 800);
    globalThis.window = {innerWidth: 1024}; app.resize();
    assert.equal(app.panelMaxWidth(), 544); assert.equal(app.effectivePanelWidth(), 544); assert.equal(app.panelWidth(), 800);
    globalThis.window = {innerWidth: 1440}; app.resize(); assert.equal(app.effectivePanelWidth(), 800);
    app.panelResizeKey({key: 'ArrowRight', preventDefault() {}}); assert.equal(app.effectivePanelWidth(), 780);
    app.startPanelResize({preventDefault() {}, currentTarget: {setPointerCapture() {}}, pointerId: 2}); app.resizePanel({clientX: 1439}); app.finishPanelResize();
    assert.equal(app.effectivePanelWidth(), 300); assert.equal(f.values.get('orbit-side-panel-width-v1'), '300');
    assert.deepEqual(f.store.workspaceState(), before);
  } finally {delete globalThis.window; f.close();}
});

test('寬畫面側欄上限為 45%，較窄時沿用固定上限；寬度超過 800px 可重開恢復', () => {
  const f = application(), app = f.app;
  try {
    for (const [width, limit] of [[1440, 800], [1777, 800], [1778, 800], [1920, 864], [2560, 1152], [3840, 1728], [1024, 544]]) {
      globalThis.window = {innerWidth: width}; app.resize(); assert.equal(app.panelMaxWidth(), limit);
    }
    globalThis.window = {innerWidth: 2560}; app.resize();
    app.startPanelResize({preventDefault() {}, currentTarget: {setPointerCapture() {}}, pointerId: 1});
    app.resizePanel({clientX: 0}); app.finishPanelResize();
    assert.equal(app.effectivePanelWidth(), 1152); assert.equal(f.values.get('orbit-side-panel-width-v1'), '1152');
    const reopened = f.reopen(); assert.equal(reopened.panelWidth(), 1152); assert.equal(reopened.effectivePanelWidth(), 800);
    globalThis.window = {innerWidth: 2560}; reopened.resize(); assert.equal(reopened.effectivePanelWidth(), 1152);
    reopened.panelResizeKey({key: 'ArrowLeft', preventDefault() {}}); assert.equal(reopened.effectivePanelWidth(), 1152);
    reopened.panelResizeKey({key: 'ArrowRight', preventDefault() {}}); assert.equal(reopened.effectivePanelWidth(), 1132);
    f.values.set('orbit-side-panel-width-v1', 'Infinity'); assert.equal(f.reopen().panelWidth(), 360);
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

test('單筆徹底刪除先確認並可取消，保存中不可關閉或重複操作，成功保留其他垃圾桶任務', async () => {
  const f = application();
  try {
    const {app, store} = f;
    await store.deleteTask('welcome-task'); await store.deleteTask('website-task'); app.openTrash();
    const selected = store.trashedTasks()[0], before = structuredClone(store.workspaceState());
    app.requestPurgeTask(selected); assert.equal(app.modal(), 'purge-task');
    assert.equal(app.taskPurgeContext().original.title, selected.title); assert.equal(app.taskPurgeContext().workspaceName, '學程工作');
    assert.deepEqual(store.workspaceState(), before);
    app.closeModal(); assert.equal(app.taskPurgeContext(), null); await app.purgeTask(); assert.deepEqual(store.workspaceState(), before);
    store.pendingWrites.set(1); app.requestPurgeTask(selected); assert.equal(app.modal(), null); store.pendingWrites.set(0);
    app.requestPurgeTask(selected); const saving = app.purgeTask();
    assert.ok(store.pendingWrites() > 0); app.closeModal(); assert.equal(app.modal(), 'purge-task');
    await app.purgeTask(); await saving;
    assert.equal(app.modal(), null); assert.equal(app.taskPurgeContext(), null); assert.equal(app.trashOpen(), true);
    assert.deepEqual(store.trashedTasks().map(item => item.id), ['website-task']);
    assert.equal(app.toast(), '任務已徹底刪除'); assert.equal(store.canUndo(), false);
  } finally {f.close();}
});

test('單筆刪除拒絕過期垃圾桶項目，確認後還原或保存失敗均保留內容與錯誤視窗', async () => {
  const f = application();
  try {
    const {app, store} = f;
    await store.deleteTask('welcome-task'); const selected = structuredClone(store.trashedTasks()[0]);
    app.requestPurgeTask(selected); const peer = new BoardStore(); await peer.restoreTask(selected.id);
    await app.purgeTask(); assert.equal(app.modal(), 'purge-task'); assert.match(app.formError(), /已更新、還原或移除/);
    assert.equal(new BoardStore().tasks().some(item => item.id === selected.id), true);
    app.closeModal(); app.requestPurgeTask(selected); assert.equal(app.modal(), null); assert.equal(app.taskPurgeContext(), null);
    await store.deleteTask(selected.id); app.requestPurgeTask(store.trashedTasks()[0]);
    const write = localStorage.setItem; localStorage.setItem = () => {throw new Error('full');};
    try {await app.purgeTask();} finally {localStorage.setItem = write;}
    assert.equal(app.modal(), 'purge-task'); assert.equal(app.taskPurgeContext().original.id, selected.id);
    assert.match(app.formError(), /任務仍保留在垃圾桶/); assert.equal(store.trashedTasks().length, 1);
    await app.purgeTask(); assert.equal(app.modal(), null); assert.equal(store.trashedTasks().length, 0);
  } finally {f.close();}
});

test('任務編輯點擊或拖曳到遮罩均不關閉，其他視窗仍可在遮罩完整短按關閉', () => {
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
    app.startBackdropClick(event()); app.finishBackdropClick(event(backdrop, {clientX: 22})); app.closeFromBackdrop(event());
    assert.equal(app.modal(), 'task'); assert.equal(app.draft.description, '尚未儲存的描述');
    app.closeModal(); assert.equal(app.modal(), null);
    app.openTask('todo', task); assert.ok(app.localTaskDraftRecovery()); app.restoreLocalTaskDraft();
    assert.equal(app.draft.description, '尚未儲存的描述'); app.cancelTaskEdit(); assert.equal(app.modal(), null);
    app.modal.set('settings'); app.startBackdropClick(event()); app.finishBackdropClick(event()); app.closeFromBackdrop(event()); assert.equal(app.modal(), null);
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
    app.escape(); assert.equal(app.modal(), 'task'); assert.equal(app.tasksOpen(), true); app.cancelTaskEdit();
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

test('本機資料載入後還原實際空間的來源與提醒選擇，之後切換空間才沿用共用控制', () => {
  for (const loadedWorkspace of ['first', 'second']) {
    const f = application(false, [], store => {
      store.storageLoading.set(true);
      saveBrowseState(store.generation(), loadedWorkspace, readBrowseState({view: 'week', showGoogle: false, showOrbit: false, panel: 'reminders', reminderTab: 'this-week'}));
    });
    try {
      f.flush(); assert.equal(f.app.calendarShowGoogle(), loadedWorkspace !== 'first');
      f.store.switchWorkspace(loadedWorkspace); f.store.storageLoading.set(false); f.flush();
      assert.equal(f.app.view(), 'week'); assert.equal(f.app.calendarShowGoogle(), false); assert.equal(f.app.calendarShowOrbit(), false);
      assert.equal(f.app.remindersOpen(), true); assert.equal(f.app.panelTab(), 'reminders'); assert.equal(f.app.reminderTab(), 'this-week');
      f.app.selectWorkspace(loadedWorkspace === 'first' ? 'second' : 'first'); f.flush();
      assert.equal(f.app.calendarShowGoogle(), false); assert.equal(f.app.calendarShowOrbit(), false);
      assert.equal(f.app.remindersOpen(), true); assert.equal(f.app.reminderTab(), 'this-week');
    } finally {f.close();}
  }
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

test('跨空間提醒開啟正確任務並保留側欄，歷史可開啟已完成任務，草稿及垃圾桶受保護', async () => {
  const f = application(), {app, store} = f;
  try {
    store.switchWorkspace('second'); await store.saveTask({...task, projectId: '', categoryId: '', title: '其他空間的同 ID 任務'});
    const item = reminderItems(store.currentWorkspace(), store.generation(), [])[0]; store.switchWorkspace('first');
    app.openReminders('today'); app.openReminder(item); f.flush();
    assert.equal(store.currentWorkspace().id, 'second'); assert.equal(app.modal(), 'task'); assert.equal(app.draft.title, '其他空間的同 ID 任務'); assert.equal(app.remindersOpen(), true);
    app.draft.title = '保留草稿'; store.switchWorkspace('first'); app.openReminder(item); assert.equal(store.currentWorkspace().id, 'first'); assert.equal(app.draft.title, '保留草稿');
    app.closeModal(); store.switchWorkspace('second'); await store.moveTask(item.task.id, 'done'); store.switchWorkspace('first');
    app.openReminder(item); assert.equal(app.modal(), null); assert.equal(store.currentWorkspace().id, 'first');
    app.openReminder({...item, historical: true}); assert.equal(app.modal(), 'task'); assert.equal(app.draft.status, 'done'); assert.equal(store.currentWorkspace().id, 'second');
    app.closeModal(); await store.deleteTask(item.task.id); store.switchWorkspace('first'); app.openReminder({...item, historical: true}); assert.equal(app.modal(), null); assert.equal(store.currentWorkspace().id, 'first');
    app.openReminder({...item, generation: 'old'}); assert.equal(app.modal(), null);
  } finally {f.close();}
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

test('右下角訊息中心在開關任務及設定後保持開啟，Escape 保留編輯任務', () => {
  const {app, store, close} = application();
  try {
    app.toggleReminders(); assert.equal(app.remindersOpen(), true); assert.equal(app.modal(), null);
    const item = reminderItems(store.currentWorkspace(), store.generation(), [])[0];
    app.openReminder(item); assert.equal(app.modal(), 'task'); assert.equal(app.remindersOpen(), true);
    app.escape(); assert.equal(app.modal(), 'task'); assert.equal(app.remindersOpen(), true); app.cancelTaskEdit();
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

test('多功能側欄入口切到提示對應內容，同頁可關閉；新郵件保留郵件篩選', () => {
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
    assert.deepEqual(calls, []); assert.equal(app.query(), '主畫面篩選');
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

test('建立文件前先明確保存新任務與未儲存用途，取消提示保留草稿，乾淨任務直接進入', async () => {
  const f = application(), opened = []; f.app.openDocumentCreation = async () => opened.push(f.app.taskEditContext());
  try {
    f.app.openTask('todo'); f.app.draft.title = '新任務與文件'; const count = f.store.tasks().length;
    await f.app.requestDocumentCreation(); assert.equal(f.app.documentCreationPrompt(), true); assert.equal(f.store.tasks().length, count);
    f.app.documentCreationPrompt.set(false); assert.equal(f.app.draft.title, '新任務與文件');
    await f.app.saveTask(false, true); assert.equal(opened.length, 1); assert.equal(f.app.modal(), 'task'); assert.equal(f.app.editing(), true);
    const file = documentFromUrl('google-drive', 'https://drive.google.com/file/d/dirty-source/view', '用途來源');
    f.app.setDraftDocuments([file]); f.app.draftDocumentDescriptions.set([{documentId: file.id, description: '建立前的用途'}]);
    await f.app.requestDocumentCreation(); assert.equal(f.app.documentCreationPrompt(), true); assert.equal(opened.length, 1);
    await f.app.saveTask(false, true); assert.equal(f.store.descriptionsForTask(f.app.draft.id)[0].description, '建立前的用途'); assert.equal(opened.length, 2);
    const revision = f.store.revision(); await f.app.requestDocumentCreation(); assert.equal(opened.length, 3); assert.equal(f.store.revision(), revision);
  } finally {f.close();}
});

test('任務保存失敗或日期不合法時，不進入雲端文件建立並保留草稿', async () => {
  const f = application(), opened = []; f.app.openDocumentCreation = async () => opened.push(true);
  try {
    f.app.openTask('todo', f.store.tasks()[0]); f.app.draft.title = '保留草稿'; f.app.draft.dueDate = '2025-01-01';
    await f.app.saveTask(false, true); assert.equal(opened.length, 0); assert.ok(f.app.formError());
    f.app.draft.dueDate = f.app.draft.startDate; const write = localStorage.setItem; localStorage.setItem = () => {throw new Error('quota');};
    try {await f.app.saveTask(false, true); assert.equal(opened.length, 0); assert.equal(f.app.modal(), 'task'); assert.match(f.app.formError(), /尚未成功保存/);} finally {localStorage.setItem = write;}
    assert.equal(f.app.draft.title, '保留草稿');
  } finally {f.close();}
});

test('任務與專注描述模式按 Escape 保留視窗，內層選檔仍可先取消', () => {
  const f = application();
  try {
    f.app.openTask('todo', f.store.tasks()[0]); f.app.draft.description = '保留這份描述';
    f.app.escape(); assert.equal(f.app.modal(), 'task');
    f.app.descriptionFocused.set(true); f.app.escape();
    assert.equal(f.app.modal(), 'task'); assert.equal(f.app.descriptionFocused(), true);
    assert.equal(f.app.draft.description, '保留這份描述');
    let cancelled = false; f.app.documentLinksEditor = () => ({pickerOpen: () => true, cancelPicker: () => {cancelled = true;}});
    f.app.escape(); assert.equal(cancelled, true); assert.equal(f.app.modal(), 'task');
    f.app.documentLinksEditor = () => undefined;
  } finally {f.close();}
});

test('停頓 1200ms 才暫存完整本機草稿，連續輸入重設等待，工作版本與同步資料不變', t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const f = application(), app = f.app;
  try {
    app.openTask('todo', f.store.tasks()[0]);
    const before = JSON.stringify(f.store.state()), revision = f.store.revision();
    const drafts = () => [...f.values.keys()].filter(key => key.startsWith('iih-orbit-task-edit-draft-v1:'));
    app.draft.description = '第一段'; app.ngDoCheck(); t.mock.timers.tick(1199); assert.equal(drafts().length, 0);
    app.draft.description += '\n持續輸入'; app.ngDoCheck(); t.mock.timers.tick(1199); assert.equal(drafts().length, 0);
    t.mock.timers.tick(1); assert.equal(drafts().length, 1); assert.match(app.localTaskDraftStatus(), /已暫存/);
    assert.equal(JSON.stringify(f.store.state()), before); assert.equal(f.store.revision(), revision);
    app.ngDoCheck(); t.mock.timers.tick(1200); assert.equal(drafts().length, 1);
    app.closeModal(); app.openTask('todo', f.store.tasks()[0]); assert.ok(app.localTaskDraftRecovery());
    assert.equal(app.draft.description, ''); app.restoreLocalTaskDraft(); assert.equal(app.draft.description, '第一段\n持續輸入');
    app.cancelTaskEdit(); assert.equal(drafts().length, 0); assert.equal(JSON.stringify(f.store.state()), before);
  } finally {f.close();}
});

test('草稿保存名稱、描述、連結用途與順序、時程及尚未加入的輸入，恢復後只有明確儲存才更新任務', async () => {
  const f = application(), app = f.app;
  try {
    const file = documentFromUrl('google-drive', 'https://drive.google.com/file/d/draft-file/view', '草稿檔案');
    const input = {name: '待加入文件', url: 'https://drive.google.com/file/d/pending/view', adding: signal(true), hasDraft: () => false};
    app.openTask('todo', f.store.tasks()[0]); app.documentLinksEditor = () => input;
    app.draft.title = '本機修改'; app.draft.description = '長篇內容'; app.draft.pinned = true;
    app.setDraftDocuments([file]); app.draftDocumentDescriptions.set([{documentId: file.id, description: '讀取方法章節'}]);
    app.draft.dueTime = '14:00'; app.hasDueTime = true; app.subtaskDraft = '未按加入的步驟';
    app.flushLocalTaskDraft(); app.closeModal(); app.documentLinksEditor = () => undefined;
    const reopened = f.reopen(); reopened.openTask('todo', f.store.tasks()[0]);
    const restoredInput = {name: '', url: '', adding: signal(false), hasDraft: () => false}; reopened.documentLinksEditor = () => restoredInput;
    reopened.restoreLocalTaskDraft(); assert.equal(reopened.draft.title, '本機修改'); assert.equal(reopened.draft.description, '長篇內容');
    assert.equal(reopened.draft.pinned, true); assert.equal(reopened.hasDueTime, true); assert.equal(reopened.draft.dueTime, '14:00');
    assert.equal(reopened.subtaskDraft, '未按加入的步驟'); assert.equal(restoredInput.name, input.name); assert.equal(restoredInput.url, input.url); assert.equal(restoredInput.adding(), true);
    assert.equal(reopened.draftDocuments()[0].id, file.id); assert.equal(reopened.draftDocumentDescriptions()[0].description, '讀取方法章節');
    assert.equal(f.store.tasks()[0].title, '迎新海報');
    await reopened.saveTask(); assert.equal(f.store.tasks()[0].title, '本機修改'); assert.equal(f.store.tasks()[0].subtasks[0].title, '未按加入的步驟');
    assert.equal(f.store.descriptionsForTask('welcome-task')[0].description, '讀取方法章節');
    assert.equal([...f.values.keys()].filter(key => key.startsWith('iih-orbit-task-edit-draft-v1:')).length, 0);
  } finally {f.close();}
});

test('恢復草稿保留舊編輯基準，另一分頁修改後不能覆蓋；新任務與工作空間草稿分開', async () => {
  const f = application(), app = f.app;
  try {
    app.openTask('todo', f.store.tasks()[0]); app.draft.description = '舊基準的本機內容'; app.flushLocalTaskDraft(); app.closeModal();
    await f.store.saveTask({...f.store.tasks()[0], description: '已更新的正式任務'});
    app.openTask('todo', f.store.tasks()[0]); app.restoreLocalTaskDraft(); assert.equal(app.taskDraftConflict(), true);
    await app.saveTask(); assert.equal(app.modal(), 'task'); assert.equal(f.store.tasks()[0].description, '已更新的正式任務');
    assert.equal(app.draft.description, '舊基準的本機內容'); app.cancelTaskEdit();
    app.openTask(); app.draft.title = '還沒建立的新任務'; app.flushLocalTaskDraft(); app.closeModal();
    f.store.switchWorkspace('second'); app.openTask(); assert.equal(app.localTaskDraftRecovery(), null); app.cancelTaskEdit();
    f.store.switchWorkspace('first'); app.openTask(); assert.ok(app.localTaskDraftRecovery()); app.restoreLocalTaskDraft();
    assert.equal(app.draft.title, '還沒建立的新任務'); assert.equal(app.editing(), false); app.cancelTaskEdit();
  } finally {f.close();}
});

test('分頁各自暫存不覆寫彼此，儲存空間失敗不宣稱已暫存，舊資料世代不恢復', () => {
  const f = application(), app = f.app;
  try {
    app.openTask('todo', f.store.tasks()[0]); app.draft.description = '第一頁'; app.flushLocalTaskDraft();
    const second = f.reopen(); second.openTask('todo', f.store.tasks()[0]); second.draft.description = '第二頁'; second.flushLocalTaskDraft();
    const records = () => [...f.values.entries()].filter(([key]) => key.startsWith('iih-orbit-task-edit-draft-v1:'));
    assert.equal(records().length, 2); assert.deepEqual(records().map(([, raw]) => JSON.parse(raw).snapshot.task.description).sort(), ['第一頁', '第二頁']);
    second.cancelTaskEdit(); assert.equal(records().length, 1);
    const write = localStorage.setItem; localStorage.setItem = () => {throw new Error('quota');};
    try {app.draft.description = '失敗後仍保留'; app.flushLocalTaskDraft(); assert.match(app.localTaskDraftStatus(), /暫存失敗/); assert.equal(app.draft.description, '失敗後仍保留');}
    finally {localStorage.setItem = write;}
    app.cancelTaskEdit();
    app.openTask(); app.draft.title = '世代隔離'; app.flushLocalTaskDraft(); app.closeModal(); f.store.generation.set('new-generation');
    app.openTask(); assert.equal(app.localTaskDraftRecovery(), null); app.cancelTaskEdit();
  } finally {f.close();}
});

test('空間總覽獨立於任務篩選，記住每個空間的範圍與下鑽，不改工作資料或同步版本', () => {
  const f = application(), app = f.app;
  try {
    app.selectScope('done'); app.projectFilter.set('website'); app.query.set('舊清單搜尋');
    const revision = f.store.revision(), before = JSON.stringify(f.store.workspaces());
    app.openOverview(); assert.equal(app.overviewOpen(), true); assert.equal(app.navigationTitle(), '空間總覽');
    assert.equal(app.scope(), 'done'); assert.equal(app.overviewProject(), 'all');
    app.overviewProject.set('welcome'); app.overviewSelection.set({kind: 'overdue'}); app.rememberBrowse();
    const reopened = f.reopen(); assert.equal(reopened.overviewOpen(), true); assert.equal(reopened.overviewProject(), 'welcome'); assert.deepEqual(reopened.overviewSelection(), {kind: 'overdue'}); assert.equal(reopened.modal(), 'overview-list');
    assert.equal(JSON.stringify(f.store.workspaces()), before); assert.equal(f.store.revision(), revision);
    app.selectCategory('design'); assert.equal(app.overviewOpen(), false); app.openOverview(); app.selectScope('all'); assert.equal(app.overviewOpen(), false);
    app.openOverview(); app.selectProject('website'); assert.equal(app.overviewOpen(), false);
    app.openOverview(); app.modal.set('settings'); app.overviewOpen.set(false); app.openOverview(); assert.equal(app.overviewOpen(), false); app.closeModal();
  } finally {f.close();}
});

test('回到專案看板顯示目前空間的全部任務，清除當次篩選而不修改任務或總覽設定', () => {
  const f = application(), app = f.app;
  try {
    const before = JSON.stringify(f.store.workspaces()), revision = f.store.revision(), workspace = f.store.currentWorkspace().id;
    app.view.set('week'); app.scope.set('done'); app.projectFilter.set('website'); app.categoryFilter.set('design');
    app.query.set('找不到的名稱'); app.priorityFilter.set('high'); app.pinnedOnly.set(true); app.recentOnly.set(true);
    app.deadlineFilter.set('due-soon'); app.deadlineDays.set(7); app.trashOpen.set(true); app.sidebarOpen.set(true);
    app.overviewOpen.set(true); app.overviewProject.set('welcome'); app.overviewArchived.set(true); app.overviewSelection.set({kind: 'pending'});
    app.openBoardHome();
    assert.equal(app.view(), 'board'); assert.equal(app.navigationTitle(), '專案看板'); assert.equal(app.overviewOpen(), false);
    assert.equal(app.scope(), 'all'); assert.equal(app.projectFilter(), 'all'); assert.equal(app.categoryFilter(), 'all'); assert.equal(app.query(), '');
    assert.equal(app.priorityFilter(), 'all'); assert.equal(app.pinnedOnly(), false); assert.equal(app.recentOnly(), false);
    assert.equal(app.deadlineFilter(), 'all'); assert.equal(app.deadlineDays(), null); assert.equal(app.trashOpen(), false); assert.equal(app.sidebarOpen(), false);
    assert.equal(app.hasFilters(), false); assert.equal(app.visibleTasks().length, 3); assert.equal(app.overviewSelection(), null);
    assert.equal(app.overviewProject(), 'welcome'); assert.equal(app.overviewArchived(), true);
    assert.equal(f.store.currentWorkspace().id, workspace); assert.equal(f.store.revision(), revision); assert.equal(JSON.stringify(f.store.workspaces()), before);
    app.view.set('month'); app.openTask('todo', f.store.tasks()[0]); app.draft.description = '正在編輯'; app.openBoardHome();
    assert.equal(app.modal(), 'task'); assert.equal(app.view(), 'month'); assert.equal(app.draft.description, '正在編輯'); app.cancelTaskEdit();
  } finally {f.close();}
});

test('沒有瀏覽紀錄預設專案看板，重新開啟仍接續原視圖與總覽狀態', () => {
  const f = application(), app = f.app;
  try {
    assert.equal(app.view(), 'board'); assert.equal(app.overviewOpen(), false); assert.equal(app.navigationTitle(), '專案看板');
    app.view.set('month'); app.scope.set('active'); app.query.set('研究'); app.rememberBrowse();
    const calendar = f.reopen(); assert.equal(calendar.view(), 'month'); assert.equal(calendar.scope(), 'active'); assert.equal(calendar.query(), '研究');
    app.openOverview(); app.overviewProject.set('welcome'); app.rememberBrowse();
    const overview = f.reopen(); assert.equal(overview.overviewOpen(), true); assert.equal(overview.overviewProject(), 'welcome'); assert.equal(overview.view(), 'month');
    app.openBoardHome(); app.rememberBrowse();
    const home = f.reopen(); assert.equal(home.overviewOpen(), false); assert.equal(home.view(), 'board'); assert.equal(home.query(), '');
  } finally {f.close();}
});

test('甘特沿用工作空間與任務篩選、封存範圍和排序，開啟任務保留原時程', () => {
  const f = application(), app = f.app;
  try {
    app.view.set('gantt'); app.projectFilter.set('welcome');
    assert.deepEqual(app.sortedTasks().map(task => task.id), ['welcome-task']);
    const key = app.ganttContext(); app.query.set('不存在'); assert.equal(app.sortedTasks().length, 0); assert.notEqual(app.ganttContext(), key);
    app.clearFilters(); app.selectScope('done'); assert.equal(app.view(), 'gantt'); assert.deepEqual(app.sortedTasks().map(task => task.id), ['website-task']);
    app.selectScope('archived'); assert.equal(app.view(), 'gantt'); assert.equal(app.sortedTasks().length, 0);
    app.selectScope('all'); app.categoryFilter.set('design'); assert.equal(app.sortedTasks().length, 3);
    const original = {...f.store.tasks()[0], startTime: '09:15', dueTime: '16:45'}, before = JSON.stringify(f.store.workspaces()), revision = f.store.revision();
    app.openTask(original.status, original); assert.equal(app.modal(), 'task'); assert.equal(app.draft.startTime, '09:15'); assert.equal(app.draft.dueTime, '16:45');
    app.cancelTaskEdit(); assert.equal(app.view(), 'gantt'); assert.equal(app.modal(), null);
    assert.equal(JSON.stringify(f.store.workspaces()), before); assert.equal(f.store.revision(), revision);
  } finally {f.close();}
});

test('甘特日期與尺度在重新開啟及切換空間後恢復，瀏覽不觸發工作資料更新', () => {
  const f = application(), app = f.app;
  try {
    f.flush(); const before = JSON.stringify(f.store.workspaces()), revision = f.store.revision();
    app.view.set('gantt'); app.ganttDate.set('2028-02-29'); app.ganttScale.set('month'); app.ganttZoom.set(175); app.ganttCompletion.set('pending'); app.ganttOrder.set('end'); app.ganttRange.set({start: '2028-02-20', end: '2028-03-15'}); app.calendarDate.set('2026-10-16'); f.flush();
    assert.equal(app.visibleTasks().length, 3); // Gantt's date range does not filter other views.
    const reopened = f.reopen(); assert.equal(reopened.view(), 'gantt'); assert.equal(reopened.ganttDate(), '2028-02-29'); assert.equal(reopened.ganttScale(), 'month'); assert.equal(reopened.calendarDate(), '2026-10-16');
    assert.equal(reopened.ganttZoom(), 175); assert.equal(reopened.ganttCompletion(), 'pending'); assert.equal(reopened.ganttOrder(), 'end'); assert.deepEqual(reopened.ganttRange(), {start: '2028-02-20', end: '2028-03-15'});
    f.store.switchWorkspace('second'); f.flush(); app.ganttDate.set('2027-01-01'); app.ganttScale.set('week'); app.ganttZoom.set(75); app.ganttCompletion.set('done'); app.ganttRange.set({start: '2027-01-01', end: '2027-01-20'}); f.flush();
    f.store.switchWorkspace('first'); f.flush(); assert.equal(app.ganttDate(), '2028-02-29'); assert.equal(app.ganttScale(), 'month');
    assert.equal(app.ganttZoom(), 175); assert.equal(app.ganttCompletion(), 'pending'); assert.equal(app.ganttOrder(), 'end'); assert.deepEqual(app.ganttRange(), {start: '2028-02-20', end: '2028-03-15'});
    assert.equal(f.store.revision(), revision); assert.equal(JSON.stringify(f.store.workspaces()), before);
    f.store.generation.set('new-generation'); f.flush(); assert.equal(app.view(), 'board'); assert.equal(app.ganttScale(), 'day');
  } finally {f.close();}
});

test('甘特圖例篩選僅存瀏覽偏好，重開接續、不同空間分開且不影響其他視圖任務', () => {
  const f = application();
  try {
    f.flush(); const {app, store} = f, before = structuredClone(store.workspaceState());
    app.view.set('gantt'); app.ganttStatuses.set(['todo', 'done']); app.ganttCategories.set(['design', '']); f.flush();
    const reopened = f.reopen(); assert.deepEqual(reopened.ganttStatuses(), ['todo', 'done']); assert.deepEqual(reopened.ganttCategories(), ['design', '']);
    assert.equal(app.visibleTasks().length, 3);
    store.switchWorkspace('second'); f.flush(); assert.deepEqual(app.ganttStatuses(), []); assert.deepEqual(app.ganttCategories(), []);
    store.switchWorkspace('first'); f.flush(); assert.deepEqual(app.ganttStatuses(), ['todo', 'done']); assert.deepEqual(app.ganttCategories(), ['design', '']);
    assert.deepEqual(store.workspaceState(), before);
    store.generation.set('new-generation'); f.flush(); assert.deepEqual(app.ganttStatuses(), []); assert.deepEqual(app.ganttCategories(), []);
  } finally {f.close();}
});

test('從總覽新增任務使用總覽專案，不繼承清單分類；空間切換與資料世代隔離總覽狀態', async () => {
  const f = application(), app = f.app;
  try {
    app.projectFilter.set('website'); app.categoryFilter.set('design'); app.openOverview(); app.overviewProject.set('welcome');
    app.openTask(); assert.equal(app.draft.projectId, 'welcome'); assert.equal(app.draft.categoryId, ''); app.draft.title = '從總覽新增'; await app.saveTask(); assert.doesNotMatch(app.toast(), /清除篩選/);
    app.overviewSelection.set({kind: 'project', value: 'welcome'}); app.rememberBrowse();
    f.store.switchWorkspace('second'); f.flush(); assert.equal(app.overviewOpen(), true); assert.equal(app.overviewProject(), 'all'); assert.equal(app.overviewSelection(), null);
    f.store.switchWorkspace('first'); f.flush(); assert.equal(app.overviewProject(), 'welcome'); assert.deepEqual(app.overviewSelection(), {kind: 'project', value: 'welcome'}); assert.equal(app.modal(), 'overview-list');
    f.store.generation.set('replacement'); f.flush(); assert.equal(app.overviewOpen(), false); assert.equal(app.overviewProject(), 'all'); assert.equal(app.overviewSelection(), null);
  } finally {f.close();}
});

test('總覽下鑽使用清單視窗，編輯、取消與儲存後接回原條件、頁碼及捲動位置', async () => {
  const f = application(), app = f.app;
  try {
    app.openOverview(); app.overviewProject.set('welcome');
    const revision = f.store.revision();
    app.openOverviewList({kind: 'pending'}); app.overviewPage.set(1); app.overviewScroll.set(180);
    assert.equal(app.modal(), 'overview-list'); assert.equal(f.store.revision(), revision);
    app.openOverviewTask(f.store.tasks().find(task => task.id === 'welcome-task'));
    assert.equal(app.modal(), 'task'); app.draft.description = '清單內的本機草稿'; app.closeModal();
    assert.equal(app.modal(), 'overview-list'); assert.equal(app.overviewPage(), 1); assert.equal(app.overviewScroll(), 180);
    assert.deepEqual(app.overviewSelection(), {kind: 'pending'}); assert.equal(app.overviewProject(), 'welcome');
    assert.equal(f.store.tasks().find(task => task.id === 'welcome-task').description, '');
    app.openOverviewTask(f.store.tasks().find(task => task.id === 'welcome-task')); app.restoreLocalTaskDraft();
    app.cancelTaskEdit(); assert.equal(app.modal(), 'overview-list');
    app.openOverviewTask(f.store.tasks().find(task => task.id === 'welcome-task')); app.draft.status = 'done'; await app.saveTask();
    assert.equal(app.modal(), 'overview-list'); assert.equal(f.store.tasks().find(task => task.id === 'welcome-task').status, 'done');
    app.closeModal(); assert.equal(app.modal(), null); assert.equal(app.overviewOpen(), true);
    assert.equal(app.overviewSelection(), null); assert.equal(app.overviewPage(), 0); assert.equal(app.overviewScroll(), 0);
  } finally {f.close();}
});

test('清單視窗可用 Escape 關閉，任務編輯仍受保護；資料世代與工作空間改變後不接回舊清單', () => {
  const f = application(), app = f.app;
  try {
    app.openOverview(); app.openOverviewList({kind: 'done'}); app.escape();
    assert.equal(app.modal(), null); assert.equal(app.overviewSelection(), null);
    app.openOverviewList({kind: 'total'}); app.openOverviewTask(f.store.tasks()[0]); app.escape(); assert.equal(app.modal(), 'task');
    f.store.generation.set('other'); app.closeModal(); assert.equal(app.modal(), null);
    app.openOverviewList({kind: 'total'}); app.openOverviewTask(f.store.tasks()[0]);
    f.store.switchWorkspace('second'); app.closeModal(); assert.equal(app.modal(), null);
    app.modal.set('settings'); app.openOverviewList({kind: 'pending'}); assert.equal(app.modal(), 'settings');
  } finally {f.close();}
});

test('總覽分類清單沿用彈窗，重新開啟與編輯返回保留分類條件，不更動工作範圍篩選', async () => {
  const f = application(), app = f.app;
  try {
    app.projectFilter.set('website'); app.categoryFilter.set('design'); app.openOverview();
    const task = f.store.tasks().find(task => task.categoryId === 'design'), revision = f.store.revision();
    app.openOverviewList({kind: 'category', value: 'design'}); app.rememberBrowse();
    assert.equal(app.modal(), 'overview-list'); assert.equal(f.store.revision(), revision);
    const reopened = f.reopen(); assert.equal(reopened.modal(), 'overview-list'); assert.deepEqual(reopened.overviewSelection(), {kind: 'category', value: 'design'});
    app.openOverviewTask(task); app.draft.categoryId = ''; await app.saveTask();
    assert.equal(app.modal(), 'overview-list'); assert.deepEqual(app.overviewSelection(), {kind: 'category', value: 'design'});
    assert.equal(f.store.tasks().find(item => item.id === task.id).categoryId, '');
    assert.equal(app.projectFilter(), 'website'); assert.equal(app.categoryFilter(), 'design');
    app.closeModal(); assert.equal(app.overviewOpen(), true); assert.equal(app.modal(), null);
  } finally {f.close();}
});

test('建立任務連結視窗確認後只加入資訊草稿，取消不變更；離開表單不接受晚到選擇', async () => {
  const opened = [], dialog = {open(component, config) {const ref = {closed: new Subject(), backdropClick: new Subject(), close(value) {this.closed.next(value); this.closed.complete();}}; opened.push({component, config, ref}); return ref;}}, f = application(false, [{provide: Dialog, useValue: dialog}]), {app, store} = f;
  try {
    app.openTask('todo', store.tasks()[0]); app.draft.description = '保留文字';
    const pending = app.openTaskLinkPicker(); app.cancelTaskLinkPicker(); await pending; assert.equal(opened.length, 0); assert.equal(app.modal(), 'task');
    await Promise.all([app.openTaskLinkPicker(), app.openTaskLinkPicker()]); assert.equal(opened.length, 1); assert.equal(opened[0].config.ariaModal, true); assert.equal(opened[0].config.data.taskId, 'welcome-task');
    opened[0].ref.close(); assert.equal(app.taskLinkPickerOpen(), false); assert.deepEqual(app.draftRelatedTasks(), []); assert.equal(app.draft.description, '保留文字');
    await app.openTaskLinkPicker(); opened[1].ref.close(['website-task']); assert.deepEqual(app.draftRelatedTasks(), ['website-task']); assert.deepEqual(store.relatedTaskIds('welcome-task'), []); assert.equal(app.modal(), 'task');
    await app.saveTask(); assert.deepEqual(store.relatedTaskIds('website-task'), ['welcome-task']);
    app.openTask('todo', store.tasks()[0]); await app.openTaskLinkPicker(); assert.deepEqual(opened[2].config.data.excluded, ['website-task']); app.cancelTaskEdit(); opened[2].ref.closed.next(['daily']); assert.deepEqual(store.relatedTaskIds('daily'), []);
    app.openTask('todo', store.tasks()[0]); await app.openTaskLinkPicker(); app.escape(); assert.equal(app.modal(), 'task'); assert.equal(app.taskLinkPickerOpen(), false);
    await app.openTaskLinkPicker(); store.switchWorkspace('second'); opened.at(-1).ref.close(['daily']); assert.deepEqual(app.draftRelatedTasks(), ['website-task']);
  } finally {f.close();}
});

function boardDragFixture() {
  const f = application(), {app, store} = f, dom = new JSDOM('<main></main>'), document = dom.window.document;
  const previous = {document: globalThis.document, window: globalThis.window, Node: globalThis.Node, navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator')};
  globalThis.document = document; globalThis.window = dom.window; globalThis.Node = dom.window.Node;
  Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {locks: {request: async (_name, action) => action()}}});
  f.flush();
  let values = new Map();
  const dataTransfer = {get types() {return [...values.keys()];}, setData(type, value) {values.set(type, value);}, getData(type) {return values.get(type) ?? '';}};
  const render = () => {
    document.querySelector('main').innerHTML = app.columns().map(column => `<section data-status="${column.id}">${column.tasks.map(task => `<article class="task-card" data-task-id="${task.id}"><button class="task-open-area">${task.title}</button></article>`).join('')}</section>`).join('');
    for (const column of document.querySelectorAll('section')) [...column.children].forEach((card, index) => {card.getBoundingClientRect = () => ({top: 100 + index * 220, bottom: 300 + index * 220});});
  };
  const event = (currentTarget, y) => ({currentTarget, target: currentTarget, clientX: 80, clientY: y, dataTransfer, preventDefault() {this.defaultPrevented = true;}, stopPropagation() {}});
  const start = (id = 'welcome-task') => {render(); values = new Map(); const source = store.tasks().find(task => task.id === id); app.startBoardTaskDrag(event(document.querySelector(`[data-task-id="${id}"] button`), 150), source);};
  const over = (status, y) => app.boardTaskOver(event(document.querySelector(`[data-status="${status}"]`), y), app.columns().find(column => column.id === status));
  const drop = (status, y) => app.dropBoardTask(event(document.querySelector(`[data-status="${status}"]`), y), app.columns().find(column => column.id === status));
  return {...f, dom, document, dataTransfer, event, start, over, drop, close() {f.close(); globalThis.document = previous.document; globalThis.window = previous.window; globalThis.Node = previous.Node; Object.defineProperty(globalThis, 'navigator', previous.navigator); dom.window.close();}};
}

test('看板沿用檔案的小型預覽與中央連結，懸停不改順序，放開才儲存且不開啟任務', async () => {
  const f = boardDragFixture(), {app, store, document} = f;
  try {
    const before = structuredClone(store.tasks()); f.start();
    assert.ok(f.dataTransfer.getData(BOARD_TASK_DRAG_TYPE)); assert.equal(f.dataTransfer.effectAllowed, 'all');
    assert.equal(document.querySelector('.task-drag-preview').textContent, '迎新海報'); assert.equal(document.querySelector('.cdk-drag-preview'), null);
    assert.equal(f.over('done', 180), true); assert.equal(f.dataTransfer.dropEffect, 'link'); assert.equal(app.boardTaskLinks('website-task'), true);
    assert.deepEqual(store.tasks(), before); assert.equal(document.querySelector('[data-task-id="website-task"]').style.transform, '');
    await f.drop('done', 180); assert.deepEqual(store.relatedTaskIds('welcome-task'), ['website-task']); assert.deepEqual(store.tasks().map(task => [task.id, task.status, task.startDate, task.dueDate]), before.map(task => [task.id, task.status, task.startDate, task.dueDate]));
    assert.equal(app.modal(), null); assert.equal(app.boardTaskDrag(), null); assert.equal(document.querySelector('.task-drag-preview,.document-drag-mask'), null);
    const links = structuredClone(store.state().taskLinks); f.start(); await f.drop('done', 180); assert.deepEqual(store.state().taskLinks, links);
    await store.undo(); assert.deepEqual(store.relatedTaskIds('welcome-task'), []); await store.redo(); assert.deepEqual(store.relatedTaskIds('website-task'), ['welcome-task']);
  } finally {f.close();}
});

test('看板空白欄位移動、同欄插入位置及佔位提示穩定，放回原位置不產生紀錄', async () => {
  const f = boardDragFixture(), {app, store, document} = f;
  try {
    f.start(); f.over('todo', 310); assert.deepEqual(app.boardTaskPosition(), {kind: 'move', status: 'todo', beforeId: 'daily'}); assert.equal(app.boardTaskMoves('daily', 'todo'), true);
    const marker = document.createElement('div'); marker.className = 'task-board-placeholder'; marker.getBoundingClientRect = () => ({top: 300, bottom: 380}); document.querySelector('[data-status="todo"]').append(marker);
    f.over('todo', 360); assert.equal(app.boardTaskMoves('daily', 'todo'), true); assert.equal(f.dataTransfer.dropEffect, 'move');
    const history = store.history().length; await f.drop('todo', 360); assert.equal(store.history().length, history);
    f.start(); f.over('progress', 180); assert.deepEqual(app.boardTaskPosition(), {kind: 'move', status: 'progress'}); assert.equal(store.tasks()[0].status, 'todo'); await f.drop('progress', 180); assert.equal(store.tasks().find(task => task.id === 'welcome-task').status, 'progress');
    await store.undo(); f.start(); await f.drop('todo', 600); assert.deepEqual(store.tasks().filter(task => task.status === 'todo').map(task => task.id), ['daily', 'welcome-task']); assert.deepEqual(store.relatedTaskIds('welcome-task'), []);
    await store.undo(); f.start('daily'); await f.drop('todo', 105); assert.deepEqual(store.tasks().filter(task => task.status === 'todo').map(task => task.id), ['daily', 'welcome-task']);
    await store.undo(); assert.deepEqual(store.tasks().filter(task => task.status === 'todo').map(task => task.id), ['welcome-task', 'daily']);
  } finally {f.close();}
});

test('看板拒絕自己、偽造資料與過期兩端，取消或切換脈絡清理預覽且不寫入', {timeout: 10000}, async () => {
  const f = boardDragFixture(), {app, store, document} = f;
  try {
    f.start(); assert.equal(f.over('todo', 180), false); await f.drop('todo', 180); assert.deepEqual(store.relatedTaskIds('welcome-task'), []); app.endBoardTaskDrag();
    f.start(); f.over('done', 180); f.dataTransfer.setData(BOARD_TASK_DRAG_TYPE, JSON.stringify({...JSON.parse(f.dataTransfer.getData(BOARD_TASK_DRAG_TYPE)), token: 'forged'})); await f.drop('done', 180); assert.deepEqual(store.relatedTaskIds('welcome-task'), []); assert.equal(app.boardTaskDrag(), null);
    f.start(); f.over('done', 180); await store.saveTask({...store.tasks()[1], title: '另一分頁的新目標'}); await f.drop('done', 180); assert.deepEqual(store.relatedTaskIds('welcome-task'), []);
    f.start(); f.over('done', 180); app.escape(); await f.drop('done', 180); assert.equal(document.querySelector('.task-drag-preview'), null); assert.deepEqual(store.relatedTaskIds('welcome-task'), []);
    for (const change of [() => app.query.set('其他篩選'), () => app.view.set('list'), () => app.modal.set('settings')]) {
      app.query.set(''); app.view.set('board'); f.start(); f.over('done', 180); change(); f.flush(); assert.equal(app.boardTaskDrag(), null); assert.equal(document.querySelector('.task-drag-preview'), null); await f.drop('done', 180); assert.deepEqual(store.relatedTaskIds('welcome-task'), []); app.closeModal();
    }
  } finally {f.close();}
});

test('看板來源更新及跨工作空間切換不接受舊拖曳，預覽隨脈絡取消', {timeout: 10000}, async () => {
  const f = boardDragFixture(), {app, store, document} = f;
  try {
    f.start(); f.over('done', 180); await store.saveTask({...store.tasks()[0], title: '來源已更新'}); f.flush(); await f.drop('done', 180);
    assert.deepEqual(store.relatedTaskIds('welcome-task'), []); assert.equal(store.tasks()[0].status, 'todo'); assert.equal(document.querySelector('.task-drag-preview'), null);
    f.start(); store.switchWorkspace('second'); f.flush(); await f.drop('done', 180); assert.equal(app.boardTaskDrag(), null); assert.equal(store.tasks().length, 0);
  } finally {f.close();}
});
