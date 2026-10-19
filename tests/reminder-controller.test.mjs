import '@angular/compiler';
import { DOCUMENT } from '@angular/common';
import { createEnvironmentInjector, runInInjectionContext, signal, ɵChangeDetectionScheduler, ɵEffectScheduler } from '@angular/core';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { COLUMNS } from '../src/app/models.ts';
import { REMINDER_DELIVERY_KEY } from '../src/app/reminder-delivery.ts';
import { REMINDER_SEEN_KEY } from '../src/app/reminder-attention.ts';
import { externalEvent } from '../src/app/google-data.ts';
import {reminderItemKey} from '../src/app/reminder-items.ts';
import {REMINDER_HISTORY_KEY} from '../src/app/reminder-history.ts';

const require = createRequire(import.meta.url);
const {build} = createRequire(require.resolve('@angular/build/package.json'))('esbuild');
await mkdir('.angular', {recursive: true});
const directory = await mkdtemp(resolve('.angular/reminder-test-'));
const output = resolve(directory, 'reminder.mjs');
await build({stdin: {contents: "export {Reminders} from './src/app/reminders.ts'; export {ReminderCenter} from './src/app/reminder-center.ts'; export {ReminderPopups} from './src/app/reminder-popups.ts'; export {GoogleCalendarService} from './src/app/google-calendar.ts'; export {BoardStore} from './src/app/board-store.ts';", resolveDir: process.cwd()}, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: output, tsconfig: 'tsconfig.json'});
const {Reminders, ReminderCenter, ReminderPopups, GoogleCalendarService, BoardStore} = await import(pathToFileURL(output).href);
after(() => rm(directory, {recursive: true, force: true}));
const task = {id: 'task', title: '會議準備', description: '', projectId: '', categoryId: '', status: 'todo', priority: 'medium', startDate: '2026-10-09', startTime: '11:00', dueDate: '2026-10-09', dueTime: '12:00', subtasks: []};

function storage(tasks = [task]) {
  const state = {version: 1, activeWorkspaceId: 'workspace', workspaces: [{version: 4, id: 'workspace', name: '工作', projects: [], categories: [], statuses: COLUMNS, tasks}]};
  const values = new Map([['orbit-workspaces-v1', JSON.stringify(state)]]);
  let failed = false;
  globalThis.localStorage = {getItem: key => values.get(key) ?? null, setItem: (key, value) => { if (failed) throw new Error('quota'); values.set(key, value); }, removeItem: key => values.delete(key)};
  return {values, fail: () => { failed = true; }};
}

function controller() {
  const store = new BoardStore(), effects = new Set(), anchors = [];
  // Fake visibility and signals only. This does not operate a browser or render a DOM.
  const document = {visibilityState: 'visible', hasFocus: () => true, addEventListener() {}, removeEventListener() {}, defaultView: null};
  const google = {reminderEvents: signal([]), visibleSources: signal([]), reminderRange: signal(null), setReminderMonth: date => anchors.push(date), status: () => '已同步'};
  const scheduler = {add: effect => effects.add(effect), schedule() {}, remove: effect => effects.delete(effect)};
  const injector = createEnvironmentInjector([{provide: DOCUMENT, useValue: document}, {provide: BoardStore, useValue: store}, {provide: GoogleCalendarService, useValue: google}, {provide: ɵEffectScheduler, useValue: scheduler}, {provide: ɵChangeDetectionScheduler, useValue: {notify() {}}}]);
  const reminders = runInInjectionContext(injector, () => new Reminders());
  const child = createEnvironmentInjector([{provide: Reminders, useValue: reminders}], injector);
  const center = runInInjectionContext(child, () => new ReminderCenter());
  const popups = runInInjectionContext(child, () => new ReminderPopups());
  popups.blocked = signal(false);
  reminders.now.set(new Date(2026, 9, 9, 10, 50));
  const flush = () => { for (let round = 0; round < 20 && [...effects].some(effect => effect.dirty); round++) for (const effect of effects) if (effect.dirty) effect.run(); };
  return {store, reminders, center, popups, google, anchors, flush, close: () => { child.destroy(); reminders.ngOnDestroy(); injector.destroy(); }};
}
const settle = async () => { for (let tick = 0; tick < 4; tick++) await new Promise(resolve => setImmediate(resolve)); };

