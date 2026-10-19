import '@angular/compiler';
import { createEnvironmentInjector, runInInjectionContext, signal, ɵChangeDetectionScheduler, ɵEffectScheduler } from '@angular/core';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { COLUMNS } from '../src/app/models.ts';
import { JSDOM } from 'jsdom';
import { externalEvent } from '../src/app/google-data.ts';
import { copyEventTask, createEventBody } from '../src/app/calendar-transfer-data.ts';
import { CALENDAR_DISPLAY_KEY, loadCalendarWidth, loadWeekRange, readWeekRange } from '../src/app/calendar-display.ts';
import {TASK_LINK_DRAG_TYPE} from '../src/app/task-link-drag.ts';

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('@angular/build/package.json'))('esbuild');
await mkdir('.angular', {recursive: true});
const directory = await mkdtemp(resolve('.angular/calendar-test-'));
const output = resolve(directory, 'calendar.mjs');
await build({stdin: {contents: "export {Calendar} from './src/app/calendar.ts'; export {GoogleCalendarService} from './src/app/google-calendar.ts'; export {BoardStore} from './src/app/board-store.ts'; export {UiPreferences} from './src/app/ui-preferences.ts';", resolveDir: process.cwd()}, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: output, tsconfig: 'tsconfig.json'});
const { Calendar, GoogleCalendarService, BoardStore, UiPreferences } = await import(pathToFileURL(output).href);
after(() => rm(directory, {recursive: true, force: true}));
const base = {id: 'task', title: '會議', description: '內容保留', projectId: '', categoryId: '', status: 'todo', priority: 'medium', startDate: '2026-10-09', startTime: '09:00', dueDate: '2026-10-09', dueTime: '10:00', subtasks: [{id: 'sub', title: '資料', done: false}]};
let dragValues = new Map();

function calendarController(tasks = [base], external = []) {
  dragValues = new Map();
  const state = {version: 1, activeWorkspaceId: 'workspace', workspaces: [{version: 4, id: 'workspace', name: '工作', projects: [], categories: [], statuses: COLUMNS, tasks}]};
  const values = new Map([['orbit-workspaces-v1', JSON.stringify(state)]]);
  globalThis.localStorage = {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key)};
  const store = new BoardStore(), effects = new Set();
  const scheduler = {add(effect) { effects.add(effect); }, schedule() {}, remove(effect) { effects.delete(effect); }};
  const google = {store, events: signal(external), visibleSources: signal([]), setMonthRange() {}};
  const preferences = {scale: () => .9, weekRange: signal({startHour: 8, endHour: 19}), weekRangeWarning: signal(''), calendarWidth: signal('wide'), calendarWidthWarning: signal(''), setCalendarWidth(width) {UiPreferences.prototype.setCalendarWidth.call(this, width);}};
  const injector = createEnvironmentInjector([{provide: GoogleCalendarService, useValue: google}, {provide: UiPreferences, useValue: preferences}, {provide: ɵEffectScheduler, useValue: scheduler}, {provide: ɵChangeDetectionScheduler, useValue: {notify() {}}}]);
  // No DOM or browser: test the action controller and store using signals and pointer coordinates only.
  globalThis.ngServerMode = true;
  let calendar;
  try { calendar = runInInjectionContext(injector, () => new Calendar()); }
  finally { delete globalThis.ngServerMode; }
  calendar.tasks = store.tasks; calendar.categories = store.categories; calendar.statuses = store.statuses; calendar.mode = signal('month'); calendar.anchor.set(new Date(2026, 9, 9));
  calendar.showOrbit = signal(true); calendar.showGoogle = signal(true); calendar.deadlineFiltered = signal(false);
  const flush = () => { for (const effect of effects) if (effect.dirty) effect.run(); };
  return {calendar, store, google, preferences, values, flush, close: () => { calendar.endDrag(); injector.destroy(); }};
}
function dragEvent(x = 20, y = 20) {
  let prevented = false, stopped = false;
  return {clientX: x, clientY: y, currentTarget: {getBoundingClientRect: () => ({top: 0, left: 0})}, dataTransfer: {get types() {return [...dragValues.keys()];}, setData: (type, value) => dragValues.set(type, value), getData: type => dragValues.get(type) ?? ''}, preventDefault() { prevented = true; }, stopPropagation() { stopped = true; }, prevented: () => prevented, stopped: () => stopped};
}

