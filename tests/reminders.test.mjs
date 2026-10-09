import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_REMINDERS, deadlineState, readReminders } from '../src/app/reminder-data.ts';
import { itemsForReminderTab, reminderItems, startPopupCandidates, startWindow } from '../src/app/reminder-items.ts';
import { ReminderDelivery, REMINDER_DELIVERY_KEY } from '../src/app/reminder-delivery.ts';
import { COLUMNS } from '../src/app/models.ts';
import { externalEvent, calendarMonthRange } from '../src/app/google-data.ts';
import { dateKey } from '../src/app/task-schedule.ts';

const task = {id: 'task', title: '截止任務', description: '', categoryId: '', projectId: '', status: 'todo', priority: 'medium', startDate: '', startTime: '', dueDate: '2026-10-09', dueTime: '', subtasks: []};

test('截止提醒依實際日期時間及當天結束判斷，範圍包含邊界且排除無截止日期', () => {
  const now = new Date(2026, 9, 9, 12);
  assert.equal(deadlineState(task, now, 3), 'due-soon');
  assert.equal(deadlineState({...task, dueTime: '11:59'}, now, 3), 'overdue');
  assert.equal(deadlineState({...task, dueTime: '12:00'}, now, 3), 'due-soon');
  assert.equal(deadlineState({...task, dueDate: '2026-10-12', dueTime: '12:00'}, now, 3), 'due-soon');
  assert.equal(deadlineState({...task, dueDate: '2026-10-12', dueTime: '12:01'}, now, 3), null);
  assert.equal(deadlineState({...task, dueDate: '2026-10-12'}, now, 3), null);
  assert.equal(deadlineState({...task, dueDate: '', dueTime: ''}, now, 3), null);
  assert.equal(deadlineState(task, new Date(2026, 9, 10), 3), 'overdue');
});

test('完成與封存任務不提醒，自訂狀態依類型判斷，分類名稱不影響截止', () => {
  const now = new Date(2026, 9, 10);
  assert.equal(deadlineState({...task, status: 'done'}, now, 3), null);
  assert.equal(deadlineState({...task, status: 'archived'}, now, 3), null);
  const statuses = [{id: 'finished', kind: 'done'}, {id: 'stored', kind: 'archived'}, {id: 'waiting', kind: 'active'}];
  assert.equal(deadlineState({...task, status: 'finished'}, now, 3, statuses), null);
  assert.equal(deadlineState({...task, status: 'stored'}, now, 3, statuses), null);
  assert.equal(deadlineState({...task, status: 'waiting'}, now, 3, statuses), 'overdue');
});

test('提醒範圍只接受 1–30 天整數，過濾未定義欄位', () => {
  assert.deepEqual(readReminders({...DEFAULT_REMINDERS, token: 'ignored'}), DEFAULT_REMINDERS);
  assert.deepEqual(readReminders({dueSoonDays: 1}), {...DEFAULT_REMINDERS, dueSoonDays: 1});
  assert.deepEqual(readReminders({dueSoonDays: 30}), {...DEFAULT_REMINDERS, dueSoonDays: 30});
  for (const dueSoonDays of [0, 31, 1.5, null, '3', NaN, Infinity]) assert.equal(readReminders({dueSoonDays}), null);
});

const workspace = tasks => ({version: 4, id: 'workspace', name: '學程', projects: [], categories: [], statuses: COLUMNS, tasks});
function google(id, start, end) {
  return externalEvent({id: 'source', accountId: 'account', calendarId: 'calendar', name: 'Google', color: '#345678', visible: true, workspaceIds: ['workspace']}, {id, start, end});
}

test('舊提醒設定補上預設提示選項，非法時間、布林與提前分鐘拒絕，未知欄位不保存', () => {
  assert.deepEqual(readReminders({dueSoonDays: 7}), {...DEFAULT_REMINDERS, dueSoonDays: 7});
  const preferences = {...DEFAULT_REMINDERS, popupEnabled: false, includeGoogle: false, leadMinutes: 60, allDayTime: '08:30'};
  assert.deepEqual(readReminders({...preferences, token: 'ignored'}), preferences);
  for (const patch of [{leadMinutes: 5}, {leadMinutes: '15'}, {popupEnabled: 'true'}, {includeGoogle: null}, {allDayTime: ''}, {allDayTime: '24:00'}]) assert.equal(readReminders({...DEFAULT_REMINDERS, ...patch}), null);
});

