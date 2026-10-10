import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { CalendarApi, GoogleHttpError, calendarViewForRange } from '../src/app/google-api.ts';
import { cacheKey, calendarMonthRange, calendarRange, DEFAULT_GOOGLE, externalEvent, externalOccursOn, googleCalendarEventLink, mergeGoogleEvents, readGoogleEvent, readGoogleSettings, safeGoogleLink } from '../src/app/google-data.ts';
import { dateKey, monthDates, weekDates } from '../src/app/task-schedule.ts';
import { layoutAllDayTasks, timedEventsOnDay } from '../src/app/week-layout.ts';
import { createBackup, readBackup } from '../src/app/backup-data.ts';
import { emptyWorkspace } from '../src/app/workspace-data.ts';

process.env.TZ = 'Asia/Taipei';
const source = {id: 'source', accountId: 'account', calendarId: 'a@example.com', name: '學程行事曆', color: '#759acb', workspaceIds: ['work'], visible: true};
const raw = {id: 'event', summary: '會議', start: {dateTime: '2026-10-09T09:00:00+08:00'}, end: {dateTime: '2026-10-09T10:00:00+08:00'}};
const event = readGoogleEvent(raw);

test('共用整月查詢涵蓋月格與該月每週，包含閏日、跨月及跨年', () => {
  for (const year of [2024, 2026]) for (let month = 0; month < 12; month++) {
    const first = new Date(year, month, 1), dates = monthDates(first), range = calendarMonthRange(first);
    assert.equal(range.key, calendarMonthRange(new Date(year, month, 25)).key);
    assert.ok(Date.parse(range.start) < dates[0].getTime());
    assert.ok(Date.parse(range.end) > dates[dates.length - 1].getTime());
    const count = new Date(year, month + 1, 0).getDate();
    for (let day = 1; day <= count; day++) {
      const week = weekDates(new Date(year, month, day));
      const query = calendarRange(dateKey(week[0]), dateKey(week[6]));
      assert.ok(Date.parse(range.start) <= Date.parse(query.start));
      assert.ok(Date.parse(range.end) >= Date.parse(query.end));
    }
  }
});

test('涵蓋範圍的快取優先選有效及最新資料，部分日期或其他時區不當作完整快取', () => {
  const month = calendarMonthRange(new Date(2026, 9, 9));
  const week = calendarRange('2026-10-05', '2026-10-11');
  const broad = {rangeKey: month.key, events: [event], updatedAt: '2026-10-09T00:00:00Z'};
  const narrow = {rangeKey: week.key, events: [], updatedAt: '2026-10-09T01:00:00Z'};
  const snapshot = {views: [broad, narrow]};
  assert.equal(calendarViewForRange(snapshot, week), narrow);
  assert.equal(calendarViewForRange({views: [broad]}, week), broad);
  assert.equal(calendarViewForRange(snapshot, month), broad);
  assert.equal(calendarViewForRange({views: [broad, {...narrow, invalidated: true}]}, week), broad);
  assert.equal(calendarViewForRange({views: [narrow, {rangeKey: 'broken'}]}, month), undefined);
  assert.equal(calendarViewForRange(snapshot, {...week, timeZone: 'America/New_York'}), undefined);
  assert.equal(calendarViewForRange(snapshot, calendarRange('2026-12-01', '2026-12-07')), undefined);
});

test('公開 Google 設定驗證、過濾憑證與無效工作空間參照', () => {
  const google = {...DEFAULT_GOOGLE, clientId: '123-example.apps.googleusercontent.com', accountId: 'account', email: 'a@example.com', sources: [source], access_token: 'never-save', client_secret: 'never-save'};
  const restored = readGoogleSettings(google, ['work']);
  assert.ok(restored);
  assert.equal(restored.access_token, undefined);
  assert.equal(restored.client_secret, undefined);
  for (const patch of [{clientId: 'secret'}, {refreshMinutes: 2}, {sources: [{...source, color: '#abc'}]}, {sources: [{...source, workspaceIds: ['missing']}]}, {sources: [source, source]}]) assert.equal(readGoogleSettings({...google, ...patch}, ['work']), null);
  assert.notEqual(cacheKey('generation', 'client', source), cacheKey('new', 'client', source));
  assert.notEqual(cacheKey('generation', 'client', source), cacheKey('generation', 'client', {...source, accountId: 'other'}));
});

