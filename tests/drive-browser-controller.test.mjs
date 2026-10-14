import '@angular/compiler';
import {DOCUMENT} from '@angular/common';
import {createEnvironmentInjector, runInInjectionContext, signal, ɵEffectScheduler, ɵChangeDetectionScheduler} from '@angular/core';
import assert from 'node:assert/strict';
import {after, test} from 'node:test';
import {createRequire} from 'node:module';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {JSDOM} from 'jsdom';
import {COLUMNS} from '../src/app/models.ts';
import {DRIVE_FOLDER_MIME, readDriveBrowserEntry, sourceFromDriveEntry} from '../src/app/drive-browser-data.ts';
import {DOCUMENT_DRAG_TYPE} from '../src/app/document-data.ts';

const require = createRequire(import.meta.url), {build} = createRequire(require.resolve('@angular/build/package.json'))('esbuild');
await mkdir('.angular', {recursive: true});
const directory = await mkdtemp(resolve('.angular/drive-browser-test-')), output = resolve(directory, 'controller.mjs');
await build({stdin: {contents: "export {DriveBrowser} from './src/app/drive-browser.ts'; export {DriveBrowserAuth} from './src/app/drive-browser-auth.ts'; export {DriveBrowserConnection} from './src/app/drive-browser-connection.ts'; export {DocumentTasks} from './src/app/document-tasks.ts'; export {BoardStore} from './src/app/board-store.ts';", resolveDir: process.cwd()}, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: output, tsconfig: 'tsconfig.json'});
const {DriveBrowser, DriveBrowserAuth, DriveBrowserConnection, DocumentTasks, BoardStore} = await import(pathToFileURL(output).href);
after(() => rm(directory, {recursive: true, force: true}));
const raw = (id, folder = false) => ({id, name: id, mimeType: folder ? DRIVE_FOLDER_MIME : 'application/pdf'});
const base = {id: 'existing', title: '原任務', description: '', categoryId: '', projectId: '', status: 'todo', priority: 'medium', startDate: '', dueDate: '', startTime: '', dueTime: '', subtasks: []};
function fixture(api = async () => ({files: [raw('folder', true), raw('file')]})) {
  const values = new Map([['orbit-workspaces-v1', JSON.stringify({version: 1, activeWorkspaceId: 'workspace', workspaces: [{version: 4, id: 'workspace', name: '工作', projects: [], categories: [], statuses: COLUMNS, tasks: [base]}]})]]);
  globalThis.localStorage = {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key)};
  const store = new BoardStore(), dom = new JSDOM('', {url: 'https://example.test'}), effects = new Set(), calls = [];
  const auth = {connectionVersion: signal(0), connected: signal(true), authorizing: signal(false), account: signal(null), ready: signal(true), message: signal(''), useSession() {}, disconnect() {this.connected.set(false); this.authorizing.set(false); this.connectionVersion.update(v => v + 1);}, prepare: async () => {}, authorize: async () => ({id: 'new-account', email: 'new@example.test'}), api: (...args) => {calls.push(args); return api(...args);}};
  const injector = createEnvironmentInjector([DriveBrowserConnection, {provide: BoardStore, useValue: store}, {provide: DOCUMENT, useValue: dom.window.document}, {provide: DriveBrowserAuth, useValue: auth}, {provide: ɵEffectScheduler, useValue: {add: e => effects.add(e), schedule() {}, remove: e => effects.delete(e)}}, {provide: ɵChangeDetectionScheduler, useValue: {notify() {}}}]);
  globalThis.ngServerMode = true;
  let browser, documents;
  try {runInInjectionContext(injector, () => {browser = new DriveBrowser(); documents = new DocumentTasks();});} finally {delete globalThis.ngServerMode;}
  const flush = () => {for (let round = 0; round < 20 && [...effects].some(effect => effect.dirty); round++) for (const effect of effects) if (effect.dirty) effect.run();}; flush();
  return {store, browser, documents, auth, calls, values, dom, flush, injector, close() {browser.ngOnDestroy(); documents.ngOnDestroy(); injector.destroy(); dom.window.close();}};
}
function event() {
  const data = new Map(); return {clientX: 20, clientY: 20, currentTarget: null, dataTransfer: {types: [], setData(type, value) {data.set(type, value); this.types = [...data.keys()];}, getData: type => data.get(type) ?? '', setDragImage() {}}, preventDefault() {}, stopPropagation() {}};
}
test('只載入直接子項，回上層與重開使用五分鐘快取，手動更新與過期才重讀', async t => {
  t.mock.timers.enable({apis: ['Date'], now: 1800000000000});
  const f = fixture(async (_, params) => ({files: [raw(params.q.includes("'folder' in parents") ? 'child' : 'folder', !params.q.includes("'folder' in parents"))]}));
  try {
    await f.browser.activate(); assert.equal(f.calls.length, 1); await f.browser.open(f.browser.files()[0]); assert.equal(f.calls.length, 2); assert.equal(f.browser.path().length, 2);
    await f.browser.back(); assert.equal(f.calls.length, 2); await f.browser.activate(); assert.equal(f.calls.length, 2);
    t.mock.timers.tick(240000); await f.browser.activate(); assert.equal(f.calls.length, 2);
    t.mock.timers.tick(60001); await f.browser.activate(); assert.equal(f.calls.length, 3);
    await f.browser.refresh(); assert.equal(f.calls.length, 4); t.mock.timers.tick(300001); await f.browser.activate(); assert.equal(f.calls.length, 5);
    assert.equal(f.values.has('iih-orbit-drive-browser-cache'), false); assert.equal(f.store.currentWorkspace().version, 4);
  } finally {f.close();}
});
test('資料夾載入失敗保留原列表與路徑，搜尋範圍與共用列表只按需請求', async () => {
  const f = fixture(async (_, params) => {if (params.q.includes("'folder' in parents")) throw new Error('offline'); return {files: [raw('folder', true), raw('file')]};});
  try {await f.browser.activate(); await f.browser.open(f.browser.files()[0]); assert.equal(f.browser.path().length, 1); assert.equal(f.browser.files().length, 2); assert.equal(f.browser.error(), 'offline'); await f.browser.search('research'); assert.match(f.calls.at(-1)[1].q, /name contains 'research'/); await f.browser.root(true); assert.match(f.calls.at(-1)[1].q, /sharedWithMe/); assert.equal(f.browser.path()[0].shared, true);} finally {f.close();}
});
test('含其他編輯器開啟連結的資料夾可進入，項目保留且能加入任務與匯出備份', async () => {
  const f = fixture(async (_, parameters) => ({files: parameters.q.includes("'folder' in parents") ? [
    {...raw('script-file'), mimeType: 'application/vnd.google-apps.script', webViewLink: 'https://script.google.com/home/projects/script-file/edit'},
    {...raw('site-file'), mimeType: 'application/vnd.google-apps.site', webViewLink: 'https://sites.google.com/d/site-file/edit'},
    {...raw('foreign-link'), webViewLink: 'https://unrecognized.example/open?access_token=PRIVATE-TOKEN', resourceKey: 'resource-key'}
  ] : [raw('folder', true)]}));
  try {
    await f.browser.activate(); await f.browser.open(f.browser.files()[0]);
    assert.equal(f.browser.path().at(-1).id, 'folder'); assert.equal(f.browser.error(), ''); assert.equal(f.browser.files().length, 3);
    const source = f.browser.source(f.browser.files().find(file => file.id === 'foreign-link'));
    assert.equal(source.url, 'https://drive.google.com/file/d/foreign-link/view?resourcekey=resource-key');
    const result = await f.store.linkDocument(base.id, source); assert.equal(result.ok, true);
    assert.equal(f.store.documentsForTask(base.id)[0].id, source.id); assert.equal(JSON.stringify(await f.store.backupForExport('full')).includes('PRIVATE-TOKEN'), false);
    await f.browser.back(); assert.equal(f.browser.path().length, 1); assert.equal(f.browser.files()[0].id, 'folder'); assert.equal(f.calls.length, 2);
  } finally {f.close();}
});
test('導覽新請求、帳號或 generation 改變後，舊結果不能回寫', async () => {
  const pending = [], f = fixture(() => new Promise(resolve => pending.push(resolve)));
  try {
    const first = f.browser.activate(), second = f.browser.root(true); pending[1]({files: [raw('shared-file')]}); await second; pending[0]({files: [raw('stale-file')]}); await first;
    assert.equal(f.browser.files()[0].id, 'shared-file'); assert.equal(f.calls[0][2].aborted, true);
    const stale = f.browser.refresh(); f.auth.connected.set(false); f.auth.connectionVersion.update(v => v + 1); f.flush(); pending[2]({files: [raw('account-old')]}); await stale; assert.equal(f.browser.files()[0].id, 'shared-file'); assert.equal(f.browser.busy(), false);
    f.auth.connected.set(true); const request = f.browser.refresh(); f.store.generation.set('replacement'); f.flush(); pending[3]({files: [raw('generation-old')]}); await request;
    assert.equal(f.browser.files().length, 0); assert.equal(f.browser.path().length, 1);
  } finally {f.close();}
});
test('分頁去重且拒絕重複游標，從快取返回後仍保留游標歷史', async () => {
  const f = fixture(async (_, p) => p.pageToken === 'a' ? {files: [raw('file'), raw('second')], nextPageToken: 'b'} : p.pageToken === 'b' ? {files: [raw('third')], nextPageToken: 'a'} : {files: [raw('file')], nextPageToken: 'a'});
  try {await f.browser.activate(); await f.browser.more(); assert.equal(f.browser.files().length, 2); await f.browser.root(true); await f.browser.root(); await f.browser.more(); assert.match(f.browser.error(), /分頁重複/); assert.equal(f.browser.files().length, 2); assert.equal(f.browser.nextPageToken(), 'b');} finally {f.close();}
});
test('未連線不提供替代檔案，連線後只使用 API 回覆與 Drive 來源身份', async () => {
  const f = fixture();
  try {
    f.auth.connected.set(false); f.flush();
    await f.browser.activate(); await f.browser.root(true); await f.browser.refresh();
    assert.equal(f.calls.length, 0); assert.deepEqual(f.browser.files(), []);
    f.auth.connected.set(true); await f.browser.activate();
    const folder = f.browser.files().find(file => file.id === 'folder'), source = f.browser.source(folder);
    assert.equal(source.sourceScope, 'drive'); assert.equal(source.fileId, 'folder'); assert.equal(f.calls.length, 1);
    const result = await f.store.linkDocument(base.id, source); assert.equal(result.ok, true);
    assert.equal(f.store.tasksForDocument(source)[0].task.id, base.id);
    f.browser.disconnect(); assert.deepEqual(f.browser.files(), []); assert.throws(() => f.browser.source(folder), /列表或連線已更新/);
    assert.equal(f.store.documentsForTask(base.id)[0].id, source.id);
  } finally {f.close();}
});
test('拖到中心只加關聯，重複拖曳不寫新事件；卡片邊緣立即插入完整任務', async () => {
  const f = fixture(), file = sourceFromDriveEntry(readDriveBrowserEntry(raw('file')));
  try {
    const drag = event(); f.documents.start(drag, file, () => true); assert.equal(f.documents.dragging(), true); await f.documents.drop(drag, {...base, id: 'new'}, {kind: 'link', taskId: base.id}); assert.equal(f.store.tasks().length, 1); assert.equal(f.store.documentsForTask(base.id).length, 1);
    const links = f.store.currentWorkspace().documentLinks.length, repeat = event(); f.documents.start(repeat, file, () => true); await f.documents.drop(repeat, {...base, id: 'new'}, {kind: 'link', taskId: base.id}); assert.equal(f.store.currentWorkspace().documentLinks.length, links); assert.match(f.documents.notice(), /已連結/);
    const insert = event(); f.documents.start(insert, file, () => true); await f.documents.drop(insert, {...base, id: 'new'}, {kind: 'create', beforeId: base.id, status: 'todo'}); assert.equal(f.store.tasks()[0].id, 'new'); assert.equal(f.store.tasks()[0].title, 'file'); assert.equal(f.store.documentsForTask('new')[0].id, file.id);
  } finally {f.close();}
});
test('週時段直接新增有起訖的任務，無效時間不留半筆任務', async () => {
  const f = fixture(), folder = sourceFromDriveEntry(readDriveBrowserEntry(raw('folder', true)));
  try {const drag = event(); f.documents.start(drag, folder, () => true); await f.documents.drop(drag, {...base, id: 'timed'}, {kind: 'create'}, {kind: 'time', day: '2026-10-13', minute: 600}); const task = f.store.tasks().find(task => task.id === 'timed'); assert.equal(task.startTime, '10:00'); assert.equal(task.dueTime, '11:00'); assert.equal(f.store.documentsForTask(task.id)[0].mimeType, DRIVE_FOLDER_MIME); const bad = event(); f.documents.start(bad, folder, () => true); await f.documents.drop(bad, {...base, id: 'bad'}, {kind: 'create'}, {kind: 'time', day: 'bad', minute: 600}); assert.equal(f.store.tasks().some(task => task.id === 'bad'), false);} finally {f.close();}
});
test('拖曳 token 與即時來源驗證，切換工作空間、帳號與 generation 取消舊拖曳', async () => {
  const f = fixture(), file = sourceFromDriveEntry(readDriveBrowserEntry(raw('file')));
  try {
    let current = true; const drag = event(); f.documents.start(drag, file, () => current); const foreign = event(); foreign.dataTransfer.setData(DOCUMENT_DRAG_TYPE, 'forged'); await f.documents.drop(foreign, {...base, id: 'forged'}); assert.equal(f.store.tasks().length, 1);
    current = false; await f.documents.drop(drag, {...base, id: 'stale'}); assert.equal(f.store.tasks().length, 1);
    const next = event(); f.documents.start(next, file, () => true); f.store.generation.set('new-generation'); f.flush(); assert.equal(f.documents.dragging(), false); await f.documents.drop(next, {...base, id: 'late'}); assert.equal(f.store.tasks().length, 1);
  } finally {f.close();}
});
test('檔案授權 API 限制為 GET files，resource keys 正確傳送，拒絕內容下載與其他端點', async () => {
  const calls = [], auth = Object.create(DriveBrowserAuth.prototype); auth.fetchJson = async (...args) => {calls.push(args); return {};};
  await auth.api('files', {fields: 'files(id,name)'}, undefined, 'folder/key'); assert.match(calls[0][0], /^https:\/\/www.googleapis.com\/drive\/v3\/files\?/); assert.equal(calls[0][1].headers['X-Goog-Drive-Resource-Keys'], 'folder/key');
  for (const args of [['files/x', {}], ['files', {alt: 'media'}], ['files', {fields: '*'}], ['files', {}, undefined, 'bad/header/value']]) assert.throws(() => auth.api(...args));
});

