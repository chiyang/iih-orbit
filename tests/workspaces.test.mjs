import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COLUMNS } from '../src/app/models.ts';
import { readBoardState } from '../src/app/board-data.ts';
import { boardStatusesForScope, createWorkspaceState, emptyWorkspace, readWorkspaceState, removeBoardStatus, statusKind, updateWorkspaceBoard } from '../src/app/workspace-data.ts';
import { isTaskOverdue, sortTasks } from '../src/app/task-schedule.ts';

const task = {id: 'task', title: '既有任務', description: '保留內容', categoryId: '', status: 'progress', priority: 'medium', startDate: '2026-10-07', startTime: '09:00', dueDate: '2026-10-09', dueTime: '18:00', subtasks: [{id: 'step', title: '小步驟', done: true}]};
const board = {version: 3, projectName: '既有專案', categories: [], statuses: COLUMNS.map(status => ({...status})), tasks: [task]};

test('單看板升級為工作空間，完整保留任務、時間、順序與分類，原始資料不變', () => {
  const legacy = {...board, version: 2, tasks: [task, {...task, id: 'second', status: 'done'}]};
  delete legacy.statuses;
  const original = structuredClone(legacy);
  const state = createWorkspaceState(readBoardState(legacy));
  assert.deepEqual(state.workspaces[0].tasks, legacy.tasks);
  assert.equal(state.workspaces[0].projectName, legacy.projectName);
  assert.deepEqual(state.workspaces[0].statuses.map(status => status.id), ['todo', 'progress', 'review', 'done', 'archived']);
  assert.deepEqual(legacy, original);
});

test('新增工作空間從空白開始，修改選定看板不改動其他工作空間或來源', () => {
  const original = createWorkspaceState(board);
  const second = emptyWorkspace('second', '研究計畫');
  const source = {...original, activeWorkspaceId: second.id, workspaces: [...original.workspaces, second]};
  const updated = updateWorkspaceBoard(source, {...second, projectName: '研究進度', tasks: [{...task, id: 'research'}]});
  assert.deepEqual(updated.workspaces[0], original.workspaces[0]);
  assert.deepEqual(second.tasks, []);
  assert.equal(updated.workspaces[1].tasks[0].id, 'research');
  assert.equal(updated.workspaces[1].name, '研究計畫');
  assert.deepEqual(source.workspaces[1].tasks, []);
});

test('多工作空間、自訂狀態、工作空間選擇經過儲存與讀取完整保留', () => {
  const first = {...board, statuses: [...board.statuses, {id: 'waiting', label: '等待回覆', subtitle: '確認下一步', color: 'pink', kind: 'active', hidden: false}], tasks: [{...task, status: 'waiting'}]};
  const state = createWorkspaceState(first);
  state.workspaces.push(emptyWorkspace('second', '教學安排'));
  state.activeWorkspaceId = 'second';
  assert.deepEqual(readWorkspaceState(JSON.parse(JSON.stringify(state))), state);
});

test('拒絕未知工作空間、重複識別碼、空狀態及任務的無效狀態', () => {
  const state = createWorkspaceState(board);
  assert.equal(readWorkspaceState({...state, activeWorkspaceId: 'missing'}), null);
  assert.equal(readWorkspaceState({...state, workspaces: [...state.workspaces, state.workspaces[0]]}), null);
  assert.equal(readWorkspaceState({...state, workspaces: []}), null);
  assert.equal(readBoardState({...board, statuses: []}), null);
  assert.equal(readBoardState({...board, statuses: [...board.statuses, board.statuses[0]]}), null);
  assert.equal(readBoardState({...board, tasks: [{...task, status: 'missing'}]}), null);
});

