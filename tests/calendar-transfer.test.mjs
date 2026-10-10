import '@angular/compiler';
import { createEnvironmentInjector, runInInjectionContext, signal, ɵChangeDetectionScheduler, ɵEffectScheduler } from '@angular/core';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { COLUMNS } from '../src/app/models.ts';
import { copyEventTask, createEventBody, eventSchedule, formatCalendarDescription, parseCalendarDescription, taskMetadata } from '../src/app/calendar-transfer-data.ts';
import { CalendarTransferApi } from '../src/app/calendar-transfer-api.ts';
import { CalendarApi, GoogleHttpError, writableCalendar } from '../src/app/google-api.ts';
import { externalEvent, readGoogleEvent } from '../src/app/google-data.ts';
import { createBackup, readBackup, copyWorkspaces } from '../src/app/backup-data.ts';
import { readBoardState } from '../src/app/board-data.ts';
import { reminderItems } from '../src/app/reminder-items.ts';

process.env.TZ = 'Asia/Taipei';
const require = createRequire(import.meta.url);
const {build} = createRequire(require.resolve('@angular/build/package.json'))('esbuild');
await mkdir('.angular', {recursive: true});
const directory = await mkdtemp(resolve('.angular/calendar-transfer-test-'));
const output = resolve(directory, 'transfer.mjs');
await build({stdin: {contents: "export {CalendarPublish} from './src/app/calendar-publish.ts'; export {CalendarTransferService} from './src/app/calendar-transfer.ts'; export {CalendarWriteAuth} from './src/app/calendar-write-auth.ts'; export {GoogleCalendarService} from './src/app/google-calendar.ts'; export {BoardStore} from './src/app/board-store.ts'; export {GoogleHttpError as ServiceHttpError} from './src/app/google-api.ts';", resolveDir: process.cwd()}, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: output, tsconfig: 'tsconfig.json'});
const {CalendarPublish, CalendarTransferService, CalendarWriteAuth, GoogleCalendarService, BoardStore, ServiceHttpError} = await import(pathToFileURL(output).href);
after(() => rm(directory, {recursive: true, force: true}));
const task = {id: 'task', title: '期末報告', description: '第一段\n第二段 & <文字>', projectId: 'project', categoryId: '', status: 'todo', priority: 'high', startDate: '', startTime: '', dueDate: '2026-10-10', dueTime: '00:10', subtasks: [{id: 's1', title: '讀文獻 "重點"\n下一行', done: true}, {id: 's2', title: '交作業', done: false}]};
const workspace = {version: 4, id: 'workspace', name: '工作', projects: [{id: 'project', name: '課程'}], categories: [], statuses: COLUMNS, tasks: [task]};
const source = {id: 'source', accountId: 'account', calendarId: 'calendar', name: '課程月曆', color: '#759acb', workspaceIds: ['workspace'], visible: true};
const choice = {mode: 'reserve', minutes: 15, startDate: '', startTime: '', endDate: task.dueDate, endTime: task.dueTime};
const id = '0123456789abcdef0123456789abcdef';
function googleEntry(body = createEventBody(task, workspace, choice, id), extra = {}) { return externalEvent(source, readGoogleEvent({...body, status: 'confirmed', htmlLink: 'https://calendar.google.com/calendar/u/0/r', ...extra})); }

