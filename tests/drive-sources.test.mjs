import '@angular/compiler';
import {DOCUMENT} from '@angular/common';
import {createEnvironmentInjector, runInInjectionContext, ɵEffectScheduler, ɵChangeDetectionScheduler} from '@angular/core';
import assert from 'node:assert/strict';
import {after, test} from 'node:test';
import {createRequire} from 'node:module';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {JSDOM} from 'jsdom';
import {COLUMNS} from '../src/app/models.ts';
import {DRIVE_BROWSER_SCOPE, DRIVE_FOLDER_MIME} from '../src/app/drive-browser-data.ts';
import {DRIVE_SOURCE_KEY, readDriveSources} from '../src/app/drive-source-data.ts';
import {documentLocationLabel} from '../src/app/document-data.ts';

const require = createRequire(import.meta.url), {build} = createRequire(require.resolve('@angular/build/package.json'))('esbuild');
await mkdir('.angular', {recursive: true});
const directory = await mkdtemp(resolve('.angular/drive-sources-test-')), output = resolve(directory, 'sources.mjs');
await build({stdin: {contents: "export {DocumentCreateService} from './src/app/document-create-service.ts'; export {DocumentMetadataService} from './src/app/document-metadata-service.ts'; export {DriveBrowser} from './src/app/drive-browser.ts'; export {DriveBrowserAuth} from './src/app/drive-browser-auth.ts'; export {DriveBrowserConnection} from './src/app/drive-browser-connection.ts'; export {BoardStore} from './src/app/board-store.ts';", resolveDir: process.cwd()}, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: output, tsconfig: 'tsconfig.json'});
const {DocumentCreateService, DocumentMetadataService, DriveBrowser, DriveBrowserAuth, DriveBrowserConnection, BoardStore} = await import(pathToFileURL(output).href);
after(() => rm(directory, {recursive: true, force: true}));
const clientId = '123-example.apps.googleusercontent.com', otherClient = '456-other.apps.googleusercontent.com';
const raw = (id, folder = false) => ({id, name: id, mimeType: folder ? DRIVE_FOLDER_MIME : 'application/pdf'});
async function fixture() {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), previousFetch = globalThis.fetch;
  const values = new Map(), tokens = new Map(), requests = [], calls = [], effects = new Set(), dom = new JSDOM('', {url: 'https://example.test'});
  const storage = {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key)};
  values.set('orbit-workspaces-v1', JSON.stringify({version: 1, activeWorkspaceId: 'workspace', workspaces: [{version: 4, id: 'workspace', name: '工作', projects: [], categories: [], statuses: COLUMNS, tasks: []}]}));
  Object.defineProperty(globalThis, 'localStorage', {value: storage, configurable: true});
  Object.defineProperty(dom.window, 'localStorage', {value: storage});
  const store = new BoardStore(); await store.updateGoogle({clientId});
  const oauth = {initTokenClient(options) {return {requestAccessToken(prompt) {requests.push({options, prompt});}};}, hasGrantedAllScopes(response, scope) {return response.scope?.split(' ').includes(scope);}};
  dom.window.google = {accounts: {oauth2: oauth}};
  let fetchFiles = async (url, account) => Response.json({files: url.searchParams.get('q').includes("'folder' in parents") ? [raw('same-file')] : [raw('folder', true), raw(account + '-file')]});
  globalThis.fetch = async (url, options) => {
    const token = new Headers(options.headers).get('Authorization').slice(7), account = tokens.get(token);
    if (String(url).includes('/userinfo')) return Response.json({sub: account, email: account + '@example.test'});
    calls.push({url: new URL(url), account, signal: options.signal});
    return fetchFiles(new URL(url), account, options);
  };
  const injector = createEnvironmentInjector([DocumentCreateService, DocumentMetadataService, DriveBrowserConnection, DriveBrowserAuth, {provide: BoardStore, useValue: store}, {provide: DOCUMENT, useValue: dom.window.document}, {provide: ɵEffectScheduler, useValue: {add: effect => effects.add(effect), schedule() {}, remove: effect => effects.delete(effect)}}, {provide: ɵChangeDetectionScheduler, useValue: {notify() {}}}]);
  const make = Type => runInInjectionContext(injector, () => new Type());
  const browser = make(DriveBrowser), picker = make(DriveBrowser), connection = injector.get(DriveBrowserConnection);
  const flush = () => {for (let round = 0; round < 30 && [...effects].some(effect => effect.dirty); round++) for (const effect of effects) if (effect.dirty) effect.run();}; flush();
  const begin = async (source, selectAccount = false) => {await source.prepare(); return {pending: source.id === 'default' ? source.connect(undefined, undefined, selectAccount) : source.connect(selectAccount)};};
  const reply = async (account, scopes = DRIVE_BROWSER_SCOPE) => {const token = 'synthetic-' + crypto.randomUUID(); tokens.set(token, account); await requests.at(-1).options.callback({access_token: token, expires_in: 3600, scope: scopes});};
  const grant = async (source, account, selectAccount = false) => {const {pending} = await begin(source, selectAccount); await reply(account); const result = await pending; flush(); return result;};
  return {store, document: dom.window.document, storage, values, requests, calls, connection, browser, picker, injector, make, flush, begin, reply, grant, setFiles: callback => fetchFiles = callback, close() {browser.ngOnDestroy(); picker.ngOnDestroy(); if (!injector.destroyed) injector.destroy(); store.ngOnDestroy(); dom.window.close(); globalThis.fetch = previousFetch; if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage); else delete globalThis.localStorage;}};
}
test('來源設定只保存公開欄位，拒絕重複身份、無效 Client ID 及過多來源', () => {
  const source = {id: crypto.randomUUID(), name: '研究', clientId, accountId: 'account', email: 'account@example.test', token: 'never-save', secret: 'never-save'};
  const settings = {version: 1, defaultName: '主要來源', sources: [source]};
  assert.equal(JSON.stringify(readDriveSources(settings)).includes('never-save'), false);
  for (const sources of [[source, source], [{...source, clientId: 'bad'}], [{...source, name: ''}], Array.from({length: 21}, () => ({...source, id: crypto.randomUUID()}))]) assert.equal(readDriveSources({...settings, sources}), undefined);
});
test('多來源使用獨立憑證及 Client ID，解除其中一個來源不影響其他連線或備份設定', async () => {
  const f = await fixture();
  try {
    const backup = structuredClone(f.store.drive()); assert.equal(await f.grant(f.connection, 'primary'), true);
    const id = await f.connection.addSource('研究', otherClient), extra = f.connection.source(id);
    assert.equal(await f.grant(extra, 'research'), true); assert.equal(f.requests.at(-1).options.client_id, otherClient);
    assert.equal(extra.auth.account().id, 'research'); assert.equal(f.connection.auth.account().id, 'primary');
    const primaryKey = 'iih-orbit-drive-browser-session-v1', extraKey = 'iih-orbit-drive-source-' + id + '-session-v1';
    assert.equal(JSON.parse(f.values.get(primaryKey)).account.id, 'primary'); assert.equal(JSON.parse(f.values.get(extraKey)).account.id, 'research');
    assert.equal(JSON.stringify(JSON.parse(f.values.get(DRIVE_SOURCE_KEY))).includes('synthetic-'), false);
    extra.disconnect(); assert.equal(extra.auth.connected(), false); assert.equal(f.connection.auth.connected(), true); assert.deepEqual(f.store.drive(), backup);
  } finally {f.close();}
});
test('側欄與選檔各自記住每個來源的目錄、搜尋與快取，同一檔案跨帳號仍只有一個身份', async () => {
  const f = await fixture();
  try {
    await f.grant(f.connection, 'primary'); const id = await f.connection.addSource('研究'); await f.grant(f.connection.source(id), 'research');
    await f.browser.activate(); await f.browser.open(f.browser.files().find(file => file.id === 'folder')); await f.browser.search('same-file');
    const primary = f.browser.source(f.browser.files()[0]); assert.equal(f.browser.pathLabel(0), 'Google Drive'); assert.equal(documentLocationLabel(primary), 'Google Drive / 我的雲端硬碟 / folder');
    await f.picker.selectSource(id); assert.equal(f.picker.pathLabel(0), '研究'); assert.equal(f.browser.sourceId(), 'default'); assert.equal(f.browser.query(), 'same-file');
    await f.browser.selectSource(id); assert.equal(f.browser.path().length, 1); await f.browser.open(f.browser.files().find(file => file.id === 'folder'));
    const research = f.browser.source(f.browser.files()[0]); assert.equal(research.id, primary.id); assert.equal(documentLocationLabel(research), '研究 / 我的雲端硬碟 / folder');
    const count = f.calls.length; await f.browser.selectSource('default'); assert.equal(f.browser.path().at(-1).id, 'folder'); assert.equal(f.browser.query(), 'same-file'); assert.equal(f.calls.length, count);
    assert.equal(f.picker.sourceId(), id); assert.equal(f.picker.path().length, 1);
  } finally {f.close();}
});
test('重新授權使用原帳號提示，回傳不同帳號被拒絕，明確切換帳號才更新來源', async () => {
  const f = await fixture();
  try {
    const id = await f.connection.addSource('研究'), source = f.connection.source(id); await f.grant(source, 'research');
    const {pending} = await f.begin(source); assert.equal(f.requests.at(-1).prompt.prompt, ''); assert.equal(f.requests.at(-1).prompt.login_hint, 'research');
    await f.reply('different'); assert.equal(await pending, false); assert.equal(source.account().id, 'research'); assert.equal(source.auth.connected(), false); assert.match(source.error(), /不同/);
    assert.equal(await f.grant(source, 'different', true), true); assert.equal(f.requests.at(-1).prompt.prompt, 'select_account'); assert.equal(f.requests.at(-1).prompt.login_hint, undefined); assert.equal(source.account().id, 'different');
    assert.equal(await f.grant(source, 'different'), true); assert.equal(f.requests.at(-1).prompt.prompt, '');
  } finally {f.close();}
});
test('來源移除或 Client ID 變更期間的授權回覆不能復活來源，保存失敗保留設定與有效連線', async () => {
  const f = await fixture();
  try {
    const id = await f.connection.addSource('研究'), source = f.connection.source(id); await f.grant(source, 'research');
    const setItem = f.storage.setItem; f.storage.setItem = () => {throw new Error('disk full');};
    assert.equal(await f.connection.removeSource(id), false); assert.equal(f.connection.source(id), source); assert.equal(source.auth.connected(), true); f.storage.setItem = setItem;
    let started = await f.begin(source); assert.equal(await f.connection.saveSource(id, '研究二', otherClient), true); await f.reply('late'); assert.equal(await started.pending, false); assert.equal(source.auth.connected(), false); assert.equal(source.clientId(), otherClient);
    started = await f.begin(source); assert.equal(await f.connection.removeSource(id), true); await f.reply('late'); assert.equal(await started.pending, false); assert.equal(f.connection.sources().length, 1); assert.equal(source.auth.connected(), false);
  } finally {f.close();}
});
test('來源切換與移除取消舊讀取，晚到列表不寫回目前來源', async () => {
  const f = await fixture();
  try {
    await f.grant(f.connection, 'primary'); const id = await f.connection.addSource('研究'); await f.grant(f.connection.source(id), 'research');
    let resolveOld; f.setFiles((_, account) => account === 'research' ? new Promise(resolve => resolveOld = resolve) : Promise.resolve(Response.json({files: [raw('primary-file')]})));
    const old = f.browser.selectSource(id); const current = f.browser.selectSource('default'); f.flush(); resolveOld(Response.json({files: [raw('stale-file')]})); await Promise.all([old, current]);
    assert.equal(f.browser.files()[0].id, 'primary-file'); assert.equal(f.calls[0].signal.aborted, true);
    await f.connection.removeSource(id); f.flush(); assert.equal(f.browser.selectedConnection().id, 'default');
  } finally {f.close();}
});
test('新帳號已授權但設定尚在等待保存時，不讀取或選用舊帳號列表', async () => {
  const f = await fixture();
  try {
    const id = await f.connection.addSource('研究'), source = f.connection.source(id); await f.grant(source, 'research'); await f.browser.selectSource(id);
    const file = f.browser.files()[0], count = f.calls.length; let release;
    Object.defineProperty(f.document.defaultView.navigator, 'locks', {value: {request: (_, write) => new Promise(resolve => release = () => resolve(write()))}});
    const {pending} = await f.begin(source, true); await f.reply('different');
    assert.equal(source.connecting(), true); assert.equal(f.browser.isListed(file), false); await f.browser.refresh(); assert.equal(f.calls.length, count);
    release(); assert.equal(await pending, true); f.flush(); await f.browser.activate();
    assert.equal(source.account().id, 'different'); assert.equal(f.calls.at(-1).account, 'different');
  } finally {f.close();}
});
test('來源授權不足與到期只影響該來源，整體解除會清除所有檔案來源憑證', async () => {
  const f = await fixture();
  try {
    await f.grant(f.connection, 'primary'); const id = await f.connection.addSource('研究'), source = f.connection.source(id);
    assert.equal(await f.grant(source, 'research', false), true);
    source.auth.disconnect('到期', 'expired'); assert.equal(f.connection.status(source), '授權已到期'); assert.equal(f.connection.auth.connected(), true);
    const {pending} = await f.begin(source); await f.reply('research', 'openid'); assert.equal(await pending, false); assert.equal(source.auth.connected(), false); assert.equal(f.connection.auth.connected(), true);
    await f.grant(source, 'research'); source.auth.validUntil.set(Date.now() + 60000); assert.equal(f.connection.status(source), '即將到期');
    f.connection.disconnectAll(); assert.equal(f.connection.auth.connected(), false); assert.equal(source.auth.connected(), false);
    assert.equal([...f.values.keys()].some(key => key.endsWith('-session-v1')), false);
  } finally {f.close();}
});
test('舊單一來源及有效憑證直接沿用，新增來源後重新建立服務仍維持原期限', async () => {
  const f = await fixture(); let restored;
  try {
    await f.grant(f.connection, 'primary'); const expiresAt = f.connection.auth.validUntil(), marker = f.connection.context();
    const id = await f.connection.addSource('研究', otherClient); await f.grant(f.connection.source(id), 'research'); const extraExpires = f.connection.source(id).auth.validUntil();
    f.browser.ngOnDestroy(); f.picker.ngOnDestroy(); f.injector.destroy();
    const effects = new Set();
    restored = createEnvironmentInjector([DriveBrowserConnection, DriveBrowserAuth, {provide: BoardStore, useValue: f.store}, {provide: DOCUMENT, useValue: f.document}, {provide: ɵEffectScheduler, useValue: {add: effect => effects.add(effect), schedule() {}, remove: effect => effects.delete(effect)}}, {provide: ɵChangeDetectionScheduler, useValue: {notify() {}}}]);
    const connection = restored.get(DriveBrowserConnection); for (const effect of effects) if (effect.dirty) effect.run();
    assert.equal(connection.context(), marker); assert.equal(connection.auth.connected(), true); assert.equal(connection.auth.validUntil(), expiresAt);
    assert.equal(connection.source(id).auth.connected(), true); assert.equal(connection.source(id).auth.validUntil(), extraExpires); assert.equal(f.requests.length, 2);
  } finally {restored?.destroy(); f.close();}
});
test('分頁接續各來源授權，晚到的舊到期事件不刪新憑證，來源移除同步解除舊分頁', async () => {
  const f = await fixture(); let peer;
  try {
    await f.grant(f.connection, 'primary'); const id = await f.connection.addSource('研究'); await f.grant(f.connection.source(id), 'research');
    const effects = new Set();
    peer = createEnvironmentInjector([DriveBrowserConnection, DriveBrowserAuth, {provide: BoardStore, useValue: f.store}, {provide: DOCUMENT, useValue: f.document}, {provide: ɵEffectScheduler, useValue: {add: effect => effects.add(effect), schedule() {}, remove: effect => effects.delete(effect)}}, {provide: ɵChangeDetectionScheduler, useValue: {notify() {}}}]);
    const connection = peer.get(DriveBrowserConnection); for (const effect of effects) if (effect.dirty) effect.run();
    const old = connection.source(id); assert.equal(old.auth.connected(), true);
    await f.grant(f.connection.source(id), 'research'); const key = 'iih-orbit-drive-source-' + id + '-session-v1', renewed = f.values.get(key);
    old.auth.disconnect('舊到期回覆', 'expired'); assert.equal(f.values.get(key), renewed);
    f.document.defaultView.dispatchEvent(new f.document.defaultView.Event('focus')); assert.equal(old.auth.connected(), true);
    await f.connection.removeSource(id); f.document.defaultView.dispatchEvent(new f.document.defaultView.StorageEvent('storage', {key: DRIVE_SOURCE_KEY}));
    assert.equal(connection.sources().length, 1); assert.equal(old.auth.connected(), false); assert.equal(connection.auth.connected(), true); assert.equal(f.values.has(key), false);
  } finally {peer?.destroy(); f.close();}
});