function googleEntry(id, start, end, title = id) {
  const source = {id: 'source', accountId: 'account', calendarId: 'calendar', name: '行事曆', color: '#4385d8', visible: true, workspaceIds: ['workspace']};
  return externalEvent(source, {id, summary: title, start, end});
}

test('月週視圖往返保留選中日，跨年週導覽後返回正確月份', () => {
  const f = calendarController();
  try {
    let selected = '';
    f.calendar.weekRequested.subscribe(date => {selected = date;});
    f.calendar.openWeek('2026-12-31'); assert.equal(selected, '2026-12-31');
    f.calendar.openWeek('invalid'); assert.equal(selected, '2026-12-31');
    f.calendar.selectedDate = signal('2026-12-31'); f.calendar.mode.set('week'); f.flush();
    assert.equal(f.calendar.days()[0].key, '2026-12-27'); assert.equal(f.calendar.days()[6].key, '2027-01-02');
    assert.deepEqual(f.calendar.weekDays().filter(day => day.selected).map(day => day.key), ['2026-12-31']);
    f.calendar.navigate(1); f.flush(); assert.equal(f.calendar.days()[0].key, '2027-01-03');
    assert.deepEqual(f.calendar.weekDays().filter(day => day.selected).map(day => day.key), ['2027-01-07']);
    let monthDate = '';
    f.calendar.monthRequested.subscribe(date => {monthDate = date;});
    f.calendar.openMonth(); assert.equal(monthDate, '2027-01-07');
    f.calendar.selectedDate.set(monthDate); f.calendar.mode.set('month'); f.flush();
    assert.equal(f.calendar.periodTitle(), '2027 年 1 月');
    assert.deepEqual(f.calendar.days().filter(day => day.selected).map(day => day.key), ['2027-01-07']);
  } finally {f.close();}
});

test('週視圖預設 08–19 時，調整範圍與暫時全天顯示保留所有安排及原始時間', () => {
  const tasks = [{...base, id: 'early', startTime: '06:00', dueTime: '07:00'}, {...base, id: 'cross', startTime: '07:00', dueTime: '09:00'}, {...base, id: 'late', startTime: '20:00', dueTime: '21:00'}];
  const f = calendarController(tasks);
  try {
    const {calendar} = f; calendar.mode.set('week');
    assert.equal(calendar.hours()[0].label, '08:00'); assert.equal(calendar.weekEndLabel(), '19:00'); assert.equal(calendar.slots().length, 22);
    assert.equal(calendar.timelineHeight(), calendar.hourHeight() * 11); assert.equal(calendar.periodTaskCount(), 3);
    const visible = calendar.weekDays().find(day => day.key === base.startDate).timedEvents;
    assert.deepEqual(visible.map(event => event.task.id), ['cross']); assert.equal(visible[0].displayStart, 480); assert.equal(visible[0].startMinute, 420); assert.equal(visible[0].label, '07:00 – 09:00');
    assert.deepEqual(calendar.outsideWeekEvents().map(entry => entry.event.task.id), ['early', 'late']);
    calendar.toggleWeekHours(); assert.equal(calendar.hours()[0].label, '00:00'); assert.equal(calendar.slots().length, 48); assert.equal(calendar.outsideWeekEvents().length, 0);
    assert.equal(calendar.weekDays().find(day => day.key === base.startDate).timedEvents.length, 3);
    assert.deepEqual(f.preferences.weekRange(), {startHour: 8, endHour: 19}); calendar.toggleWeekHours();
    f.preferences.weekRange.set({startHour: 6, endHour: 22}); assert.equal(calendar.hours()[0].label, '06:00'); assert.equal(calendar.weekEndLabel(), '22:00'); assert.equal(calendar.outsideWeekEvents().length, 0);
    assert.deepEqual(f.store.tasks().map(task => task.startTime), ['06:00', '07:00', '20:00']);
  } finally {f.close();}
});