test('三個時段選項、跨午夜與全天 exclusive end；缺少時間不可推測', () => {
  for (const minutes of [15, 30, 60, 120]) {
    const result = eventSchedule(task, {...choice, minutes});
    assert.equal(Date.parse(result.end.dateTime) - Date.parse(result.start.dateTime), minutes * 60000);
    assert.equal(new Date(result.end.dateTime).getHours(), 0);
    assert.equal(new Date(result.start.dateTime).getDate(), 9);
  }
  assert.deepEqual(eventSchedule(task, {...choice, mode: 'all-day'}), {start: {date: '2026-10-10'}, end: {date: '2026-10-11'}});
  assert.throws(() => eventSchedule({...task, dueTime: ''}, {...choice, endTime: ''}), /補齊/);
  assert.throws(() => eventSchedule(task, {...choice, minutes: 1440}), /15 分鐘/);
  assert.throws(() => eventSchedule(task, {...choice, mode: 'custom', startDate: task.dueDate, startTime: task.dueTime}), /晚於/);
  assert.throws(() => eventSchedule({...task, dueDate: ''}, {...choice, mode: 'all-day'}), /截止日期/);
  const custom = eventSchedule(task, {...choice, mode: 'custom', startDate: '2026-10-09', startTime: '20:00'});
  assert.equal(new Date(custom.start.dateTime).getHours(), 20);
  assert.equal(createEventBody(task, workspace, choice, id).transparency, 'transparent');
});
test('子任務格式無損保留描述、順序、勾選、引號與換行，毀損時保存原文', () => {
  const description = formatCalendarDescription(task, taskMetadata(task, workspace));
  const parsed = parseCalendarDescription(description);
  assert.equal(parsed.description, task.description);
  assert.deepEqual(parsed.subtasks, task.subtasks.map(({title, done}) => ({title, done})));
  assert.equal(parsed.metadata.project, '課程');
  for (const broken of [description.replace('[x]', '[?]'), description.replace('任務 v1', '任務 v2'), description.slice(0, -10)]) {
    assert.equal(parseCalendarDescription(broken).valid, false);
    assert.equal(parseCalendarDescription(broken).description, broken);
    assert.deepEqual(parseCalendarDescription(broken).subtasks, []);
  }
  assert.throws(() => formatCalendarDescription({...task, description: 'x'.repeat(19000)}, taskMetadata(task, workspace)), /過長/);
});
test('只開放 Google 明確允許寫入的角色，未知權限不能當成可寫入', () => {
  for (const accessRole of ['writer', 'owner', 'writerWithoutPrivateAccess']) assert.equal(writableCalendar({accessRole}), true);
  for (const accessRole of ['reader', 'freeBusyReader', '', 'admin', undefined]) assert.equal(writableCalendar({accessRole}), false);
});
test('Google 副本依最新時間與清單建立獨立 ID，備份及工作空間副本不建立來源連結', () => {
  const entry = googleEntry(); let count = 0;
  const copy = copyEventTask(entry, workspace, undefined, () => 'new-' + count++);
  assert.equal(copy.startDate, '2026-10-09'); assert.equal(copy.startTime, '23:55');
  assert.equal(copy.projectId, 'project'); assert.equal(copy.subtasks[0].done, true);
  assert.notEqual(copy.id, task.id); assert.notEqual(copy.subtasks[0].id, task.subtasks[0].id);
  const state = {version: 1, activeWorkspaceId: workspace.id, workspaces: [{...workspace, tasks: [copy]}]};
  const restored = readBackup(createBackup(state, 'full', [], 'standard'));
  assert.equal('calendarOrigin' in restored.data.workspaces[0].tasks[0], false);
  const independent = copyWorkspaces(restored.data.workspaces)[0];
  assert.notEqual(independent.tasks[0].id, copy.id);
  assert.equal('calendarOrigin' in independent.tasks[0], false);
  const old = readBackup(createBackup({version: 1, activeWorkspaceId: workspace.id, workspaces: [workspace]}, 'full', [], 'standard'));
  assert.equal('calendarOrigin' in old.data.workspaces[0].tasks[0], false);
  assert.equal('calendarTransfers' in old.data.workspaces[0], false);
});
test('Google 副本各自顯示與提醒，儲存重新載入也不建立同源關係', () => {
  const entry = googleEntry(), copy = copyEventTask(entry, workspace);
  const board = {...workspace, tasks: [copy]};
  assert.equal('calendarOrigin' in copy, false);
  assert.equal(reminderItems(board, 'g', [entry]).length, 2);
  const restored = readBackup(createBackup({version: 1, activeWorkspaceId: workspace.id, workspaces: [board]}, 'full', [], 'standard'));
  const reloaded = restored.data.workspaces[0];
  assert.equal('calendarOrigin' in reloaded.tasks[0], false);
  assert.equal(reminderItems(reloaded, 'g', [entry]).length, 2);
  const changed = {...reloaded, tasks: [{...reloaded.tasks[0], description: 'Orbit 改動'}]};
  assert.equal(reminderItems(changed, 'g', [entry]).length, 2);
  assert.equal(entry.event.description, createEventBody(task, workspace, choice, id).description);
});
test('一般 Google HTML 描述複製為可讀文字，不保存比較指紋', () => {
  const body = {...createEventBody(task, workspace, choice, id), description: '<p>第一段 &amp; 重點</p><div>第二段<br>第三段</div>'};
  const entry = googleEntry(body), copy = copyEventTask(entry, workspace, taskMetadata(task, workspace));
  assert.equal(copy.description, '第一段 & 重點\n第二段\n第三段');
  assert.equal('calendarOrigin' in copy, false);
  assert.equal('comparisonData' in entry.event, false);
  const formatted = googleEntry({...body, description: '<p><b>第一段 &amp; 重點</b></p><div>第二段<br>第三段</div>'});
  assert.equal(copyEventTask(formatted, workspace, taskMetadata(task, workspace)).description, copy.description);
});
test('過長活動只顯示節錄，複製及移轉讀回都拒絕截斷', async () => {
  for (const extra of [{summary: '名'.repeat(2001)}, {description: '文'.repeat(20001)}, {location: '地'.repeat(2001)}]) {
    const raw = {...createEventBody(task, workspace, choice, id), ...extra}, entry = googleEntry(raw);
    assert.equal(entry.event.contentComplete, false);
    assert.equal(readGoogleEvent(JSON.parse(JSON.stringify(entry.event))).contentComplete, false);
    assert.throws(() => copyEventTask(entry, workspace), /超過/);
    await assert.rejects(new CalendarTransferApi(async () => raw).get(source.calendarId, id), /過長/);
  }
});