test('既有資料夾建立使用指定來源獨立 Drive 授權，記憶體憑證不覆蓋瀏覽或備份連線', async () => {
  const f = await fixture();
  try {
    await f.grant(f.connection, 'primary'); const profileId = await f.connection.addSource('研究文件', otherClient), source = f.connection.source(profileId);
    await f.grant(source, 'research');
    const task = {id: 'create-task', title: '研究任務', description: '', categoryId: '', projectId: '', status: 'todo', priority: 'medium', startDate: '', dueDate: '', startTime: '', dueTime: '', subtasks: []};
    await f.store.saveTask(task); const backup = structuredClone(f.store.drive()), readonlySession = f.values.get('iih-orbit-drive-source-' + profileId + '-session-v1');
    f.setFiles(async (url, account, options) => {assert.equal(account, 'research'); if (options.method !== 'POST') return Response.json({id: url.pathname.split('/').at(-1), name: '已授權資料夾', mimeType: DRIVE_FOLDER_MIME, capabilities: {canAddChildren: true}}); const body = JSON.parse(options.body); return Response.json({id: 'created-document', name: body.name, mimeType: body.mimeType, appProperties: body.appProperties, parents: body.parents});});
    const creation = f.injector.get(DocumentCreateService); f.flush(); await creation.prepare(profileId);
    const pending = creation.create(f.store.taskContext(task.id), profileId, '研究文件', 'application/vnd.google-apps.document', {id: 'write-folder', name: '選用的資料夾'});
    assert.equal(f.requests.at(-1).options.client_id, otherClient); assert.equal(f.requests.at(-1).options.scope.split(' ').includes('https://www.googleapis.com/auth/drive'), true);
    assert.equal(f.requests.at(-1).options.scope.includes('metadata.readonly'), false);
    await f.reply('research', 'https://www.googleapis.com/auth/drive'); await pending;
    assert.equal(creation.result().phase, 'linked'); assert.equal(f.store.documentsForTask(task.id)[0].fileId, 'created-document');
    creation.operations.set([]); assert.equal(creation.lastFolder(profileId).id, 'write-folder'); assert.equal(creation.lastFolder('default').id, 'root');
    assert.throws(() => creation.authorization(profileId).api('files/created-document', {}, {method: 'DELETE'}), /僅允許/);
    assert.throws(() => creation.authorization(profileId).api('files', {fields: '*'}, {method: 'POST', body: '{}'}), /僅允許/);
    assert.equal(f.values.get('iih-orbit-drive-source-' + profileId + '-session-v1'), readonlySession); assert.deepEqual(f.store.drive(), backup);
    assert.equal([...f.values.keys()].some(key => /document-create-.*-session-v1$/.test(key)), false);
    creation.authorization(profileId).disconnect(); assert.equal(source.auth.connected(), true); assert.equal(f.connection.auth.connected(), true);
  } finally {f.close();}
});