test('範圍時間表的拖放、鍵盤邊界及現在時間線以設定起點定位', () => {
  const f = calendarController();
  try {
    const {calendar} = f, element = {getBoundingClientRect: () => ({top: 100})};
    assert.equal(calendar.timePosition(base.startDate, element, 100 + calendar.hourHeight() / 2).minute, 510);
    assert.equal(calendar.timePosition(base.startDate, element, -100).minute, 480);
    assert.equal(calendar.timePosition(base.startDate, element, 10000).minute, 1125);
    let focused = ''; calendar.weekScroller = () => ({nativeElement: {querySelector(selector) {return {focus() {focused = selector;}};}}});
    calendar.slotKeydown({key: 'ArrowUp', preventDefault() {}}, 0, 480); assert.match(focused, /data-minute="480"/);
    calendar.slotKeydown({key: 'ArrowDown', preventDefault() {}}, 6, 1110); assert.match(focused, /data-minute="1110"/);
    calendar.now.set(new Date(2026, 9, 9, 7)); assert.equal(calendar.nowInRange(), false);
    calendar.now.set(new Date(2026, 9, 9, 8)); assert.equal(calendar.nowInRange(), true); assert.equal(calendar.nowPosition(), 0);
    calendar.now.set(new Date(2026, 9, 9, 19)); assert.equal(calendar.nowInRange(), false);
  } finally {f.close();}
});

test('窄版月曆使用開始時間，只有截止時用截止時間，完整時間標籤保留', () => {
  const due = {...base, id: 'due', startDate: '', startTime: '', dueTime: '17:30'}, external = googleEntry('meeting', {dateTime: '2026-10-09T13:00:00'}, {dateTime: '2026-10-09T14:00:00'});
  const f = calendarController([base, due], [external]);
  try {
    assert.equal(f.calendar.compactMonthScheduleLabel(base, base.startDate), '09:00'); assert.equal(f.calendar.monthScheduleLabel(base, base.startDate), '09:00 – 10:00');
    assert.equal(f.calendar.compactMonthScheduleLabel(due, due.dueDate), '17:30'); assert.match(f.calendar.monthScheduleLabel(due, due.dueDate), /17:30 截止/);
    assert.equal(f.calendar.compactMonthScheduleLabel(external.task, base.startDate), '13:00');
    assert.match(f.calendar.taskTitle(base), /09:00.*10:00/);
  } finally {f.close();}
});

test('本機週範圍讀取拒絕損壞及不合法時間，保存失敗保留當前可用範圍', () => {
  const f = calendarController();
  try {
    for (const value of [null, {startHour: 19, endHour: 8}, {startHour: -1, endHour: 19}, {startHour: 8, endHour: 25}, {startHour: '8', endHour: 19}, {startHour: 8.5, endHour: 19}]) assert.deepEqual(readWeekRange(value), {startHour: 8, endHour: 19});
    assert.equal(UiPreferences.prototype.setWeekRange.call(f.preferences, {startHour: 5, endHour: 20}), true);
    assert.deepEqual(loadWeekRange(), {startHour: 5, endHour: 20});
    f.values.set(CALENDAR_DISPLAY_KEY, 'broken'); assert.deepEqual(loadWeekRange(), {startHour: 8, endHour: 19});
    const originalSet = localStorage.setItem; localStorage.setItem = () => {throw new Error('quota');};
    try {assert.equal(UiPreferences.prototype.setWeekRange.call(f.preferences, {startHour: 9, endHour: 18}), true); assert.deepEqual(f.preferences.weekRange(), {startHour: 9, endHour: 18}); assert.match(f.preferences.weekRangeWarning(), /無法保存/);}
    finally {localStorage.setItem = originalSet;}
  } finally {f.close();}
});

test('月週單一寬度切換共用本機選擇，舊設定保留寬版，保存時不覆蓋週時間範圍', () => {
  const f = calendarController();
  try {
    assert.equal(loadCalendarWidth(), 'wide');
    f.values.set(CALENDAR_DISPLAY_KEY, JSON.stringify({version: 1, range: {startHour: 6, endHour: 22}}));
    assert.equal(loadCalendarWidth(), 'wide'); assert.deepEqual(loadWeekRange(), {startHour: 6, endHour: 22});
    f.preferences.weekRange.set(loadWeekRange());
    f.calendar.draggedTaskId.set(base.id); f.calendar.dropPosition.set({kind: 'month', day: base.startDate});
    f.calendar.toggleWidth();
    assert.equal(f.calendar.draggedTaskId(), ''); assert.equal(f.calendar.dropPosition(), null);
    assert.equal(f.calendar.widthMode(), 'standard'); assert.equal(loadCalendarWidth(), 'standard');
    f.calendar.mode.set('week'); assert.equal(f.calendar.widthMode(), 'standard');
    f.calendar.toggleWidth(); assert.equal(loadCalendarWidth(), 'wide');
    f.calendar.toggleWidth(); assert.equal(loadCalendarWidth(), 'standard');
    UiPreferences.prototype.setWeekRange.call(f.preferences, {startHour: 7, endHour: 21});
    assert.equal(loadCalendarWidth(), 'standard'); assert.deepEqual(loadWeekRange(), {startHour: 7, endHour: 21});
    const originalSet = localStorage.setItem; localStorage.setItem = () => {throw new Error('quota');};
    try {f.calendar.toggleWidth(); assert.equal(f.calendar.widthMode(), 'wide'); assert.match(f.preferences.calendarWidthWarning(), /無法保存/);}
    finally {localStorage.setItem = originalSet;}
    assert.equal(loadCalendarWidth(), 'standard');
    for (const value of ['broken', JSON.stringify({version: 1, width: 'invalid'}), JSON.stringify({version: 2, width: 'standard'})]) {
      f.values.set(CALENDAR_DISPLAY_KEY, value); assert.equal(loadCalendarWidth(), 'wide');
    }
  } finally {f.close();}
});