test('明天與下週採日曆日期，週日屬於當週，正確跨月與跨年', () => {
  const tomorrow = startWindow(new Date(2026, 11, 31, 23), 'tomorrow');
  assert.equal(dateKey(new Date(tomorrow.start)), '2027-01-01');
  assert.equal(dateKey(new Date(tomorrow.end)), '2027-01-02');
  const next = startWindow(new Date(2026, 9, 9), 'next-week');
  assert.equal(dateKey(new Date(next.start)), '2026-10-11'); assert.equal(dateKey(new Date(next.end)), '2026-10-18');
  assert.match(next.label, /週日至週六/);
  assert.equal(dateKey(new Date(startWindow(new Date(2026, 9, 11), 'next-week').start)), '2026-10-18');
  assert.equal(dateKey(new Date(startWindow(new Date(2026, 11, 31), 'next-week').start)), '2027-01-03');
});

test('明天及下週開始包含全天 Google 與本機，排除完成封存、只有截止及已開始的跨日項目', () => {
  const tasks = [
    {...task, id: 'all', startDate: '2026-10-10', dueDate: '2026-10-12'},
    {...task, id: 'timed', startDate: '2026-10-10', startTime: '10:00', dueDate: '2026-10-10'},
    {...task, id: 'done', status: 'done', startDate: '2026-10-10'},
    {...task, id: 'archive', status: 'archived', startDate: '2026-10-10'},
    {...task, id: 'ongoing', startDate: '2026-10-08', dueDate: '2026-10-12'},
    {...task, id: 'week-start', startDate: '2026-10-11', dueDate: '2026-10-11'},
    {...task, id: 'week-last', startDate: '2026-10-17', dueDate: '2026-10-17'},
    {...task, id: 'following', startDate: '2026-10-18', dueDate: '2026-10-18'},
    {...task, id: 'deadline-only', dueDate: '2026-10-10'}
  ];
  const external = google('all-day', {date: '2026-10-10'}, {date: '2026-10-13'});
  const state = workspace(tasks), items = reminderItems(state, 'generation', [external, external]);
  const tomorrow = itemsForReminderTab(items, 'tomorrow', new Date(2026, 9, 9), 3, state);
  assert.equal(tomorrow.length, 3); assert.equal(tomorrow.filter(item => item.allDay).length, 2);
  assert.equal(tomorrow.at(-1).task.id, 'timed');
  assert.deepEqual(itemsForReminderTab(items, 'next-week', new Date(2026, 9, 9), 3, state).map(item => item.task.id), ['week-start', 'week-last']);
  assert.equal(reminderItems(state, 'generation', [{...external, source: {...external.source, visible: false}}]).some(item => item.external), false);
  assert.equal(reminderItems(state, 'generation', [{...external, source: {...external.source, workspaceIds: ['other']}}]).some(item => item.external), false);
});

test('1、3、7、30 天到期範圍保持截止排序，外部活動不作到期任務', () => {
  const tasks = [30, 7, 3, 1].map(days => ({...task, id: String(days), dueDate: dateKey(new Date(2026, 9, 9 + days)), dueTime: '12:00'}));
  const state = workspace(tasks), external = google('event', {date: '2026-10-09'}, {date: '2026-10-10'});
  const items = reminderItems(state, 'generation', [external]);
  for (const days of [1, 3, 7, 30]) assert.deepEqual(itemsForReminderTab(items, 'due-soon', new Date(2026, 9, 9, 12), days, state).map(item => item.task.id), [1, 3, 7, 30].filter(value => value <= days).map(String));
});

