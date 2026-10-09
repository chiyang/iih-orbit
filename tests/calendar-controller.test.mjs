import '@angular/compiler';
import { createEnvironmentInjector, runInInjectionContext, signal, ɵChangeDetectionScheduler, ɵEffectScheduler } from '@angular/core';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { COLUMNS } from '../src/app/models.ts';
import { externalEvent } from '../src/app/google-data.ts';

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('@angular/build/package.json'))('esbuild');
await mkdir('.angular', {recursive: true});
const directory = await mkdtemp(resolve('.angular/calendar-test-'));
const output = resolve(directory, 'calendar.mjs');
await build({stdin: {contents: "export {Calendar} from './src/app/calendar.ts'; export {GoogleCalendarService} from './src/app/google-calendar.ts'; export {BoardStore} from './src/app/board-store.ts'; export {UiPreferences} from './src/app/ui-preferences.ts';", resolveDir: process.cwd()}, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: output, tsconfig: 'tsconfig.json'});
const { Calendar, GoogleCalendarService, BoardStore, UiPreferences } = await import(pathToFileURL(output).href);
after(() => rm(directory, {recursive: true, force: true}));
const base = {id: 'task', title: '會議', description: '內容保留', projectId: '', categoryId: '', status: 'todo', priority: 'medium', startDate: '2026-10-09', startTime: '09:00', dueDate: '2026-10-09', dueTime: '10:00', subtasks: [{id: 'sub', title: '資料', done: false}]};

function calendarController(tasks = [base], external = []) {
  const state = {version: 1, activeWorkspaceId: 'workspace', workspaces: [{version: 4, id: 'workspace', name: '工作', projects: [], categories: [], statuses: COLUMNS, tasks}]};
  const values = new Map([['orbit-workspaces-v1', JSON.stringify(state)]]);
  globalThis.localStorage = {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key)};
  const store = new BoardStore(), effects = new Set();
  const scheduler = {add(effect) { effects.add(effect); }, schedule() {}, remove(effect) { effects.delete(effect); }};
  const google = {store, events: signal(external), visibleSources: signal([]), setMonthRange() {}};
  const injector = createEnvironmentInjector([{provide: GoogleCalendarService, useValue: google}, {provide: UiPreferences, useValue: {scale: () => .9}}, {provide: ɵEffectScheduler, useValue: scheduler}, {provide: ɵChangeDetectionScheduler, useValue: {notify() {}}}]);
  // No DOM or browser: test the action controller and store using signals and pointer coordinates only.
  globalThis.ngServerMode = true;
  let calendar;
  try { calendar = runInInjectionContext(injector, () => new Calendar()); }
  finally { delete globalThis.ngServerMode; }
  calendar.tasks = store.tasks; calendar.categories = store.categories; calendar.statuses = store.statuses; calendar.mode = signal('month'); calendar.anchor.set(new Date(2026, 9, 9));
  calendar.showOrbit = signal(true); calendar.showGoogle = signal(true); calendar.deadlineFiltered = signal(false);
  const flush = () => { for (const effect of effects) if (effect.dirty) effect.run(); };
  return {calendar, store, google, flush, close: () => { calendar.endDrag(); injector.destroy(); }};
}
function dragEvent(x = 20, y = 20) {
  let prevented = false, stopped = false;
  return {clientX: x, clientY: y, currentTarget: {getBoundingClientRect: () => ({top: 0, left: 0})}, dataTransfer: {setData() {}}, preventDefault() { prevented = true; }, stopPropagation() { stopped = true; }, prevented: () => prevented, stopped: () => stopped};
}

function googleEntry(id, start, end, title = id) {
  const source = {id: 'source', accountId: 'account', calendarId: 'calendar', name: '行事曆', color: '#4385d8', visible: true, workspaceIds: ['workspace']};
  return externalEvent(source, {id, summary: title, start, end});
}