test('月曆空白與日期開啟該週，任務、Google 活動、＋及展開按鈕不會連帶切換', () => {
  const external = googleEntry('google-event', {dateTime: '2026-10-09T09:00:00'}, {dateTime: '2026-10-09T10:00:00'}), f = calendarController([base], [external]);
  const dom = new JSDOM('<section><div class="heading"><button id="date">9</button><span id="label">今天</span><button id="add"><svg><path></path></svg></button></div><div id="blank"><button id="task"><span>任務</span></button><button id="external"><span>Google 活動</span></button><button id="more"><span>更多</span></button></div></section>');
  const document = dom.window.document, selected = [], edits = [], reads = [], creates = [], date = '2026-10-09';
  try {
    f.calendar.weekRequested.subscribe(value => selected.push(value)); f.calendar.editTask.subscribe(value => edits.push(value.id)); f.calendar.readExternal.subscribe(value => reads.push(value.task.id)); f.calendar.createTask.subscribe(value => creates.push(value));
    document.querySelector('section').addEventListener('click', event => f.calendar.openWeekFromDay(event, date));
    document.querySelector('#date').addEventListener('click', () => f.calendar.openWeek(date));
    document.querySelector('#add').addEventListener('click', () => f.calendar.createAt(date));
    document.querySelector('#task').addEventListener('click', () => f.calendar.openEntry(base));
    document.querySelector('#external').addEventListener('click', () => f.calendar.openEntry(external.task));
    document.querySelector('#more').addEventListener('click', () => f.calendar.toggleDay(date));
    const click = (selector, options = {}) => document.querySelector(selector).dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true, cancelable: true, ...options}));
    click('#task span'); click('#external span'); click('#add path'); click('#more span');
    assert.deepEqual(edits, [base.id]); assert.deepEqual(reads, [external.task.id]); assert.deepEqual(creates, [{date}]); assert.equal(f.calendar.dayExpanded(date), true); assert.deepEqual(selected, []);
    click('#blank'); click('#label'); click('#date'); assert.deepEqual(selected, [date, date, date]);
    click('#blank', {button: 2}); assert.equal(selected.length, 3);
    const prevented = new dom.window.MouseEvent('click', {bubbles: true, cancelable: true}); prevented.preventDefault(); document.querySelector('#blank').dispatchEvent(prevented); assert.equal(selected.length, 3);
  } finally {dom.window.close(); f.close();}
});
test('月視圖各列對應完整一週，換月份清除懸停；拖曳中及結束後避免誤開週視圖', () => {
  const f = calendarController(); let switches = 0;
  try {
    f.flush();
    const days = f.calendar.days();
    for (let index = 0; index < days.length / 7; index++) {
      const row = days.filter(day => day.weekIndex === index); assert.equal(row.length, 7); assert.equal(row[0].date.getDay(), 0); assert.equal(row[6].date.getDay(), 6);
    }
    f.calendar.hoveredMonthWeek.set(1); f.calendar.navigate(1); f.flush(); assert.equal(f.calendar.hoveredMonthWeek(), null);
    f.calendar.weekRequested.subscribe(() => switches++);
    f.calendar.startDrag(dragEvent(), base, {kind: 'month', day: base.startDate}); f.calendar.openWeek(base.startDate); assert.equal(switches, 0);
    f.calendar.endDrag(); f.calendar.openWeek(base.startDate); assert.equal(switches, 0);
    f.calendar.ignoreClickUntil = 0; f.calendar.mailDragging = signal(true); f.calendar.openWeek(base.startDate); assert.equal(switches, 0);
    f.calendar.mailDragging.set(false); f.calendar.savingMove.set(true); f.calendar.openWeek(base.startDate); assert.equal(switches, 0);
    f.calendar.savingMove.set(false); f.calendar.openWeek(base.startDate); assert.equal(switches, 1);
    f.calendar.mode.set('week'); f.calendar.openWeek(base.startDate); assert.equal(switches, 1);
  } finally {f.close();}
});