test('文件建立授權回傳不同帳號或被拒絕時，不送出建立要求且保留任務', async () => {
  const f = await fixture();
  try {
    await f.grant(f.connection, 'primary'); const task = {id: 'safe-create', title: '保留任務', description: '', categoryId: '', projectId: '', status: 'todo', priority: 'medium', startDate: '', dueDate: '', startTime: '', dueTime: '', subtasks: []};
    await f.store.saveTask(task); const creation = f.injector.get(DocumentCreateService); f.flush(); await creation.prepare('default'); const revision = f.store.revision(), calls = f.calls.length;
    const pending = creation.create(f.store.taskContext(task.id), 'default', '文件', 'application/vnd.google-apps.document', {id: 'root', name: '我的雲端硬碟'});
    await f.reply('other-account', 'https://www.googleapis.com/auth/drive.file'); await pending;
    assert.match(creation.message(), /帳號/); assert.equal(f.calls.length, calls); assert.equal(f.store.revision(), revision); assert.equal(f.connection.auth.connected(), true);
    const rejected = creation.create(f.store.taskContext(task.id), 'default', '文件', 'application/vnd.google-apps.document', {id: 'root', name: '我的雲端硬碟'});
    await f.requests.at(-1).options.callback({error: 'access_denied'}); await rejected; assert.equal(f.calls.length, calls); assert.equal(creation.operations().length, 0);
  } finally {f.close();}
});