test('精簡提醒選單可切換六個日期範圍與歷史，保留空間及到期天數並通知主畫面保存範圍', () => {
  storage(); const f = controller(), selected = [];
  try {
    f.center.tabChange.subscribe(tab => selected.push(tab));
    f.center.workspaceScope.set('current'); f.center.dueDays.set(5);
    for (const tab of ['today', 'tomorrow', 'this-week', 'next-week', 'due-soon', 'overdue']) {
      f.center.selectView(tab);
      assert.equal(f.center.viewSelection(), tab); assert.equal(f.center.historyMode(), false);
    }
    assert.deepEqual(selected, ['today', 'tomorrow', 'this-week', 'next-week', 'due-soon', 'overdue']);
    f.center.selectView('history');
    assert.equal(f.center.viewSelection(), 'history'); assert.equal(f.center.activeTab(), 'overdue');
    f.center.selectView('invalid'); assert.equal(f.center.viewSelection(), 'history'); assert.equal(selected.length, 6);
    f.center.selectView('due-soon');
    assert.equal(f.center.viewSelection(), 'due-soon'); assert.equal(f.center.dueDays(), 5);
    assert.equal(f.center.workspaceScope(), 'current'); assert.equal(f.store.reminders().dueSoonDays, 3);
    assert.equal(f.center.tabs().find(tab => tab.id === 'due-soon').label, '5 天內到期');
  } finally {f.close();}
});

test('跨空間提醒與徽章聚合，相同任務 ID 不互相蓋掉，目前空間只查看自己的提醒', async () => {
  storage(); const f = controller();
  try {
    f.center.visible = signal(false); f.center.workspaceScope.set('current');
    await f.store.saveWorkspace('', '教學工作'); const other = f.store.currentWorkspace().id;
    await f.store.saveTask({...task, title: '另一個空間的同 ID 任務'}); f.store.switchWorkspace('workspace'); f.flush(); await settle();
    assert.equal(f.reminders.summaryCount(), 2); assert.equal(f.reminders.unseenCount(), 2); assert.equal(f.center.count(), 1);
    assert.equal(f.reminders.popups().length, 2); const keys = f.reminders.popups().map(popup => popup.key);
    f.center.visible.set(true); f.flush(); await settle(); assert.equal(f.reminders.unseenCount(), 1); assert.equal(f.reminders.unseenItems()[0].workspaceId, other);
    f.center.workspaceScope.set('all'); f.flush(); await settle(); assert.equal(f.center.count(), 2); assert.equal(f.reminders.unseenCount(), 0);
    f.store.switchWorkspace(other); f.flush(); await settle(); assert.deepEqual(f.reminders.popups().map(popup => popup.key), keys);
    assert.deepEqual(new Set(f.reminders.history().map(entry => entry.workspaceName)), new Set(['工作', '教學工作']));
  } finally {f.close();}
});

test('前景產生歷史但背景不補造，已讀、提示及關閉保存；改名、完成和刪除仍保留快照', async () => {
  const memory = storage(), f = controller(); let reopened;
  try {
    f.center.visible = signal(false); f.reminders.active.set(false); f.flush(); await settle(); assert.equal(f.reminders.history().length, 0);
    f.reminders.active.set(true); f.flush(); await settle(); f.flush(); await settle();
    assert.equal(f.reminders.history().length, 1); const original = f.reminders.history()[0]; assert.equal(original.readAt, undefined); assert.ok(original.popupAt);
    f.reminders.dismiss(f.reminders.popups()[0].key); await settle(); assert.ok(f.reminders.history()[0].dismissedAt);
    await f.store.saveTask({...task, title: '後來改名'}); f.flush(); await settle(); assert.equal(f.reminders.history()[0].title, task.title);
    f.center.historyMode.set(true); f.center.visible.set(true); f.flush(); await settle(); assert.equal(f.reminders.unseenCount(), 1);
    f.reminders.markHistoryRead(f.reminders.history()); await settle(); assert.equal(f.reminders.unseenCount(), 0); assert.ok(f.reminders.history()[0].readAt);
    await f.store.saveTask({...task, status: 'done', title: '已完成的新名稱'}); f.flush(); await settle();
    assert.equal(f.reminders.summaryCount(), 0); assert.equal(f.reminders.resolveHistory(original).task.title, '已完成的新名稱');
    await f.store.deleteTask(task.id); f.flush(); await settle(); assert.equal(f.reminders.history().length, 1); assert.equal(f.reminders.resolveHistory(original), undefined);
    const backup = await f.store.backupForExport('full'); assert.equal(JSON.stringify(backup).includes(original.key), false);
    reopened = controller(); reopened.center.visible = signal(false); reopened.flush(); await settle(); assert.equal(reopened.reminders.history().length, 1);
    assert.equal(JSON.parse(memory.values.get(REMINDER_HISTORY_KEY)).entries[0].title, task.title);
  } finally {reopened?.close(); f.close();}
});