test('跨共用硬碟的資料夾捷徑用 target ID 導覽，不沿用捷徑所在硬碟範圍', async () => {
  const f = fixture(async () => ({files: [{...raw('shortcut'), mimeType: 'application/vnd.google-apps.shortcut', driveId: 'origin-drive', shortcutDetails: {targetId: 'target-folder', targetMimeType: DRIVE_FOLDER_MIME, targetResourceKey: 'target-key'}}]}));
  try {await f.browser.activate(); await f.browser.open(f.browser.files()[0]); const call = f.calls.at(-1); assert.match(call[1].q, /'target-folder' in parents/); assert.equal(call[1].corpora, 'user'); assert.equal(call[1].driveId, undefined); assert.equal(call[3], 'target-folder/target-key');} finally {f.close();}
});

test('取消檔案瀏覽授權後，晚到回覆不重建帳號與列表', async () => {
  const f = fixture(); let resolveAuthorization;
  try {
    f.store.google = signal({clientId: 'client'}); f.flush(); f.auth.authorize = () => {f.auth.authorizing.set(true); return new Promise(resolve => resolveAuthorization = resolve);};
    const pending = f.browser.connection.connect(); f.browser.connection.cancelAuthorization(); f.flush();
    resolveAuthorization({id: 'late-account', email: 'late@example.test'}); assert.equal(await pending, false);
    assert.equal(f.auth.connected(), false); assert.deepEqual(f.browser.files(), []); assert.equal(f.browser.connection.account().id, ''); assert.equal(f.calls.length, 0);
  } finally {f.close();}
});