test('月／週視圖相同內容也保留 Google 與 Orbit 各自的卡片，切換顯示來源不隱藏另一邊', () => {
  const source = {id: 'source', accountId: 'account', calendarId: 'calendar', name: '月曆', color: '#759acb', visible: true, workspaceIds: ['workspace']};
  const board = {id: 'workspace', projects: [], categories: [], statuses: COLUMNS};
  const body = createEventBody(base, board, {mode: 'custom', minutes: 15, startDate: base.startDate, startTime: base.startTime, endDate: base.dueDate, endTime: base.dueTime}, '0123456789abcdef');
  const entry = externalEvent(source, body), copy = copyEventTask(entry, board);
  const {calendar, close} = calendarController([copy], [entry]);
  try {
    assert.equal(calendar.combinedTasks().length, 2); assert.equal(calendar.isExternal(copy), false);
    assert.equal('calendarOrigin' in copy, false);
    calendar.mode.set('week'); assert.equal(calendar.combinedTasks().length, 2);
    calendar.showOrbit.set(false); assert.deepEqual(calendar.combinedTasks().map(task => task.id), [entry.task.id]);
    calendar.showOrbit.set(true); calendar.showGoogle.set(false); assert.deepEqual(calendar.combinedTasks().map(task => task.id), [copy.id]);
    calendar.showGoogle.set(true); calendar.deadlineFiltered.set(true); assert.deepEqual(calendar.combinedTasks().map(task => task.id), [copy.id]);
  } finally { close(); }
});
test('Google 或 Orbit 改期後兩張卡片各自出現在正確時段，快取內容不合併', async () => {
  const source = {id: 'source', accountId: 'account', calendarId: 'calendar', name: '月曆', color: '#759acb', visible: true, workspaceIds: ['workspace']};
  const board = {id: 'workspace', projects: [], categories: [], statuses: COLUMNS};
  const body = createEventBody(base, board, {mode: 'custom', minutes: 15, startDate: base.startDate, startTime: base.startTime, endDate: base.dueDate, endTime: base.dueTime}, '0123456789abcdef');
  const entry = externalEvent(source, body), copy = copyEventTask(entry, board);
  const {calendar, store, google, close} = calendarController([copy], [entry]);
  try {
    await store.saveTask({...copy, startTime: '13:00', dueTime: '14:00'});
    assert.equal(calendar.combinedTasks().length, 2);
    const day = calendar.days().find(item => item.key === base.startDate);
    assert.equal(day.timedEvents.find(item => item.task.id === copy.id).startMinute, 780);
    assert.equal(day.timedEvents.find(item => item.task.id === entry.task.id).startMinute, 540);
    await store.saveTask(copy); google.events.set([structuredClone(entry)]);
    assert.equal(calendar.combinedTasks().length, 2);
    google.events.set([entry]); assert.equal(calendar.combinedTasks().length, 2);
  } finally { close(); }
});
test('舊備份的來源欄位僅維持相容，重新載入後仍顯示兩張獨立卡片', () => {
  const entry = googleEntry('legacy-event', {dateTime: '2026-10-09T09:00:00'}, {dateTime: '2026-10-09T10:00:00'}, base.title);
  const legacy = {...base, calendarOrigin: {accountId: 'account', calendarId: 'calendar', eventId: 'legacy-event', extra: '', metadata: {project: '', category: '', status: '待辦', priority: 'medium'}}};
  const {calendar, store, close} = calendarController([legacy], [entry]);
  try {
    assert.equal(store.tasks().length, 1); assert.equal(store.tasks()[0].calendarOrigin.eventId, 'legacy-event');
    assert.equal(calendar.combinedTasks().length, 2); assert.equal(calendar.isExternal(store.tasks()[0]), false);
    calendar.mode.set('week'); assert.equal(calendar.combinedTasks().length, 2);
  } finally { close(); }
});

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

