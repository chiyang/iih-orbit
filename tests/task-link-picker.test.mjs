import '@angular/compiler';
import {createEnvironmentInjector, runInInjectionContext, ɵChangeDetectionScheduler, ɵEffectScheduler} from '@angular/core';
import {DIALOG_DATA, DialogRef} from '@angular/cdk/dialog';
import {createRequire} from 'node:module';
import {after, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {emptyWorkspace} from '../src/app/workspace-data.ts';
const require = createRequire(import.meta.url), {build} = createRequire(require.resolve('@angular/build/package.json'))('esbuild');
await mkdir('.angular', {recursive: true}); const directory = await mkdtemp(resolve('.angular/task-picker-test-')), output = resolve(directory, 'picker.mjs');
await build({stdin: {contents: "export {TaskLinkPicker} from './src/app/task-link-picker.ts'; export {BoardStore} from './src/app/board-store.ts';", resolveDir: process.cwd()}, bundle: true, platform: 'node', format: 'esm', packages: 'external', tsconfig: 'tsconfig.json', outfile: output});
const {TaskLinkPicker, BoardStore} = await import(pathToFileURL(output).href); after(() => rm(directory, {recursive: true, force: true}));
function fixture() {
  const task = id => ({id, title: id === 'research' ? '整理研究結果' : id, description: '', projectId: 'project', categoryId: '', status: 'todo', priority: 'medium', startDate: '', startTime: '', dueDate: '', dueTime: '', subtasks: []});
  const workspace = {...emptyWorkspace('space', '研究工作'), projects: [{id: 'project', name: '論文投稿'}], tasks: ['source', 'linked', 'research', 'course', 'trashed'].map(task)}; workspace.tasks.at(-1).deletedAt = new Date().toISOString();
  const values = new Map([['orbit-workspaces-v1', JSON.stringify({version: 1, activeWorkspaceId: 'space', workspaces: [workspace]})]]);
  globalThis.localStorage = {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key)};
  const store = new BoardStore(), effects = new Set(), closures = [], data = {taskId: 'source', workspaceId: 'space', generation: store.generation(), excluded: ['linked']};
  const injector = createEnvironmentInjector([{provide: BoardStore, useValue: store}, {provide: DIALOG_DATA, useValue: data}, {provide: DialogRef, useValue: {close: value => closures.push(value)}}, {provide: ɵEffectScheduler, useValue: {add: e => effects.add(e), schedule() {}, remove: e => effects.delete(e)}}, {provide: ɵChangeDetectionScheduler, useValue: {notify() {}}}]);
  const picker = runInInjectionContext(injector, () => new TaskLinkPicker()), flush = () => {for (const effect of effects) if (effect.dirty) effect.run();}; flush();
  return {store, picker, closures, flush, close() {injector.destroy(); store.ngOnDestroy();}};
}
test('任務連結選擇排除自己、既有連結與垃圾桶，可搜尋跨專案並跨搜尋保留選取', () => {
  const f = fixture();
  try {const {picker} = f; assert.deepEqual(picker.candidates().map(task => task.id), ['research', 'course']); picker.query.set('研究'); assert.deepEqual(picker.candidates().map(task => task.id), ['research']); picker.toggle('research'); picker.query.set('course'); picker.toggle('course'); assert.deepEqual(picker.selected(), ['research', 'course']); picker.query.set('論文投稿'); assert.equal(picker.candidates().length, 2); for (const id of ['source', 'linked', 'trashed', 'missing']) picker.toggle(id); assert.equal(picker.selected().length, 2); picker.confirm(); assert.deepEqual(f.closures, [['research', 'course']]); assert.deepEqual(f.store.relatedTaskIds('source'), []);}
  finally {f.close();}
});
test('取消及 Escape 不回傳選擇，確認前任務刪除則要求重新確認，不部分建立', async () => {
  const f = fixture();
  try {const {picker, store} = f; picker.toggle('research'); picker.toggle('course'); await store.deleteTask('research'); picker.confirm(); assert.deepEqual(f.closures, []); assert.deepEqual(picker.selected(), ['course']); assert.match(picker.error(), /已移除/); let prevented = false, stopped = false; picker.escape({preventDefault() {prevented = true;}, stopPropagation() {stopped = true;}}); assert.deepEqual(f.closures, [undefined]); assert.equal(prevented && stopped, true); assert.deepEqual(store.relatedTaskIds('source'), []);}
  finally {f.close();}
});
test('來源工作資料世代變更即取消選擇，不接受舊工作空間的結果', () => {
  const f = fixture();
  try {f.picker.toggle('research'); f.store.generation.set('replacement'); f.flush(); assert.equal(f.picker.valid(), false); assert.deepEqual(f.closures, [undefined]); f.picker.confirm(); assert.equal(f.closures.every(value => value === undefined), true);}
  finally {f.close();}
});