test('建立視窗可連線尚未連線的來源並準備獨立建立授權，設定缺漏有明確提示', async () => {
  const f = await fixture();
  try {
    const creation = f.injector.get(DocumentCreateService); f.flush(); await creation.prepare('default');
    const pending = creation.connectSource('default'); await f.reply('primary'); await pending; f.flush();
    assert.equal(f.connection.auth.connected(), true); assert.equal(creation.authorization('default').ready(), true); assert.equal(creation.authorization('default').connected(), false);
    await f.store.updateGoogle({clientId: ''}); f.flush(); await creation.connectSource('default'); assert.match(creation.message(), /設定.*Client ID/);
  } finally {f.close();}
});

test('直接使用所選來源的既有 Google 讀取授權查核資料夾，不需要 Picker 或新的授權', async () => {
  const f = await fixture();
  try {
    await f.grant(f.connection, 'primary'); const id = await f.connection.addSource('研究', otherClient); await f.grant(f.connection.source(id), 'research');
    const creation = f.injector.get(DocumentCreateService); f.flush(); const count = f.requests.length;
    f.setFiles(async (url, account, options) => {assert.equal(account, 'research'); assert.equal(options.method ?? 'GET', 'GET'); assert.equal(url.pathname, '/drive/v3/files/folder'); assert.match(url.searchParams.get('fields'), /capabilities\(canAddChildren\)/); assert.equal(new Headers(options.headers).get('X-Goog-Drive-Resource-Keys'), 'folder/key'); return Response.json({...raw('folder', true), name: '真正位置', driveId: 'shared-drive', capabilities: {canAddChildren: true}});});
    assert.deepEqual(await creation.validateFolder(id, {id: 'folder', name: '舊名稱', resourceKey: 'key'}), {id: 'folder', name: '真正位置', driveId: 'shared-drive', resourceKey: 'key'});
    assert.equal(f.requests.length, count); assert.equal(creation.authorization(id), undefined); assert.equal(creation.operations().length, 0); assert.equal(creation.lastFolder(id).id, 'root');
  } finally {f.close();}
});

