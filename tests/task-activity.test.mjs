import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COLUMNS } from '../src/app/models.ts';
import { readBoardState } from '../src/app/board-data.ts';
import { readBackup, createBackup, copyWorkspaces } from '../src/app/backup-data.ts';
import { recordTaskEdits, recentTasks, recentlyEdited, validTaskEditTime } from '../src/app/task-activity-data.ts';

const task = {id: 'task', title: '任務', description: '', projectId: '', categoryId: '', status: 'todo', priority: 'medium', startDate: '', startTime: '', dueDate: '', dueTime: '', subtasks: []};
const board = {version: 4, projects: [], categories: [], statuses: COLUMNS, tasks: [task]};

test('舊資料保留原形，釘選與編輯時間隨備份及工作空間副本往返，非法欄位拒絕', () => {
  assert.deepEqual(readBoardState(board), board);
  const tracked = {...task, pinned: true, updatedAt: '2026-10-11T02:00:00.000Z', deletedAt: '2026-10-11T03:00:00.000Z'};
  assert.deepEqual(readBoardState({...board, tasks: [tracked]}).tasks, [tracked]);
  const workspace = {...board, id: 'workspace', name: '工作', tasks: [tracked]};
  const backup = createBackup({version: 1, activeWorkspaceId: workspace.id, workspaces: [workspace]}, 'full');
  assert.deepEqual(readBackup(backup).data.workspaces[0].tasks, [tracked]);
  const copy = copyWorkspaces([workspace])[0].tasks[0];
  assert.notEqual(copy.id, task.id); assert.equal(copy.pinned, true); assert.equal(copy.updatedAt, tracked.updatedAt); assert.equal(copy.deletedAt, tracked.deletedAt);
  for (const extra of [{pinned: 'true'}, {updatedAt: 'invalid'}, {updatedAt: '2026-02-30T02:00:00.000Z'}, {updatedAt: 0}, {deletedAt: ''}, {deletedAt: 'invalid'}, {deletedAt: 0}]) {
    assert.equal(readBoardState({...board, tasks: [{...task, ...extra}]}), null);
  }
});

test('只有建立或內容修改更新時間，釘選、同欄排序與未修改儲存保留時間', () => {
  const first = new Date('2026-10-10T02:00:00.000Z'), second = new Date('2026-10-11T03:00:00.000Z');
  const created = recordTaskEdits([], [task], first)[0];
  assert.equal(created.updatedAt, first.toISOString());
  const pinned = recordTaskEdits([created], [{...created, pinned: true}], second)[0];
  assert.equal(pinned.updatedAt, created.updatedAt); assert.equal(pinned.pinned, true);
  assert.deepEqual(recordTaskEdits([created], [created], second), [created]);
  const other = {...created, id: 'other'};
  assert.deepEqual(recordTaskEdits([created, other], [other, created], second), [other, created]);
  for (const change of [{title: '新名稱'}, {description: '新增描述'}, {status: 'done'}, {dueDate: '2026-10-12'}, {subtasks: [{id: 'child', title: '子任務', done: true}]}]) {
    assert.equal(recordTaskEdits([created], [{...created, ...change}], second)[0].updatedAt, second.toISOString());
  }
  assert.equal(recordTaskEdits([task], [{...task, pinned: true}], second)[0].updatedAt, undefined);
  assert.equal(recordTaskEdits([created], [{...created, updatedAt: second.toISOString()}], second)[0].updatedAt, created.updatedAt);
});

test('最近編輯列最新 20 筆且不修改來源，七天篩選使用本機日期並排除舊資料與未來日期', () => {
  const tasks = Array.from({length: 22}, (_, index) => ({...task, id: String(index), updatedAt: new Date(2026, 9, index + 1, 10).toISOString()}));
  const before = structuredClone(tasks), recent = recentTasks([task, ...tasks]);
  assert.equal(recent.length, 20); assert.equal(recent[0].id, '21'); assert.equal(recent[19].id, '2'); assert.deepEqual(tasks, before);
  const now = new Date(2026, 9, 11, 12);
  for (const [date, expected] of [[new Date(2026, 9, 4, 23, 59), false], [new Date(2026, 9, 5), true], [new Date(2026, 9, 11, 23, 59), true], [new Date(2026, 9, 12), false]]) {
    assert.equal(recentlyEdited({...task, updatedAt: date.toISOString()}, now), expected);
  }
  assert.equal(recentlyEdited(task, now), false); assert.equal(validTaskEditTime('invalid'), false);
});