test('不同分頁接續歷史已讀狀態，改期新增事件，工作空間刪除及世代重置拒絕舊連結', async () => {
  storage(); const first = controller(), second = controller();
  try {
    first.center.visible = signal(false); second.center.visible = signal(false); first.flush(); second.flush(); await settle(); first.flush(); second.flush(); await settle();
    assert.equal(first.reminders.history().length, 1); first.reminders.markHistoryRead(first.reminders.history()); await settle();
    second.reminders.seenChanged({key: REMINDER_HISTORY_KEY}); second.reminders.seenChanged({key: REMINDER_SEEN_KEY}); assert.ok(second.reminders.history()[0].readAt); assert.equal(second.reminders.unseenCount(), 0);
    await first.store.saveTask({...task, startTime: '11:15'}); first.flush(); await settle(); assert.equal(first.reminders.history().length, 2);
    const old = first.reminders.history()[0]; await first.store.saveWorkspace('', '保留空間'); await first.store.deleteWorkspace('workspace'); first.flush(); await settle();
    assert.equal(first.reminders.resolveHistory(old), undefined); assert.equal(first.reminders.history().length, 2);
    await first.store.resetData(false, first.store.revision()); first.flush(); await settle(); assert.equal(first.reminders.history().length, 0); assert.equal(first.reminders.resolveHistory(old), undefined);
  } finally {second.close(); first.close();}
});

test('開啟開始提示即標為已讀，單純關閉提示仍保留未讀歷史', async () => {
  storage([task, {...task, id: 'other'}]); const f = controller();
  try {
    f.center.visible = signal(false); f.flush(); await settle(); f.flush(); await settle();
    const [opened, dismissed] = f.reminders.popups(); f.popups.open(opened.item, opened.key); f.reminders.dismiss(dismissed.key); await settle();
    assert.ok(f.reminders.history().find(entry => entry.taskId === opened.item.task.id).readAt);
    assert.equal(f.reminders.history().find(entry => entry.taskId === dismissed.item.task.id).readAt, undefined);
    assert.equal(f.reminders.unseenCount(), 1);
  } finally {f.close();}
});

test('提醒徽章只計算未查看項目，開啟側欄後收起，隱藏及背景時不誤標已查看', async () => {
  const memory = storage(), f = controller(); let reopened;
  try {
    f.center.visible = signal(false); f.flush(); await settle();
    assert.equal(f.reminders.summaryCount(), 1); assert.equal(f.reminders.unseenCount(), 1); assert.equal(memory.values.has(REMINDER_SEEN_KEY), false);
    f.center.visible.set(true); f.reminders.active.set(false); f.flush(); await settle(); assert.equal(f.reminders.unseenCount(), 1);
    f.reminders.active.set(true); f.flush(); await settle();
    assert.equal(f.reminders.unseenCount(), 0); assert.equal(f.reminders.summaryCount(), 1); assert.equal(f.center.visibleItems().length, 1);
    const saved = JSON.parse(memory.values.get(REMINDER_SEEN_KEY)); assert.equal(saved.keys.length, 1); assert.equal(JSON.stringify(saved).includes(task.title), false);
    reopened = controller(); reopened.center.visible = signal(false); reopened.flush(); await settle();
    assert.equal(reopened.reminders.unseenCount(), 0); assert.equal(reopened.reminders.summaryCount(), 1);
    const backup = await f.store.backupForExport('full'); assert.equal(JSON.stringify(backup).includes('reminder-seen'), false);
  } finally {reopened?.close(); f.close();}
});