test('月曆接續本機全部展開偏好，切週及回月保持，單日收合會回報關閉全部展開', async () => {
  const f = calendarController(Array.from({length: 6}, (_, index) => ({...base, id: 'saved-' + index})));
  try {
    const calendar = f.calendar, changes = [];
    calendar.savedExpandAll = signal(true);
    calendar.expandAllChange.subscribe(value => {changes.push(value); calendar.savedExpandAll.set(value);});
    const day = () => calendar.days().find(item => item.key === '2026-10-09');
    assert.equal(day().visibleTasks.length, 6);
    calendar.mode.set('week'); calendar.mode.set('month'); assert.equal(day().visibleTasks.length, 6);
    calendar.toggleDay('2026-10-09'); assert.equal(day().visibleTasks.length, 4); assert.deepEqual(changes, [false]);
    calendar.toggleAllDays(); assert.deepEqual(changes, [false, true]);
    calendar.savedExpandAll.set(false); assert.equal(calendar.expandAll(), false);
    assert.equal(JSON.stringify(await f.store.backupForExport('full')).includes('calendarExpandAll'), false);
  } finally {f.close();}
});

function assertEditedTask(actual, expected) {
  const {updatedAt, editSource, ...content} = actual;
  const {editSource: previousSource, ...expectedContent} = expected;
  assert.equal(typeof updatedAt, 'string');
  assert.equal(new Date(updatedAt).toISOString(), updatedAt);
  assert.equal(typeof editSource.id, 'string'); assert.equal(typeof editSource.name, 'string');
  assert.deepEqual(content, expectedContent);
}

test('月曆拖曳保存本機任務並保留其他欄位，取消拖曳不寫入且不誤開編輯', async () => {
  const {calendar, store, close} = calendarController();
  let edits = 0;
  calendar.editTask.subscribe(() => edits++);
  try {
    calendar.startDrag(dragEvent(), base, {kind: 'month', day: base.startDate});
    await calendar.drop(dragEvent(), {kind: 'month', day: '2026-10-12'});
    assertEditedTask(store.tasks()[0], {...base, startDate: '2026-10-12', dueDate: '2026-10-12'});
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
    const target = calendar.timePosition('2026-10-10', element, calendar.hourHeight() * 3.25);
    assert.equal(target.minute, 660);
    await calendar.drop(dragEvent(), target);
    assertEditedTask(store.tasks()[0], {...base, startDate: '2026-10-10', startTime: '11:00', dueDate: '2026-10-10', dueTime: '12:00'});
    calendar.startDrag(dragEvent(), store.tasks()[0], {kind: 'time', day: '2026-10-10', minute: 660});
    await calendar.drop(dragEvent(), {kind: 'all-day', day: '2026-10-11'});
    assertEditedTask(store.tasks()[0], {...base, startDate: '2026-10-11', startTime: '', dueDate: '2026-10-11', dueTime: ''});
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
    assertEditedTask(store.tasks()[0], {...empty, dueDate: '2026-10-10', dueTime: '10:00'});
    calendar.startDrag(dragEvent(), store.tasks()[0], {kind: 'time', day: '2026-10-10', minute: 600});
    await calendar.drop(dragEvent(), {kind: 'time', day: '2026-02-30', minute: 600});
    assert.equal(store.tasks()[0].dueDate, '2026-10-10'); assert.match(calendar.moveError(), /不合法/);
  } finally { close(); }
});

