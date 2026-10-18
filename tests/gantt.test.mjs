import '@angular/compiler';
import {createEnvironmentInjector, runInInjectionContext, signal} from '@angular/core';
import assert from 'node:assert/strict';
import {after, test} from 'node:test';
import {createRequire} from 'node:module';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {JSDOM} from 'jsdom';
import {ganttDropPosition} from '../src/app/gantt-data.ts';
import {GMAIL_MIME} from '../src/app/gmail-data.ts';
import {DOCUMENT_DRAG_TYPE} from '../src/app/document-data.ts';
import {editGanttSchedule} from '../src/app/gantt-edit.ts';
import {civilDay, civilKey, ganttAxis, ganttDayAtPosition, ganttParts, ganttTaskInRange, ganttPosition, ganttRows, ganttSchedule, ganttSpan, ganttZoomScroll, moveGanttDate, readGanttRange, readGanttZoom, virtualRange} from '../src/app/gantt-data.ts';

const task = (id, patch = {}) => ({id, title: id, description: '', categoryId: '', projectId: '', status: 'working', priority: 'medium', startDate: '', startTime: '', dueDate: '', dueTime: '', subtasks: [], ...patch});
const require = createRequire(import.meta.url), {build} = createRequire(require.resolve('@angular/build/package.json'))('esbuild');
await mkdir('.angular', {recursive: true});
const directory = await mkdtemp(resolve('.angular/gantt-test-')), output = resolve(directory, 'gantt.mjs');
await build({stdin: {contents: "export {Gantt} from './src/app/gantt.ts'; export {UiPreferences} from './src/app/ui-preferences.ts';", resolveDir: process.cwd()}, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: output, tsconfig: 'tsconfig.json'});
const {Gantt, UiPreferences} = await import(pathToFileURL(output).href);
after(() => rm(directory, {recursive: true, force: true}));

test('甘特移動及端點調整保留時刻與單一日期，處理跨年閏日並拒絕反向或超界', () => {
  const source = task('one', {startDate: '2028-02-28', startTime: '09:15', dueDate: '2028-03-01', dueTime: '17:45'}), original = structuredClone(source);
  const moved = editGanttSchedule(source, 'move', 1); assert.equal(moved.startDate, '2028-02-29'); assert.equal(moved.dueDate, '2028-03-02'); assert.equal(moved.startTime, '09:15'); assert.equal(moved.dueTime, '17:45'); assert.deepEqual(source, original);
  const resized = editGanttSchedule(source, 'end', 2); assert.equal(resized.startDate, source.startDate); assert.equal(resized.dueDate, '2028-03-03');
  assert.equal(editGanttSchedule({...source, startDate: '2027-12-31', dueDate: '2028-01-01'}, 'move', 1).startDate, '2028-01-01');
  const single = editGanttSchedule(task('single', {dueDate: '2026-10-18', dueTime: '09:00'}), 'move', -1); assert.equal(single.startDate, ''); assert.equal(single.startTime, ''); assert.equal(single.dueDate, '2026-10-17'); assert.equal(single.dueTime, '09:00');
  assert.throws(() => editGanttSchedule(source, 'start', 4)); assert.throws(() => editGanttSchedule(source, 'end', -4));
  for (const days of [NaN, Infinity, .5]) assert.throws(() => editGanttSchedule(source, 'move', days));
  assert.throws(() => editGanttSchedule(task('min', {startDate: '1900-01-01'}), 'move', -1)); assert.throws(() => editGanttSchedule(task('max', {dueDate: '9999-12-31'}), 'move', 1));
  assert.throws(() => editGanttSchedule(task('unset'), 'move', 1));
});

test('甘特按日移動在夏令時間切換時保留牆鐘時間，不以二十四小時毫秒平移', () => {
  const source = new URL('../src/app/gantt-edit.ts', import.meta.url).href;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `import {editGanttSchedule} from ${JSON.stringify(source)}; console.log(JSON.stringify(editGanttSchedule({id:'one',startDate:'2026-03-07',startTime:'09:00',dueDate:'2026-03-08',dueTime:'17:00'},'move',1)));`], {env: {...process.env, TZ: 'America/New_York'}, encoding: 'utf8'}));
  assert.equal(result.startDate, '2026-03-08'); assert.equal(result.startTime, '09:00'); assert.equal(result.dueDate, '2026-03-09'); assert.equal(result.dueTime, '17:00');
});

