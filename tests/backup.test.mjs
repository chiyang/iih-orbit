import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backupFilename, copyWorkspaces, createBackup, readBackup } from '../src/app/backup-data.ts';
import { createWorkspaceState, emptyWorkspace } from '../src/app/workspace-data.ts';

const task = {id: 'task', title: '跨日任務', description: '內容', categoryId: 'category', projectId: 'project', status: 'todo', priority: 'high', startDate: '2026-10-07', startTime: '22:00', dueDate: '2026-10-10', dueTime: '10:00', subtasks: [{id: 'subtask', title: '第一步', done: true}]};
const first = {...emptyWorkspace('first', '研究計畫'), projects: [{id: 'project', name: '研究專案'}], categories: [{id: 'category', name: '研究', color: 'green'}], tasks: [task]};
const state = {version: 1, activeWorkspaceId: 'first', workspaces: [first, emptyWorkspace('second', '課程安排')]};

test('多組來源的獨立 ID 隨完整備份保存，公開設定選項控制空間備份，未知憑證欄位被移除', () => {
  const driveSources = {version: 1, defaultName: '主要來源', sources: [{id: crypto.randomUUID(), provider: 'google-drive', name: '研究', clientId: '123-research.apps.googleusercontent.com', accountId: 'device-only', token: 'never-export'}, {id: crypto.randomUUID(), provider: 'google-drive', name: '教學', clientId: '456-teaching.apps.googleusercontent.com'}]};
  const full = createBackup(state, 'full', [], undefined, undefined, false, undefined, undefined, driveSources);
  assert.equal(full.formatVersion, 10); assert.deepEqual(readBackup(JSON.parse(JSON.stringify(full))), full);
  assert.deepEqual(full.driveSources.sources.map(source => source.clientId), driveSources.sources.map(source => source.clientId));
  assert.equal(JSON.stringify(full).includes('device-only'), false); assert.equal(JSON.stringify(full).includes('never-export'), false);
  const partial = include => createBackup(state, 'workspaces', ['first'], undefined, undefined, include, undefined, undefined, driveSources);
  assert.equal(partial(false).driveSources, undefined); assert.equal(partial(false).formatVersion, 5); assert.deepEqual(partial(true).driveSources, full.driveSources);
  const downgraded = {...full, formatVersion: 9}; assert.throws(() => readBackup(downgraded), /來源.*新版/);
  for (const invalid of [{...full.driveSources, sources: [full.driveSources.sources[0], full.driveSources.sources[0]]}, {...full.driveSources, sources: [{...full.driveSources.sources[0], clientId: 'bad-id'}]}]) assert.throws(() => readBackup({...full, driveSources: invalid}));
});

test('全部備份往返保留工作資料與主題色，本機深淺主題與六種字級都不匯出', () => {
  for (const textSize of ['extra-small', 'compact', 'small', 'standard', 'large', 'extra-large']) {
    const backup = createBackup(state, 'full', [], {textSize, theme: 'dark', accent: '#3264ad'});
    const restored = readBackup(JSON.parse(JSON.stringify(backup)));
    assert.deepEqual(restored.data, state);
    assert.deepEqual(restored.preferences, {accent: '#3264ad'});
    assert.equal(Object.hasOwn(backup.preferences, 'textSize'), false);
    assert.equal(Object.hasOwn(backup.preferences, 'theme'), false);
    assert.equal(backupFilename(restored), `IIH-Orbit-全部資料-${backup.exportedAt.slice(0, 10)}.json`);
    assert.notEqual(backup.data, state);
  }
});

test('選定工作空間備份只包含指定資料，不攜帶全域偏好，拒絕空選擇與不存在的空間', () => {
  const backup = createBackup(state, 'workspaces', ['second'], 'small');
  assert.deepEqual(backup.data.workspaces, [state.workspaces[1]]);
  assert.equal(backup.data.activeWorkspaceId, 'second');
  assert.equal(backup.preferences, undefined);
  assert.throws(() => createBackup(state, 'workspaces', [], 'small'));
  assert.throws(() => createBackup(state, 'workspaces', ['first', 'missing'], 'small'));
});

test('工作空間副本保留重複名稱，重建任務、分類、狀態及子任務識別碼與參照', () => {
  let counter = 0;
  const copies = copyWorkspaces([first, first], () => `new-${++counter}`);
  assert.equal(copies[0].name, first.name);
  assert.equal(copies[1].name, first.name);
  assert.notEqual(copies[0].id, copies[1].id);
  assert.notEqual(copies[0].tasks[0].id, task.id);
  assert.notEqual(copies[0].tasks[0].subtasks[0].id, 'subtask');
  assert.equal(copies[0].tasks[0].categoryId, copies[0].categories[0].id);
  assert.notEqual(copies[0].projects[0].id, first.projects[0].id);
  assert.equal(copies[0].tasks[0].projectId, copies[0].projects[0].id);
  assert.equal(copies[0].tasks[0].status, copies[0].statuses[0].id);
  assert.equal(copies[0].tasks[0].startTime, '22:00');
  assert.equal(copies[0].tasks[0].dueTime, '10:00');
  copies[0].tasks[0].title = '修改副本';
  assert.equal(first.tasks[0].title, '跨日任務');
});

test('損壞格式、未知版本、無效日期、參照與重複子任務識別碼皆拒絕匯入', () => {
  const backup = createBackup(state, 'full', [], 'standard');
  for (const mutate of [
    value => { value.application = 'other'; },
    value => { value.formatVersion = 99; },
    value => { value.kind = 'other'; },
    value => { value.data.workspaces[0].tasks[0].dueDate = '2026-02-30'; },
    value => { value.data.workspaces[0].tasks[0].categoryId = 'missing'; },
    value => { value.data.workspaces[0].tasks[0].status = 'missing'; },
    value => { value.data.workspaces[0].tasks[0].projectId = 'missing'; },
    value => { value.data.workspaces[0].tasks[0].subtasks.push({...value.data.workspaces[0].tasks[0].subtasks[0]}); },
    value => { value.preferences.textSize = 'invalid'; }
  ]) {
    const invalid = structuredClone(backup);
    mutate(invalid);
    assert.throws(() => readBackup(invalid));
  }
  assert.deepEqual(backup.data, state);
});

test('匯入只保留支援欄位，忽略夾帶的憑證與其他未定義欄位', () => {
  const backup = createBackup(state, 'full', [], 'small');
  backup.clientSecret = 'not-imported';
  backup.preferences.accessToken = 'not-imported';
  backup.data.workspaces[0].categories[0].unexpected = 'not-imported';
  backup.data.workspaces[0].projects[0].unexpected = 'not-imported';
  backup.data.workspaces[0].statuses[0].unexpected = 'not-imported';
  backup.data.workspaces[0].tasks[0].subtasks[0].unexpected = 'not-imported';
  assert.equal(JSON.stringify(readBackup(backup)).includes('not-imported'), false);
});