test('Google 活動白名單、惡意連結及無效日期不會成為可執行內容', () => {
  assert.equal(readGoogleEvent({...raw, access_token: 'token'}).access_token, undefined);
  for (const link of ['javascript:alert(1)', 'https://calendar.google.com.evil.test/event', 'http://calendar.google.com/event', 'https://www.google.com/search']) assert.equal(safeGoogleLink(link), '');
  assert.equal(safeGoogleLink('https://www.google.com/calendar/event?eid=123'), 'https://www.google.com/calendar/event?eid=123');
  for (const start of [{dateTime: '2026-02-30T09:00:00+08:00'}, {dateTime: '2026-10-09T09:00:00'}, {dateTime: '2026-10-09T25:00:00Z'}, {date: '2026-02-30'}]) assert.equal(readGoogleEvent({...raw, start}), null);
  assert.equal(readGoogleEvent({...raw, end: {dateTime: '2026-10-09T08:00:00+08:00'}}), null);
});

test('開啟 Google 活動帶入連線帳號，保留 API 活動識別與時區且取代舊帳號提示', () => {
  const htmlLink = 'https://www.google.com/calendar/event?eid=encoded%2Bshared%2Fevent%3D&ctz=Asia%2FTaipei&authuser=0&authuser=wrong%40example.com';
  const entry = externalEvent({...source, calendarId: 'shared@group.calendar.google.com'}, readGoogleEvent({...raw, htmlLink}));
  const email = 'orbit+work@example.com';
  const account = new URL(googleCalendarEventLink(entry, {accountId: source.accountId, email}));
  assert.equal(account.origin, 'https://accounts.google.com'); assert.equal(account.pathname, '/AccountChooser');
  assert.equal(account.searchParams.get('Email'), email);
  const target = new URL(account.searchParams.get('continue'));
  assert.equal(target.origin, 'https://www.google.com'); assert.equal(target.pathname, '/calendar/event');
  assert.equal(target.searchParams.get('eid'), 'encoded+shared/event='); assert.equal(target.searchParams.get('ctz'), 'Asia/Taipei');
  assert.deepEqual(target.searchParams.getAll('authuser'), [email]);
  assert.equal(entry.event.htmlLink, htmlLink);
});

test('Google 活動網址移除固定登入序號，同一活動在登入順序改變後仍指定帳號', () => {
  for (const path of ['/calendar/u/0/r/event', '/calendar/u/3/r/eventedit/encoded-instance', '/calendar/u/old%40example.com/event']) {
    const entry = externalEvent(source, readGoogleEvent({...raw, htmlLink: 'https://calendar.google.com' + path + '?eid=instance&ctz=UTC'}));
    const target = new URL(new URL(googleCalendarEventLink(entry, {accountId: 'account', email: 'work@example.com'})).searchParams.get('continue'));
    assert.equal(target.pathname, path.replace(/\/u\/[^/]+/, '')); assert.equal(target.searchParams.get('eid'), 'instance');
    assert.equal(target.searchParams.get('authuser'), 'work@example.com');
  }
});

test('Google 開啟連結缺少帳號、來源屬於其他帳號或網址不安全時不退回預設帳號', () => {
  const entry = externalEvent(source, readGoogleEvent({...raw, htmlLink: 'https://www.google.com/calendar/event?eid=instance'}));
  for (const settings of [{accountId: '', email: 'work@example.com'}, {accountId: 'other', email: 'work@example.com'}, {accountId: 'account', email: ''}, {accountId: 'account', email: 'work@example.com\nother@example.com'}]) {
    assert.equal(googleCalendarEventLink(entry, settings), '');
  }
  for (const htmlLink of ['', 'javascript:alert(1)', 'https://calendar.google.com.evil.test/calendar/event?eid=instance', 'https://www.google.com/search']) {
    assert.equal(googleCalendarEventLink({...entry, event: {...entry.event, htmlLink}}, {accountId: 'account', email: 'work@example.com'}), '');
  }
});