test('讀取授權的資料夾選取拒絕無能力、垃圾桶、捷徑、備份及無法存取的結果', async () => {
  const f = await fixture();
  try {
    await f.grant(f.connection, 'primary'); const creation = f.injector.get(DocumentCreateService); f.flush(); const count = f.requests.length;
    for (const item of [{...raw('folder', true), capabilities: {canAddChildren: false}}, {...raw('folder', true), trashed: true, capabilities: {canAddChildren: true}}, {...raw('folder'), capabilities: {canAddChildren: true}}, {...raw('folder', true), name: 'IIH Orbit', capabilities: {canAddChildren: true}}, null]) {
      f.setFiles(async () => item ? Response.json(item) : Response.json({}, {status: 403})); await assert.rejects(creation.validateFolder('default', {id: 'folder', name: '資料夾'}));
    }
    assert.equal(f.requests.length, count); assert.equal(creation.operations().length, 0); assert.equal(creation.lastFolder('default').id, 'root');
  } finally {f.close();}
});

test('資料夾查核期間切換空間或取消讀取，晚到結果不返回表單', async () => {
  const f = await fixture();
  try {
    await f.grant(f.connection, 'primary'); await f.store.saveWorkspace('', '其他空間'); f.store.switchWorkspace('workspace'); const creation = f.injector.get(DocumentCreateService); f.flush();
    let release; f.setFiles(() => new Promise(resolve => release = resolve));
    const pending = creation.validateFolder('default', {id: 'folder', name: '資料夾'}); f.store.switchWorkspace(f.store.workspaces().find(workspace => workspace.id !== 'workspace').id); release(Response.json({...raw('folder', true), capabilities: {canAddChildren: true}})); await assert.rejects(pending, /變更/);
    const controller = new AbortController(), cancelled = creation.validateFolder('default', {id: 'folder', name: '資料夾'}, controller.signal); controller.abort(); release(Response.json({...raw('folder', true), capabilities: {canAddChildren: true}})); await assert.rejects(cancelled);
    assert.equal(creation.operations().length, 0);
  } finally {f.close();}
});

