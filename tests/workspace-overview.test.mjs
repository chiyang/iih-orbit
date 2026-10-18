import '@angular/compiler';
import {createEnvironmentInjector, runInInjectionContext, signal} from '@angular/core';
import assert from 'node:assert/strict';
import {after, test} from 'node:test';
import {createRequire} from 'node:module';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {workspaceOverview, overviewTasks, readOverviewSelection} from '../src/app/workspace-overview-data.ts';
import {documentFromUrl} from '../src/app/document-data.ts';
import {dateKey} from '../src/app/task-schedule.ts';
import {donutSegments} from '../src/app/overview-charts.ts';
import {withCompletionEvents} from '../src/app/task-completion-data.ts';

const require = createRequire(import.meta.url), {build} = createRequire(require.resolve('@angular/build/package.json'))('esbuild');
await mkdir('.angular', {recursive: true});
const directory = await mkdtemp(resolve('.angular/overview-test-')), output = resolve(directory, 'overview.mjs');
await build({stdin: {contents: "export {CompletionTrend} from './src/app/completion-trend.ts'; export {WorkspaceOverview} from './src/app/workspace-overview.ts'; export {BoardStore} from './src/app/board-store.ts'; export {DocumentMetadataService} from './src/app/document-metadata-service.ts';", resolveDir: process.cwd()}, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: output, tsconfig: 'tsconfig.json'});
const {CompletionTrend, WorkspaceOverview, BoardStore, DocumentMetadataService} = await import(pathToFileURL(output).href);
after(() => rm(directory, {recursive: true, force: true}));
const now = new Date(2026, 9, 15, 12), options = {project: 'all', includeArchived: false, dueSoonDays: 3};
const makeTask = (id, patch = {}) => ({id, title: id, description: '', projectId: 'research', categoryId: '', status: 'working', priority: 'medium', startDate: '', startTime: '', dueDate: '', dueTime: '', subtasks: [], ...patch});
const workspace = (tasks = []) => ({version: 6, id: 'first', name: '研究工作', projects: [{id: 'research', name: '研究計畫'}, {id: 'old', name: '封存計畫', archived: true}], categories: [], statuses: [{id: 'working', label: '研究進行中', kind: 'active', color: '#45a677', subtitle: ''}, {id: 'accepted', label: '審核通過', kind: 'done', color: 'blue', subtitle: ''}, {id: 'stored', label: '留存', kind: 'archived', color: 'gray', subtitle: ''}], tasks});
const count = (data, kind) => overviewTasks(data, {kind}).length;

test('完成歷史下鑽只接受有效日期，趨勢期間在任務更新及專案切換後保持', () => {
  assert.deepEqual(readOverviewSelection({kind: 'completion-history', value: '2026-10-01/2026-10-15'}), {kind: 'completion-history', value: '2026-10-01/2026-10-15'});
  for (const value of [undefined, '2026-02-30/2026-03-01', '2026-10-15/2026-10-01', '2026-10-15']) assert.equal(readOverviewSelection({kind: 'completion-history', value}), null);
  const injector = createEnvironmentInjector([]);
  try {
    const trend = runInInjectionContext(injector, () => new CompletionTrend());
    trend.workspace = signal(withCompletionEvents(workspace(), [{id: 'event', taskId: 'removed', kind: 'completed', at: '2026-10-15T04:00:00.000Z', day: '2026-10-15', title: '完成記錄', projectId: 'research', projectName: '研究計畫'}]));
    trend.now = signal(now); trend.project = signal('all');
    assert.equal(trend.days(), 30); trend.changeDays(90); assert.equal(trend.weekly(), true);
    trend.workspace.update(board => ({...board, tasks: [makeTask('new')]})); trend.project.set('research');
    assert.equal(trend.days(), 90); assert.equal(trend.weekly(), true); assert.equal(trend.data().total, 1);
    let opened; trend.selectRange.subscribe(value => {opened = value;}); trend.show(trend.data().buckets[0]);
    assert.equal(opened, '2026-10-15/2026-10-15');
    trend.workspace.update(board => ({...board, id: 'other'})); assert.equal(trend.days(), 30); assert.equal(trend.weekly(), false);
  } finally {injector.destroy();}
});