test('全天活動的 exclusive end 不多顯示一天，跨月日期及週橫條一致', () => {
  const entry = externalEvent(source, readGoogleEvent({id: 'all-day', start: {date: '2026-10-30'}, end: {date: '2026-11-02'}}));
  assert.equal(entry.task.dueDate, '2026-11-01');
  assert.equal(externalOccursOn(entry, '2026-11-01'), true);
  assert.equal(externalOccursOn(entry, '2026-11-02'), false);
  assert.equal(layoutAllDayTasks([entry.task], ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'])[0].endColumn, 3);
});

test('跨時區活動換算本機時間，午夜結束在月曆與週視圖皆不留幽靈活動', () => {
  const entry = externalEvent(source, readGoogleEvent({...raw, start: {dateTime: '2026-10-08T14:00:00Z'}, end: {dateTime: '2026-10-08T16:00:00Z'}}));
  assert.equal(entry.task.startDate, '2026-10-08');
  assert.equal(entry.task.startTime, '22:00');
  assert.equal(entry.task.dueDate, '2026-10-09');
  assert.equal(externalOccursOn(entry, '2026-10-08'), true);
  assert.equal(externalOccursOn(entry, '2026-10-09'), false);
  assert.equal(timedEventsOnDay([entry.task], '2026-10-09').length, 0);
  assert.equal(timedEventsOnDay([entry.task], '2026-10-08')[0].endMinute, 1440);
});

test('跨日完整日放全天，首末日及秒數邊界保留實際時段', () => {
  const entry = externalEvent(source, readGoogleEvent({...raw, start: {dateTime: '2026-10-08T22:00:00+08:00'}, end: {dateTime: '2026-10-11T10:00:00+08:00'}}));
  const days = ['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'];
  assert.deepEqual(layoutAllDayTasks([entry.task], days).map(item => [item.startColumn, item.endColumn]), [[1, 3]]);
  assert.equal(timedEventsOnDay([entry.task], '2026-10-09').length, 0);
  assert.equal(timedEventsOnDay([entry.task], '2026-10-11')[0].endMinute, 600);
  const seconds = externalEvent(source, readGoogleEvent({...raw, start: {dateTime: '2026-10-09T00:00:01+08:00'}, end: {dateTime: '2026-10-10T00:00:01+08:00'}}));
  assert.equal(layoutAllDayTasks([seconds.task], days).length, 0);
  assert.equal(timedEventsOnDay([seconds.task], '2026-10-10')[0].milestone, false);
});

test('夏令時間切換保留日期與實際區間，重複時鐘小時不變成零長度', () => {
  const code = `import {externalEvent,readGoogleEvent,externalOccursOn} from './src/app/google-data.ts'; import {timedEventsOnDay} from './src/app/week-layout.ts';
    const source=${JSON.stringify(source)};
    const entry=externalEvent(source,readGoogleEvent({id:'dst',start:{dateTime:'2026-11-01T01:30:00-04:00'},end:{dateTime:'2026-11-01T01:30:00-05:00'}}));
    const spring=externalEvent(source,readGoogleEvent({id:'spring',start:{dateTime:'2026-03-08T01:30:00-05:00'},end:{dateTime:'2026-03-08T03:30:00-04:00'}}));
    console.log(JSON.stringify({timed:timedEventsOnDay([entry.task],'2026-11-01')[0],day:externalOccursOn(entry,'2026-11-01'),spring:[spring.task.startTime,spring.task.dueTime]}));`;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], {cwd: process.cwd(), env: {...process.env, TZ: 'America/New_York'}, encoding: 'utf8'}));
  assert.equal(result.day, true);
  assert.equal(result.timed.milestone, false);
  assert.equal(result.timed.displayEnd - result.timed.displayStart, 60);
  assert.match(result.timed.label, /時區轉換/);
  assert.deepEqual(result.spring, ['01:30', '03:30']);
});

test('增量活動依 ID 更新、取消移除，重複活動例外保留取消識別且無副本', () => {
  const exception = readGoogleEvent({...raw, id: 'repeat-instance', recurringEventId: 'series', originalStartTime: raw.start});
  const cancellation = readGoogleEvent({id: exception.id, recurringEventId: 'series', status: 'cancelled', originalStartTime: raw.start});
  const result = mergeGoogleEvents([event, exception], [{...event, summary: '改名'}, cancellation, {...event, summary: '最新'}]);
  assert.equal(result.length, 2);
  assert.equal(result[0].summary, '最新');
  assert.equal(result[1].status, 'cancelled');
  assert.equal(externalEvent(source, result[1]), null);
  assert.equal(mergeGoogleEvents(result, [readGoogleEvent({id: event.id, status: 'cancelled'})]).length, 1);
});