test('月曆先分全天與時間，各組 Google 在前，時間依各來源排序且預覽保持四項', () => {
  const local = [
    {...base, id: 'orbit-noon', title: '下午任務', startTime: '13:00', dueTime: '14:00'},
    {...base, id: 'orbit-all', title: '全天任務', startTime: '', dueTime: ''},
    {...base, id: 'orbit-early', title: '早上任務', startTime: '08:00', dueTime: '09:00'}
  ];
  const external = [
    googleEntry('google-noon', {dateTime: '2026-10-09T12:00:00'}, {dateTime: '2026-10-09T13:00:00'}),
    googleEntry('google-all', {date: '2026-10-09'}, {date: '2026-10-10'}),
    googleEntry('google-early', {dateTime: '2026-10-09T09:00:00'}, {dateTime: '2026-10-09T10:00:00'})
  ];
  const {calendar, close} = calendarController(local, external);
  try {
    const expected = [external[1].task.id, 'orbit-all', external[2].task.id, external[0].task.id, 'orbit-early', 'orbit-noon'];
    const day = () => calendar.days().find(day => day.key === '2026-10-09');
    assert.deepEqual(day().tasks.map(task => task.id), expected);
    assert.deepEqual(day().visibleTasks.map(task => task.id), expected.slice(0, 4));
    assert.equal(calendar.monthScheduleLabel(external[1].task, day().key), '全天');
    assert.equal(calendar.monthScheduleLabel(local[2], day().key), '08:00 – 09:00');
    assert.equal(calendar.monthScheduleLabel(external[0].task, day().key), '12:00 – 13:00');
    calendar.toggleAllDays(); assert.deepEqual(day().visibleTasks.map(task => task.id), expected);
  } finally { close(); }
});

test('跨日任務與 Google 活動的完整日用全天呈現，部分日保留時間且午夜結束不多顯示一天', async () => {
  const local = {...base, startDate: '2026-10-08', startTime: '18:00', dueDate: '2026-10-11', dueTime: '00:00'};
  const external = googleEntry('overnight', {dateTime: '2026-10-08T18:00:00'}, {dateTime: '2026-10-11T00:00:00'});
  const {calendar, store, close} = calendarController([local], [external]);
  try {
    for (const task of [local, external.task]) {
      assert.equal(calendar.isAllDay(task, '2026-10-08'), false);
      assert.equal(calendar.monthScheduleLabel(task, '2026-10-08'), '18:00 – 24:00');
      for (const date of ['2026-10-09', '2026-10-10']) {
        assert.equal(calendar.isAllDay(task, date), true);
        assert.equal(calendar.monthScheduleLabel(task, date), '全天');
        assert.equal(calendar.days().find(day => day.key === date).timedEvents.some(event => event.task.id === task.id), false);
      }
      assert.equal(calendar.days().find(day => day.key === '2026-10-11').tasks.some(entry => entry.id === task.id), false);
    }
    const partial = {...local, dueTime: '11:00'};
    await store.saveTask(partial);
    assert.equal(calendar.isAllDay(partial, '2026-10-11'), false);
    assert.equal(calendar.monthScheduleLabel(partial, '2026-10-11'), '00:00 – 11:00');
    calendar.mode.set('week');
    assert.equal(calendar.weekDays().find(day => day.key === '2026-10-10').timedEvents.length, 0);
    assert.equal(calendar.allDayEvents().length, 2);
  } finally { close(); }
});

test('Google 全天 exclusive end 與只設開始或截止時間的 Orbit 標記在月視圖正確呈現', () => {
  const external = googleEntry('all-day', {date: '2026-10-09'}, {date: '2026-10-11'});
  const seconds = googleEntry('with-seconds', {dateTime: '2026-10-09T09:15:30'}, {dateTime: '2026-10-09T10:15:00'});
  const start = {...base, id: 'start', dueDate: '', dueTime: ''};
  const due = {...base, id: 'due', startDate: '', startTime: '', dueTime: '17:00'};
  const {calendar, close} = calendarController([due, start], [external, seconds]);
  try {
    assert.equal(calendar.isAllDay(start, '2026-10-09'), false);
    assert.equal(calendar.isAllDay(due, '2026-10-09'), false);
    assert.equal(calendar.monthScheduleLabel(start, '2026-10-09'), '09:00 開始');
    assert.equal(calendar.monthScheduleLabel(due, '2026-10-09'), '17:00 截止');
    assert.equal(calendar.monthScheduleLabel(seconds.task, '2026-10-09'), '09:15 – 10:15');
    assert.equal(calendar.isAllDay(external.task, '2026-10-10'), true);
    assert.equal(calendar.days().find(day => day.key === '2026-10-11').tasks.length, 0);
  } finally { close(); }
});

