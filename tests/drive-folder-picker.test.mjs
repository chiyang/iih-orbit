import '@angular/compiler';
import {createEnvironmentInjector, runInInjectionContext, signal, ɵEffectScheduler, ɵChangeDetectionScheduler} from '@angular/core';
import {DIALOG_DATA, DialogRef} from '@angular/cdk/dialog';
import assert from 'node:assert/strict';
import {after, test} from 'node:test';
import {createRequire} from 'node:module';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DRIVE_FOLDER_MIME} from '../src/app/drive-browser-data.ts';
const require = createRequire(import.meta.url), {build} = createRequire(require.resolve('@angular/build/package.json'))('esbuild');
await mkdir('.angular', {recursive: true});
const directory = await mkdtemp(resolve('.angular/folder-picker-test-')), output = resolve(directory, 'picker.mjs');
await build({stdin: {contents: "export {DriveFolderPicker} from './src/app/drive-folder-picker.ts'; export {DriveBrowser} from './src/app/drive-browser.ts'; export {DocumentCreateService} from './src/app/document-create-service.ts';", resolveDir: process.cwd()}, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: output, tsconfig: 'tsconfig.json'});
const {DriveFolderPicker, DriveBrowser, DocumentCreateService} = await import(pathToFileURL(output).href);
after(() => rm(directory, {recursive: true, force: true}));
function fixture() {
  const effects = new Set(), closures = [], calls = [], folder = {id: 'folder', name: '研究資料夾', mimeType: DRIVE_FOLDER_MIME, url: 'https://drive.google.com/drive/folders/folder', resourceKey: 'key'};
  const source = {id: 'research', name: () => '研究來源', context: signal('context'), connecting: signal(false), auth: {connected: signal(true), connectionVersion: signal(1)}};
  const store = {generation: signal('generation'), currentWorkspace: signal({id: 'workspace'})};
  const browser = {path: signal([{id: 'root', name: '我的雲端硬碟'}]), busy: signal(false), visibleFiles: signal([folder, {...folder, id: 'file', mimeType: 'application/pdf'}, {...folder, id: 'trash', trashed: true}]), async selectSource(id) {calls.push(['source', id]);}, isListed(file) {return this.visibleFiles().includes(file);}, async open(file) {this.path.set([...this.path(), file]);}, async root(shared) {this.path.set([{id: shared ? 'shared' : 'root', name: shared ? '與我共用' : '我的雲端硬碟', ...(shared ? {shared: true} : {})}]);}, async back(index) {this.path.set(this.path().slice(0, index + 1));}};
  const creation = {store, connections: {sources: signal([source])}, async validateFolder(id, item, signal) {calls.push(['validate', id, item, signal]); return {...item, name: '實際資料夾名稱'};}};
  const injector = createEnvironmentInjector([{provide: DriveBrowser, useValue: browser}, {provide: DocumentCreateService, useValue: creation}, {provide: DialogRef, useValue: {close: result => closures.push(result)}}, {provide: DIALOG_DATA, useValue: {profileId: 'research', context: 'context', generation: 'generation', workspaceId: 'workspace', version: 1}}, {provide: ɵEffectScheduler, useValue: {add: effect => effects.add(effect), schedule() {}, remove: effect => effects.delete(effect)}}, {provide: ɵChangeDetectionScheduler, useValue: {notify() {}}}]);
  const picker = runInInjectionContext(injector, () => new DriveFolderPicker()), flush = () => {for (const effect of effects) if (effect.dirty) effect.run();}; flush();
  return {picker, browser, creation, source, store, folder, calls, closures, flush, close() {picker.ngOnDestroy(); injector.destroy();}};
}
test('直接瀏覽指定來源，只顯示資料夾；確認後才傳回實際查核結果', async () => {
  const f = fixture();
  try {assert.deepEqual(f.calls, [['source', 'research']]); assert.deepEqual(f.picker.folders(), [f.folder]); await f.picker.select(f.folder); assert.equal(f.calls[1][1], 'research'); assert.equal(f.calls[1][2].resourceKey, 'key'); assert.equal(f.closures[0].folder.name, '實際資料夾名稱');} finally {f.close();}
});
test('階層與根位置切換清除搜尋，與我共用不可當成保存資料夾', async () => {
  const f = fixture();
  try {f.picker.search = '舊搜尋'; await f.picker.open(f.folder); assert.equal(f.browser.path().length, 2); assert.equal(f.picker.search, ''); await f.picker.back(0); assert.equal(f.browser.path().length, 1); await f.picker.root(true); await f.picker.selectCurrent(); assert.equal(f.closures.length, 0); await f.picker.root(); await f.picker.selectCurrent(); assert.equal(f.closures[0].folder.id, 'root');} finally {f.close();}
});
test('Escape 只關閉資料夾視窗，取消查核後晚到結果不套用', async () => {
  const f = fixture(); let release, prevented = false, stopped = false;
  try {f.creation.validateFolder = (...args) => {f.calls.push(args); return new Promise(resolve => release = resolve);}; const pending = f.picker.select(f.folder); assert.equal(f.picker.validating(), true); f.picker.escape({preventDefault() {prevented = true;}, stopPropagation() {stopped = true;}}); assert.equal(f.calls.at(-1)[2].aborted, true); release(f.folder); await pending; assert.deepEqual(f.closures, [undefined]); assert.equal(prevented && stopped, true);} finally {f.close();}
});
test('資料夾權限拒絕留在選擇器顯示原因，仍可選其他位置', async () => {
  const f = fixture();
  try {f.creation.validateFolder = async () => {throw new Error('此資料夾無建立權限');}; await f.picker.select(f.folder); assert.match(f.picker.error(), /無建立權限/); assert.equal(f.closures.length, 0); assert.equal(f.picker.validating(), false); f.creation.validateFolder = async (_, item) => item; await f.picker.selectCurrent(); assert.equal(f.closures[0].folder.id, 'root');} finally {f.close();}
});
test('來源、連線版本或空間變更會取消選擇，不能帶回舊結果', async () => {
  for (const change of [f => f.source.context.set('other'), f => f.source.auth.connectionVersion.set(2), f => f.source.auth.connected.set(false), f => f.store.currentWorkspace.set({id: 'other'}), f => f.creation.connections.sources.set([])]) {
    const f = fixture(); let release;
    try {f.creation.validateFolder = () => new Promise(resolve => release = resolve); const pending = f.picker.select(f.folder); change(f); f.flush(); release(f.folder); await pending; assert.equal(f.closures.length, 1); assert.equal(f.closures[0].folder, undefined); assert.match(f.closures[0].message, /變更/);} finally {f.close();}
  }
});
