import assert from 'node:assert/strict';
import { test } from 'node:test';
import { layoutAllDayTasks, minuteLabel, timedEventsInRange, timedEventsOnDay } from '../src/app/week-layout.ts';

const days = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'];
function task(overrides = {}) {
  return {id: 'task', title: '任務', description: '', categoryId: '', status: 'todo', priority: 'medium', startDate: '', startTime: '', dueDate: '', dueTime: '', subtasks: [], ...overrides};
}

test('限制週時段只裁切顯示，保留原始時間，邊界點事件及很短的時段外安排不誤入', () => {
  const day = days[0], tasks = [
    task({id: 'before', startDate: day, dueDate: day, startTime: '07:50', dueTime: '07:55'}),
    task({id: 'before-point', dueDate: day, dueTime: '07:50'}),
    task({id: 'first', startDate: day, startTime: '08:00'}),
    task({id: 'cross', startDate: day, dueDate: day, startTime: '07:00', dueTime: '20:00'}),
    task({id: 'last', dueDate: day, dueTime: '18:59'}),
    task({id: 'after-point', dueDate: day, dueTime: '19:00'})
  ];
  const events = timedEventsOnDay(tasks, day), visible = timedEventsInRange(events, 480, 1140);
  assert.deepEqual(new Set(visible.map(event => event.task.id)), new Set(['first', 'cross', 'last']));
  const cross = visible.find(event => event.task.id === 'cross'); assert.equal(cross.displayStart, 480); assert.equal(cross.displayEnd, 1140); assert.equal(cross.startMinute, 420); assert.equal(cross.endMinute, 1200); assert.equal(cross.label, '07:00 – 20:00');
  assert.equal(visible.find(event => event.task.id === 'last').displayEnd, 1140); assert.equal(visible.every(event => event.displayEnd - event.displayStart >= 30), true);
  assert.deepEqual(timedEventsInRange(events, 0, 1440), events); assert.equal(events.find(event => event.task.id === 'cross').displayStart, 420);
});

test('全天任務跨日期排成橫條，超出週範圍會裁切，衝突分列', () => {
  const items = [
    task({id: 'long', startDate: '2026-10-01', dueDate: '2026-10-07'}),
    task({id: 'overlap', dueDate: '2026-10-06'}),
    task({id: 'later', startDate: '2026-10-08', dueDate: '2026-10-15'}),
    task({id: 'timed', dueDate: '2026-10-08', dueTime: '10:00'}),
    task({id: 'unscheduled'})
  ];
  const events = layoutAllDayTasks(items, days);
  assert.deepEqual(events.map(event => [event.task.id, event.startColumn, event.endColumn, event.row]), [['long', 0, 3, 0], ['overlap', 1, 2, 1], ['later', 3, 7, 0]]);
  assert.equal(events[0].continuesBefore, true);
  assert.equal(events[2].continuesAfter, true);
  assert.deepEqual(layoutAllDayTasks(items, []), []);
});

test('時間任務依實際開始與結束位置及長度呈現', () => {
  const item = task({startDate: '2026-10-08', startTime: '09:15', dueDate: '2026-10-08', dueTime: '11:45'});
  const [event] = timedEventsOnDay([item], '2026-10-08');
  assert.deepEqual([event.startMinute, event.endMinute, event.displayStart, event.displayEnd], [555, 705, 555, 705]);
  assert.equal(event.label, '09:15 – 11:45');
  assert.equal(event.milestone, false);
});

test('跨日時間任務的完整中間日移至全天區，首末日保留實際時段', () => {
  const item = task({startDate: '2026-10-07', startTime: '22:00', dueDate: '2026-10-09', dueTime: '10:00'});
  const [first] = timedEventsOnDay([item], '2026-10-07');
  const middle = timedEventsOnDay([item], '2026-10-08');
  const [last] = timedEventsOnDay([item], '2026-10-09');
  assert.deepEqual([first.startMinute, first.endMinute, first.continuesAfter], [1320, 1440, true]);
  assert.deepEqual(middle, []);
  const [allDay] = layoutAllDayTasks([item], days);
  assert.deepEqual([allDay.startColumn, allDay.endColumn], [3, 4]);
  assert.deepEqual([last.startMinute, last.endMinute, last.continuesBefore], [0, 600, true]);
  assert.equal(timedEventsOnDay([item], '2026-10-10').length, 0);
});

test('連續完整日合併為全天橫條，跨週裁切且不重複占用時間格線', () => {
  const item = task({startDate: '2026-10-03', startTime: '18:00', dueDate: '2026-10-14', dueTime: '10:00'});
  const [event] = layoutAllDayTasks([item], days);
  assert.deepEqual([event.startColumn, event.endColumn, event.continuesBefore, event.continuesAfter], [0, 7, true, true]);
  assert.ok(days.every(day => timedEventsOnDay([item], day).length === 0));
  const nextWeek = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18'];
  const [continuation] = layoutAllDayTasks([item], nextWeek);
  assert.deepEqual([continuation.startColumn, continuation.endColumn, continuation.continuesBefore, continuation.continuesAfter], [0, 2, true, false]);
  assert.equal(timedEventsOnDay([item], '2026-10-14')[0].endMinute, 600);
});