test('甘特指標預覽只在放開後提交一次，取消、拖後點擊、失效脈絡及唯讀不改時程', () => {
  const dom = new JSDOM('<div id="viewport"><button>task</button></div>'), injector = createEnvironmentInjector([{provide: UiPreferences, useValue: {scale: () => 1}}]);
  globalThis.ngServerMode = true; let component; try {component = runInInjectionContext(injector, () => new Gantt());} finally {delete globalThis.ngServerMode;}
  try {
    const source = task('one', {startDate: '2026-10-18', dueDate: '2026-10-20'}), viewport = dom.window.document.getElementById('viewport'), button = viewport.querySelector('button'), changes = [], edits = [];
    component.tasks = signal([source]); component.selectedDate = signal('2026-10-18'); component.scale = signal('week'); component.resetKey = signal('context'); component.viewport = () => ({nativeElement: viewport});
    viewport.getBoundingClientRect = () => ({left: 0, right: 900}); viewport.scrollLeft = ganttPosition(civilDay('2026-10-18'), component.axis(), component.columnWidth());
    component.scheduleChange.subscribe(value => changes.push(value)); component.editTask.subscribe(value => edits.push(value));
    const event = (x, patch = {}) => ({button: 0, pointerId: 1, isPrimary: true, clientX: x, clientY: 100, currentTarget: button, preventDefault() {}, stopPropagation() {}, ...patch}), x = component.labelWidth() + 70;
    component.beginSchedule(event(x), source, 'move'); component.moveSchedule(event(x + 28)); assert.equal(changes.length, 0); assert.equal(component.schedulePreview().startDate, '2026-10-19');
    component.finishSchedule(event(x + 28)); component.openBar(source); assert.equal(edits.length, 0); assert.equal(changes.length, 1); assert.equal(changes[0].task.dueDate, '2026-10-21'); assert.deepEqual(source.startDate, '2026-10-18');
    component.beginSchedule(event(x), source, 'end'); component.moveSchedule(event(x + 56)); component.cancelScheduleKey(event(x)); component.finishSchedule(event(x + 56)); component.openBar(source); assert.equal(changes.length, 1); assert.equal(edits.length, 0);
    component.beginSchedule(event(x), source, 'move'); component.moveSchedule(event(x + 28)); component.resetKey.set('different'); component.finishSchedule(event(x + 28)); assert.equal(changes.length, 1);
    component.busy = signal(true); component.beginSchedule(event(x), source, 'move'); assert.equal(component.schedulePreview(), null);
    component.busy.set(false); component.lockedTaskIds = signal(['one']); component.beginSchedule(event(x), source, 'move'); component.moveSchedule(event(x + 28)); assert.equal(changes.length, 1); assert.equal(component.schedulePreview(), null);
    component.lockedTaskIds.set([]); component.resetKey.set('context'); component.order = signal('start');
    component.beginSchedule(event(x), source, 'move'); component.moveSchedule(event(x + 28)); component.order.set('end'); component.finishSchedule(event(x + 28)); assert.equal(changes.length, 1);
    component.beginSchedule(event(x), source, 'move'); component.moveSchedule(event(x + 28)); component.documentDragging = signal(true); component.finishSchedule(event(x + 28)); assert.equal(changes.length, 1);
  } finally {injector.destroy(); dom.window.close();}
});

test('甘特空白落點以實際日期定位，日模式以十五分鐘建立，週月依日期且不越過範圍', () => {
  for (const scale of ['day', 'week', 'month']) {
    const axis = ganttAxis('2028-02-29', scale, {start: '2028-02-28', end: '2028-03-02'}), width = 288;
    const position = ganttPosition(civilDay('2028-02-29') + (9 * 60 + 37) / 1440, axis, width);
    assert.deepEqual(ganttDropPosition(position, axis, width), scale === 'day' ? {kind: 'time', day: '2028-02-29', minute: 570} : {kind: 'all-day', day: '2028-02-29'});
    const last = ganttDropPosition(axis.units * width - .001, axis, width);
    assert.equal(last.day, '2028-03-02'); if (scale === 'day') assert.equal(last.minute, 1425);
    for (const invalid of [-1, NaN, Infinity, axis.units * width]) assert.equal(ganttDropPosition(invalid, axis, width), undefined);
  }
});

test('甘特來源拖放區分任務與空白日期，保留專案、清理取消提示並拒絕外部或過期拖曳', () => {
  const dom = new JSDOM('<div id="viewport"><div class="gantt-body"><div class="task-label" data-link-task-id="one"><button>任務</button></div><div class="task-timeline"></div></div></div>');
  const originals = {Element: globalThis.Element, Node: globalThis.Node};
  globalThis.Element = dom.window.Element; globalThis.Node = dom.window.Node;
  const injector = createEnvironmentInjector([{provide: UiPreferences, useValue: {scale: () => 1}}]);
  globalThis.ngServerMode = true; let component;
  try {component = runInInjectionContext(injector, () => new Gantt());} finally {delete globalThis.ngServerMode;}
  try {
    component.tasks = signal([task('one', {projectId: 'p', startDate: '2026-10-16', dueDate: '2026-10-17'})]);
    component.projects = signal([{id: 'p', name: '研究'}]); component.selectedDate = signal('2026-10-16');
    component.mailDragging = signal(true); component.documentDragging = signal(false);
    const body = dom.window.document.querySelector('.gantt-body'), viewport = dom.window.document.querySelector('#viewport'), blank = dom.window.document.querySelector('.task-timeline'), button = dom.window.document.querySelector('button');
    body.getBoundingClientRect = () => ({left: -3500, top: 100}); viewport.getBoundingClientRect = () => ({left: 0, top: 36});
    component.viewport = () => ({nativeElement: viewport});
    const drops = [], files = [];
    component.mailDrop.subscribe(value => drops.push(value)); component.documentDrop.subscribe(value => files.push(value));
    const make = (target, x, y = 170, mime = GMAIL_MIME) => ({target, currentTarget: body, clientX: x, clientY: y, dataTransfer: {types: [mime]}, preventDefault() {this.prevented = true;}, stopPropagation() {}});
    const link = make(button, 20); component.dropSource(link);
    assert.equal(drops[0].taskId, 'one'); assert.equal(drops[0].position, undefined); assert.equal(component.sourceTarget(), null);
    const x = ganttPosition(civilDay('2026-10-16') + 9.5 / 24, component.axis(), component.columnWidth()) + component.labelWidth() - 3500;
    const create = make(blank, x); component.dropSource(create);
    assert.deepEqual(drops[1].position, {kind: 'time', day: '2026-10-16', minute: 570}); assert.equal(drops[1].projectId, 'p');
    const group = make(blank, x, 120); component.dropSource(group); assert.equal(drops[2].projectId, 'p');
    const empty = make(blank, x, 270); component.dropSource(empty); assert.equal(drops[3].projectId, undefined);
    assert.equal(component.sourceOver(create), true); component.sourceLeave({...create, relatedTarget: null}); assert.equal(component.sourceTarget(), null);
    component.sourceOver(create); component.mailDragging.set(false); assert.equal(component.sourceTarget(), null); component.dropSource(create); assert.equal(drops.length, 4);
    component.documentDragging.set(true); component.dropSource(make(button, 20, 170, DOCUMENT_DRAG_TYPE)); assert.equal(files[0].taskId, 'one');
    component.dropSource(make(blank, x, 170, 'text/plain')); assert.equal(files.length, 1);
    component.dropSource(make(button, 20, 120, DOCUMENT_DRAG_TYPE)); assert.equal(files.length, 1);
  } finally {injector.destroy(); dom.window.close(); for (const [key, value] of Object.entries(originals)) {if (value === undefined) delete globalThis[key]; else globalThis[key] = value;}}
});

