import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COLUMNS } from '../src/app/models.ts';
import { readBoardState } from '../src/app/board-data.ts';
import { projectProgress, projectSummaries, tasksForProject } from '../src/app/project-data.ts';
import { sortTasks } from '../src/app/task-schedule.ts';
import { createBackup, copyWorkspaces, readBackup } from '../src/app/backup-data.ts';

const projects = [{id: 'welcome', name: '迎新活動'}, {id: 'website', name: '網站改版'}, {id: 'empty', name: '未啟動專案'}];
const task = {id: 'first', title: '任務', description: '保留內容', projectId: 'welcome', categoryId: '', status: 'todo', priority: 'medium', startDate: '2026-10-07', startTime: '09:00', dueDate: '2026-10-08', dueTime: '10:00', subtasks: []};
const board = {version: 4, projects, categories: [], statuses: COLUMNS, tasks: [task]};

test('舊單一專案轉為任務分組，保留名稱、順序、時程及來源，升級識別碼穩定', () => {
  const old = {version: 3, projectName: '品牌網站改版', categories: [], statuses: COLUMNS, tasks: [task, {...task, id: 'second', status: 'done'}]};
  const original = structuredClone(old);
  const migrated = readBoardState(old);
  assert.equal(migrated.version, 4);
  assert.deepEqual(migrated.projects, [{id: 'project-legacy', name: old.projectName}]);
  assert.deepEqual(migrated.tasks, old.tasks.map(item => ({...item, projectId: 'project-legacy'})));
  assert.deepEqual(readBoardState(old), migrated);
  assert.deepEqual(readBoardState(JSON.parse(JSON.stringify(migrated))), migrated);
  assert.deepEqual(old, original);
});

test('專案資料拒絕重複名稱、識別碼、保留值、遺失欄位及未知任務參照', () => {
  assert.equal(readBoardState({...board, projects: [...projects, projects[0]]}), null);
  assert.equal(readBoardState({...board, projects: [...projects, {id: 'duplicate', name: ' 迎新活動 '}]}), null);
  assert.equal(readBoardState({...board, projects: [{id: 'all', name: '專案'}]}), null);
  assert.equal(readBoardState({...board, projects: undefined}), null);
  assert.equal(readBoardState({...board, tasks: [{...task, projectId: 'missing'}]}), null);
  assert.equal(readBoardState({...board, tasks: [{...task, projectId: undefined}]}), null);
  assert.ok(readBoardState({...board, projects: [], tasks: [{...task, projectId: ''}]}));
});

test('所有專案以任務數加權，個別進度獨立，封存排除且未指定任務仍計入總進度', () => {
  const tasks = [task, {...task, id: 'welcome-done', status: 'done'}, {...task, id: 'archive', status: 'archived'}, {...task, id: 'web', projectId: 'website', status: 'done'}, {...task, id: 'loose', projectId: ''}];
  const total = projectProgress(tasks, COLUMNS, 'all', '所有專案');
  assert.deepEqual([total.completed, total.total, total.taskCount, total.percent], [2, 4, 5, 50]);
  const rows = projectSummaries(tasks, COLUMNS, projects);
  assert.deepEqual(rows.map(row => [row.name, row.percent]), [['迎新活動', 50], ['網站改版', 100], ['未啟動專案', 0], ['未指定專案', 0]]);
  assert.equal(rows[0].taskCount, 3);
  assert.equal(rows[2].total, 0);
  assert.deepEqual(tasksForProject(tasks, 'welcome').map(item => item.id), ['first', 'welcome-done', 'archive']);
  assert.deepEqual(tasksForProject(tasks, '').map(item => item.id), ['loose']);
  assert.equal(tasksForProject(tasks, 'all').length, 5);
});

test('專案進度依自訂完成與封存狀態類型計算，只有封存任務時無除零錯誤', () => {
  const statuses = [{...COLUMNS[3], id: 'finished'}, {...COLUMNS[4], id: 'history'}];
  const tasks = [{...task, status: 'finished'}, {...task, id: 'old', status: 'history'}];
  assert.equal(projectProgress(tasks, statuses, 'welcome', '迎新活動').percent, 100);
  assert.equal(projectProgress([tasks[1]], statuses, 'welcome', '迎新活動').percent, 0);
  assert.equal(projectProgress([], statuses, 'all', '所有專案').percent, 0);
});