test('刪除使用中的狀態會保留任務並轉移，拒絕自己或不存在的目的地', () => {
  const original = structuredClone(board);
  const updated = removeBoardStatus(board, 'progress', 'todo');
  assert.equal(updated.statuses.some(status => status.id === 'progress'), false);
  assert.deepEqual(updated.tasks, [{...task, status: 'todo'}]);
  assert.deepEqual(board, original);
  assert.equal(removeBoardStatus(board, 'progress', 'progress'), null);
  assert.equal(removeBoardStatus(board, 'progress', 'missing'), null);
  assert.equal(removeBoardStatus({...board, statuses: [COLUMNS[0]]}, 'todo', 'progress'), null);
});

test('清單狀態排序遵守自訂欄位順序，包含封存且保留相同值的順序', () => {
  const statuses = [{...COLUMNS[0], id: 'waiting'}, COLUMNS[4], COLUMNS[3]];
  const items = [{...task, id: 'done', status: 'done'}, {...task, id: 'archive', status: 'archived'}, {...task, id: 'first', status: 'waiting'}, {...task, id: 'second', status: 'waiting'}];
  assert.deepEqual(sortTasks(items, [], 'status', 'asc', statuses).map(item => item.id), ['first', 'second', 'archive', 'done']);
  assert.deepEqual(sortTasks(items, [], 'status', 'desc', statuses).map(item => item.id), ['done', 'archive', 'first', 'second']);
});

test('已完成與封存行為依類型判斷，改名或自訂 ID 不會失去語意', () => {
  const statuses = [{...COLUMNS[3], id: 'finished', label: '交付完成'}, {...COLUMNS[4], id: 'history', label: '歷史紀錄'}, COLUMNS[0]];
  assert.equal(statusKind(statuses, 'finished'), 'done');
  assert.equal(statusKind(statuses, 'history'), 'archived');
  assert.equal(isTaskOverdue({...task, status: 'finished'}, new Date(2026, 9, 12), statuses), false);
  assert.equal(isTaskOverdue({...task, status: 'history'}, new Date(2026, 9, 12), statuses), false);
  assert.equal(isTaskOverdue({...task, status: 'todo'}, new Date(2026, 9, 12), statuses), true);
});

test('舊狀態資料預設隱藏封存，保留任務且不改動來源', () => {
  const source = {...board, statuses: board.statuses.map(({hidden, ...status}) => status), tasks: [task, {...task, id: 'archive', status: 'archived'}]};
  const original = structuredClone(source);
  const migrated = readBoardState(source);
  assert.deepEqual(migrated.tasks, source.tasks);
  assert.equal(migrated.statuses.find(status => status.kind === 'archived').hidden, true);
  assert.equal(migrated.statuses.find(status => status.kind === 'active').hidden, false);
  assert.deepEqual(source, original);
});

test('欄位顯示偏好會保留，封存可明確顯示且拒絕無效設定', () => {
  const source = {...board, statuses: board.statuses.map(status => ({...status, hidden: status.id === 'progress'}))};
  assert.deepEqual(readBoardState(JSON.parse(JSON.stringify(source))), source);
  assert.equal(readBoardState({...source, statuses: [{...COLUMNS[0], hidden: 'false'}]}), null);
});

test('專案看板隱藏欄位，各任務檢視仍可找到對應狀態，全部隱藏亦可處理', () => {
  const statuses = board.statuses.map(status => ({...status, hidden: status.id === 'progress' || status.kind === 'archived'}));
  assert.deepEqual(boardStatusesForScope(statuses, 'all').map(status => status.id), ['todo', 'review', 'done']);
  assert.deepEqual(boardStatusesForScope(statuses, 'active').map(status => status.id), ['todo', 'progress', 'review']);
  assert.deepEqual(boardStatusesForScope(statuses, 'done').map(status => status.id), ['done']);
  assert.deepEqual(boardStatusesForScope(statuses, 'archived').map(status => status.id), ['archived']);
  assert.deepEqual(boardStatusesForScope(statuses.map(status => ({...status, hidden: true})), 'all'), []);
});