test('日／週軸含首尾日、跨月跨年及閏日，起訖同日仍有一天寬度', () => {
  for (const scale of ['day', 'week']) {
    const axis = ganttAxis('2028-02-29', scale), source = task('range', {startDate: '2028-02-28', dueDate: '2028-03-01'}), original = structuredClone(source);
    const span = ganttSpan(source, axis, 70);
    assert.equal(axis.count, scale === 'day' ? 42 : 12);
    assert.equal(span.width, scale === 'day' ? 210 : 30);
    assert.equal(span.marker, false); assert.equal(span.outside, null); assert.deepEqual(source, original);
    const one = ganttSpan({...source, dueDate: source.startDate}, axis, 70);
    assert.ok(Math.abs(one.width - (scale === 'day' ? 70 : 10)) < 1e-10);
  }
  const year = ganttAxis('2027-01-01', 'day');
  assert.ok(year.label.includes('2026-12')); assert.ok(year.label.includes('2027-01'));
  assert.equal(civilKey(civilDay('2028-02-29') + 1), '2028-03-01');
});

test('月軸依真實月份長度換算，長區間裁切但不改原始時程', () => {
  const axis = ganttAxis('2028-03-15', 'month');
  assert.equal(axis.column(0).end - axis.column(0).start, 29);
  assert.equal(ganttPosition(civilDay('2028-03-01'), axis, 116), 116);
  assert.equal(ganttPosition(civilDay('2028-03-16') + 0.5, axis, 116), 174);
  const span = ganttSpan(task('long', {startDate: '2027-01-01', dueDate: '2030-01-01'}), axis, 116);
  assert.equal(span.left, 0); assert.equal(span.width, 12 * 116); assert.equal(span.clippedStart, true); assert.equal(span.clippedEnd, true);
});

test('僅開始／僅截止有時間則定位該時刻，無時間置中；未排程不生成假日期', () => {
  const axis = ganttAxis('2026-10-16', 'day');
  for (const patch of [{startDate: '2026-10-16', startTime: '09:30'}, {dueDate: '2026-10-16', dueTime: '17:45'}]) {
    const source = task('single', patch), span = ganttSpan(source, axis, 44);
    assert.equal(span.marker, true); assert.equal(span.width, 0);
    const [hour, minute] = (patch.startTime || patch.dueTime).split(':').map(Number);
    assert.equal(span.left, ganttPosition(civilDay('2026-10-16') + (hour * 60 + minute) / 1440, axis, 44));
    assert.match(ganttSchedule(source), patch.startDate ? /僅開始.*09:30/ : /僅截止.*17:45/);
  }
  assert.equal(ganttSpan(task('none'), axis, 44), null); assert.equal(ganttSchedule(task('none')), '未排程');
  assert.match(ganttSchedule(task('timed', {startDate: '2026-10-16', startTime: '10:15', dueDate: '2026-10-17', dueTime: '16:20'})), /10:15.*16:20/);
  assert.match(ganttSchedule(task('all-day', {dueDate: '2026-10-16'})), /全天/);
  assert.equal(ganttSpan(task('all-day', {dueDate: '2026-10-16'}), axis, 44).left, ganttPosition(civilDay('2026-10-16') + 0.5, axis, 44));
});

test('日模式按分鐘繪製同日／跨夜／混合全天時程，週月仍以日期包含首尾', () => {
  const source = task('timed', {startDate: '2026-10-16', startTime: '09:15', dueDate: '2026-10-16', dueTime: '16:45'}), before = structuredClone(source);
  const axis = ganttAxis('2026-10-16', 'day'), span = ganttSpan(source, axis, 288);
  const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, actual + ' != ' + expected);
  close(span.left - ganttPosition(civilDay('2026-10-16'), axis, 288), 111); close(span.width, 90);
  close(ganttSpan({...source, startTime: '23:30', dueDate: '2026-10-17', dueTime: '00:15'}, axis, 288).width, 9);
  close(ganttSpan({...source, startTime: ''}, axis, 288).width, 201);
  close(ganttSpan({...source, dueTime: ''}, axis, 288).width, 177);
  for (const scale of ['week', 'month']) close(ganttSpan(source, ganttAxis('2026-10-16', scale), 196).width, 196 / (scale === 'week' ? 7 : 31));
  assert.deepEqual(source, before);
});

test('午夜截止的重疊裁切與同時起訖定位，不把零長度任務放大成全天', () => {
  const axis = ganttAxis('2026-10-16', 'day', {start: '2026-10-16', end: '2026-10-16'});
  const midnight = task('midnight', {startDate: '2026-10-15', startTime: '23:00', dueDate: '2026-10-16', dueTime: '00:00'});
  assert.equal(ganttSpan(midnight, axis, 288).outside, 'before');
  const zero = ganttSpan({...midnight, startDate: '2026-10-16', startTime: '00:00'}, axis, 288);
  assert.equal(zero.marker, true); assert.equal(zero.left, 0); assert.equal(zero.outside, null);
  const crossing = ganttSpan({...midnight, dueTime: '01:30'}, axis, 288);
  assert.equal(crossing.clippedStart, true); assert.equal(crossing.left, 0); assert.equal(crossing.width, 18);
  const end = ganttSpan(task('end', {dueDate: '2026-10-16', dueTime: '23:59'}), axis, 288);
  assert.equal(end.marker, true); assert.ok(end.left < 288 && end.left > 287);
});