test('開啟側欄後新提醒標記保留至本次瀏覽結束，舊提醒不標新，暫時遮住與切換範圍保留標記', async () => {
  storage(); const f = controller();
  try {
    f.center.active = signal(false); f.center.visible = signal(false); f.flush();
    f.reminders.markViewed(); await settle();
    await f.store.saveTask({...task, id: 'new', title: '新增提醒'}); f.flush(); assert.equal(f.reminders.unseenCount(), 1);
    f.center.active.set(true); f.center.visible.set(true); f.flush(); await settle();
    const newId = reminderItemKey(f.reminders.items().find(item => item.task.id === 'new')), oldId = reminderItemKey(f.reminders.items().find(item => item.task.id === task.id));
    assert.equal(f.reminders.unseenCount(), 0); assert.equal(f.center.newItemIds().has(newId), true); assert.equal(f.center.newItemIds().has(oldId), false);
    f.center.selectTab('this-week'); f.flush(); assert.equal(f.center.newItemIds().has(newId), true);
    f.center.visible.set(false); f.flush(); f.center.visible.set(true); f.flush(); assert.equal(f.center.newItemIds().has(newId), true);
    await f.store.saveTask({...task, id: 'later', title: '後續提醒'}); f.flush(); await settle();
    assert.equal(f.reminders.unseenCount(), 0); assert.equal(f.center.newItemIds().size, 2);
    f.center.active.set(false); f.center.visible.set(false); f.flush(); assert.equal(f.center.newItemIds().size, 0);
    f.center.active.set(true); f.center.visible.set(true); f.flush(); await settle(); assert.equal(f.center.newItemIds().size, 0);
    await f.store.saveTask({...task, startTime: '11:30'}); f.flush(); await settle(); assert.equal(f.center.newItemIds().has(oldId), true);
    await f.store.saveWorkspace('', '其他工作空間'); f.flush(); await settle(); assert.equal(f.center.newItemIds().size, 0);
  } finally {f.close();}
});

test('查看後改標題不再提醒，改期或變成逾期時提示一次，側欄收起仍能提示新安排', async () => {
  storage(); const f = controller();
  try {
    f.flush(); await settle(); assert.equal(f.reminders.unseenCount(), 0);
    f.center.visible = signal(false);
    await f.store.saveTask({...task, title: '新的標題'}); f.flush(); assert.equal(f.reminders.unseenCount(), 0);
    await f.store.saveTask({...task, title: '新的標題', startTime: '11:15'}); f.flush(); assert.equal(f.reminders.unseenCount(), 1);
    f.reminders.markViewed(); await settle(); assert.equal(f.reminders.unseenCount(), 0);
    f.reminders.now.set(new Date(2026, 9, 9, 12, 30)); f.flush(); assert.equal(f.reminders.unseenCount(), 1);
    f.reminders.markViewed(); await settle(); f.reminders.now.set(new Date(2026, 9, 9, 13)); f.flush(); assert.equal(f.reminders.unseenCount(), 0);
    await f.store.saveTask({...task, id: 'new', startTime: '14:00', dueTime: '15:00'}); f.flush(); assert.equal(f.reminders.unseenCount(), 1);
    f.center.visible.set(true); f.flush(); await settle(); assert.equal(f.reminders.unseenCount(), 0); assert.equal(f.reminders.summaryCount(), 2);
  } finally {f.close();}
});

test('同瀏覽器分頁接續查看紀錄，新工作空間及重置世代不借用舊提醒狀態', async () => {
  storage(); const first = controller(), second = controller();
  try {
    first.center.visible = signal(false); second.center.visible = signal(false);
    first.flush(); second.flush(); await settle(); assert.equal(second.reminders.unseenCount(), 1);
    first.reminders.markViewed(); await settle(); second.reminders.seenChanged({key: REMINDER_SEEN_KEY}); assert.equal(second.reminders.unseenCount(), 0);
    await second.store.saveWorkspace('', '另一個工作空間'); await second.store.saveTask(task); second.flush(); assert.equal(second.reminders.unseenCount(), 1);
    second.reminders.markViewed(); await settle(); first.reminders.seenChanged({key: REMINDER_SEEN_KEY}); assert.equal(first.reminders.unseenCount(), 0);
    first.store.refreshFromStorage(); assert.equal((await first.store.resetData(false, first.store.revision())).ok, true);
    await first.store.saveTask(task); first.flush(); assert.equal(first.reminders.unseenCount(), 1);
  } finally {second.close(); first.close();}
});

