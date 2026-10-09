import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dateKey, isTaskOverdue, monthDates, scheduleError, sortTasks, taskOccursOn, validDate, weekDates } from '../src/app/task-schedule.ts';
import { readBoardState } from '../src/app/board-data.ts';
import { COLUMNS } from '../src/app/models.ts';

const categories = [{id: 'design', name: '介面設計', color: 'violet'}];
function task(overrides = {}) {
  return {id: 'task', title: '任務', description: '', categoryId: 'design', projectId: '', status: 'todo', priority: 'medium', startDate: '', startTime: '', dueDate: '', dueTime: '', subtasks: [], ...overrides};
}

test('升級舊看板時保留不同成員的全部任務、子任務、分類與順序', () => {
  const legacy = {
    version: 1,
    projectName: '既有專案',
    categories,
    tasks: [
      {id: 'a', title: 'Mia 的任務', description: '保留內容', categoryId: 'design', projectId: '', status: 'progress', priority: 'high', assignee: 'mia', dueDate: '2026-10-09', subtasks: [{id: 's', title: '步驟', done: true}]},
      {id: 'b', title: '未指派任務', description: '', categoryId: '', status: 'done', priority: 'low', assignee: '', dueDate: '', subtasks: []}
    ]
  };
  const original = structuredClone(legacy);
  const migrated = readBoardState(legacy);
  assert.equal(migrated.version, 4);
  assert.deepEqual(migrated.statuses, COLUMNS);
  assert.equal(migrated.projects[0].name, legacy.projectName);
  assert.equal(migrated.tasks[0].projectId, migrated.projects[0].id);
  assert.deepEqual(migrated.tasks.map(item => item.id), ['a', 'b']);
  assert.equal(migrated.tasks[0].dueDate, '2026-10-09');
  assert.deepEqual(migrated.tasks[0].subtasks, legacy.tasks[0].subtasks);
  assert.deepEqual(migrated.categories, categories);
  assert.equal(migrated.tasks[0].startDate, '');
  assert.equal(migrated.tasks[0].dueTime, '');
  assert.equal('assignee' in migrated.tasks[0], false);
  assert.deepEqual(legacy, original);
});

test('新版看板讀取後保留開始與截止時間', () => {
  const state = {version: 2, projectName: '時間排程', categories, tasks: [task({startDate: '2026-10-08', startTime: '09:15', dueDate: '2026-10-09', dueTime: '17:30'})]};
  assert.deepEqual(readBoardState(state), {version: 4, projects: [{id: 'project-legacy', name: '時間排程'}], categories, statuses: COLUMNS, tasks: state.tasks.map(item => ({...item, projectId: 'project-legacy'}))});
});

test('拒絕無效日期、時間、重複 ID 與未知格式', () => {
  const state = {version: 2, projectName: '專案', categories, tasks: [task()]};
  assert.equal(readBoardState({...state, version: 99}), null);
  assert.equal(readBoardState({...state, tasks: [task(), task()]}), null);
  assert.equal(readBoardState({...state, tasks: [task({dueDate: '2026-02-30'})]}), null);
  assert.equal(readBoardState({...state, tasks: [task({dueDate: '2026-10-08', dueTime: '24:00'})]}), null);
  assert.equal(readBoardState(null), null);
});

test('同日截止時間不得早於開始時間，未指定截止時間可到當日結束', () => {
  assert.match(scheduleError(task({startDate: '2026-10-08', startTime: '18:00', dueDate: '2026-10-08', dueTime: '17:59'})), /不能早於/);
  assert.equal(scheduleError(task({startDate: '2026-10-08', startTime: '23:59', dueDate: '2026-10-08'})), '');
  assert.equal(scheduleError(task({startDate: '2026-10-08', startTime: '09:00', dueDate: '2026-10-08', dueTime: '09:00'})), '');
  assert.match(scheduleError(task({startDate: '2026-10-09', dueDate: '2026-10-08'})), /不能早於/);
  assert.match(scheduleError(task({startTime: '09:00'})), /先選擇日期/);
});