test('時間窗之外可辨識前後，邊界相鄰不誤算為重疊', () => {
  const axis = ganttAxis('2026-10-16', 'day');
  assert.equal(ganttSpan(task('before', {dueDate: civilKey(axis.start - 1)}), axis, 44).outside, 'before');
  assert.equal(ganttSpan(task('after', {startDate: civilKey(axis.end)}), axis, 44).outside, 'after');
  assert.equal(ganttSpan(task('first', {dueDate: civilKey(axis.start)}), axis, 44).outside, null);
  assert.equal(ganttSpan(task('last', {startDate: civilKey(axis.end - 1)}), axis, 44).outside, null);
});

test('日期導航按日曆推進，前後可逆且支援 1900 與 9999 邊界', () => {
  for (const scale of ['day', 'week', 'month']) {
    assert.equal(moveGanttDate(moveGanttDate('2026-10-31', scale, 1), scale, -1), '2026-10-31');
    assert.equal(moveGanttDate('1900-01-01', scale, -1), '1900-01-01');
    assert.equal(moveGanttDate('9999-12-31', scale, 1), '9999-12-31');
    const minimum = ganttAxis('1900-01-01', scale), maximum = ganttAxis('9999-12-31', scale);
    assert.equal(minimum.start, civilDay('1900-01-01')); assert.equal(maximum.end, civilDay('9999-12-31') + 1);
    assert.ok(Array.from({length: maximum.count}, (_, index) => maximum.column(index)).every(column => Number.isFinite(column.start) && column.end > column.start));
  }
  assert.equal(moveGanttDate('2028-02-29', 'month', 1), '2029-02-28');
});

test('夏令時間切換仍為相等的民用日期寬度，不用本地 24 小時推算', () => {
  const code = `import {ganttAxis,ganttSpan,moveGanttDate} from './src/app/gantt-data.ts'; const axis=ganttAxis('2026-03-08','day'); const span=ganttSpan({startDate:'2026-03-07',dueDate:'2026-03-09'},axis,44); console.log(JSON.stringify({width:span.width,next:moveGanttDate('2026-03-08','day',1)}));`;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], {cwd: process.cwd(), env: {...process.env, TZ: 'America/New_York'}, encoding: 'utf8'}));
  assert.deepEqual(result, {width: 132, next: '2026-04-19'});
});

test('日期相同的任務保留原排序，保留封存與自訂狀態、排除垃圾桶；一萬筆只取可見列與欄', () => {
  const sources = Array.from({length: 10000}, (_, index) => task('task-' + index, index % 2 ? {dueDate: '2026-10-16', status: 'custom-archive'} : {}));
  const rows = ganttRows([...sources, task('trash', {deletedAt: '2026-10-16T00:00:00Z'})]);
  assert.equal(rows.length, 10002); assert.equal(rows[0].count, 5000); assert.equal(rows[5001].count, 5000);
  assert.equal(rows[1].id, 'task-1'); assert.equal(rows[2].id, 'task-3'); assert.equal(rows[5002].id, 'task-0');
  assert.equal(rows[1].task.status, 'custom-archive');
  for (const offset of [0, 1234, 329000, 660000]) {
    const range = virtualRange(rows.length, offset, 480, 48);
    assert.ok(range.end - range.start <= 17); assert.ok(range.end <= rows.length); assert.ok(range.start >= 0);
  }
  assert.deepEqual(virtualRange(0, 100, 480, 48), {start: 0, end: 0});
  assert.deepEqual(ganttRows([]), []);
});

const statuses = [{id: 'working', kind: 'active'}, {id: 'accepted', kind: 'done'}, {id: 'stored', kind: 'archived'}];
const projects = [{id: 'a', name: '研究'}, {id: 'b', name: '教學'}];
test('日期範圍驗證含起訖日、閏日及單日，拒絕缺漏、無效或反向範圍', () => {
  const range = {start: '2028-02-29', end: '2028-02-29'};
  assert.deepEqual(readGanttRange(range), range); assert.notEqual(readGanttRange(range), range);
  for (const value of [null, '', {start: '', end: '2026-10-20'}, {start: '2026-02-29', end: '2026-03-01'}, {start: '2026-10-20', end: '2026-10-10'}, {start: 1, end: '2026-10-20'}]) assert.equal(readGanttRange(value), null);
});

test('範圍以重疊篩選，包含跨界與單端日期，排除未排程並與完成及垃圾桶條件交集', () => {
  const range = {start: '2026-10-10', end: '2026-10-20'};
  const sources = [task('before', {dueDate: '2026-10-09'}), task('first', {startDate: '2026-10-10'}), task('last', {dueDate: '2026-10-20'}), task('after', {startDate: '2026-10-21'}), task('cross-left', {startDate: '2026-10-01', dueDate: '2026-10-10'}), task('cross-right', {startDate: '2026-10-20', dueDate: '2026-11-01'}), task('covering', {status: 'accepted', startDate: '2020-01-01', dueDate: '2030-01-01'}), task('none'), task('trash', {dueDate: '2026-10-16', deletedAt: '2026-10-16T00:00:00Z'})];
  const before = structuredClone(sources), ids = completion => ganttRows(sources, [], statuses, completion, 'start', range).filter(row => row.kind === 'task').map(row => row.id);
  assert.equal(ganttTaskInRange(sources[0], range), false); assert.equal(ganttTaskInRange(sources[7], null), true);
  assert.deepEqual(ids('all'), ['covering', 'cross-left', 'first', 'cross-right', 'last']);
  assert.deepEqual(ids('done'), ['covering']); assert.equal(ids('pending').length, 4);
  assert.equal(ganttRows(sources, [], statuses, 'all', 'start', range).some(row => row.kind === 'group' && row.id === 'unscheduled'), false);
  assert.equal(ganttRows(sources, [], statuses).some(row => row.kind === 'group' && row.id === 'unscheduled'), true);
  assert.deepEqual(sources, before);
});