test('來源開關共同控制月曆、週時間格、全天橫條、未排程與計數，保持原任務及外部活動', () => {
  const localAll = {...base, id: 'local-all', startTime: '', dueTime: ''};
  const unscheduled = {...base, id: 'unscheduled', startDate: '', startTime: '', dueDate: '', dueTime: ''};
  const external = [googleEntry('timed', {dateTime: '2026-10-09T11:00:00'}, {dateTime: '2026-10-09T12:00:00'}), googleEntry('all', {date: '2026-10-09'}, {date: '2026-10-10'})];
  const {calendar, store, google, flush, close} = calendarController([base, localAll, unscheduled], external);
  calendar.orbitVisibilityChange.subscribe(value => calendar.showOrbit.set(value));
  calendar.googleVisibilityChange.subscribe(value => calendar.showGoogle.set(value));
  try {
    assert.equal(calendar.periodTaskCount(), 2); assert.equal(calendar.periodExternalCount(), 2);
    calendar.toggleGoogle(); assert.equal(calendar.periodExternalCount(), 0);
    calendar.mode.set('week');
    assert.equal(calendar.allDayEvents().length, 1); assert.equal(calendar.weekDays().find(day => day.key === base.startDate).timedEvents.length, 1);
    calendar.startDrag(dragEvent(), base, {kind: 'time', day: base.startDate, minute: 540});
    calendar.toggleOrbit(); flush(); assert.equal(calendar.draggedTaskId(), '');
    assert.equal(calendar.allDayEvents().length, 0); assert.equal(calendar.periodTaskCount(), 0); assert.equal(calendar.unscheduled().length, 0);
    assert.equal(calendar.weekDays().every(day => day.timedEvents.length === 0), true);
    calendar.toggleGoogle(); assert.equal(calendar.periodExternalCount(), 2); assert.equal(calendar.periodTaskCount(), 0);
    calendar.toggleOrbit(); calendar.mode.set('month');
    assert.equal(calendar.periodTaskCount(), 2); assert.equal(calendar.unscheduled().length, 1);
    assert.deepEqual(store.tasks(), [base, localAll, unscheduled]); assert.deepEqual(google.events(), external);
  } finally { close(); }
});

test('截止篩選暫時隱藏 Google，期間不能打開；清除篩選恢復原本的來源選擇', () => {
  const external = googleEntry('timed', {dateTime: '2026-10-09T11:00:00'}, {dateTime: '2026-10-09T12:00:00'});
  const {calendar, close} = calendarController([base], [external]);
  calendar.googleVisibilityChange.subscribe(value => calendar.showGoogle.set(value));
  try {
    calendar.deadlineFiltered.set(true);
    assert.equal(calendar.showGoogle(), true); assert.equal(calendar.googleVisible(), false); assert.equal(calendar.periodExternalCount(), 0);
    calendar.toggleGoogle(); assert.equal(calendar.showGoogle(), true);
    calendar.mode.set('week'); assert.equal(calendar.periodExternalCount(), 0); assert.equal(calendar.periodTaskCount(), 1);
    calendar.deadlineFiltered.set(false); assert.equal(calendar.googleVisible(), true); assert.equal(calendar.periodExternalCount(), 1);
    calendar.toggleGoogle(); calendar.deadlineFiltered.set(true); calendar.deadlineFiltered.set(false);
    assert.equal(calendar.showGoogle(), false); assert.equal(calendar.googleVisible(), false); assert.equal(calendar.periodExternalCount(), 0);
  } finally { close(); }
});