test('任務分類按識別、名稱、配色與順序統計，含未分類及零任務分類，完成率與占比分開', () => {
  const state = workspace([
    makeTask('design-pending', {categoryId: 'design', subtasks: [{id: 's', title: '子任務', done: true}]}),
    makeTask('design-done', {categoryId: 'design', status: 'accepted'}),
    makeTask('research-pending', {categoryId: 'study'}),
    makeTask('unassigned', {categoryId: ''}),
    makeTask('stored', {categoryId: 'design', status: 'stored'}),
    makeTask('archived-project', {categoryId: 'study', projectId: 'old'}),
    makeTask('trash', {categoryId: 'design', deletedAt: '2026-10-15T00:00:00Z'})
  ]);
  state.categories = [{id: 'study', name: '研究', color: '#456789'}, {id: 'design', name: '研究', color: 'purple'}, {id: 'empty', name: '尚未使用', color: 'blue'}];
  const before = JSON.stringify(state), data = workspaceOverview(state, now, options);
  assert.deepEqual(data.categories.map(row => [row.id, row.name, row.color, row.count]), [['study', '研究', '#456789', 1], ['design', '研究', 'purple', 2], ['empty', '尚未使用', 'blue', 0], ['', '未分類', 'gray', 1]]);
  const design = data.categories.find(row => row.id === 'design');
  assert.equal(design.completed, 1); assert.equal(design.pending, 1); assert.equal(design.archivedCount, 0); assert.equal(design.share, 50); assert.equal(design.percent, 50);
  assert.equal(data.categories.reduce((sum, row) => sum + row.count, 0), data.tasks.length);
  assert.equal(data.categories.reduce((sum, row) => sum + row.share, 0), 100);
  assert.deepEqual(overviewTasks(data, {kind: 'category', value: 'design'}).map(task => task.id), ['design-pending', 'design-done']);
  assert.deepEqual(overviewTasks(data, {kind: 'category', value: ''}).map(task => task.id), ['unassigned']);
  const full = workspaceOverview(state, now, {...options, includeArchived: true});
  const archivedDesign = full.categories.find(row => row.id === 'design');
  assert.equal(archivedDesign.count, 3); assert.equal(archivedDesign.archivedCount, 1); assert.equal(archivedDesign.percent, 33); assert.equal(archivedDesign.share, 50);
  for (const row of full.categories) assert.equal(row.completed + row.pending + row.archivedCount, row.count);
  const archivedProject = workspaceOverview(state, now, {...options, project: 'old', includeArchived: true});
  assert.equal(archivedProject.categories.find(row => row.id === 'study').count, 1); assert.equal(archivedProject.categories.find(row => row.id === 'design').count, 0);
  assert.equal(workspaceOverview(state, now, {...options, project: ''}).categories.every(row => row.count === 0 && row.percent === 0 && row.share === 0), true);
  assert.equal(JSON.stringify(state), before);
});