test('指定範圍裁切日期軸與任務條，週月部分欄保留真實日期、原任務時間不改變', () => {
  const range = {start: '2026-10-14', end: '2026-10-20'}, source = task('long', {startDate: '2026-10-01', startTime: '09:15', dueDate: '2026-11-01', dueTime: '16:45'}), before = structuredClone(source);
  for (const [scale, count] of [['day', 7], ['week', 2], ['month', 1]]) {
    const axis = ganttAxis('2026-10-16', scale, range);
    assert.equal(axis.count, count); assert.equal(axis.start, civilDay(range.start)); assert.equal(axis.end, civilDay(range.end) + 1);
    assert.equal(axis.column(0).start, axis.start); assert.equal(axis.column(count - 1).end, axis.end);
    const span = ganttSpan(source, axis, 196);
    assert.equal(span.left, 0); assert.equal(span.width, axis.units * 196); assert.equal(span.clippedStart, true); assert.equal(span.clippedEnd, true); assert.equal(span.outside, null);
    assert.equal(ganttPosition(axis.end, axis, 196), axis.units * 196);
  }
  const week = ganttAxis('2026-10-16', 'week', range);
  assert.equal(week.column(0).label, '10/14–10/17'); assert.equal(week.column(1).label, '10/18–10/20');
  for (let day = week.start; day < week.end; day++) assert.ok(Math.abs(ganttPosition(day + 1, week, 196) - ganttPosition(day, week, 196) - 28) < 1e-10);
  const monthBoundary = ganttAxis('2026-10-31', 'month', {start: '2026-10-30', end: '2026-11-02'});
  assert.ok(Math.abs(ganttPosition(civilDay('2026-11-01'), monthBoundary, 196) - 196 * 2 / 31) < 1e-10);
  const day = ganttAxis('2028-02-29', 'day', {start: '2028-02-29', end: '2028-02-29'}); assert.equal(day.count, 1);
  const large = ganttAxis('2026-10-16', 'day', {start: '2020-01-01', end: '2040-12-31'});
  assert.ok(large.count > 7600); assert.equal(large.column(large.count - 1).label, '12/31');
  const rangeWindow = virtualRange(large.count, 10000, 800, 44, 1); assert.ok(rangeWindow.end - rangeWindow.start < 22);
  assert.deepEqual(source, before);
});
test('已排程依專案分區、未指定專案接後、未排程最後；每區先完成再未完成，由早到晚', () => {
  const sources = [task('a-late', {projectId: 'a', startDate: '2026-10-20', dueDate: '2026-10-22'}), task('b-early', {projectId: 'b', startDate: '2026-10-01'}), task('a-done', {projectId: 'a', status: 'accepted', startDate: '2026-10-25'}), task('a-early', {projectId: 'a', dueDate: '2026-10-10'}), task('unassigned', {dueDate: '2026-10-01'}), task('unscheduled', {projectId: 'a'}), task('unscheduled-done', {projectId: 'b', status: 'accepted'}), task('archive', {projectId: 'a', status: 'stored', dueDate: '2026-09-01'})];
  const before = structuredClone(sources), rows = ganttRows(sources, projects, statuses);
  assert.deepEqual(rows.map(row => row.id), ['project:a', 'a-done', 'a-early', 'a-late', 'archive', 'project:b', 'b-early', 'project:', 'unassigned', 'unscheduled', 'unscheduled-done', 'unscheduled']);
  assert.deepEqual(rows[0], {kind: 'group', id: 'project:a', label: '研究', count: 4, done: 1, pending: 2, archived: 1});
  assert.equal(rows.at(-3).kind, 'group'); assert.equal(rows.at(-3).label, '未排程');
  assert.deepEqual(sources, before); assert.deepEqual(projects.map(project => project.id), ['a', 'b']);
  // Group and task IDs may be identical; the rendered track key also includes row.kind.
  assert.equal(rows.filter(row => row.id === 'unscheduled').length, 2);
});

test('開始／截止排序包含時間，缺一端使用現有日期，第二日期處理同日同時並列', () => {
  const sources = [task('long', {startDate: '2026-10-01', startTime: '08:00', dueDate: '2026-11-01'}), task('short', {startDate: '2026-10-02', startTime: '08:00', dueDate: '2026-10-03'}), task('due-only', {dueDate: '2026-10-01', dueTime: '09:30'}), task('tie-late-end', {startDate: '2026-10-01', startTime: '08:00', dueDate: '2026-11-02'}), task('earlier-time', {startDate: '2026-10-01', startTime: '07:30'}), task('date-only', {startDate: '2026-10-01'})];
  const ids = order => ganttRows(sources, [], statuses, 'all', order).filter(row => row.kind === 'task').map(row => row.id);
  assert.deepEqual(ids('start'), ['date-only', 'earlier-time', 'long', 'tie-late-end', 'due-only', 'short']);
  assert.deepEqual(ids('end'), ['date-only', 'earlier-time', 'due-only', 'short', 'long', 'tie-late-end']);
});

test('全部／已完成／未完成依 status kind 篩選，區段計數一致且空專案不出現', () => {
  const sources = [task('active', {projectId: 'a', dueDate: '2026-10-01'}), task('done', {projectId: 'b', status: 'accepted', dueDate: '2026-10-01'}), task('archive', {projectId: 'a', status: 'stored'}), task('trash', {status: 'accepted', deletedAt: '2026-10-16T00:00:00Z'})];
  assert.deepEqual(ganttRows(sources, projects, statuses, 'done').map(row => row.id), ['project:b', 'done']);
  assert.deepEqual(ganttRows(sources, projects, statuses, 'pending').map(row => row.id), ['project:a', 'active']);
  assert.equal(ganttRows(sources, projects, statuses, 'all').filter(row => row.kind === 'task').length, 3);
  assert.deepEqual(ganttRows([task('none')], projects, statuses, 'done'), []);
});

