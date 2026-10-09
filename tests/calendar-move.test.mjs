import assert from 'node:assert/strict';
import { test } from 'node:test';
import { moveCalendarTask, snapCalendarMinute } from '../src/app/calendar-move.ts';

const schedule = {startDate: '2026-10-09', startTime: '09:00', dueDate: '2026-10-09', dueTime: '10:30'};
const position = (day, minute, kind = 'time') => ({day, minute, kind});

test('月曆拖曳保留日期跨度與時間，跨月跨年及閏年日期皆正確', () => {
  assert.deepEqual(moveCalendarTask(schedule, position('2026-10-09', undefined, 'month'), position('2026-11-01', undefined, 'month')), {...schedule, startDate: '2026-11-01', dueDate: '2026-11-01'});
  const multi = {...schedule, startDate: '2026-12-30', dueDate: '2027-01-02'};
  assert.deepEqual(moveCalendarTask(multi, position('2027-01-01', undefined, 'month'), position('2026-12-29', undefined, 'month')), {...multi, startDate: '2026-12-27', dueDate: '2026-12-30'});
  assert.equal(moveCalendarTask(schedule, position('2026-10-09', undefined, 'month'), position('2028-02-29', undefined, 'month')).dueDate, '2028-02-29');
});

test('週時間拖曳以 15 分鐘定位，保留 90 分鐘長度，跨午夜自動調整截止日期', () => {
  const result = moveCalendarTask(schedule, position('2026-10-09', 540), position('2026-10-10', 1400));
  assert.deepEqual(result, {startDate: '2026-10-10', startTime: '23:15', dueDate: '2026-10-11', dueTime: '00:45'});
  assert.deepEqual([snapCalendarMinute(-99), snapCalendarMinute(547), snapCalendarMinute(548), snapCalendarMinute(1450)], [0, 540, 555, 1425]);
});

test('跨日任務從末日片段拖曳，整個區間一起平移，不把末日當成開始日', () => {
  const task = {...schedule, dueDate: '2026-10-10', dueTime: '10:00'};
  assert.deepEqual(moveCalendarTask(task, position('2026-10-10', 0), position('2026-10-12', 60)), {startDate: '2026-10-11', startTime: '10:00', dueDate: '2026-10-12', dueTime: '11:00'});
});

test('只有開始或截止的任務保留單一邊界，未排程任務拖入後設定截止標記', () => {
  const start = {...schedule, dueDate: '', dueTime: ''};
  assert.deepEqual(moveCalendarTask(start, position('2026-10-09', 540), position('2026-10-10', 600)), {...start, startDate: '2026-10-10', startTime: '10:00'});
  const due = {...schedule, startDate: '', startTime: ''};
  assert.deepEqual(moveCalendarTask(due, position('2026-10-09', 630), position('2026-10-10', 600)), {...due, dueDate: '2026-10-10', dueTime: '10:00'});
  const empty = {startDate: '', startTime: '', dueDate: '', dueTime: ''};
  assert.deepEqual(moveCalendarTask(empty, position('2026-10-09', undefined, 'all-day'), position('2026-10-12', 600)), {...empty, dueDate: '2026-10-12', dueTime: '10:00'});
});

test('時間任務移至全天區移除時間，全天區的跨日片段橫向移動保留原時間', () => {
  assert.deepEqual(moveCalendarTask(schedule, position('2026-10-09', 540), position('2026-10-10', undefined, 'all-day')), {startDate: '2026-10-10', startTime: '', dueDate: '2026-10-10', dueTime: ''});
  const multi = {...schedule, dueDate: '2026-10-12'};
  assert.deepEqual(moveCalendarTask(multi, position('2026-10-10', undefined, 'all-day'), position('2026-10-11', undefined, 'all-day')), {...multi, startDate: '2026-10-10', dueDate: '2026-10-13'});
});

test('全天任務拖入時間區單日預設一小時，多日保留日數；單一日期仍是標記', () => {
  const allDay = {...schedule, startTime: '', dueTime: ''};
  assert.deepEqual(moveCalendarTask(allDay, position('2026-10-09', undefined, 'all-day'), position('2026-10-10', 1380)), {...schedule, startDate: '2026-10-10', startTime: '23:00', dueDate: '2026-10-11', dueTime: '00:00'});
  assert.deepEqual(moveCalendarTask({...allDay, dueDate: '2026-10-11'}, position('2026-10-10', undefined, 'all-day'), position('2026-10-13', 600)), {startDate: '2026-10-12', startTime: '10:00', dueDate: '2026-10-15', dueTime: '10:00'});
  assert.deepEqual(moveCalendarTask({...allDay, startDate: ''}, position('2026-10-09', undefined, 'all-day'), position('2026-10-10', 600)), {startDate: '', startTime: '', dueDate: '2026-10-10', dueTime: '10:00'});
});

test('選填時間與同時刻標記保持原有邊界語意，移動不改動來源', () => {
  const original = structuredClone(schedule);
  assert.deepEqual(moveCalendarTask({...schedule, dueTime: ''}, position('2026-10-09', 540), position('2026-10-10', 600)), {startDate: '2026-10-10', startTime: '10:00', dueDate: '2026-10-10', dueTime: ''});
  const milestone = {...schedule, dueTime: '09:00'};
  const moved = moveCalendarTask(milestone, position('2026-10-09', 540), position('2026-10-10', 600));
  assert.equal(moved.startTime, moved.dueTime); assert.deepEqual(schedule, original);
});

test('跨夏令時間切換仍以本機日曆日期及牆上時間平移', () => {
  const timezone = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const task = {...schedule, startDate: '2026-10-31', dueDate: '2026-10-31'};
    assert.deepEqual(moveCalendarTask(task, position('2026-10-31', 540), position('2026-11-01', 540)), {...task, startDate: '2026-11-01', dueDate: '2026-11-01'});
  } finally { if (timezone === undefined) delete process.env.TZ; else process.env.TZ = timezone; }
});

test('拒絕無效來源、目的日期及不合法時間，不產生倒置的時程', () => {
  assert.throws(() => moveCalendarTask(schedule, position('2026-10-09', 540), position('2026-02-30', 600)), /不合法/);
  assert.throws(() => moveCalendarTask(schedule, position('2026-10-09', 540), position('2026-10-10', NaN)), /時間/);
  assert.throws(() => moveCalendarTask({...schedule, dueTime: '08:00'}, position('2026-10-09', 540), position('2026-10-10', 600)), /不合法/);
  assert.throws(() => moveCalendarTask(schedule, position('2026-10-09', undefined, 'month'), position('1899-12-31', undefined, 'month')), /不合法/);
});