test('分類下鑽驗證包含未分類，未知分類不擴大查詢，空範圍與萬筆分類統計保持完整', () => {
  assert.deepEqual(readOverviewSelection({kind: 'category', value: ''}), {kind: 'category', value: ''});
  assert.deepEqual(readOverviewSelection({kind: 'category', value: 'custom'}), {kind: 'category', value: 'custom'});
  for (const value of [undefined, null, 1, {}, 'x'.repeat(501)]) assert.equal(readOverviewSelection({kind: 'category', value}), null);
  const state = workspace(Array.from({length: 10000}, (_, i) => makeTask('task-' + i, {categoryId: i % 3 ? 'a' : '', status: i % 4 ? 'working' : 'accepted'})));
  state.categories = [{id: 'a', name: 'A', color: 'blue'}, {id: 'unused', name: '尚無任務', color: 'purple'}];
  const data = workspaceOverview(state, now, options);
  assert.equal(data.categories.reduce((sum, row) => sum + row.count, 0), 10000);
  assert.equal(overviewTasks(data, {kind: 'category', value: 'a'}).length, 6666);
  assert.equal(overviewTasks(data, {kind: 'category', value: 'removed'}).length, 0);
  assert.deepEqual(donutSegments(data.categories).map(row => row.id), ['a', '']);
  assert.equal(state.tasks[0].updatedAt, undefined);
  const empty = workspaceOverview(workspace(), now, options);
  assert.deepEqual(empty.categories, [{id: '', name: '未分類', color: 'gray', count: 0, completed: 0, pending: 0, archivedCount: 0, percent: 0, share: 0}]);
});

test('分類圖表與彈窗標題即時反映改名、分類及狀態修改，分類清單仍分頁且不發出查驗', () => {
  const state = signal({...workspace(Array.from({length: 35}, (_, i) => makeTask('task-' + i, {categoryId: 'design'}))), categories: [{id: 'design', name: '設計', color: 'purple'}]});
  const store = {currentWorkspace: state, projects: () => state().projects, statuses: () => state().statuses, reminders: () => ({dueSoonDays: 3})};
  const injector = createEnvironmentInjector([{provide: BoardStore, useValue: store}, {provide: DocumentMetadataService, useValue: {view() {throw new Error('此範圍沒有文件，不應發請求');}}}]);
  const previous = globalThis.ngServerMode; globalThis.ngServerMode = true;
  try {
    const component = runInInjectionContext(injector, () => new WorkspaceOverview()); component.now = signal(now); component.project = signal('all'); component.selection = signal({kind: 'category', value: 'design'});
    assert.equal(component.selectionLabel(), '設計'); assert.equal(component.taskRows().length, 30); assert.equal(component.pageCount(), 2);
    assert.equal(component.categorySlices()[0].share, 100); assert.equal(component.categorySlices()[0].count, 35);
    let selection; component.selectionChange.subscribe(value => {selection = value;}); component.show('category', 'design'); assert.deepEqual(selection, {kind: 'category', value: 'design'});
    state.update(value => ({...value, categories: [{id: 'design', name: '設計改名', color: 'green'}], tasks: value.tasks.map((task, index) => index === 0 ? {...task, categoryId: ''} : {...task, status: 'accepted'})}));
    assert.equal(component.selectionLabel(), '設計改名'); assert.equal(component.selectedTasks().length, 34);
    assert.equal(component.data().categories[0].completed, 34); assert.equal(component.data().categories[0].percent, 100); assert.equal(component.categorySlices()[0].color, 'green');
    component.selection.set({kind: 'category', value: ''}); assert.equal(component.selectionLabel(), '未分類'); assert.equal(component.selectedTasks()[0].id, 'task-0');
    component.selection.set({kind: 'category', value: 'removed'}); assert.equal(component.selectionLabel(), '已移除的分類'); assert.equal(component.taskRows().length, 0);
    component.categoryLimit.set(24); component.project.set('old'); assert.equal(component.categoryLimit(), 12);
  } finally {injector.destroy(); if (previous === undefined) delete globalThis.ngServerMode; else globalThis.ngServerMode = previous;}
});

