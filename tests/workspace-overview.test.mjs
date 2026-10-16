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

const require = createRequire(import.meta.url), {build} = createRequire(require.resolve('@angular/build/package.json'))('esbuild');
await mkdir('.angular', {recursive: true});
const directory = await mkdtemp(resolve('.angular/overview-test-')), output = resolve(directory, 'overview.mjs');
await build({stdin: {contents: "export {WorkspaceOverview} from './src/app/workspace-overview.ts'; export {BoardStore} from './src/app/board-store.ts'; export {DocumentMetadataService} from './src/app/document-metadata-service.ts';", resolveDir: process.cwd()}, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: output, tsconfig: 'tsconfig.json'});
const {WorkspaceOverview, BoardStore, DocumentMetadataService} = await import(pathToFileURL(output).href);
after(() => rm(directory, {recursive: true, force: true}));
const now = new Date(2026, 9, 15, 12), options = {project: 'all', includeArchived: false, dueSoonDays: 3};
const makeTask = (id, patch = {}) => ({id, title: id, description: '', projectId: 'research', categoryId: '', status: 'working', priority: 'medium', startDate: '', startTime: '', dueDate: '', dueTime: '', subtasks: [], ...patch});
const workspace = (tasks = []) => ({version: 6, id: 'first', name: '研究工作', projects: [{id: 'research', name: '研究計畫'}, {id: 'old', name: '封存計畫', archived: true}], categories: [], statuses: [{id: 'working', label: '研究進行中', kind: 'active', color: '#45a677', subtitle: ''}, {id: 'accepted', label: '審核通過', kind: 'done', color: 'blue', subtitle: ''}, {id: 'stored', label: '留存', kind: 'archived', color: 'gray', subtitle: ''}], tasks});
const count = (data, kind) => overviewTasks(data, {kind}).length;

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