test('查看紀錄寫入失敗仍收起當前徽章並提示，提醒清單保留', async () => {
  const memory = storage(), f = controller();
  try {
    f.center.visible = signal(false); f.reminders.blocked.set(true); f.flush(); await settle();
    memory.fail(); f.center.visible.set(true); f.flush(); await settle();
    assert.equal(f.reminders.unseenCount(), 0); assert.equal(f.reminders.summaryCount(), 1); assert.equal(f.center.visibleItems().length, 1);
    assert.match(f.reminders.attentionWarning(), /無法保存查看紀錄/); assert.equal(memory.values.has(REMINDER_SEEN_KEY), false);
    assert.match(f.reminders.historyWarning(), /無法保存這次提醒歷史/);
    f.reminders.seenChanged({key: REMINDER_SEEN_KEY}); assert.equal(f.reminders.unseenCount(), 0);
  } finally {f.close();}
});

test('右下角提示只在前景且未編輯時顯示，點選可開啟最新任務且關閉不再重複', async () => {
  const {values} = storage(); const fixture = controller();
  const {store, reminders, center, flush} = fixture;
  try {
    await store.updateReminders({leadMinutes: 15});
    reminders.active.set(false); flush(); await settle();
    assert.equal(reminders.popups().length, 0); assert.equal(values.has(REMINDER_DELIVERY_KEY), false);
    reminders.active.set(true); fixture.popups.blocked.set(true); flush(); await settle(); assert.equal(reminders.popups().length, 0);
    fixture.popups.blocked.set(false); flush(); await settle(); assert.equal(reminders.popups().length, 1);
    assert.equal(fixture.anchors.at(-1).getMonth(), 9);
    const popup = reminders.popups()[0];
    await store.saveTask({...task, title: '最新內容'}); flush(); await settle();
    assert.equal(reminders.popups()[0].item.task.title, '最新內容');
    let opened; fixture.popups.openItem.subscribe(value => { opened = value; });
    fixture.popups.open(popup.item, popup.key); assert.equal(opened.task.title, '最新內容');
    flush(); await settle(); assert.equal(reminders.popups().length, 0);
    reminders.now.set(new Date(2026, 9, 9, 10, 55)); flush(); await settle(); assert.equal(reminders.popups().length, 0);
  } finally { fixture.close(); }
});

test('兩個分頁及重新載入只提示一次，改期後依新時刻重新提示', async () => {
  storage(); const first = controller(); let second;
  try {
    await first.store.updateReminders({leadMinutes: 15}); second = controller();
    first.flush(); second.flush(); await settle();
    assert.equal(first.reminders.popups().length + second.reminders.popups().length, 1);
    const third = controller();
    try { third.flush(); await settle(); assert.equal(third.reminders.popups().length, 0); } finally { third.close(); }
    await first.store.saveTask({...task, startTime: '11:15'}); second.store.refreshFromStorage();
    first.reminders.now.set(new Date(2026, 9, 9, 11, 5)); second.reminders.now.set(new Date(2026, 9, 9, 11, 5));
    first.flush(); second.flush(); await settle();
    assert.equal(first.reminders.popups().length + second.reminders.popups().length, 1);
    assert.equal([...first.reminders.popups(), ...second.reminders.popups()][0].item.task.startTime, '11:15');
  } finally { second?.close(); first.close(); }
});

test('完成、封存、刪除及資料重置立即移除提示，舊項目不能再開啟', async () => {
  storage(); const fixture = controller();
  try {
    fixture.flush(); await settle(); const item = fixture.reminders.popups()[0].item;
    await fixture.store.saveTask({...task, status: 'done'}); fixture.flush(); await settle();
    assert.equal(fixture.reminders.popups().length, 0); assert.equal(fixture.reminders.resolve(item), undefined);
    await fixture.store.saveTask({...task, status: 'archived'}); fixture.flush(); assert.equal(fixture.reminders.resolve(item), undefined);
    await fixture.store.deleteTask(task.id); fixture.flush(); assert.equal(fixture.reminders.resolve(item), undefined);
    await fixture.store.resetData(false, fixture.store.revision()); fixture.flush(); await settle();
    assert.equal(fixture.reminders.items().length, 0); assert.equal(fixture.reminders.resolve(item), undefined);
  } finally { fixture.close(); }
});