test('總覽使用自訂狀態 kind，排除垃圾桶與兩種封存，主任務與子任務分母分開', () => {
  const state = workspace([...Array.from({length: 5}, (_, i) => makeTask('pending-' + i)), ...Array.from({length: 3}, (_, i) => makeTask('done-' + i, {status: 'accepted', subtasks: [{id: 's', title: '子任務', done: true}]})), makeTask('archived', {status: 'stored'}), makeTask('project-archive', {projectId: 'old'}), makeTask('trash', {deletedAt: now.toISOString()})]);
  const data = workspaceOverview(state, now, options);
  assert.equal(data.tasks.length, 8); assert.equal(data.completed, 3); assert.equal(data.percent, 38);
  assert.equal(count(data, 'pending'), 5); assert.equal(count(data, 'done'), 3); assert.equal(data.subtaskTotal, 3); assert.equal(data.subtaskDone, 3);
  assert.equal(data.statuses.find(row => row.id === 'working').count, 5); assert.equal(data.statuses.some(row => row.id === 'stored'), false);
  assert.equal(data.projects.some(row => row.id === 'old'), false);
  const full = workspaceOverview(state, now, {...options, includeArchived: true});
  assert.equal(full.tasks.length, 10); assert.equal(count(full, 'archived'), 1); assert.equal(full.percent, 30);
  assert.equal(full.statuses.reduce((sum, row) => sum + row.count, 0), full.tasks.length);
  const research = full.projects.find(row => row.id === 'research');
  assert.equal(research.completed, 3); assert.equal(research.pending, 5); assert.equal(research.archivedCount, 1);
  assert.equal(research.completed + research.pending + research.archivedCount, research.count);
  assert.equal(overviewTasks(full, {kind: 'project', value: 'old'})[0].id, 'project-archive');
});

test('圓環圖保留精確比例與自訂識別，略過零數量；零任務與整圈不產生無效圖形', () => {
  assert.deepEqual(donutSegments([]), []);
  assert.deepEqual(donutSegments([{id: 'empty', count: 0}]), []);
  const one = donutSegments([{id: 'done', count: 8}, {id: 'empty', count: 0}]);
  assert.equal(one.length, 1); assert.equal(one[0].percent, 100); assert.equal((one[0].path.match(/A88,88/g) ?? []).length, 2);
  const rows = donutSegments([{id: 'a', color: '#45a677', count: 3}, {id: 'b', count: 5}, {id: 'zero', count: 0}]);
  assert.equal(rows[0].percent, 37.5); assert.equal(rows[1].percent, 62.5); assert.equal(rows[0].color, '#45a677');
  assert.equal(rows.map(row => row.percent).reduce((sum, value) => sum + value, 0), 100);
  assert.equal(rows[1].path.includes('A88,88 0 1,1'), true);
  const uneven = donutSegments([{count: 1}, {count: 1}, {count: 1}, {count: 9997}]);
  assert.ok(Math.abs(uneven.reduce((sum, row) => sum + row.percent, 0) - 100) < 1e-10);
  assert.equal(uneven.some(row => /NaN|Infinity/.test(row.path)), false);
});

test('未指定專案獨立計算，零任務為 0%，無開始與截止才是未排程', () => {
  const state = workspace([makeTask('unassigned', {projectId: ''}), makeTask('start-only', {startDate: '2026-10-20'}), makeTask('due-only', {dueDate: '2026-10-20'})]);
  const data = workspaceOverview(state, now, options);
  assert.equal(count(data, 'unscheduled'), 1); assert.equal(data.projects.find(row => row.id === '').count, 1);
  const selected = workspaceOverview(state, now, {...options, project: ''}); assert.deepEqual(selected.tasks.map(task => task.id), ['unassigned']);
  const empty = workspaceOverview(workspace(), now, options); assert.equal(empty.percent, 0); assert.equal(empty.tasks.length, 0);
  assert.equal(empty.projects.every(row => row.percent === 0), true);
});