test('側欄與選檔各自導航、搜尋與快取，只共享授權，關閉選檔不影響側欄', async () => {
  const f = fixture(async (_, parameters) => ({files: parameters.q.includes("'research' in parents") ? [raw('proposal')] : parameters.q.includes("'course' in parents") ? [raw('slides')] : [raw('research', true), raw('course', true)]})); let picker;
  try {
    picker = runInInjectionContext(f.injector, () => new DriveBrowser()); f.flush();
    assert.equal(picker.auth, f.browser.auth); assert.equal(picker.connection, f.browser.connection);
    await f.browser.activate(); await f.browser.open(f.browser.files().find(file => file.id === 'research')); await f.browser.search('proposal');
    const before = {path: structuredClone(f.browser.path()), files: structuredClone(f.browser.files()), query: f.browser.query()};
    assert.deepEqual(picker.files(), []); await picker.activate(); await picker.open(picker.files().find(file => file.id === 'course'));
    assert.equal(picker.path().at(-1).id, 'course'); assert.equal(picker.files()[0].id, 'slides');
    assert.deepEqual(f.browser.path(), before.path); assert.deepEqual(f.browser.files(), before.files); assert.equal(f.browser.query(), before.query);
    const requests = f.calls.length; await f.browser.back(); await f.browser.open(f.browser.files().find(file => file.id === 'research')); await f.browser.search('proposal');
    assert.equal(f.calls.length, requests); assert.deepEqual(f.browser.path(), before.path);
    picker.ngOnDestroy(); assert.equal(f.auth.connected(), true); assert.deepEqual(f.browser.path(), before.path);
  } finally {picker?.ngOnDestroy(); f.close();}
});
test('選檔的請求取消與錯誤不取消側欄讀取，也不共用錯誤訊息', async () => {
  const pending = [], f = fixture(() => new Promise(resolve => pending.push(resolve))); let picker;
  try {
    picker = runInInjectionContext(f.injector, () => new DriveBrowser()); f.flush();
    const sidebarLoad = f.browser.activate(), pickerLoad = picker.activate();
    picker.ngOnDestroy(); assert.equal(f.calls[0][2].aborted, false); assert.equal(f.calls[1][2].aborted, true); assert.equal(f.auth.connected(), true);
    pending[0]({files: [raw('sidebar-file')]}); pending[1]({files: [raw('discarded-file')]}); await Promise.all([sidebarLoad, pickerLoad]);
    assert.equal(f.browser.files()[0].id, 'sidebar-file'); assert.equal(f.browser.error(), ''); assert.equal(picker.files().length, 0);
  } finally {picker?.ngOnDestroy(); f.close();}
});