test('清單可依專案名稱排序，同專案維持原順序且不改動看板', () => {
  const source = [{...task, id: 'a', projectId: 'website'}, {...task, id: 'b'}, {...task, id: 'c'}];
  const ordered = sortTasks(source, [], 'project', 'asc', COLUMNS, projects);
  assert.equal(ordered.findIndex(item => item.id === 'c'), ordered.findIndex(item => item.id === 'b') + 1);
  assert.deepEqual(sortTasks(source, [], 'project', 'desc', COLUMNS, projects).map(item => item.projectId), [...ordered].reverse().map(item => item.projectId));
  assert.deepEqual(source.map(item => item.id), ['a', 'b', 'c']);
});

test('格式 1 舊備份匯入時升級專案與任務，舊匯出檔仍保持原樣', () => {
  const workspace = {version: 3, id: 'old', name: '學程工作', projectName: '迎新活動', categories: [], statuses: COLUMNS, tasks: [task]};
  const backup = {application: 'iih-orbit', formatVersion: 1, appVersion: '1.1.0', kind: 'workspaces', exportedAt: '2026-10-08T00:00:00Z', data: {version: 1, activeWorkspaceId: 'old', workspaces: [workspace]}};
  const original = structuredClone(backup);
  const restored = readBackup(backup);
  assert.equal(restored.formatVersion, 5);
  assert.equal(restored.data.workspaces[0].projects[0].name, '迎新活動');
  assert.equal(restored.data.workspaces[0].tasks[0].projectId, restored.data.workspaces[0].projects[0].id);
  assert.deepEqual(backup, original);
});

test('專案封存排除整體進度，保留任務與個別專案進度，還原後重新計入', () => {
  const list = [{...projects[0], archived: true}, projects[1]];
  const tasks = [task, {...task, id: 'web', projectId: 'website', status: 'done'}, {...task, id: 'loose', projectId: ''}, {...task, id: 'history', projectId: 'website', status: 'archived'}];
  const snapshot = structuredClone(tasks);
  const total = projectProgress(tasks, COLUMNS, 'all', '所有專案', list);
  assert.deepEqual([total.completed, total.total, total.percent, total.taskCount], [1, 2, 50, 4]);
  const archived = projectProgress(tasks, COLUMNS, 'welcome', '迎新活動', list);
  assert.equal(archived.total, 1); assert.equal(archived.percent, 0);
  assert.equal(projectProgress(tasks, COLUMNS, 'all', '所有專案', projects).percent, 33);
  assert.equal(projectProgress([task], COLUMNS, 'all', '所有專案', list).total, 0);
  assert.equal(projectProgress([task], COLUMNS, 'all', '所有專案', list).percent, 0);
  assert.deepEqual(tasksForProject(tasks, 'all'), snapshot);
  assert.deepEqual(tasks, snapshot);
});

test('封存旗標驗證及備份往返，舊專案沒有旗標時不新增欄位', () => {
  const legacy = readBoardState(board);
  assert.deepEqual(legacy.projects, projects);
  for (const archived of ['false', null, 1]) assert.equal(readBoardState({...board, projects: [{...projects[0], archived}]}), null);
  const archivedBoard = {...board, projects: [{...projects[0], archived: true}, {...projects[1], archived: false}]};
  const workspace = {...archivedBoard, id: 'workspace', name: '學程工作'};
  const state = {version: 1, activeWorkspaceId: workspace.id, workspaces: [workspace]};
  for (const kind of ['full', 'workspaces']) {
    const saved = readBackup(createBackup(state, kind, [workspace.id], 'standard'));
    assert.deepEqual(saved.data.workspaces[0].projects, workspace.projects);
    const copy = copyWorkspaces(saved.data.workspaces)[0];
    assert.equal(copy.projects[0].archived, true);
    assert.notEqual(copy.projects[0].id, workspace.projects[0].id);
    assert.equal(copy.tasks[0].projectId, copy.projects[0].id);
  }
});