test('時程沿用全天結束與精確時間，週起訖為週日至週六，開始與持續任務分開', () => {
  const state = workspace([makeTask('all-day', {startDate: '2026-10-15', dueDate: '2026-10-15'}), makeTask('timed-late', {dueDate: '2026-10-15', dueTime: '11:59'}), makeTask('sunday', {startDate: '2026-10-11'}), makeTask('saturday', {startDate: '2026-10-17'}), makeTask('next-week', {startDate: '2026-10-18'}), makeTask('ongoing', {startDate: '2026-10-01', dueDate: '2026-10-17'}), makeTask('finished', {status: 'accepted', startDate: '2026-10-15', dueDate: '2026-10-01'})]);
  const data = workspaceOverview(state, now, options);
  assert.deepEqual(overviewTasks(data, {kind: 'overdue'}).map(task => task.id), ['timed-late']);
  assert.equal(count(data, 'today-start'), 1); assert.equal(count(data, 'week-start'), 3); assert.equal(count(data, 'due-soon'), 2);
  assert.equal(data.weekLabel, '2026-10-11 ～ 2026-10-17');
  const midnight = new Date(2026, 9, 16); assert.equal(count(workspaceOverview(state, midnight, options), 'overdue'), 2);
});

test('資訊來源與任務引用去重，只將近期明確查驗失敗計入，沒有查驗不算失效', () => {
  const files = ['ok', 'missing', 'stale', 'auth', 'offline', 'limited', 'unknown'].map(id => documentFromUrl('google-drive', 'https://drive.google.com/file/d/' + id + '/view', id));
  const state = workspace([makeTask('first'), makeTask('second'), makeTask('removed')]); state.documentSources = files;
  state.documentLinks = files.map((file, i) => ({id: 'link-' + i, taskId: 'first', documentId: file.id}));
  state.documentLinks.push({id: 'duplicate', taskId: 'first', documentId: files[1].id}, {id: 'other-task', taskId: 'second', documentId: files[1].id}, {id: 'removed', taskId: 'removed', documentId: files[0].id, removed: true});
  const states = {ok: {status: 'available', checkedAt: 1, stale: false}, missing: {status: 'unavailable', checkedAt: 1, stale: false}, stale: {status: 'trashed', checkedAt: 1, stale: true}, auth: {status: 'authorization', checkedAt: 1, stale: false}, offline: {status: 'offline', checkedAt: 1, stale: false}, limited: {status: 'limited', checkedAt: 1, stale: false}, unknown: {status: 'unverified', stale: false}};
  let reads = 0; const before = JSON.stringify(state);
  const data = workspaceOverview(state, now, options, source => {reads++; return states[source.name];});
  assert.equal(count(data, 'linked'), 2); assert.equal(count(data, 'unavailable'), 2); assert.equal(reads, 7);
  assert.deepEqual(data.coverage, {total: 7, checked: 2, stale: 1, unavailable: 1}); assert.equal(JSON.stringify(state), before);
  assert.equal(workspaceOverview(state, now, options).coverage.unavailable, 0);
});

test('衝突只計目前空間與所選範圍，沒有主任務的刪除分歧仍可比較，不計已解決候選', () => {
  const state = workspace([makeTask('conflict')]);
  state.taskConflicts = [{id: 'conflict', versions: [{key: 'a', task: makeTask('conflict')}, {key: 'b', task: makeTask('conflict', {description: 'other'})}]}, {id: 'deleted-choice', versions: [{key: 'a', task: null}, {key: 'b', task: makeTask('deleted-choice')}]}, {id: 'archived-choice', versions: [{key: 'a', task: makeTask('archived-choice', {projectId: 'old'})}]}, {id: 'resolved', resolved: 'a', versions: [{key: 'a', task: makeTask('resolved')}]}];
  assert.deepEqual(workspaceOverview(state, now, options).conflicts.map(item => item.id), ['conflict', 'deleted-choice']);
  assert.equal(workspaceOverview(state, now, {...options, project: ''}).conflicts.length, 0);
  assert.equal(workspaceOverview(state, now, {...options, includeArchived: true}).conflicts.length, 3);
});

