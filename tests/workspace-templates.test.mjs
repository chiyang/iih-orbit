import assert from 'node:assert/strict';
import {test} from 'node:test';
import {WORKSPACE_TEMPLATES, workspaceFromTemplate} from '../src/app/workspace-templates.ts';
import {readWorkspaceState} from '../src/app/workspace-data.ts';
import {dateKey, scheduleError, weekDates} from '../src/app/task-schedule.ts';
import {createBackup, readBackup, copyWorkspaces} from '../src/app/backup-data.ts';

test('六種樣板建立同名專案、共享分類與合法本週時程，資料及範本不被修改', () => {
  assert.deepEqual(WORKSPACE_TEMPLATES.map(item => item.name), ['學程行政', '學生事務', '課程安排', '研究計劃', '軟體開發', '學習進度']);
  const catalog = structuredClone(WORKSPACE_TEMPLATES);
  const now = new Date(2026, 9, 9, 22, 30);
  const dates = weekDates(now).map(dateKey);
  assert.equal(dates[0], '2026-10-04');
  for (const template of WORKSPACE_TEMPLATES) {
    const workspace = workspaceFromTemplate('workspace', ' 自訂工作空間 ', {templateId: template.id, now});
    const state = {version: 1, activeWorkspaceId: workspace.id, workspaces: [workspace]};
    assert.deepEqual(readWorkspaceState(JSON.parse(JSON.stringify(state))), state);
    assert.equal(workspace.projects[0].name, '自訂工作空間');
    assert.ok(workspace.tasks.some(task => task.projectId === workspace.projects[0].id));
    assert.ok(workspace.tasks.some(task => !task.startTime));
    assert.ok(workspace.tasks.some(task => task.startTime && task.dueTime));
    for (const task of workspace.tasks) {
      assert.ok(dates.includes(task.startDate)); assert.ok(dates.includes(task.dueDate));
      assert.equal(scheduleError(task), '');
      assert.ok(task.projectId); assert.ok(task.categoryId);
      assert.match(task.description, /虛構/);
    }
    assert.deepEqual(workspace.categories.map(category => [category.name, category.color]), template.categories.map(category => [category.name, category.color]));
  }
  assert.deepEqual(WORKSPACE_TEMPLATES, catalog);
  assert.equal(now.getDate(), 9);
});

test('跨月跨年與夏令時間當週範例使用本機日期，週日為起點', () => {
  for (const now of [new Date(2026, 11, 31, 23), new Date(2027, 0, 3), new Date(2026, 2, 10)]) {
    const days = weekDates(now).map(dateKey);
    const workspace = workspaceFromTemplate('workspace', '研究', {templateId: 'research', now});
    for (const [index, task] of workspace.tasks.entries()) {
      const example = WORKSPACE_TEMPLATES.find(template => template.id === 'research').examples[index];
      assert.equal(task.startDate, days[example.day]);
      assert.equal(task.dueDate, days[example.endDay ?? example.day]);
    }
  }
});

test('選擇不加入示範任務仍保留專案與分類；空白工作空間只建立同名專案', () => {
  for (const template of WORKSPACE_TEMPLATES) {
    const workspace = workspaceFromTemplate('workspace', template.name, {templateId: template.id, includeExamples: false});
    assert.equal(workspace.tasks.length, 0);
    assert.equal(workspace.categories.length, template.categories.length);
    assert.equal(workspace.projects.length, template.projects.length + 1);
    assert.equal(workspace.projects[0].name, template.name);
  }
  const blank = workspaceFromTemplate('workspace', '空白工作空間', {templateId: 'blank'});
  assert.equal(blank.projects.length, 1); assert.equal(blank.projects[0].name, blank.name);
  assert.deepEqual(blank.tasks, []); assert.deepEqual(blank.categories, []);
  assert.throws(() => workspaceFromTemplate('workspace', '不合法', {templateId: 'unknown'}));
});

test('同樣板重複建立不共享識別碼或陣列，專案同名時仍可建立合法工作空間', () => {
  const first = workspaceFromTemplate('first', '網站改版', {templateId: 'software'});
  const second = workspaceFromTemplate('second', '網站改版', {templateId: 'software'});
  const ids = workspace => [...workspace.projects, ...workspace.categories, ...workspace.tasks, ...workspace.tasks.flatMap(task => task.subtasks)].map(item => item.id);
  const firstIds = new Set(ids(first));
  assert.equal(ids(second).some(id => firstIds.has(id)), false);
  assert.ok(readWorkspaceState({version: 1, activeWorkspaceId: first.id, workspaces: [first, second]}));
  assert.deepEqual(first.projects.map(project => project.name), ['網站改版', '網站改版（專案）', '工具優化']);
  second.categories[0].name = '修改分類'; second.tasks[0].title = '修改任務'; second.statuses[0].label = '修改狀態';
  assert.notEqual(first.categories[0].name, second.categories[0].name);
  assert.notEqual(first.tasks[0].title, second.tasks[0].title);
  assert.notEqual(first.statuses[0].label, second.statuses[0].label);
});

test('樣板工作空間可匯出與獨立匯入，保留示範排程、順序與任務歸屬', () => {
  const workspace = workspaceFromTemplate('workspace', '學程行政', {templateId: 'administration', now: new Date(2026, 9, 9)});
  const state = {version: 1, activeWorkspaceId: workspace.id, workspaces: [workspace]};
  const backup = readBackup(createBackup(state, 'workspaces', [workspace.id], 'standard'));
  const copy = copyWorkspaces(backup.data.workspaces)[0];
  assert.deepEqual(copy.tasks.map(task => [task.title, task.startDate, task.dueDate, task.startTime, task.dueTime]), workspace.tasks.map(task => [task.title, task.startDate, task.dueDate, task.startTime, task.dueTime]));
  for (const task of copy.tasks) assert.ok(copy.projects.some(project => project.id === task.projectId));
  assert.deepEqual(copy.categories.map(category => category.name), workspace.categories.map(category => category.name));
  assert.notEqual(copy.id, workspace.id);
});