test('根位置維持 drive.file，選定既有資料夾後才升級寫入授權，拒絕時不建立第二份', async () => {
  const f = await fixture();
  try {
    await f.grant(f.connection, 'primary'); const task = {id: 'scope-task', title: '文件', description: '', projectId: '', categoryId: '', status: 'todo', priority: 'medium', startDate: '', dueDate: '', startTime: '', dueTime: '', subtasks: []}; await f.store.saveTask(task);
    let posts = 0; f.setFiles(async (url, _, options) => {if (options.method !== 'POST') return Response.json({...raw('folder', true), capabilities: {canAddChildren: true}}); posts++; const body = JSON.parse(options.body); return Response.json({id: 'created', name: body.name, mimeType: body.mimeType, appProperties: body.appProperties});});
    const creation = f.injector.get(DocumentCreateService); f.flush(); await creation.prepare('default', true); await creation.prepare('default');
    const root = creation.create(f.store.taskContext(task.id), 'default', '根位置文件', 'application/vnd.google-apps.document', {id: 'root', name: '我的雲端硬碟'});
    assert.equal(f.requests.at(-1).options.scope.split(' ').includes('https://www.googleapis.com/auth/drive.file'), true); await f.reply('primary', 'https://www.googleapis.com/auth/drive.file'); await root; assert.equal(posts, 1);
    const count = f.requests.length; await creation.validateFolder('default', {id: 'folder', name: '資料夾'}); await creation.prepare('default', true); assert.equal(f.requests.length, count);
    const folder = creation.create(f.store.taskContext(task.id), 'default', '指定位置文件', 'application/vnd.google-apps.document', {id: 'folder', name: '資料夾'});
    assert.equal(f.requests.at(-1).options.scope.split(' ').includes('https://www.googleapis.com/auth/drive'), true); await f.requests.at(-1).options.callback({error: 'access_denied'}); await folder;
    assert.equal(posts, 1); assert.equal(creation.lastFolder('default').id, 'root'); assert.equal(f.connection.auth.connected(), true); assert.equal(f.store.documentsForTask(task.id).length, 1);
  } finally {f.close();}
});