test('月曆及週視圖以週日起始，標籤、標題與跨日橫條欄位一致', () => {
  const {calendar, close} = calendarController([{...base, startDate: '2026-10-04', startTime: '', dueDate: '2026-10-05', dueTime: ''}]);
  try {
    assert.equal(calendar.days()[0].key, '2026-09-27');
    assert.deepEqual(calendar.weekdays, ['週日', '週一', '週二', '週三', '週四', '週五', '週六']);
    calendar.mode.set('week');
    assert.equal(calendar.weekDays()[0].key, '2026-10-04'); assert.equal(calendar.weekDays()[0].weekday, '週日');
    assert.equal(calendar.weekDays()[6].key, '2026-10-10');
    assert.match(calendar.periodTitle(), /10 月 4 日.*10 月 10 日/);
    assert.equal(calendar.allDayEvents()[0].startColumn, 0); assert.equal(calendar.allDayEvents()[0].endColumn, 2);
  } finally { close(); }
});

test('月曆每天預覽四項，超過可逐日或全部展開，全部展開後也能單日收合', () => {
  const tasks = Array.from({length: 6}, (_, index) => ({...base, id: 'task-' + index}));
  const fixture = calendarController([...tasks, ...tasks.map(task => ({...task, id: task.id + '-next', startDate: '2026-10-10', dueDate: '2026-10-10'}))]);
  const {calendar, close} = fixture;
  try {
    const day = key => calendar.days().find(item => item.key === key);
    assert.equal(day('2026-10-09').visibleTasks.length, 4); assert.equal(calendar.hasOverflow(), true);
    calendar.toggleDay('2026-10-09'); assert.equal(day('2026-10-09').visibleTasks.length, 6); assert.equal(day('2026-10-10').visibleTasks.length, 4);
    calendar.toggleAllDays(); assert.equal(calendar.allDaysExpanded(), true); assert.equal(day('2026-10-10').visibleTasks.length, 6);
    calendar.toggleDay('2026-10-09'); assert.equal(day('2026-10-09').visibleTasks.length, 4); assert.equal(day('2026-10-10').visibleTasks.length, 6);
    calendar.toggleAllDays(); calendar.toggleAllDays(); assert.equal(day('2026-10-10').visibleTasks.length, 4);
    calendar.toggleAllDays(); calendar.navigate(1); assert.equal(calendar.expandAll(), true);
  } finally { close(); }
});

test('月曆拖曳保存本機任務並保留其他欄位，取消拖曳不寫入且不誤開編輯', async () => {
  const {calendar, store, close} = calendarController();
  let edits = 0;
  calendar.editTask.subscribe(() => edits++);
  try {
    calendar.startDrag(dragEvent(), base, {kind: 'month', day: base.startDate});
    await calendar.drop(dragEvent(), {kind: 'month', day: '2026-10-12'});
    assert.deepEqual(store.tasks()[0], {...base, startDate: '2026-10-12', dueDate: '2026-10-12'});
    assert.match(calendar.moveNotice(), /已調整/); assert.equal(calendar.draggedTaskId(), '');
    calendar.openEntry(store.tasks()[0]); assert.equal(edits, 0);
    calendar.ignoreClickUntil = 0;
    calendar.startDrag(dragEvent(), store.tasks()[0], {kind: 'month', day: '2026-10-12'});
    calendar.endDrag(); assert.equal(store.tasks()[0].startDate, '2026-10-12');
    await calendar.drop(dragEvent(), {kind: 'month', day: '2026-10-13'}); assert.equal(store.tasks()[0].startDate, '2026-10-12');
  } finally { close(); }
});