test('全天截止在當天仍有效，指定時間則依實際時刻判斷', () => {
  const now = new Date(2026, 9, 8, 15, 30);
  assert.equal(isTaskOverdue(task({dueDate: '2026-10-08'}), now), false);
  assert.equal(isTaskOverdue(task({dueDate: '2026-10-08', dueTime: '15:00'}), now), true);
  assert.equal(isTaskOverdue(task({dueDate: '2026-10-08', dueTime: '16:00'}), now), false);
  assert.equal(isTaskOverdue(task({dueDate: '2026-10-07', status: 'done'}), now), false);
  assert.equal(isTaskOverdue(task({dueDate: '2026-10-07'}), now), true);
});

test('日期排序包含時間，無日期任務在兩種排序方向都排在最後', () => {
  const items = [
    task({id: 'blank'}),
    task({id: 'all-day', dueDate: '2026-10-08'}),
    task({id: 'late', dueDate: '2026-10-08', dueTime: '23:59'}),
    task({id: 'early', dueDate: '2026-10-08', dueTime: '08:00'})
  ];
  assert.deepEqual(sortTasks(items, categories, 'dueDate', 'asc').map(item => item.id), ['early', 'late', 'all-day', 'blank']);
  assert.deepEqual(sortTasks(items, categories, 'dueDate', 'desc').map(item => item.id), ['all-day', 'late', 'early', 'blank']);
  assert.deepEqual(items.map(item => item.id), ['blank', 'all-day', 'late', 'early']);
});

test('開始日期與時間排序，以及還原看板順序', () => {
  const items = [task({id: 'b', startDate: '2026-10-08', startTime: '10:00'}), task({id: 'a', startDate: '2026-10-08', startTime: '09:00'}), task({id: 'c'})];
  assert.deepEqual(sortTasks(items, categories, 'startDate', 'asc').map(item => item.id), ['a', 'b', 'c']);
  assert.deepEqual(sortTasks(items, categories, null, 'asc').map(item => item.id), ['b', 'a', 'c']);
});

test('優先順序按高、中、低排序，相同優先順序維持原本順序', () => {
  const items = [task({id: 'low', priority: 'low'}), task({id: 'high1', priority: 'high'}), task({id: 'medium'}), task({id: 'high2', priority: 'high'})];
  assert.deepEqual(sortTasks(items, categories, 'priority', 'asc').map(item => item.id), ['high1', 'high2', 'medium', 'low']);
  assert.deepEqual(sortTasks(items, categories, 'priority', 'desc').map(item => item.id), ['low', 'medium', 'high1', 'high2']);
});

test('跨月與跨年任務在區間內每一天顯示，包含首尾日期', () => {
  const spanning = task({startDate: '2026-12-30', dueDate: '2027-01-02'});
  for (const day of ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']) assert.equal(taskOccursOn(spanning, day), true);
  assert.equal(taskOccursOn(spanning, '2026-12-29'), false);
  assert.equal(taskOccursOn(spanning, '2027-01-03'), false);
  assert.equal(taskOccursOn(task({dueDate: '2026-10-08'}), '2026-10-08'), true);
  assert.equal(taskOccursOn(task({startDate: '2026-10-08'}), '2026-10-08'), true);
  assert.equal(taskOccursOn(task(), '2026-10-08'), false);
});

test('月曆以週日開始，正確包含閏日與完整週數', () => {
  const days = monthDates(new Date(2024, 1, 15));
  assert.equal(days[0].getDay(), 0);
  assert.equal(days.length % 7, 0);
  assert.equal(days.filter(day => day.getMonth() === 1).length, 29);
  assert.equal(validDate('2024-02-29'), true);
  assert.equal(validDate('2026-02-29'), false);
  assert.equal(monthDates(new Date(2026, 1, 15)).length, 28);
  assert.equal(monthDates(new Date(2026, 2, 15)).length, 35);
  assert.equal(monthDates(new Date(2026, 7, 15)).length, 42);
});

test('週視圖維持週日至週六並正確跨年，週日屬於新的一週', () => {
  assert.deepEqual(weekDates(new Date(2027, 0, 1)).map(dateKey), ['2026-12-27', '2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
  assert.equal(dateKey(weekDates(new Date(2026, 9, 11))[0]), '2026-10-11');
  assert.equal(dateKey(weekDates(new Date(2026, 9, 10))[0]), '2026-10-04');
});