test('檔案在月曆日期與週時間建立任務，Orbit 活動只關聯，Google 活動阻擋且不冒泡新增', async () => {
  const external = googleEntry('external', {date: '2026-10-09'}, {date: '2026-10-10'}), f = calendarController([base], [external]), drops = [];
  try {
    f.calendar.documentDragging = signal(true); f.calendar.documentDrop.subscribe(entry => drops.push(entry));
    const event = () => ({...dragEvent(), dataTransfer: {types: ['application/x-orbit-document'], dropEffect: 'none'}});
    const date = event(); f.calendar.dragOver(date, {kind: 'month', day: '2026-10-09'}); assert.equal(date.prevented(), true); assert.equal(date.stopped(), true); assert.equal(date.dataTransfer.dropEffect, 'copy'); await f.calendar.drop(date, {kind: 'month', day: '2026-10-09'}); assert.deepEqual(drops[0].position, {kind: 'month', day: '2026-10-09'});
    const timed = event(); await f.calendar.drop(timed, {kind: 'time', day: '2026-10-10', minute: 615}); assert.equal(drops[1].position.minute, 615);
    const link = event(); f.calendar.documentEntryOver(link, base); assert.equal(f.calendar.documentLinkTaskId(), base.id); assert.equal(f.calendar.dropPosition(), null); f.calendar.documentEntryDrop(link, base); assert.equal(drops[2].taskId, base.id); assert.equal(drops[2].position, undefined);
    const blocked = event(); f.calendar.documentEntryOver(blocked, external.task); assert.equal(f.calendar.documentBlocked(), true); assert.equal(blocked.dataTransfer.dropEffect, 'none'); assert.equal(blocked.stopped(), true); f.calendar.documentEntryDrop(blocked, external.task); assert.equal(drops.length, 3); assert.equal(blocked.stopped(), true);
    assert.deepEqual(f.store.tasks(), [base]);
  } finally {f.close();}
});

test('郵件可加入月／週既有 Orbit 任務，Google 活動阻擋，空白時段仍建立排程任務', async () => {
  const external = googleEntry('external-mail', {date: '2026-10-09'}, {date: '2026-10-10'}), f = calendarController([base], [external]), drops = [];
  try {
    f.calendar.mailDragging = signal(true); f.calendar.mailDrop.subscribe(entry => drops.push(entry));
    const event = () => ({...dragEvent(), dataTransfer: {types: ['application/x-iih-orbit-mail'], dropEffect: 'none'}});
    const link = event(); f.calendar.documentEntryOver(link, base); assert.equal(f.calendar.documentLinkTaskId(), base.id); f.calendar.documentEntryDrop(link, base); assert.equal(drops[0].taskId, base.id); assert.equal(drops[0].position, undefined);
    const blocked = event(); f.calendar.documentEntryOver(blocked, external.task); assert.equal(blocked.dataTransfer.dropEffect, 'none'); f.calendar.documentEntryDrop(blocked, external.task); assert.equal(drops.length, 1); assert.equal(blocked.stopped(), true);
    const timed = event(); await f.calendar.drop(timed, {kind: 'time', day: '2026-10-10', minute: 615}); assert.equal(drops[1].position.minute, 615); assert.equal(drops[1].taskId, undefined);
  } finally {f.close();}
});

test('月曆與週視圖的 Orbit 任務可拖到另一任務建立雙向連結，不改日期、狀態或開啟編輯', async () => {
  for (const mode of ['month', 'week']) for (const kind of ['month', 'time', 'all-day']) {
    if (mode === 'month' && kind !== 'month' || mode === 'week' && kind === 'month') continue;
    const target = {...base, id: 'target', title: '另一任務', startDate: '2026-10-10', dueDate: '2026-10-10', status: 'progress'}, f = calendarController([base, target]);
    try {
      const {calendar, store} = f; calendar.mode.set(mode); f.flush(); let opened = 0; calendar.editTask.subscribe(() => opened++);
      const fields = () => store.tasks().map(task => [task.id, task.title, task.status, task.startDate, task.startTime, task.dueDate, task.dueTime]), before = fields();
      calendar.startDrag(dragEvent(), base, {kind, day: base.startDate, ...(kind === 'time' ? {minute: 540} : {})});
      const over = dragEvent(); calendar.documentEntryOver(over, target); assert.equal(over.stopped(), true); assert.equal(over.dataTransfer.dropEffect, 'link'); assert.equal(calendar.dropPosition(), null); assert.equal(calendar.taskLinkTarget().original.id, target.id);
      await calendar.documentEntryDrop(dragEvent(), target); assert.deepEqual(store.relatedTaskIds(base.id), [target.id]); assert.deepEqual(store.relatedTaskIds(target.id), [base.id]); assert.deepEqual(fields(), before); assert.equal(calendar.draggedTaskId(), ''); assert.equal(calendar.taskLinkTarget(), null);
      calendar.openEntry(target); assert.equal(opened, 0); await store.undo(); assert.deepEqual(store.relatedTaskIds(base.id), []); await store.redo(); assert.deepEqual(store.relatedTaskIds(base.id), [target.id]);
    } finally {f.close();}
  }
});