test('訊息中心計數依項目去重，全天只在指定時間後提示且可關閉，沒有儲存權限仍能查看清單', async () => {
  const memory = storage([{...task, startTime: ''}]); const fixture = controller();
  try {
    fixture.reminders.now.set(new Date(2026, 9, 9, 8)); fixture.flush(); await settle();
    assert.equal(fixture.reminders.popups().length, 0); assert.equal(fixture.center.count(), 1);
    memory.fail(); fixture.reminders.now.set(new Date(2026, 9, 9, 9)); fixture.flush(); await settle();
    assert.equal(fixture.reminders.popups().length, 0); assert.match(fixture.reminders.warning(), /無法保存/);
    assert.equal(fixture.center.visibleItems().length, 1);
    fixture.popups.blocked.set(true); let opened = 0; fixture.popups.openItem.subscribe(() => opened++);
    fixture.popups.open(fixture.center.visibleItems()[0], 'unused'); assert.equal(opened, 0);
  } finally { fixture.close(); }
});

test('訊息中心以 Google／Orbit 篩選來源與計數，顏色依月曆來源或本機分類', async () => {
  storage(); const fixture = controller();
  try {
    await fixture.store.saveCategory({id: 'design', name: '設計', color: '#4873b5'});
    await fixture.store.saveTask({...fixture.store.tasks()[0], categoryId: 'design'});
    const source = {id: 'calendar', name: 'Google 月曆', calendarId: 'calendar', accountId: 'account', color: '#9b6b32', visible: true, workspaceIds: ['workspace']};
    const external = externalEvent(source, {id: 'event', summary: 'Google 活動', start: {dateTime: '2026-10-09T12:00:00'}, end: {dateTime: '2026-10-09T13:00:00'}});
    fixture.google.reminderEvents.set([external]); fixture.flush();
    assert.equal(fixture.center.visibleItems().length, 2);
    assert.deepEqual(fixture.center.visibleItems().map(item => fixture.center.color(item)), ['#4873b5', '#9b6b32']);
    fixture.center.selectSource('google'); assert.equal(fixture.center.visibleItems().length, 1); assert.equal(fixture.center.visibleItems()[0].external, external);
    assert.equal(fixture.center.tabs().find(tab => tab.id === 'today').count, 2); assert.equal(fixture.center.count(), 2);
    fixture.center.activeTab.set('due-soon'); assert.equal(fixture.center.visibleItems().length, 1); assert.equal(fixture.center.hasMixedSources(), false);
    fixture.center.selectSource('orbit'); assert.ok(fixture.center.visibleItems().every(item => !item.external));
    fixture.center.activeTab.set('today'); assert.equal(fixture.center.sourceFilter(), 'google');
    fixture.center.selectSource('orbit'); assert.equal(fixture.center.visibleItems().length, 1);
    fixture.center.selectSource('all'); assert.equal(fixture.center.count(), 2);
    fixture.google.reminderEvents.set([]); fixture.flush(); assert.equal(fixture.center.visibleItems().length, 1);
  } finally { fixture.close(); }
});

const source = (id, patch = {}) => ({id, name: '月曆 ' + id, calendarId: id, accountId: 'account', color: '#4385d8', visible: true, workspaceIds: ['workspace'], ...patch});
const calendarEvent = (calendar, id, date = '2026-10-09', hour = '12') => externalEvent(calendar, {id, summary: id, start: {dateTime: `${date}T${hour}:00:00`}, end: {dateTime: `${date}T${hour}:30:00`}});