test('週時間拖曳使用滑鼠抓取偏移定位，保存開始與截止；全天位置移除時間', async () => {
  const {calendar, store, close} = calendarController();
  try {
    calendar.mode.set('week');
    const start = dragEvent(20, calendar.hourHeight() / 4);
    calendar.startDrag(start, base, {kind: 'time', day: base.startDate, minute: 540});
    const element = {getBoundingClientRect: () => ({top: 0})};
    const target = calendar.timePosition('2026-10-10', element, calendar.hourHeight() * 11.25);
    assert.equal(target.minute, 660);
    await calendar.drop(dragEvent(), target);
    assert.deepEqual(store.tasks()[0], {...base, startDate: '2026-10-10', startTime: '11:00', dueDate: '2026-10-10', dueTime: '12:00'});
    calendar.startDrag(dragEvent(), store.tasks()[0], {kind: 'time', day: '2026-10-10', minute: 660});
    await calendar.drop(dragEvent(), {kind: 'all-day', day: '2026-10-11'});
    assert.deepEqual(store.tasks()[0], {...base, startDate: '2026-10-11', startTime: '', dueDate: '2026-10-11', dueTime: ''});
  } finally { close(); }
});

test('拖曳期間被其他分頁更新、刪除或重置的任務不被覆蓋或復活', async () => {
  const {calendar, store, close} = calendarController();
  try {
    calendar.startDrag(dragEvent(), base, {kind: 'month', day: base.startDate});
    await store.saveTask({...base, title: '其他分頁的新標題'});
    await calendar.drop(dragEvent(), {kind: 'month', day: '2026-10-12'});
    assert.equal(store.tasks()[0].title, '其他分頁的新標題'); assert.equal(store.tasks()[0].startDate, base.startDate); assert.match(calendar.moveError(), /未套用/);
    calendar.startDrag(dragEvent(), store.tasks()[0], {kind: 'month', day: base.startDate});
    await store.deleteTask(base.id); await calendar.drop(dragEvent(), {kind: 'month', day: '2026-10-12'});
    assert.equal(store.tasks().length, 0);
    await store.saveTask(base);
    calendar.startDrag(dragEvent(), base, {kind: 'month', day: base.startDate});
    await store.resetData(false, store.revision());
    await calendar.drop(dragEvent(), {kind: 'month', day: '2026-10-12'}); assert.equal(store.tasks().length, 0);
  } finally { close(); }
});

test('Google 活動保持唯讀且不可拖曳，只有點選會開啟外部活動', async () => {
  const externalTask = {...base, id: 'google:source:event'};
  const external = {task: externalTask};
  const {calendar, store, close} = calendarController([base], [external]);
  let opened;
  calendar.readExternal.subscribe(value => { opened = value; });
  try {
    const event = dragEvent(); calendar.startDrag(event, externalTask, {kind: 'month', day: base.startDate});
    assert.equal(event.prevented(), true); assert.equal(calendar.draggedTaskId(), '');
    await calendar.drop(dragEvent(), {kind: 'month', day: '2026-10-12'}); assert.deepEqual(store.tasks(), [base]);
    calendar.openEntry(externalTask); assert.equal(opened, external);
  } finally { close(); }
});

test('未排程任務可拖至日期或時段，設定截止標記；無效目的日期保留原資料', async () => {
  const empty = {...base, startDate: '', startTime: '', dueDate: '', dueTime: ''};
  const {calendar, store, close} = calendarController([empty]);
  try {
    calendar.startDrag(dragEvent(), store.tasks()[0], {kind: 'all-day', day: '2026-10-09'});
    await calendar.drop(dragEvent(), {kind: 'time', day: '2026-10-10', minute: 600});
    assert.deepEqual(store.tasks()[0], {...empty, dueDate: '2026-10-10', dueTime: '10:00'});
    calendar.startDrag(dragEvent(), store.tasks()[0], {kind: 'time', day: '2026-10-10', minute: 600});
    await calendar.drop(dragEvent(), {kind: 'time', day: '2026-02-30', minute: 600});
    assert.equal(store.tasks()[0].dueDate, '2026-10-10'); assert.match(calendar.moveError(), /不合法/);
  } finally { close(); }
});