test('總覽控制器只讀快取、不發查驗請求，任務清單分頁並即時反映正式修改', () => {
  const state = signal(workspace(Array.from({length: 65}, (_, i) => makeTask('task-' + i)))), store = {currentWorkspace: state, projects: () => state().projects, statuses: () => state().statuses, reminders: () => ({dueSoonDays: 3})};
  const source = documentFromUrl('google-drive', 'https://drive.google.com/file/d/controller/view', '快取來源'); state().documentSources = [source]; state().documentLinks = [{id: 'controller-link', taskId: 'task-0', documentId: source.id}];
  let requests = 0, reads = 0; const metadata = {view() {reads++; return {status: 'unverified', stale: false};}, refresh() {requests++; throw new Error('should not refresh');}, watch() {requests++; throw new Error('should not watch');}};
  const injector = createEnvironmentInjector([{provide: BoardStore, useValue: store}, {provide: DocumentMetadataService, useValue: metadata}]);
  const serverMode = globalThis.ngServerMode; globalThis.ngServerMode = true;
  try {
    const component = runInInjectionContext(injector, () => new WorkspaceOverview()); component.now = signal(now); component.selection = signal({kind: 'pending'});
    assert.equal(component.selectedTasks().length, 65); assert.equal(component.taskRows().length, 30); assert.equal(component.pageCount(), 3); assert.equal(reads, 1);
    assert.deepEqual(component.completionSlices().map(slice => [slice.kind, slice.count, slice.percent]), [['pending', 65, 100]]);
    assert.deepEqual(component.statusSlices().map(slice => [slice.id, slice.count]), [['working', 65]]);
    assert.equal(component.percentLabel(.01), '<0.1%'); assert.equal(component.percentLabel(37.5), '37.5%');
    component.page.set(2); assert.equal(component.taskRows().length, 5);
    state.set(workspace([makeTask('latest')])); assert.equal(component.currentPage(), 0); assert.equal(component.taskRows()[0].id, 'latest');
    assert.equal(requests, 0);
    let selected; component.selectionChange.subscribe(value => {selected = value;}); component.show('status', 'working'); assert.deepEqual(selected, {kind: 'status', value: 'working'});
    component.selection.set({kind: 'project', value: 'removed'}); assert.equal(component.selectionLabel(), '已移除的專案');
  } finally {injector.destroy(); if (serverMode === undefined) delete globalThis.ngServerMode; else globalThis.ngServerMode = serverMode;}
});

test('萬項任務統計與連結查驗讀取按來源去重，不修改本機工作資料', () => {
  const source = documentFromUrl('google-drive', 'https://drive.google.com/file/d/shared/view', '共用文件');
  const state = workspace(Array.from({length: 10000}, (_, i) => makeTask(String(i), {status: i % 4 === 0 ? 'accepted' : 'working'})));
  state.documentSources = [source]; state.documentLinks = state.tasks.map(task => ({id: 'link-' + task.id, taskId: task.id, documentId: source.id}));
  let reads = 0; const data = workspaceOverview(state, now, options, () => {reads++; return {status: 'available', checkedAt: 1, stale: false};});
  assert.equal(data.tasks.length, 10000); assert.equal(data.completed, 2500); assert.equal(data.percent, 25); assert.equal(count(data, 'linked'), 10000); assert.equal(reads, 1);
  assert.equal(state.tasks[0].updatedAt, undefined); assert.equal(data.todayLabel, dateKey(now));
});

test('總覽下鑽選項只接收可辨識類型與有限文字，不恢復不合法狀態', () => {
  assert.deepEqual(readOverviewSelection({kind: 'project', value: ''}), {kind: 'project', value: ''});
  assert.equal(readOverviewSelection({kind: 'status'}), null); assert.equal(readOverviewSelection({kind: 'unknown'}), null);
  assert.equal(readOverviewSelection({kind: 'project', value: 'x'.repeat(501)}), null);
  assert.deepEqual(readOverviewSelection({kind: 'overdue', value: 'ignored'}), {kind: 'overdue'});
});