test('Colab 使用指定來源一次 multipart 上傳空白筆記本，僅接受固定模板及新增端點', async () => {
  const f = await fixture();
  try {
    await f.grant(f.connection, 'primary'); const id = await f.connection.addSource('研究', otherClient); await f.grant(f.connection.source(id), 'research');
    const task = {id: 'colab-task', title: '資料分析', description: '', projectId: '', categoryId: '', status: 'todo', priority: 'medium', startDate: '', dueDate: '', startTime: '', dueTime: '', subtasks: []}; await f.store.saveTask(task);
    let posts = 0, metadata;
    f.setFiles(async (url, account, options) => {
      assert.equal(account, 'research');
      if (options.method !== 'POST') return Response.json({...raw('research-folder', true), capabilities: {canAddChildren: true}});
      posts++; assert.equal(url.pathname, '/upload/drive/v3/files'); assert.equal(url.searchParams.get('uploadType'), 'multipart'); assert.equal(url.searchParams.get('supportsAllDrives'), 'true'); assert.equal(new Headers(options.headers).get('X-Goog-Drive-Resource-Keys'), 'research-folder/key');
      const contentType = new Headers(options.headers).get('Content-Type'), boundary = /^multipart\/related; boundary=(orbit-notebook-[a-f0-9-]+)$/.exec(contentType)?.[1]; assert.ok(boundary);
      const parts = options.body.split('--' + boundary); assert.equal(parts.length, 4); assert.equal(parts[3], '--\r\n');
      metadata = JSON.parse(parts[1].slice(parts[1].indexOf('\r\n\r\n') + 4)); const notebook = JSON.parse(parts[2].slice(parts[2].indexOf('\r\n\r\n') + 4));
      assert.match(parts[1], /Content-Type: application\/json; charset=UTF-8/); assert.match(parts[2], /Content-Type: application\/vnd.google.colaboratory/); assert.equal(notebook.nbformat, 4); assert.deepEqual(notebook.cells[0].source, []); assert.deepEqual(notebook.cells[0].outputs, []);
      assert.deepEqual(metadata.parents, ['research-folder']); assert.equal(metadata.name, '分析 "資料".ipynb'); assert.equal(Object.keys(metadata.appProperties).length, 1);
      return Response.json({id: 'colab-created', name: metadata.name, mimeType: metadata.mimeType, parents: metadata.parents, appProperties: metadata.appProperties});
    });
    const creation = f.injector.get(DocumentCreateService); f.flush(); await creation.prepare(id, true);
    const pending = creation.create(f.store.taskContext(task.id), id, '分析 "資料"', 'application/vnd.google.colaboratory', {id: 'research-folder', name: '研究資料夾', resourceKey: 'key'});
    assert.equal(f.requests.at(-1).options.client_id, otherClient); await f.reply('research', 'https://www.googleapis.com/auth/drive'); await pending;
    assert.equal(creation.result().phase, 'linked'); assert.equal(f.store.documentsForTask(task.id)[0].fileId, 'colab-created'); assert.equal(posts, 1); assert.equal(f.connection.auth.connected(), true);
    const auth = creation.authorization(id);
    const fields = f.calls.at(-1).url.searchParams.get('fields');
    assert.throws(() => auth.api('files', {fields}, {method: 'POST', body: JSON.stringify(metadata)}), /只能建立/);
    for (const invalid of [{...metadata, id: 'existing-file'}, {...metadata, contents: 'arbitrary code'}, {...metadata, mimeType: 'application/vnd.google-apps.document'}, {...metadata, parents: ['one', 'two']}, {...metadata, name: 'not-a-notebook.txt'}]) assert.throws(() => auth.createNotebook(invalid));
    assert.throws(() => auth.createNotebook(metadata, 'different-folder/key')); assert.throws(() => auth.api('upload/drive/v3/files', {}, {method: 'POST', body: 'arbitrary'})); assert.equal(posts, 1);
  } finally {f.close();}
});