async function fixture() {
  const state = {version: 1, activeWorkspaceId: workspace.id, workspaces: [workspace]};
  const values = new Map([['orbit-workspaces-v1', JSON.stringify(state)]]);
  let denied = false;
  globalThis.localStorage = {getItem: key => values.get(key) ?? null, setItem: (key, value) => { if (denied) throw new Error('quota'); values.set(key, value); }, removeItem: key => values.delete(key)};
  const store = new BoardStore();
  await store.updateGoogle({clientId: '123-test.apps.googleusercontent.com'});
  await store.updateGoogle({accountId: 'account', email: 'test@example.test'});
  const events = new Map(), calls = [];
  const controls = {role: 'writer', loseResponse: false, onPost: async () => {}, onGet: async () => {}};
  const request = async (path, parameters, options) => {
    calls.push({path, method: options?.method ?? 'GET', body: options?.body});
    if (path === 'users/me/calendarList') return {items: [{id: 'calendar', summary: '課程月曆', accessRole: controls.role}]};
    if (path.startsWith('users/me/calendarList/')) return {id: 'calendar', accessRole: controls.role};
    if (options?.method === 'POST') {
      const body = JSON.parse(options.body);
      if (events.has(body.id)) throw new ServiceHttpError(409);
      events.set(body.id, {...body, status: 'confirmed', htmlLink: 'https://calendar.google.com/calendar/u/0/r'});
      await controls.onPost(body);
      if (controls.loseResponse) { controls.loseResponse = false; throw new Error('response lost'); }
      return events.get(body.id);
    }
    const eventId = decodeURIComponent(path.split('/').at(-1));
    await controls.onGet(eventId);
    if (!events.has(eventId)) throw new ServiceHttpError(404);
    return structuredClone(events.get(eventId));
  };
  const auth = {connected: signal(true), account: signal({id: 'account', email: 'test@example.test'}), connectionVersion: signal(1), authorizing: signal(false), prepare: async () => {}, useSession() {}, cancelRequests() {}, disconnect() { this.connected.set(false); this.connectionVersion.update(n => n + 1); }, api: request};
  const google = {auth: {...auth, request}, refresh: async () => {}, events: signal([]), available: signal([]), listing: signal(false), error: signal(''), async listCalendars() { this.available.set(await new CalendarApi(request).calendars()); }};
  const effects = new Set(), children = [];
  const scheduler = {add(effect) { effects.add(effect); }, schedule() {}, remove(effect) { effects.delete(effect); }};
  const injector = createEnvironmentInjector([{provide: BoardStore, useValue: store}, {provide: CalendarWriteAuth, useValue: auth}, {provide: GoogleCalendarService, useValue: google}, {provide: ɵEffectScheduler, useValue: scheduler}, {provide: ɵChangeDetectionScheduler, useValue: {notify() {}}}]);
  const service = runInInjectionContext(injector, () => new CalendarTransferService());
  await service.loadCalendars();
  const createPublish = (value = store.tasks()[0]) => {
    const child = createEnvironmentInjector([{provide: CalendarTransferService, useValue: service}], injector); children.push(child);
    const controller = runInInjectionContext(child, () => new CalendarPublish());
    controller.task = () => value; controller.context = () => store.taskContext(value.id); controller.ngOnInit(); return controller;
  };
  return {store, service, auth, google, events, calls, controls, createPublish, flush: () => { for (const effect of effects) if (effect.dirty) effect.run(); }, deny: value => denied = value, createService: () => runInInjectionContext(injector, () => new CalendarTransferService()), close: () => { for (const child of children) child.destroy(); injector.destroy(); store.ngOnDestroy(); }};
}