test('Calendar 清單與活動讀完所有分頁，增量游標只在最後一頁採用', async () => {
  const calls = [];
  const api = new CalendarApi(async (path, parameters) => {
    calls.push({path, parameters});
    if (path === 'users/me/calendarList') return parameters.pageToken ? {items: [{id: 'second', summary: '第二個'}]} : {items: [{id: 'first', summary: '第一個'}], nextPageToken: 'page2'};
    return parameters.pageToken ? {items: [{...raw, id: 'other'}], nextSyncToken: 'next'} : {items: [raw], nextPageToken: 'events2'};
  });
  assert.equal((await api.calendars()).length, 2);
  const synced = await api.sync('a@example.com');
  assert.equal(synced.events.length, 2);
  assert.equal(synced.syncToken, 'next');
  assert.equal(calls.at(-1).parameters.pageToken, 'events2');
  assert.match(calls.at(-1).path, /a%40example.com/);
});

test('同步游標與日期篩選分開，410 只重建該來源，失敗不修改舊快取', async () => {
  const previous = {key: 'only-source', syncToken: 'old', events: [event], updatedAt: '', views: []};
  const calls = [];
  const api = new CalendarApi(async (path, parameters) => {
    calls.push(parameters);
    if (parameters.syncToken) throw new GoogleHttpError(410);
    return parameters.singleEvents === 'true' ? {items: [raw]} : {items: [{...raw, id: 'new'}], nextSyncToken: 'renewed'};
  });
  const synced = await api.sync(source.calendarId, previous);
  assert.equal(synced.events[0].id, 'new');
  assert.equal(previous.events[0].id, 'event');
  await api.instances(source.calendarId, calendarRange('2026-10-01', '2026-10-31'));
  assert.equal(calls[0].timeMin, undefined);
  assert.equal(calls[0].singleEvents, 'false');
  assert.equal(calls[1].syncToken, undefined);
  assert.equal(calls[2].syncToken, undefined);
  assert.ok(calls[2].timeMin && calls[2].timeMax);
  const failed = new CalendarApi(async () => { throw new GoogleHttpError(403); });
  await assert.rejects(failed.sync(source.calendarId, previous), /權限/);
  assert.equal(previous.syncToken, 'old');
});

test('活動分頁中途失敗與循環分頁拒絕套用不完整結果', async () => {
  const api = new CalendarApi(async (path, parameters) => { if (parameters.pageToken) throw new GoogleHttpError(500); return {items: [raw], nextPageToken: 'page2'}; });
  await assert.rejects(api.sync('calendar'), /Google/);
  const loop = new CalendarApi(async () => ({items: [], nextPageToken: 'repeat'}));
  await assert.rejects(loop.sync('calendar'), /分頁/);
});

test('備份格式 4 攜帶公開 Google 設定，工作空間備份只帶相關來源，舊檔忽略夾帶設定', () => {
  const state = {version: 1, activeWorkspaceId: 'work', workspaces: [emptyWorkspace('work', '學程'), emptyWorkspace('other', '其他')]};
  const google = {...DEFAULT_GOOGLE, clientId: '123-example.apps.googleusercontent.com', accountId: 'account', email: 'a@example.com', sources: [{...source, workspaceIds: ['work', 'other']}]};
  const full = createBackup(state, 'full', [], 'standard', google);
  assert.deepEqual(readBackup(full).google, google);
  const selected = createBackup(state, 'workspaces', ['work'], 'standard', google);
  assert.equal(selected.google, undefined);
  assert.deepEqual(readBackup(selected).calendarSources[0].workspaceIds, ['work']);
  const portable = createBackup(state, 'workspaces', ['work'], 'standard', google, true);
  assert.equal(readBackup(portable).google.clientId, google.clientId);
  assert.deepEqual(readBackup(portable).google.sources, []);
  const modified = {...full, google: {...google, client_secret: 'never', access_token: 'never'}};
  assert.equal(JSON.stringify(readBackup(modified)).includes('never'), false);
  for (const formatVersion of [1, 2, 3]) assert.equal(readBackup({...modified, formatVersion}).google, undefined);
});