test('來源按鈕依原始列表的混合來源出現，單一來源不會被其他列表的條件隱藏', () => {
  storage([]); const f = controller();
  try {
    assert.equal(f.center.listItems().length, 0); assert.equal(f.center.hasMixedSources(), false); assert.equal(f.center.showCalendarFilter(), false);
    const google = calendarEvent(source('only'), 'event'); f.google.reminderEvents.set([google]);
    assert.equal(f.center.hasMixedSources(), false); assert.equal(f.center.showCalendarFilter(), false);
    f.center.selectSource('orbit'); assert.equal(f.center.visibleItems().length, 1); assert.equal(f.center.effectiveSource(), 'all');
    f.center.activeTab.set('due-soon'); assert.equal(f.center.listItems().length, 0); assert.equal(f.center.calendars().length, 0);
  } finally { f.close(); }
});

test('多選月曆只列目前日期範圍的來源，保留選項以便重新勾選，不變更系統資料與顯示設定', async () => {
  storage(); const f = controller();
  try {
    const a = source('a'), b = source('b'), c = source('c');
    await f.store.updateGoogle({clientId: '123-test.apps.googleusercontent.com'}); await f.store.updateGoogle({accountId: 'account'});
    for (const calendar of [a, b, c]) await f.store.bindCalendar(calendar, 'workspace', true);
    const events = [calendarEvent(a, 'a1'), calendarEvent(a, 'a2', '2026-10-09', '13'), calendarEvent(b, 'b1'), calendarEvent(c, 'tomorrow', '2026-10-10'), calendarEvent(source('hidden', {visible: false}), 'hidden'), calendarEvent(source('elsewhere', {workspaceIds: ['other']}), 'elsewhere')];
    f.google.reminderEvents.set(events);
    const revision = f.store.revision(), settings = structuredClone(f.store.google());
    assert.equal(f.center.hasMixedSources(), true); assert.equal(f.center.showCalendarFilter(), true);
    assert.deepEqual(f.center.calendars().map(calendar => [calendar.id, calendar.count]), [['a', 2], ['b', 1]]);
    f.center.toggleCalendar('a', false);
    assert.deepEqual(f.center.visibleItems().map(item => item.task.title), [task.title, 'b1']);
    assert.deepEqual(f.center.calendars().map(calendar => calendar.id), ['a', 'b']);
    f.center.selectSource('google'); assert.deepEqual(f.center.visibleItems().map(item => item.task.title), ['b1']);
    assert.equal(f.center.tabs().find(tab => tab.id === 'today').count, 4); assert.equal(f.center.tabs().find(tab => tab.id === 'tomorrow').count, 1);
    f.center.toggleCalendar('a', true); assert.equal(f.center.visibleItems().length, 3);
    f.center.selectCalendars(false); assert.equal(f.center.visibleItems().length, 0); assert.equal(f.center.showCalendarFilter(), true);
    f.center.selectCalendars(true); assert.equal(f.center.visibleItems().length, 3);
    f.center.toggleCalendar('not-in-list', false); assert.equal(f.center.visibleItems().length, 3);
    assert.equal(f.store.revision(), revision); assert.deepEqual(f.store.google(), settings); assert.equal(f.google.reminderEvents(), events);
  } finally { f.close(); }
});

test('今日與下週各自保留來源及月曆選擇，清除一個列表不改另一個列表', () => {
  storage(); const f = controller();
  try {
    const a = source('a'), b = source('b');
    f.google.reminderEvents.set([calendarEvent(a, 'a-today'), calendarEvent(b, 'b-today'), calendarEvent(a, 'a-next', '2026-10-11'), calendarEvent(b, 'b-next', '2026-10-12')]);
    f.center.selectSource('google'); f.center.toggleCalendar('a', false);
    f.center.activeTab.set('next-week'); assert.equal(f.center.sourceFilter(), 'all'); assert.equal(f.center.visibleItems().length, 2); assert.equal(f.center.hasMixedSources(), false);
    f.center.toggleCalendar('b', false); assert.deepEqual(f.center.visibleItems().map(item => item.task.title), ['a-next']);
    f.center.activeTab.set('today'); assert.equal(f.center.sourceFilter(), 'google'); assert.deepEqual(f.center.visibleItems().map(item => item.task.title), ['b-today']);
    f.center.clearFilters(); assert.equal(f.center.visibleItems().length, 3);
    f.center.activeTab.set('next-week'); assert.deepEqual(f.center.visibleItems().map(item => item.task.title), ['a-next']);
    f.center.activeTab.set('tomorrow'); assert.equal(f.center.calendars().length, 0); assert.equal(f.center.showCalendarFilter(), false);
  } finally { f.close(); }
});