test('週尺度細分七天，月尺度依實際週日及月份邊界分隔，不假設每月四週', () => {
  const week = ganttAxis('2028-02-29', 'week');
  assert.equal(ganttParts(week.column(0), 'week').length, 7);
  assert.deepEqual(ganttParts(week.column(0), 'week').map(part => part.label), ['日', '一', '二', '三', '四', '五', '六']);
  assert.equal(ganttParts(week.column(0), 'week').filter(part => part.weekend).length, 2);
  const months = ganttAxis('2028-03-01', 'month'), february = months.column(0), parts = ganttParts(february, 'month');
  assert.equal(parts[0].start, civilDay('2028-02-01')); assert.equal(parts[0].end, civilDay('2028-02-06'));
  assert.equal(parts.at(-1).end, civilDay('2028-03-01')); assert.equal(parts.reduce((sum, part) => sum + part.end - part.start, 0), 29);
  assert.ok(parts.slice(1).every(part => new Date(part.start * 86400000).getUTCDay() === 0));
  for (let i = 1; i < parts.length; i++) assert.equal(parts[i].start, parts[i - 1].end);
  const day = ganttAxis('2026-10-16', 'day').column(0), hours = ganttParts(day, 'day');
  assert.equal(hours.length, 24); assert.equal(hours[0].label, '00:00'); assert.equal(hours[23].label, '23:00');
  assert.equal(hours[0].start, day.start); assert.equal(hours[23].end, day.end);
  for (let i = 1; i < hours.length; i++) assert.equal(hours[i].start, hours[i - 1].end);
});

test('列背景的今日邊界按日期軸定位，週月與部分範圍不以固定像素切半', () => {
  for (const scale of ['day', 'week', 'month']) {
    const axis = ganttAxis('2026-10-16', scale, {start: '2026-10-14', end: '2026-10-20'});
    const boundary = ganttPosition(civilDay('2026-10-16'), axis, 196);
    assert.ok(boundary > 0 && boundary < axis.units * 196);
    assert.equal(ganttPosition(civilDay('1900-01-01'), axis, 196), 0);
    assert.equal(ganttPosition(civilDay('9999-12-31'), axis, 196), axis.units * 196);
    assert.ok(Math.abs(ganttDayAtPosition(boundary, axis, 196) - civilDay('2026-10-16')) < 1e-10);
  }
});

test('縮放有範圍與刻度，週月縮放維持可見中央的實際日期，不隨月份天數漂移', () => {
  for (const [input, expected] of [[0, 50], [400, 250], [137, 125], [NaN, 100], [Infinity, 100], ['150', 100], [undefined, 100]]) assert.equal(readGanttZoom(input), expected);
  for (const scale of ['day', 'week', 'month']) {
    const axis = ganttAxis('2028-02-29', scale), width = 196, scroll = 370, extent = 430;
    const before = ganttDayAtPosition(scroll + extent / 2, axis, width), zoomedScroll = ganttZoomScroll(axis, width, width * 1.75, scroll, extent);
    assert.ok(Math.abs(ganttDayAtPosition(zoomedScroll + extent / 2, axis, width * 1.75) - before) < 1e-10);
    assert.ok(Math.abs(ganttZoomScroll(axis, width * 1.75, width, zoomedScroll, extent) - scroll) < 1e-8);
  }
  assert.equal(ganttZoomScroll(ganttAxis('9999-12-31', 'month'), 196, 98, 0, 800), 0);
});

test('甘特控制器只發出日期／尺度／編輯事件，逾期沿用實際 kind 且不改任務', () => {
  const fontScale = signal(1), injector = createEnvironmentInjector([{provide: UiPreferences, useValue: {scale: fontScale}}]);
  globalThis.ngServerMode = true;
  let component;
  try {component = runInInjectionContext(injector, () => new Gantt());} finally {delete globalThis.ngServerMode;}
  try {
    const sources = [task('late', {dueDate: '2026-10-16', dueTime: '11:59'}), task('done', {status: 'accepted', dueDate: '2026-10-15'}), task('archive', {status: 'stored', dueDate: '2026-10-15'}), task('none')];
    const before = structuredClone(sources);
    component.tasks = signal(sources); component.now = signal(new Date(2026, 9, 16, 12)); component.selectedDate = signal('2026-10-16'); component.resetKey = signal('first');
    component.statuses = signal([{id: 'working', kind: 'active', color: '#45a677', label: '進行'}, {id: 'accepted', kind: 'done', color: 'blue', label: '審核通過'}, {id: 'stored', kind: 'archived', color: 'gray', label: '留存'}]);
    const dates = [], scales = [], edits = [];
    component.dateChange.subscribe(value => dates.push(value)); component.scaleChange.subscribe(value => scales.push(value)); component.editTask.subscribe(value => edits.push(value));
    component.move(1); component.selectScale('month'); component.selectDate('2026-02-30'); component.selectDate(''); component.locate(sources[0]); component.today(); component.editTask.emit(sources[1]);
    assert.deepEqual(dates, ['2026-11-27', '2026-10-16', '2026-10-16']); assert.deepEqual(scales, ['month']); assert.equal(edits[0], sources[1]);
    assert.equal(component.overdue(sources[0]), true); assert.equal(component.overdue(sources[1]), false); assert.equal(component.overdue(sources[2]), false);
    assert.equal(component.status(sources[1]).label, '審核通過'); assert.equal(component.status(sources[0]).color, '#45a677');
    fontScale.set(1.3); assert.ok(Math.abs(component.rowHeight() - 62.4) < 1e-10); assert.ok(Math.abs(component.columnWidth() - 374.4) < 1e-10);
    component.tasks.set(Array.from({length: 10000}, (_, index) => task('large-' + index, {dueDate: '2026-10-16'})));
    component.scrollTop.set(420000); assert.ok(component.visibleRows().length <= 15); assert.ok(component.visibleColumns().length <= 18);
    assert.deepEqual(sources, before);
  } finally {injector.destroy();}
});

