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
import { externalEvent } from '../src/app/google-data.ts';

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

test('切換工作空間或重置資料清除訊息中心舊篩選，返回仍可從全部查看', async () => {
  storage(); const f = controller();
  try {
    f.google.reminderEvents.set([calendarEvent(source('a'), 'a'), calendarEvent(source('b'), 'b')]);
    f.center.selectSource('google'); f.center.toggleCalendar('a', false);
    await f.store.saveWorkspace('', '其他工作空間'); assert.equal(f.center.sourceFilter(), 'all'); assert.equal(f.center.calendars().length, 0);
    f.store.switchWorkspace('workspace'); assert.equal(f.center.sourceFilter(), 'all'); assert.deepEqual(f.center.selectedCalendarIds(), ['a', 'b']);
    f.center.selectSource('orbit'); await f.store.resetData(false, f.store.revision());
    assert.equal(f.center.sourceFilter(), 'all'); assert.equal(f.center.visibleItems().length, 0);
  } finally { f.close(); }
});