test('列表更新保持篩選，新月曆預設納入；單一來源與單一月曆時不殘留隱藏條件', async () => {
  storage(); const f = controller();
  try {
    const a = calendarEvent(source('a'), 'a'), b = calendarEvent(source('b'), 'b'), c = calendarEvent(source('c'), 'c');
    f.google.reminderEvents.set([a, b]); f.center.selectSource('google'); f.center.toggleCalendar('a', false);
    await f.store.saveTask({...f.store.tasks()[0], title: '新名稱'});
    assert.equal(f.center.sourceFilter(), 'google'); assert.deepEqual(f.center.selectedCalendarIds(), ['b']);
    f.google.reminderEvents.set([a, b, c]); assert.deepEqual(f.center.selectedCalendarIds(), ['b', 'c']);
    f.center.selectSource('orbit'); assert.equal(f.center.showCalendarFilter(), false); assert.deepEqual(f.center.visibleItems().map(item => item.task.title), ['新名稱']);
    await f.store.deleteTask(task.id); assert.equal(f.center.hasMixedSources(), false); assert.equal(f.center.showCalendarFilter(), true);
    assert.deepEqual(f.center.visibleItems().map(item => item.task.title), ['b', 'c']);
    f.google.reminderEvents.set([a]); assert.equal(f.center.showCalendarFilter(), false); assert.deepEqual(f.center.visibleItems().map(item => item.task.title), ['a']);
  } finally { f.close(); }
});

test('本週提醒呈現完整排程、來源篩選與去重計數，分頁變更可保存', () => {
  storage([
    {...task, id: 'ongoing', startDate: '2026-09-30', dueDate: '2026-10-12'},
    {...task, id: 'deadline', startDate: '', startTime: '', dueDate: '2026-10-04', dueTime: ''},
    {...task, id: 'done', status: 'done'}
  ]);
  const f = controller();
  try {
    const event = calendarEvent(source('a'), 'Google 活動', '2026-10-05');
    f.google.reminderEvents.set([event, event]);
    let selected;
    f.center.tabChange.subscribe(tab => {selected = tab;});
    f.center.selectTab('this-week');
    assert.equal(selected, 'this-week'); assert.equal(f.center.tabs().find(tab => tab.id === 'this-week').count, 3);
    assert.equal(f.center.count(), 3); assert.equal(f.reminders.summaryCount(), 3);
    assert.equal(f.center.rangeLabel(), '2026/10/4 — 2026/10/10（週日至週六）');
    assert.equal(f.center.dateLabel(f.center.listItems()[0]), '2026/09/30 · 11:00 — 2026/10/12 · 12:00');
    assert.equal(f.center.dateLabel(f.center.listItems()[1]), '2026/10/04 · 當天結束 截止');
    f.center.selectSource('google'); assert.deepEqual(f.center.visibleItems().map(item => item.task.id), [event.task.id]);
    f.center.selectTab('today'); assert.equal(f.center.sourceFilter(), 'all');
    f.center.selectTab('this-week'); assert.equal(f.center.sourceFilter(), 'google');
  } finally {f.close();}
});

test('切換工作空間或重置資料清除訊息中心舊篩選，返回仍可從全部查看', async () => {
  storage(); const f = controller();
  try {
    f.google.reminderEvents.set([calendarEvent(source('a'), 'a'), calendarEvent(source('b'), 'b')]);
    f.center.selectSource('google'); f.center.toggleCalendar('a', false);
    await f.store.saveWorkspace('', '其他工作空間'); assert.equal(f.center.sourceFilter(), 'all'); assert.equal(f.center.calendars().length, 2);
    f.center.workspaceScope.set('current'); assert.equal(f.center.calendars().length, 0); f.center.workspaceScope.set('all');
    f.store.switchWorkspace('workspace'); assert.equal(f.center.sourceFilter(), 'all'); assert.deepEqual(f.center.selectedCalendarIds(), ['a', 'b']);
    f.center.selectSource('orbit'); await f.store.resetData(false, f.store.revision());
    assert.equal(f.center.sourceFilter(), 'all'); assert.equal(f.center.visibleItems().length, 0);
  } finally { f.close(); }
});