test('列狀態與任務分類配色各自獨立，未分類回退，篩選與縮放只發出瀏覽事件', () => {
  const injector = createEnvironmentInjector([{provide: UiPreferences, useValue: {scale: () => 1}}]);
  globalThis.ngServerMode = true;
  let component;
  try {component = runInInjectionContext(injector, () => new Gantt());} finally {delete globalThis.ngServerMode;}
  try {
    const sources = [task('active', {categoryId: 'research', dueDate: '2026-10-16'}), task('done', {status: 'accepted', dueDate: '2026-10-16'})], before = structuredClone(sources);
    component.tasks = signal(sources); component.completion = signal('all'); component.zoom = signal(100);
    component.statuses = signal([{id: 'working', kind: 'active', color: '#45a677', label: '研究中'}, {id: 'accepted', kind: 'done', color: 'blue', label: '已審核'}]);
    component.categories = signal([{id: 'research', name: '實驗', color: 'pink'}]);
    assert.equal(component.status(sources[0]).color, '#45a677'); assert.deepEqual(component.legends().statuses.map(entry => entry.label), ['研究中', '已審核']);
    assert.equal(component.color(sources[0]), 'pink'); assert.equal(component.color(sources[1]), 'gray');
    assert.equal(component.colorLabel(sources[0]), '分類：實驗'); assert.deepEqual(component.legends().categories.map(entry => entry.label), ['實驗', '未分類']);
    component.completion.set('done'); assert.deepEqual(component.legends().categories.map(entry => entry.label), ['未分類']);
    assert.deepEqual(component.rows().filter(row => row.kind === 'task').map(row => row.id), ['done']);
    const zooms = []; component.zoomChange.subscribe(value => zooms.push(value)); component.zoomBy(1); component.selectZoom(999); component.selectZoom(NaN);
    assert.deepEqual(zooms, [125, 250, 100]); assert.equal(component.zoom(), 100);
    component.zoom.set(200); assert.equal(component.columnWidth(), 576); assert.deepEqual(sources, before);
  } finally {injector.destroy();}
});

test('日期範圍先驗證再套用，錯誤保留原圖；清除恢復未排程且原任務不變', () => {
  const injector = createEnvironmentInjector([{provide: UiPreferences, useValue: {scale: () => 1}}]);
  globalThis.ngServerMode = true;
  let component;
  try {component = runInInjectionContext(injector, () => new Gantt());} finally {delete globalThis.ngServerMode;}
  try {
    const sources = [task('inside', {dueDate: '2026-11-03'}), task('outside', {dueDate: '2026-10-16'}), task('none')], before = structuredClone(sources), changes = [], dates = [];
    component.tasks = signal(sources); component.range = signal(null); component.selectedDate = signal('2026-10-16'); component.now = signal(new Date(2026, 9, 16, 12));
    component.rangeChange.subscribe(value => {changes.push(value); component.range.set(value);}); component.dateChange.subscribe(value => dates.push(value));
    component.rangeStart.set('2026-11-01'); component.applyRange(); assert.ok(component.rangeError()); assert.equal(changes.length, 0); assert.equal(component.rows().filter(row => row.kind === 'task').length, 3);
    component.rangeEnd.set('2026-10-01'); component.applyRange(); assert.match(component.rangeError(), /不能早於/); assert.equal(changes.length, 0);
    component.rangeEnd.set('2026-11-07'); component.applyRange(); assert.equal(component.rangeError(), ''); assert.deepEqual(changes, [{start: '2026-11-01', end: '2026-11-07'}]); assert.deepEqual(dates, ['2026-11-01']);
    assert.deepEqual(component.rows().filter(row => row.kind === 'task').map(row => row.id), ['inside']);
    component.rangeStart.set('2026-12-01'); component.applyRange(); assert.equal(changes.length, 1); assert.equal(component.rows().filter(row => row.kind === 'task').length, 1);
    component.move(1); component.today(); component.selectDate('2026-10-16'); assert.equal(dates.length, 1); component.selectDate('2026-11-03'); assert.equal(dates.at(-1), '2026-11-03');
    component.clearRange(); assert.equal(changes.at(-1), null); assert.equal(component.rangeStart(), ''); assert.equal(component.rangeError(), ''); assert.ok(component.rows().some(row => row.kind === 'group' && row.id === 'unscheduled'));
    assert.deepEqual(sources, before);
  } finally {injector.destroy();}
});

test('短任務文字移至條外、末端可改放左側，今天起只在對應任務條區間加背景', () => {
  const injector = createEnvironmentInjector([{provide: UiPreferences, useValue: {scale: () => 1}}]);
  globalThis.ngServerMode = true;
  let component;
  try {component = runInInjectionContext(injector, () => new Gantt());} finally {delete globalThis.ngServerMode;}
  try {
    const sources = [task('today', {startDate: '2026-10-16', startTime: '10:00', dueDate: '2026-10-16', dueTime: '11:00'}), task('future', {startDate: '2026-10-17', startTime: '10:00', dueDate: '2026-10-17', dueTime: '11:00'}), task('cross', {startDate: '2026-10-16', startTime: '12:00', dueDate: '2026-10-18', dueTime: '12:00'}), task('edge', {startDate: '2026-10-18', startTime: '23:00', dueDate: '2026-10-18', dueTime: '23:30'})], before = structuredClone(sources);
    component.tasks = signal(sources); component.range = signal({start: '2026-10-15', end: '2026-10-18'}); component.now = signal(new Date(2026, 9, 16, 12));
    component.titleWidths.set(new Map(sources.map(source => [source.id, 200])));
    const rows = new Map(component.visibleRows().filter(item => item.row.kind === 'task').map(item => [item.row.id, item]));
    assert.equal(rows.get('today').titleOutside, true); assert.ok(rows.get('today').titleLeft > rows.get('today').span.width);
    assert.equal(rows.get('today').futureStart, 0); assert.equal(rows.get('future').futureStart, 0);
    assert.equal(rows.get('cross').titleOutside, false); assert.equal(rows.get('cross').futureStart, 0);
    assert.equal(rows.get('edge').titleOutside, true); assert.ok(rows.get('edge').titleLeft < -200);
    component.scrollLeft.set(rows.get('cross').span.left + 100);
    assert.equal(component.visibleRows().find(item => item.row.id === 'cross').titleLeft, 108);
    assert.deepEqual(sources, before);
  } finally {injector.destroy();}
});