test('開始提示符合提前時間與五分鐘補提示，全天指定時刻後當天一次，改期使用新識別', () => {
  const state = workspace([{...task, startDate: '2026-10-09', startTime: '10:00'}]);
  const items = reminderItems(state, 'generation', []);
  assert.equal(startPopupCandidates(items, new Date(2026, 9, 9, 9, 29, 59), DEFAULT_REMINDERS).length, 0);
  const popup = startPopupCandidates(items, new Date(2026, 9, 9, 9, 30), DEFAULT_REMINDERS)[0];
  assert.ok(popup); assert.equal(startPopupCandidates(items, new Date(2026, 9, 9, 10, 5), DEFAULT_REMINDERS).length, 1);
  assert.equal(startPopupCandidates(items, new Date(2026, 9, 9, 10, 5, 1), DEFAULT_REMINDERS).length, 0);
  assert.equal(startPopupCandidates(items, new Date(2026, 9, 9, 9), {...DEFAULT_REMINDERS, leadMinutes: 60}).length, 1);
  assert.equal(startPopupCandidates(items, new Date(2026, 9, 9, 9, 45), {...DEFAULT_REMINDERS, popupEnabled: false}).length, 0);
  const changed = reminderItems(workspace([{...state.tasks[0], startTime: '10:15'}]), 'generation', []);
  assert.notEqual(startPopupCandidates(changed, new Date(2026, 9, 9, 10), DEFAULT_REMINDERS)[0].key, popup.key);
  const allDay = reminderItems(workspace([{...state.tasks[0], startTime: ''}]), 'generation', []);
  assert.equal(startPopupCandidates(allDay, new Date(2026, 9, 9, 8, 59), DEFAULT_REMINDERS).length, 0);
  assert.equal(startPopupCandidates(allDay, new Date(2026, 9, 9, 23, 59), DEFAULT_REMINDERS).length, 1);
  assert.equal(startPopupCandidates(allDay, new Date(2026, 9, 10), DEFAULT_REMINDERS).length, 0);
});

test('Google 提示可獨立關閉，但明天與下週清單仍含顯示的來源，午夜及真實開始時刻保持正確', () => {
  const external = google('timed', {dateTime: '2026-10-09T00:00:00+08:00'}, {dateTime: '2026-10-09T01:00:00+08:00'});
  const items = reminderItems(workspace([]), 'generation', [external]);
  assert.equal(items[0].start, Date.parse('2026-10-09T00:00:00+08:00'));
  const now = new Date(items[0].start - 60000);
  assert.equal(startPopupCandidates(items, now, DEFAULT_REMINDERS).length, 1);
  assert.equal(startPopupCandidates(items, now, {...DEFAULT_REMINDERS, includeGoogle: false}).length, 0);
});

test('月曆提醒查詢涵蓋每一天的明天及下週，包含跨月、跨年與閏日', () => {
  for (const year of [2024, 2026, 2027]) for (let month = 0; month < 12; month++) {
    const length = new Date(year, month + 1, 0).getDate();
    for (let day = 1; day <= length; day++) {
      const now = new Date(year, month, day), range = calendarMonthRange(now), next = startWindow(now, 'next-week');
      assert.ok(Date.parse(range.start) <= next.start); assert.ok(Date.parse(range.end) >= next.end);
      assert.ok(Date.parse(range.end) >= startWindow(now, 'tomorrow').end);
    }
  }
});

test('多分頁共用提示識別，並行只取得一次，重新整理保留，過期清理且不存標題或憑證', async () => {
  const values = new Map();
  const storage = {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value)};
  let chain = Promise.resolve();
  const lock = operation => { const next = chain.then(operation); chain = next.catch(() => {}); return next; };
  const first = new ReminderDelivery(storage, lock), second = new ReminderDelivery(storage, lock);
  assert.deepEqual(await Promise.all([first.claim('event-start-1', 500, 100), second.claim('event-start-1', 500, 100)]), [true, false]);
  assert.equal(await new ReminderDelivery(storage, lock).claim('event-start-1', 500, 100), false);
  assert.equal(await second.claim('event-start-2', 900, 600), true);
  assert.deepEqual(JSON.parse(values.get(REMINDER_DELIVERY_KEY)), [{key: 'event-start-2', expires: 900}]);
  assert.equal(await first.claim('already-expired', 100, 600), false);
  values.set(REMINDER_DELIVERY_KEY, 'invalid JSON'); assert.equal(await first.claim('new', 900, 600), true);
  const failed = new ReminderDelivery({getItem: () => null, setItem() { throw new Error('quota'); }}, lock);
  await assert.rejects(failed.claim('blocked', 900, 600), /quota/);
});