test('完整起訖時間直接沿用，只有截止才給選項，沒有時段則補齊欄位', async () => {
  const f = await fixture();
  try {
    const full = f.createPublish({...task, startDate: '2026-10-09', startTime: '20:00'}); f.flush();
    assert.equal(full.completeSchedule(), true); assert.equal(full.needsOptions(), false); assert.equal(full.choice.mode, 'custom');
    assert.equal(full.validSchedule(), true); assert.equal(full.choice.startTime, '20:00'); assert.equal(full.choice.endTime, task.dueTime);
    const deadline = f.createPublish(); f.flush();
    assert.equal(deadline.completeSchedule(), false); assert.equal(deadline.needsOptions(), true); assert.equal(deadline.choice.mode, 'reserve');
    const missing = f.createPublish({...task, dueDate: '', dueTime: ''}); f.flush();
    assert.equal(missing.needsOptions(), false); assert.equal(missing.choice.mode, 'custom'); assert.equal(missing.validSchedule(), false);
  } finally { f.close(); }
});

test('非同步月曆載入後自動選第一個可寫入項目，保留手動選擇並略過未知權限', async () => {
  const f = await fixture();
  try {
    f.google.available.set([]); const controller = f.createPublish(); f.flush();
    await f.service.loadCalendars(); f.flush(); assert.equal(controller.calendarId, 'calendar');
    const item = {name: '月曆', color: '#759acb', timeZone: ''};
    f.google.available.set([{...item, id: 'reader', accessRole: 'reader'}, {...item, id: 'unknown'}, {...item, id: 'first', accessRole: 'writer'}, {...item, id: 'second', accessRole: 'owner'}]); f.flush();
    assert.equal(controller.calendarId, 'first'); controller.calendarId = 'second';
    f.google.available.set([...f.google.available()]); f.flush(); assert.equal(controller.calendarId, 'second');
    f.google.available.set([{...item, id: 'second', accessRole: 'reader'}, {...item, id: 'first', accessRole: 'writer'}]); f.flush(); assert.equal(controller.calendarId, 'first');
  } finally { f.close(); }
});
test('發佈讀回確認後才移除 Orbit，清除已完成紀錄並綁定月曆', async () => {
  const f = await fixture();
  try {
    assert.equal(await f.service.publish(f.store.tasks()[0], f.store.taskContext('task'), 'calendar', choice), true);
    assert.equal(f.store.tasks().length, 0); assert.equal(f.events.size, 1);
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
    assert.equal(f.store.currentWorkspace().calendarTransfers.length, 0);
    assert.equal(f.store.google().sources[0].workspaceIds.includes(workspace.id), true);
    const backup = readBackup(createBackup(f.store.workspaceState(), 'full', [], 'standard'));
    assert.equal(backup.data.workspaces[0].calendarTransfers.length, 0);
  } finally { f.close(); }
});
test('回應丟失保留本機，重新載入後重試使用同一個活動，不重複 POST', async () => {
  const f = await fixture();
  try {
    f.controls.loseResponse = true;
    assert.equal(await f.service.publish(f.store.tasks()[0], f.store.taskContext('task'), 'calendar', choice), false);
    assert.equal(f.store.tasks().length, 1); assert.equal(f.events.size, 1);
    const reopened = f.createService(); await reopened.loadCalendars();
    assert.equal(await reopened.publish(f.store.tasks()[0], f.store.taskContext('task'), 'other', {...choice, minutes: 120}), true);
    assert.equal(f.events.size, 1); assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
    assert.equal(f.store.tasks().length, 0);
  } finally { f.close(); }
});
test('權限收回、儲存空間不足與不同帳號均保留 Orbit，不送出未保存的操作', async () => {
  for (const failure of ['role', 'quota', 'account']) {
    const f = await fixture();
    try {
      if (failure === 'role') f.controls.role = 'reader';
      if (failure === 'quota') f.deny(true);
      if (failure === 'account') f.auth.account.set({id: 'other'});
      assert.equal(f.service.calendars()[0].accessRole, 'writer');
      assert.equal(await f.service.publish(f.store.tasks()[0], f.store.taskContext('task'), 'calendar', choice), false);
      assert.equal(f.store.tasks().length, 1); assert.equal(f.events.size, 0);
      assert.equal(f.calls.some(call => call.method === 'POST'), false);
    } finally { f.close(); }
  }
});
test('已建立活動但保存結果失敗時保留任務，重試後才移除且不建立副本', async () => {
  const f = await fixture();
  try {
    f.controls.onPost = async () => f.deny(true);
    assert.equal(await f.service.publish(f.store.tasks()[0], f.store.taskContext('task'), 'calendar', choice), false);
    assert.equal(f.store.tasks().length, 1); assert.equal(f.store.currentWorkspace().calendarTransfers[0].published, false);
    f.deny(false);
    assert.equal(await f.service.publish(f.store.tasks()[0], f.store.taskContext('task'), 'calendar', choice), true);
    assert.equal(f.store.tasks().length, 0); assert.equal(f.events.size, 1);
  } finally { f.close(); }
});
test('移轉期間另一分頁編輯任務或切換帳號，不能刪掉新內容', async () => {
  for (const change of ['edit', 'account']) {
    const f = await fixture();
    try {
      f.controls.onPost = async () => {
        if (change === 'edit') { const other = new BoardStore(); await other.saveTask({...other.tasks()[0], description: '另一分頁的新內容'}); other.ngOnDestroy(); }
        else await f.store.updateGoogle({accountId: 'other'});
      };
      await f.service.publish(f.store.tasks()[0], f.store.taskContext('task'), 'calendar', choice);
      assert.equal(f.store.tasks().length, 1);
      if (change === 'edit') assert.equal(f.store.tasks()[0].description, '另一分頁的新內容');
      assert.equal(f.events.size, 1);
    } finally { f.close(); }
  }
});
test('兩個分頁同時移轉同一任務，先保存的移轉紀錄阻止第二次建立', async () => {
  const f = await fixture();
  try {
    const second = f.createService(); await second.loadCalendars();
    const original = f.store.tasks()[0], context = f.store.taskContext('task');
    await Promise.all([f.service.publish(original, context, 'calendar', choice), second.publish(original, context, 'calendar', choice)]);
    assert.equal(f.events.size, 1); assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  } finally { f.close(); }
});
test('複製 Google 只讀取不刪除，可獨立複製多份，預覽後更新必須重新載入', async () => {
  const f = await fixture();
  try {
    const entry = googleEntry(); f.events.set(id, {...createEventBody(task, workspace, choice, id), status: 'confirmed', htmlLink: 'https://calendar.google.com/calendar/u/0/r'});
    const reviewed = await f.service.latest(entry), copy = f.service.draft(reviewed);
    assert.equal(await f.service.copy(reviewed, copy, f.store.taskContext(copy.id)), true);
    assert.equal(f.events.size, 1); assert.equal(f.calls.every(call => call.method === 'GET'), true);
    const duplicate = f.service.draft(reviewed);
    assert.equal(await f.service.copy(reviewed, duplicate, f.store.taskContext(duplicate.id)), true);
    f.events.get(id).summary = 'Google 改名';
    assert.equal(await f.service.copy(reviewed, copy, f.store.taskContext(copy.id)), false);
    assert.match(f.service.error(), /又有更新/);
    assert.equal(f.store.tasks().find(item => item.id === copy.id).title, task.title);
  } finally { f.close(); }
});
test('GET 已存在但內容不同時不能覆寫，POST 409 會讀回同一活動確認', async () => {
  const body = createEventBody(task, workspace, choice, id), event = {...body, summary: 'Google 已更新'};
  let posts = 0;
  const mismatch = new CalendarTransferApi(async path => path.startsWith('users/') ? {id: 'calendar', accessRole: 'writer'} : event);
  await assert.rejects(mismatch.publish('calendar', body, () => {}), /Google 活動已存在且有修改/);
  let gets = 0;
  const race = new CalendarTransferApi(async (path, parameters, options) => {
    if (path.startsWith('users/')) return {id: 'calendar', accessRole: 'writer'};
    if (options?.method === 'POST') { posts++; throw new GoogleHttpError(409); }
    if (++gets === 1) throw new GoogleHttpError(404);
    return body;
  });
  assert.equal((await race.publish('calendar', body, () => {})).id, id); assert.equal(posts, 1);
});
test('預留時間維持原截止點，夏令時間不存在的時刻與重複時刻不能錯誤合併', () => {
  assert.throws(() => eventSchedule(task, {...choice, endTime: '01:00'}), /原有截止時間/);
  const previous = process.env.TZ; process.env.TZ = 'America/New_York';
  try {
    assert.throws(() => eventSchedule({...task, dueDate: '', dueTime: ''}, {...choice, mode: 'custom', startDate: '2026-03-08', startTime: '02:30', endDate: '2026-03-08', endTime: '04:00'}), /不存在/);
    const entry = googleEntry({...createEventBody(task, workspace, choice, id), start: {dateTime: '2026-11-01T01:30:00-05:00'}, end: {dateTime: '2026-11-01T02:30:00-05:00'}});
    assert.equal('calendarOrigin' in copyEventTask(entry, workspace), false);
  } finally { process.env.TZ = previous; }
});
test('未完成移轉隨工作空間匯入改寫本機 ID，但保留 Google 活動 ID 與原快照', async () => {
  const f = await fixture();
  try {
    f.controls.loseResponse = true;
    await f.service.publish(f.store.tasks()[0], f.store.taskContext('task'), 'calendar', choice);
    const original = f.store.currentWorkspace(), copied = copyWorkspaces([original])[0];
    const transfer = copied.calendarTransfers[0];
    assert.equal(transfer.taskId, copied.tasks[0].id); assert.notEqual(transfer.taskId, task.id);
    assert.equal(transfer.eventId, original.calendarTransfers[0].eventId);
    assert.deepEqual(JSON.parse(transfer.original), (() => {const {calendarOrigin, ...value} = copied.tasks[0]; return value;})());
    assert.ok(readBoardState(copied));
    const imported = await f.store.importBackup(createBackup(f.store.workspaceState(), 'workspaces', [original.id], 'standard'));
    assert.equal(imported.ok, true);
    await f.service.loadCalendars();
    const copy = f.store.tasks()[0];
    assert.equal(await f.service.publish(copy, f.store.taskContext(copy.id), 'calendar', choice), true);
    assert.equal(f.events.size, 1); assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
    assert.equal(f.store.tasks().length, 0);
  } finally { f.close(); }
});
test('備份拒絕毀損來源、無效時段、非 Orbit 格式與意外寫入欄位', async () => {
  const f = await fixture();
  try {
    f.controls.loseResponse = true;
    await f.service.publish(f.store.tasks()[0], f.store.taskContext('task'), 'calendar', choice);
    const board = structuredClone(f.store.currentWorkspace());
    for (const mutate of [body => body.attendees = [{email: 'unsafe@example.test'}], body => body.start = {date: 'invalid'}, body => body.description = 'missing format']) {
      const changed = structuredClone(board), body = JSON.parse(changed.calendarTransfers[0].body); mutate(body); changed.calendarTransfers[0].body = JSON.stringify(body);
      assert.equal(readBoardState(changed), null);
    }
    const bad = {...workspace, tasks: [{...task, calendarOrigin: {accountId: 'account', calendarId: 'calendar', eventId: id, extra: '', metadata: {project: '', category: '', status: '', priority: 'invalid'}}}]};
    assert.equal(readBoardState(bad), null);
  } finally { f.close(); }
});
test('Google 在斷線後修改原活動，重試保留兩邊且不建立追蹤關係', async () => {
  const f = await fixture();
  try {
    f.controls.loseResponse = true;
    await f.service.publish(f.store.tasks()[0], f.store.taskContext('task'), 'calendar', choice);
    const event = [...f.events.values()][0]; event.summary = 'Google 新標題';
    assert.equal(await f.service.publish(f.store.tasks()[0], f.store.taskContext('task'), 'calendar', choice), true);
    assert.equal(f.store.tasks().length, 1); assert.equal(f.store.tasks()[0].title, task.title);
    assert.equal('calendarOrigin' in f.store.tasks()[0], false);
    assert.equal(f.store.currentWorkspace().calendarTransfers.length, 0);
    assert.match(f.service.error(), /已有修改|有修改/); assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  } finally { f.close(); }
});
test('頁面離開後晚回來的寫入回應不能移除 Orbit，重試仍確認原活動', async () => {
  const f = await fixture();
  try {
    f.controls.onPost = async () => f.service.leave();
    assert.equal(await f.service.publish(f.store.tasks()[0], f.store.taskContext('task'), 'calendar', choice), false);
    assert.equal(f.store.tasks().length, 1); assert.equal(f.events.size, 1);
    f.controls.onPost = async () => {};
    assert.equal(await f.service.publish(f.store.tasks()[0], f.store.taskContext('task'), 'calendar', choice), true);
    assert.equal(f.events.size, 1);
  } finally { f.close(); }
});
test('複製只能建立新任務，不能覆寫現有副本，Google 與 Orbit 各自保留', async () => {
  const f = await fixture();
  try {
    const body = createEventBody(task, workspace, choice, id); f.events.set(id, body);
    const reviewed = await f.service.latest(googleEntry()), copied = f.service.draft(reviewed);
    assert.equal(await f.service.copy(reviewed, copied, f.store.taskContext(copied.id)), true);
    const context = f.store.taskContext(copied.id), update = {...copied, title: '準備套用的內容'};
    await f.store.saveTask({...copied, description: 'Orbit 新內容'});
    assert.equal(await f.service.copy(reviewed, update, context), false);
    assert.equal(f.store.tasks().find(item => item.id === copied.id).description, 'Orbit 新內容');
    f.events.get(id).summary = 'Google 最新內容';
    const latest = await f.service.latest(reviewed), next = {...f.service.draft(latest), id: copied.id, priority: 'low'};
    assert.equal(await f.service.copy(latest, next, f.store.taskContext(copied.id)), false);
    const saved = f.store.tasks().find(item => item.id === copied.id);
    assert.equal(saved.title, task.title); assert.equal(saved.priority, task.priority); assert.equal(f.events.size, 1);
    assert.equal(f.calls.every(call => call.method === 'GET'), true);
  } finally { f.close(); }
});