test('00:00 開始可覆蓋完整首日，00:00 截止只計入前一天', () => {
  const item = task({startDate: '2026-10-07', startTime: '00:00', dueDate: '2026-10-09', dueTime: '00:00'});
  const [event] = layoutAllDayTasks([item], days);
  assert.deepEqual([event.startColumn, event.endColumn], [2, 4]);
  for (const day of ['2026-10-07', '2026-10-08', '2026-10-09']) assert.deepEqual(timedEventsOnDay([item], day), []);
  const point = task({startDate: '2026-10-08', startTime: '00:00', dueDate: '2026-10-08', dueTime: '00:00'});
  assert.deepEqual(layoutAllDayTasks([point], days), []);
  assert.equal(timedEventsOnDay([point], '2026-10-08')[0].milestone, true);
});

test('未指定截止時間的最後一日可算全天，23:59 截止仍保留時間區間', () => {
  const openEnd = task({startDate: '2026-10-07', startTime: '22:00', dueDate: '2026-10-09'});
  const [event] = layoutAllDayTasks([openEnd], days);
  assert.deepEqual([event.startColumn, event.endColumn], [3, 5]);
  assert.deepEqual(timedEventsOnDay([openEnd], '2026-10-09'), []);
  const almostFull = task({startDate: '2026-10-08', startTime: '00:00', dueDate: '2026-10-08', dueTime: '23:59'});
  assert.deepEqual(layoutAllDayTasks([almostFull], days), []);
  assert.equal(timedEventsOnDay([almostFull], '2026-10-08')[0].endMinute, 1439);
});

test('跨午夜但沒有完整一天的短任務仍只顯示在時間格線', () => {
  const item = task({startDate: '2026-10-08', startTime: '22:00', dueDate: '2026-10-09', dueTime: '02:00'});
  assert.deepEqual(layoutAllDayTasks([item], days), []);
  assert.equal(timedEventsOnDay([item], '2026-10-08')[0].startMinute, 1320);
  assert.equal(timedEventsOnDay([item], '2026-10-09')[0].endMinute, 120);
});

test('午夜結束不在隔天留下幽靈任務，同時刻事件仍可顯示', () => {
  const overnight = task({startDate: '2026-10-08', startTime: '23:00', dueDate: '2026-10-09', dueTime: '00:00'});
  assert.equal(timedEventsOnDay([overnight], '2026-10-08')[0].endMinute, 1440);
  assert.equal(timedEventsOnDay([overnight], '2026-10-08')[0].continuesAfter, false);
  assert.deepEqual(timedEventsOnDay([overnight], '2026-10-09'), []);
  const point = task({startDate: '2026-10-08', startTime: '00:00', dueDate: '2026-10-08', dueTime: '00:00'});
  assert.equal(timedEventsOnDay([point], '2026-10-08')[0].milestone, true);
});

test('只有一個日期的開始及截止時間是標記，沒有虛構工作時長', () => {
  const items = [task({id: 'start', startDate: '2026-10-08', startTime: '09:00'}), task({id: 'due', dueDate: '2026-10-08', dueTime: '23:59'})];
  const events = timedEventsOnDay(items, '2026-10-08');
  assert.equal(events[0].label, '09:00 開始');
  assert.equal(events[1].label, '23:59 截止');
  assert.ok(events.every(event => event.startMinute === event.endMinute && event.milestone));
  assert.ok(events.every(event => event.displayEnd <= 1440 && event.displayEnd - event.displayStart >= 30));
});

test('日期存在但未填時間的區間邊界採用日初及日末', () => {
  const [end] = timedEventsOnDay([task({startDate: '2026-10-08', dueDate: '2026-10-08', dueTime: '12:00'})], '2026-10-08');
  assert.deepEqual([end.startMinute, end.endMinute], [0, 720]);
  const [start] = timedEventsOnDay([task({startDate: '2026-10-08', startTime: '12:00', dueDate: '2026-10-08'})], '2026-10-08');
  assert.deepEqual([start.startMinute, start.endMinute], [720, 1440]);
  assert.deepEqual(timedEventsOnDay([task({dueDate: '2026-10-08'})], '2026-10-08'), []);
});

test('重疊事件並排，不相交的事件共用欄位，獨立群組恢復完整寬度', () => {
  const items = [
    task({id: 'a', startDate: '2026-10-08', startTime: '09:00', dueDate: '2026-10-08', dueTime: '11:00'}),
    task({id: 'b', startDate: '2026-10-08', startTime: '09:30', dueDate: '2026-10-08', dueTime: '10:30'}),
    task({id: 'c', startDate: '2026-10-08', startTime: '10:30', dueDate: '2026-10-08', dueTime: '12:00'}),
    task({id: 'd', startDate: '2026-10-08', startTime: '14:00', dueDate: '2026-10-08', dueTime: '15:00'})
  ];
  const original = structuredClone(items);
  const events = timedEventsOnDay(items, '2026-10-08');
  assert.deepEqual(events.map(event => [event.task.id, event.column, event.columns]), [['a', 0, 2], ['b', 1, 2], ['c', 1, 2], ['d', 0, 1]]);
  assert.deepEqual(items, original);
});

test('三個同時事件占三欄，短事件與長事件不遮擋', () => {
  const items = [
    task({id: 'long', startDate: '2026-10-08', startTime: '09:00', dueDate: '2026-10-08', dueTime: '12:00'}),
    task({id: 'short1', startDate: '2026-10-08', startTime: '09:05', dueDate: '2026-10-08', dueTime: '09:10'}),
    task({id: 'short2', startDate: '2026-10-08', startTime: '09:15', dueDate: '2026-10-08', dueTime: '09:20'})
  ];
  const events = timedEventsOnDay(items, '2026-10-08');
  assert.deepEqual(events.map(event => event.column), [0, 1, 2]);
  assert.ok(events.every(event => event.columns === 3));
  assert.equal(minuteLabel(1440), '24:00');
});