test('Orbit 任務拖放拒絕自己、Google 活動及偽造 payload，已連結不增加事件', async () => {
  const target = {...base, id: 'target', title: '另一任務'}, external = googleEntry('google-target', {dateTime: '2026-10-09T13:00:00'}, {dateTime: '2026-10-09T14:00:00'}), f = calendarController([base, target], [external]);
  try {
    const {calendar, store} = f;
    for (const task of [base, external.task]) {calendar.startDrag(dragEvent(), store.tasks()[0], {kind: 'month', day: base.startDate}); const event = dragEvent(); calendar.documentEntryOver(event, task); assert.equal(event.dataTransfer.dropEffect, 'none'); await calendar.documentEntryDrop(event, task); assert.deepEqual(store.relatedTaskIds(base.id), []);}
    calendar.startDrag(dragEvent(), store.tasks()[0], {kind: 'month', day: base.startDate}); const forged = dragEvent(); forged.dataTransfer.setData(TASK_LINK_DRAG_TYPE, JSON.stringify({...JSON.parse(forged.dataTransfer.getData(TASK_LINK_DRAG_TYPE)), token: 'forged'})); await calendar.documentEntryDrop(forged, target); assert.deepEqual(store.relatedTaskIds(base.id), []);
    calendar.startDrag(dragEvent(), store.tasks()[0], {kind: 'month', day: base.startDate}); await calendar.documentEntryDrop(dragEvent(), target); const count = store.state().taskLinks.length;
    calendar.startDrag(dragEvent(), store.tasks()[0], {kind: 'month', day: base.startDate}); await calendar.documentEntryDrop(dragEvent(), store.tasks()[1]); assert.equal(store.state().taskLinks.length, count); assert.match(calendar.moveNotice(), /已經連結/);
  } finally {f.close();}
});

test('拖曳目標或來源更新後不建立過期連結，離開任務後空白日期仍可改期', async () => {
  const target = {...base, id: 'target', title: '另一任務'}, f = calendarController([base, target]);
  try {
    const {calendar, store} = f;
    calendar.startDrag(dragEvent(), base, {kind: 'month', day: base.startDate}); calendar.documentEntryOver(dragEvent(), target);
    await store.saveTask({...target, title: '更新後的目標'}); await calendar.documentEntryDrop(dragEvent(), target); assert.deepEqual(store.relatedTaskIds(base.id), []); assert.match(calendar.moveError(), /已更新/);
    calendar.startDrag(dragEvent(), store.tasks()[0], {kind: 'month', day: base.startDate}); calendar.documentEntryOver(dragEvent(), store.tasks()[1]);
    await store.saveTask({...store.tasks()[0], title: '更新後的來源'}); await calendar.documentEntryDrop(dragEvent(), store.tasks()[1]); assert.deepEqual(store.relatedTaskIds(base.id), []);
    calendar.startDrag(dragEvent(), store.tasks()[0], {kind: 'month', day: base.startDate}); calendar.documentEntryOver(dragEvent(), store.tasks()[1]); calendar.dragOver(dragEvent(), {kind: 'month', day: '2026-10-12'}); assert.equal(calendar.taskLinkTarget(), null); await calendar.drop(dragEvent(), {kind: 'month', day: '2026-10-12'}); assert.equal(store.tasks()[0].startDate, '2026-10-12'); assert.deepEqual(store.relatedTaskIds(base.id), []);
  } finally {f.close();}
});

test('切換月週／日期與取消拖曳會清除任務連結落點，舊拖曳不能跨脈絡寫入', async () => {
  const target = {...base, id: 'target', title: '另一任務'}, f = calendarController([base, target]);
  try {
    const {calendar, store} = f; calendar.busy = signal(false); f.flush();
    for (const change of [() => calendar.mode.set('week'), () => calendar.anchor.set(new Date(2026, 10, 1)), () => calendar.busy.set(true), () => calendar.endDrag()]) {
      calendar.busy.set(false); f.flush(); calendar.startDrag(dragEvent(), store.tasks()[0], {kind: calendar.mode() === 'month' ? 'month' : 'time', day: base.startDate}); calendar.documentEntryOver(dragEvent(), target); change(); f.flush(); assert.equal(calendar.taskLinkTarget(), null); await calendar.documentEntryDrop(dragEvent(), target); assert.deepEqual(store.relatedTaskIds(base.id), []);
    }
  } finally {f.close();}
});