test('日週月的斜紋皆對齊今天零時；昨天跨今天只標今日部分，午夜菱形立即生效', () => {
  const injector = createEnvironmentInjector([{provide: UiPreferences, useValue: {scale: () => 1}}]);
  globalThis.ngServerMode = true;
  let component;
  try {component = runInInjectionContext(injector, () => new Gantt());} finally {delete globalThis.ngServerMode;}
  try {
    component.tasks = signal([task('past', {startDate: '2026-10-15', startTime: '08:00', dueDate: '2026-10-15', dueTime: '17:00'}), task('cross', {startDate: '2026-10-15', startTime: '23:30', dueDate: '2026-10-16', dueTime: '01:15'}), task('midnight', {dueDate: '2026-10-16', dueTime: '00:00'}), task('future', {startDate: '2026-10-17', dueDate: '2026-10-18'})]);
    component.range = signal({start: '2026-10-15', end: '2026-10-18'}); component.now = signal(new Date(2026, 9, 16, 16, 30)); component.scale = signal('day');
    for (const scale of ['day', 'week', 'month']) {
      component.scale.set(scale);
      const rows = new Map(component.visibleRows().filter(item => item.row.kind === 'task').map(item => [item.row.id, item]));
      const cross = rows.get('cross');
      assert.equal(cross.span.left + cross.futureStart, component.todayPosition());
      assert.equal(rows.get('past').futureStart, rows.get('past').span.width);
      assert.equal(rows.get('midnight').futureMarker, true); assert.equal(rows.get('future').futureStart, 0);
      if (scale === 'day') {assert.ok(Math.abs(cross.span.width - 21) < 1e-7); assert.ok(Math.abs(cross.futureStart - 6) < 1e-7);}
    }
    component.now.set(new Date(2026, 9, 17, 0));
    const rows = new Map(component.visibleRows().filter(item => item.row.kind === 'task').map(item => [item.row.id, item]));
    assert.equal(rows.get('cross').futureStart, rows.get('cross').span.width); assert.equal(rows.get('midnight').futureMarker, false);
  } finally {injector.destroy();}
});

test('圖例同組複選取聯集、兩組取交集，選項不因自身篩選消失，零結果仍可取消', () => {
  const injector = createEnvironmentInjector([{provide: UiPreferences, useValue: {scale: () => 1}}]);
  globalThis.ngServerMode = true; let component;
  try {component = runInInjectionContext(injector, () => new Gantt());} finally {delete globalThis.ngServerMode;}
  try {
    const sources = [task('a', {categoryId: 'research'}), task('b'), task('c', {status: 'accepted', categoryId: 'research'}), task('d', {status: 'stored', categoryId: 'teaching'})], before = structuredClone(sources);
    component.tasks = signal(sources); component.statuses = signal(statuses.map(status => ({...status, label: status.id, color: 'blue'})));
    component.categories = signal([{id: 'research', name: '實驗', color: 'pink'}, {id: 'teaching', name: '教學', color: 'blue'}]);
    component.statusFilter = signal([]); component.categoryFilter = signal([]); component.completion = signal('all');
    component.statusFilterChange.subscribe(value => component.statusFilter.set(value)); component.categoryFilterChange.subscribe(value => component.categoryFilter.set(value));
    const ids = () => component.rows().filter(row => row.kind === 'task').map(row => row.id).sort();
    component.toggleStatus('working'); assert.deepEqual(ids(), ['a', 'b']);
    component.toggleStatus('accepted'); component.toggleCategory('research'); assert.deepEqual(ids(), ['a', 'c']);
    assert.deepEqual(component.legends().statuses.map(entry => entry.id), ['working', 'accepted', 'stored']);
    assert.deepEqual(component.legends().categories.map(entry => entry.id), ['research', 'teaching', '']);
    component.toggleStatus('working'); assert.deepEqual(ids(), ['c']);
    component.toggleStatus('accepted'); assert.deepEqual(ids(), ['a', 'c']);
    component.toggleCategory('research'); assert.deepEqual(ids(), ['a', 'b', 'c', 'd']);
    component.toggleCategory(''); assert.deepEqual(ids(), ['b']); component.toggleCategory('research'); assert.deepEqual(ids(), ['a', 'b', 'c']);
    component.clearLegendFilters(); component.toggleStatus('accepted'); component.toggleCategory('teaching');
    assert.deepEqual(ids(), []); assert.equal(component.activeLegendFilters().statuses[0].id, 'accepted');
    component.completion.set('pending'); assert.equal(component.legends().statuses.find(entry => entry.id === 'accepted').count, 0);
    component.clearLegendFilters(); assert.deepEqual(ids(), ['a', 'b']);
    component.categoryFilter.set(['research']); component.categories.set([]); assert.deepEqual(ids(), ['a', 'b']);
    component.toggleStatus('unknown'); component.toggleCategory('unknown'); assert.deepEqual(component.selectedCategories(), []);
    assert.deepEqual(sources, before);
  } finally {injector.destroy();}
});
