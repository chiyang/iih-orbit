import '@angular/compiler';
import { DOCUMENT } from '@angular/common';
import { createEnvironmentInjector, runInInjectionContext, signal, ɵEffectScheduler, ɵChangeDetectionScheduler } from '@angular/core';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { COLUMNS } from '../src/app/models.ts';
import { createDriveDocument, readDriveFile, versionProperties } from '../src/app/drive-data.ts';
import { CALENDAR_SCOPE } from '../src/app/google-data.ts';
import { GMAIL_SCOPE } from '../src/app/gmail-data.ts';
import { DRIVE_SCOPE, DRIVE_SESSION_KEY } from '../src/app/drive-data.ts';
import { GOOGLE_SESSION_KEY } from '../src/app/google-session.ts';

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('@angular/build/package.json'))('esbuild');
await mkdir('.angular', {recursive: true});
const directory = await mkdtemp(resolve('.angular/combined-test-')), output = resolve(directory, 'combined.mjs');
await build({stdin: {contents: "export {GoogleConnection} from './src/app/google-connection.ts'; export {GoogleConnections} from './src/app/google-connections.ts'; export {GoogleRenewalButton} from './src/app/google-renewal-button.ts'; export {GoogleCombinedAuth, COMBINED_GOOGLE_SCOPE} from './src/app/google-combined-auth.ts'; export {GoogleAuth} from './src/app/google-auth.ts'; export {GmailAuth} from './src/app/gmail-auth.ts'; export {DriveAuth} from './src/app/drive-auth.ts'; export {CalendarWriteAuth} from './src/app/calendar-write-auth.ts'; export {CalendarCache} from './src/app/calendar-cache.ts'; export {GoogleCalendarService} from './src/app/google-calendar.ts'; export {GmailService} from './src/app/gmail-service.ts'; export {DriveService} from './src/app/drive-service.ts'; export {BoardStore} from './src/app/board-store.ts';", resolveDir: process.cwd()}, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: output, tsconfig: 'tsconfig.json'});
const {GoogleConnection, GoogleConnections, GoogleRenewalButton, GoogleCombinedAuth, COMBINED_GOOGLE_SCOPE, GoogleAuth, GmailAuth, DriveAuth, CalendarWriteAuth, CalendarCache, GoogleCalendarService, GmailService, DriveService, BoardStore} = await import(pathToFileURL(output).href);
after(() => rm(directory, {recursive: true, force: true}));

// Exercise real consent, credential storage and connect methods with synthetic API responses.
// Service constructors and their background network jobs are not started; no browser is used.
async function fixture() {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), previousFetch = globalThis.fetch;
  const values = new Map(), tabs = new Map(), requests = [], effects = new Set();
  const memory = map => ({get length() {return map.size;}, key: index => [...map.keys()][index] ?? null, getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key)});
  const storage = memory(values), sessionStorage = memory(tabs);
  values.set('orbit-workspaces-v1', JSON.stringify({version: 1, activeWorkspaceId: 'workspace', workspaces: [{version: 4, id: 'workspace', name: '工作', projects: [], categories: [], statuses: COLUMNS, tasks: []}]}));
  Object.defineProperty(globalThis, 'localStorage', {value: storage, configurable: true, writable: true});
  const store = new BoardStore(); await store.updateGoogle({clientId: '123-example.apps.googleusercontent.com'});
  const account = {id: 'account', email: 'account@example.test'};
  globalThis.fetch = async () => Response.json({sub: account.id, email: account.email});
  const oauth = {
    initTokenClient(options) {return {requestAccessToken(prompt) {requests.push({options, prompt});}};},
    hasGrantedAllScopes(response, ...scopes) {return scopes.every(scope => response.scope?.split(' ').includes(scope));}
  };
  const scheduler = {add(effect) {effects.add(effect);}, schedule() {}, remove(effect) {effects.delete(effect);}};
  const injector = createEnvironmentInjector([
    {provide: DOCUMENT, useValue: {defaultView: {google: {accounts: {oauth2: oauth}}, localStorage: storage, sessionStorage}, addEventListener() {}, removeEventListener() {}}},
    {provide: BoardStore, useValue: store}, {provide: ɵEffectScheduler, useValue: scheduler}, {provide: ɵChangeDetectionScheduler, useValue: {notify() {}}}
  ]);
  const make = Type => runInInjectionContext(injector, () => new Type());
  const auth = make(GoogleAuth), gmailAuth = make(GmailAuth), driveAuth = make(DriveAuth), writeAuth = make(CalendarWriteAuth), combined = make(GoogleCombinedAuth);
  let calendarLists = 0, driveLists = 0;
  const calendar = {auth, store, error: signal(''), available: signal([]), message: error => error.message, listCalendars: async () => {calendarLists++;}, refresh: async () => {}};
  calendar.connect = GoogleCalendarService.prototype.connect.bind(calendar);
  const gmail = {auth: gmailAuth, store, preferences: signal({generation: store.generation(), clientId: store.google().clientId, accountId: '', email: '', selected: ['INBOX']}), error: signal(''), clientId: () => store.google().clientId, selected: () => gmail.preferences().selected, clearCache() {}, savePreferences() {values.set('gmail-preferences', JSON.stringify(this.preferences()));}};
  gmail.connect = GmailService.prototype.connect.bind(gmail); gmail.disconnect = GmailService.prototype.disconnect.bind(gmail);
  const cache = {clear: async () => {}};
  const drive = {auth: driveAuth, store, error: signal(''), busy: signal(false), syncing: signal(false), online: signal(true), runtime: signal({}), files: signal([]), removals: signal([]), catalogFresh: signal(true), clearLocalData: async () => {drive.runtime.set({});}, coordinator: {activate() {}}, loadRuntime: async () => {}, list: async () => {driveLists++;}, schedule() {}, describe: error => error.message};
  drive.connect = DriveService.prototype.connect.bind(drive);
  const child = createEnvironmentInjector([GoogleConnections, {provide: GoogleCalendarService, useValue: calendar}, {provide: CalendarCache, useValue: cache}, {provide: GmailService, useValue: gmail}, {provide: DriveService, useValue: drive}, {provide: CalendarWriteAuth, useValue: writeAuth}, {provide: GoogleCombinedAuth, useValue: combined}], injector);
  const connection = runInInjectionContext(child, () => new GoogleConnection());
  const flush = () => {for (let round = 0; round < 30 && [...effects].some(effect => effect.dirty); round++) for (const effect of effects) if (effect.dirty) effect.run();};
  flush(); await Promise.all([auth, gmailAuth, driveAuth, combined].map(auth => auth.prepare()));
  const reply = async (scopes = COMBINED_GOOGLE_SCOPE) => requests.at(-1).options.callback({access_token: 'synthetic-only-token', expires_in: 3600, scope: scopes});
  return {connection, button: runInInjectionContext(child, () => new GoogleRenewalButton()), connections: child.get(GoogleConnections), store, calendar, cache, gmail, drive, auth, gmailAuth, driveAuth, writeAuth, combined, requests, values, tabs, reply, flush, counts: () => [calendarLists, driveLists], close() {connection.ngOnDestroy(); child.destroy(); for (const item of [auth, gmailAuth, driveAuth, writeAuth, combined]) item.ngOnDestroy(); injector.destroy(); store.ngOnDestroy(); globalThis.fetch = previousFetch; if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage); else delete globalThis.localStorage;}};
}

test('同步並登出成功才清除資料與所有憑證，保留兩個識別並提供 G 登入', async () => {
  const f = await fixture();
  try {
    const connecting = f.connections.connectAll(); await f.reply(); await connecting;
    await f.store.saveTask({id: 'logout-task', title: '必須先備份', description: '', categoryId: '', projectId: '', status: 'todo', priority: 'medium', startDate: '', startTime: '', dueDate: '', dueTime: '', subtasks: []});
    const generation = f.store.generation(), clientId = f.store.google().clientId, datasetId = crypto.randomUUID();
    f.values.set('orbit-private-preview', '模擬個人資料'); f.tabs.set('iih-orbit-private-session', 'synthetic-credential'); f.values.set('another-app-data', '保留');
    let verified = false, clears = 0;
    f.drive.checkpointForLogout = async () => {assert.equal(f.store.tasks().length, 1); verified = true; return {datasetId, revision: f.store.revision()};};
    f.cache.clear = async () => {assert.equal(verified, true); assert.ok(f.store.cloudResume()); clears++;};
    await f.connections.logout();
    assert.equal(clears, 1); assert.equal(f.connections.error(), ''); assert.equal(f.connections.cleanupError(), '');
    assert.equal(f.store.tasks().length, 0); assert.notEqual(f.store.generation(), generation); assert.equal(f.store.google().clientId, clientId); assert.deepEqual(f.store.cloudResume(), {datasetId});
    assert.equal(f.values.has('orbit-private-preview'), false); assert.equal(f.values.has('orbit-workspaces-v1'), false); assert.equal(f.values.get('another-app-data'), '保留');
    assert.equal(f.tabs.has('iih-orbit-private-session'), false);
    for (const auth of [f.auth, f.gmailAuth, f.driveAuth, f.writeAuth]) assert.equal(auth.connected(), false);
    for (const key of [GOOGLE_SESSION_KEY, 'iih-orbit-gmail-session-v1', DRIVE_SESSION_KEY, 'iih-orbit-calendar-write-session-v1']) assert.equal(f.values.has(key), false);
    assert.equal(f.connections.authorizationNeeded(), true); assert.equal(f.connections.renewalVisible(), true);
  } finally {f.close();}
});

test('備份失敗或完成後有新修改，不登出、不清除任務及憑證；清理失敗可以重試', async () => {
  const f = await fixture();
  try {
    const connecting = f.connections.connectAll(); await f.reply(); await connecting;
    const snapshot = f.values.get('orbit-workspaces-v2'), generation = f.store.generation(), datasetId = crypto.randomUUID();
    f.drive.checkpointForLogout = async () => {f.drive.error.set('備份網路失敗'); return null;};
    await f.connections.logout(); assert.equal(f.values.get('orbit-workspaces-v2'), snapshot); assert.equal(f.auth.connected(), true); assert.equal(f.store.cloudResume(), undefined);
    f.drive.checkpointForLogout = async () => {const revision = f.store.revision(); await f.store.updateAppearance({accent: '#123456'}); return {datasetId, revision};};
    await f.connections.logout(); assert.equal(f.store.generation(), generation); assert.match(f.connections.error(), /又有變更/); assert.equal(f.driveAuth.connected(), true);
    f.drive.checkpointForLogout = async () => ({datasetId, revision: f.store.revision()});
    f.cache.clear = async () => {throw new Error('blocked');}; await f.connections.logout();
    assert.ok(f.store.cloudResume()); assert.match(f.connections.cleanupError(), /清理/); assert.equal(f.connections.canConnect(), false); assert.equal(f.auth.connected(), false);
    f.cache.clear = async () => {}; await f.connections.cleanupLogout(); assert.equal(f.connections.cleanupError(), ''); assert.equal(f.connections.canConnect(), true);
  } finally {f.close();}
});

function cloudFile(document, id) {return readDriveFile({id: 'drive_' + id, name: 'Orbit.json', mimeType: 'application/json', size: '100', createdTime: document.exportedAt, appProperties: versionProperties(document)});}
async function prepareResume(f) {
  const backup = await f.store.backupForExport('full'), datasetId = crypto.randomUUID();
  const document = await createDriveDocument(backup, datasetId, [], 'sync');
  await f.store.logoutToCloud(f.store.google().clientId, datasetId, f.store.revision(), f.store.generation());
  await f.connections.cleanupLogout(); f.flush();
  let joins = 0;
  f.drive.join = async (file, revision, heads) => {
    joins++; assert.equal(file.cloud.datasetId, datasetId); assert.ok(heads.includes(file.cloud.versionId));
    const selected = file.document ?? document;
    const result = await f.store.applyDriveBackup(selected, revision, selected.data.workspaces.map(workspace => workspace.id));
    assert.equal(result.ok, true); await f.store.updateDrive({mode: 'sync', kind: 'full'});
    f.drive.runtime.set({link: {datasetId, kind: 'full'}}); return true;
  };
  return {document, datasetId, joins: () => joins};
}

test('保留集合識別後，G 授權直接接回原集合，多個其他集合也不需重新挑選', async () => {
  const f = await fixture();
  try {
    await f.store.saveTask({id: 'saved-task', title: '回到原本的任務', description: '', categoryId: '', projectId: '', status: 'todo', priority: 'medium', startDate: '', startTime: '', dueDate: '', dueTime: '', subtasks: []});
    const saved = await prepareResume(f), other = await createDriveDocument(saved.document, crypto.randomUUID(), [], 'sync');
    f.drive.files.set([cloudFile(other, 'other'), cloudFile(saved.document, 'original')]);
    const login = f.button.renew(); assert.equal(f.requests.length, 1); await f.reply(); await login;
    assert.equal(saved.joins(), 1); assert.equal(f.store.cloudResume(), undefined); assert.equal(f.store.tasks()[0].title, '回到原本的任務'); assert.equal(f.store.drive().mode, 'sync');
    assert.equal(f.connections.renewalVisible(), false); assert.match(f.connections.message(), /已登入並同步/);
  } finally {f.close();}
});

test('登入遇到多份內容先列出選擇；雲端又更新則拒絕舊選擇', async () => {
  const f = await fixture();
  try {
    const saved = await prepareResume(f), first = await createDriveDocument(saved.document, saved.datasetId, [saved.document.cloud.versionId], 'sync');
    const changed = structuredClone(saved.document); changed.data.workspaces[0].name = '另一份雲端內容';
    const second = await createDriveDocument(changed, saved.datasetId, [saved.document.cloud.versionId], 'sync');
    const file1 = {...cloudFile(first, 'first'), document: first}, file2 = {...cloudFile(second, 'second'), document: second};
    f.drive.files.set([cloudFile(saved.document, 'root'), file1, file2]);
    const login = f.button.renew(); await f.reply(); await login;
    assert.equal(saved.joins(), 0); assert.equal(f.connections.resumeChoices().length, 2); assert.ok(f.store.cloudResume());
    const newer = await createDriveDocument(second, saved.datasetId, [second.cloud.versionId], 'sync'), newerFile = {...cloudFile(newer, 'newer'), document: newer};
    f.drive.files.update(files => [...files, newerFile]); await f.connections.resumeCloud(file2);
    assert.equal(saved.joins(), 0); assert.match(f.connections.error(), /重新選擇/); assert.equal(f.connections.resumeChoices().some(file => file.id === 'drive_newer'), true);
    await f.connections.resumeCloud(newerFile); assert.equal(saved.joins(), 1); assert.equal(f.store.cloudResume(), undefined); assert.equal(f.store.currentWorkspace().name, '另一份雲端內容');
  } finally {f.close();}
});

test('錯誤帳號找不到原集合保持登出；取消再次授權不自行接續舊帳號', async () => {
  const f = await fixture();
  try {
    const saved = await prepareResume(f);
    f.drive.files.set([cloudFile(await createDriveDocument(saved.document, crypto.randomUUID(), [], 'sync'), 'wrong-account')]);
    const login = f.button.renew(); await f.reply(); await login;
    assert.equal(saved.joins(), 0); assert.ok(f.store.cloudResume()); assert.match(f.connections.error(), /原本的帳號/); assert.equal(f.store.drive().mode, 'off');
    f.drive.files.set([cloudFile(saved.document, 'original')]); const lists = f.counts()[1];
    const cancelled = f.button.renew(); f.requests.at(-1).options.error_callback({type: 'popup_closed'}); await cancelled;
    assert.equal(f.counts()[1], lists); assert.equal(saved.joins(), 0); assert.ok(f.store.cloudResume()); assert.match(f.connections.error(), /已關閉/);
  } finally {f.close();}
});

test('登入下載期間 Drive 授權被解除時停止，不清除登出目的地並提示再次登入', async () => {
  const f = await fixture();
  try {
    const saved = await prepareResume(f); f.drive.files.set([cloudFile(saved.document, 'original')]);
    const list = f.drive.list; let lists = 0;
    f.drive.list = async () => {await list(); if (++lists === 2) f.driveAuth.disconnect();};
    const login = f.button.renew(); await f.reply(); await login;
    assert.equal(saved.joins(), 0); assert.ok(f.store.cloudResume()); assert.match(f.connections.error(), /再按 G 登入/); assert.equal(f.connections.resuming(), false);
  } finally {f.close();}
});

test('登出後可在正常介面新增任務，G 登入不默默覆蓋這些新資料', async () => {
  const f = await fixture();
  try {
    const saved = await prepareResume(f); f.drive.files.set([cloudFile(saved.document, 'original')]);
    await f.store.saveTask({id: 'new-local-task', title: '登出後新增的本機任務', description: '', categoryId: '', projectId: '', status: 'todo', priority: 'medium', startDate: '', startTime: '', dueDate: '', dueTime: '', subtasks: []});
    const login = f.button.renew(); await f.reply(); await login;
    assert.equal(saved.joins(), 0); assert.ok(f.store.cloudResume()); assert.equal(f.store.tasks()[0].title, '登出後新增的本機任務'); assert.match(f.connections.error(), /本機已有/);
  } finally {f.close();}
});

test('登出清理完成後重新開啟不再次清理新資料與偏好', async () => {
  const f = await fixture(); let reopened;
  try {
    await prepareResume(f); let clears = 0; f.cache.clear = async () => {clears++;};
    f.values.set('iih-orbit-calendar-display-v1', '新的本機偏好');
    await f.store.saveTask({id: 'new-local-task', title: '登出後繼續使用', description: '', categoryId: '', projectId: '', status: 'todo', priority: 'medium', startDate: '', startTime: '', dueDate: '', dueTime: '', subtasks: []});
    reopened = runInInjectionContext(f.connections.injector, () => new GoogleConnections()); f.flush(); await Promise.resolve();
    assert.equal(clears, 0); assert.equal(f.values.get('iih-orbit-calendar-display-v1'), '新的本機偏好'); assert.equal(f.store.tasks()[0].title, '登出後繼續使用');
  } finally {reopened?.ngOnDestroy(); f.close();}
});

test('全部授權僅開一個視窗，讀取與寫入各自接續；取消單一服務不停止其他服務', async () => {
  const f = await fixture();
  try {
    const connecting = f.connection.connectAll();
    assert.equal(f.requests.length, 1); assert.equal(f.connection.busy(), true);
    await f.connection.connectAll(); assert.equal(f.requests.length, 1);
    const requested = f.requests[0].options.scope.split(' ');
    for (const scope of [CALENDAR_SCOPE, GMAIL_SCOPE, DRIVE_SCOPE, 'https://www.googleapis.com/auth/calendar.events']) assert.ok(requested.includes(scope));
    assert.equal(f.requests[0].options.include_granted_scopes, false);
    await f.reply(); await connecting;
    for (const auth of [f.auth, f.gmailAuth, f.driveAuth, f.writeAuth]) {assert.equal(auth.connected(), true); assert.equal(auth.account().id, 'account');}
    assert.deepEqual(f.counts(), [1, 1]); assert.equal(f.store.drive().mode, 'off');
    assert.equal(f.combined.connected(), false); assert.equal(f.connection.connectingAll(), false); assert.equal(f.connection.error(), '');
    assert.equal(f.tabs.has('iih-orbit-combined-session'), false); assert.equal(f.values.has('iih-orbit-combined-session'), false);
    assert.equal(JSON.parse(f.values.get(GOOGLE_SESSION_KEY)).scope, CALENDAR_SCOPE);
    assert.equal(JSON.parse(f.values.get('iih-orbit-gmail-session-v1')).scope, GMAIL_SCOPE);
    assert.equal(JSON.parse(f.values.get(DRIVE_SESSION_KEY)).scope, DRIVE_SCOPE);
    assert.ok(f.values.get('iih-orbit-calendar-write-session-v1'));
    for (const key of [GOOGLE_SESSION_KEY, 'iih-orbit-gmail-session-v1', DRIVE_SESSION_KEY, 'iih-orbit-calendar-write-session-v1']) assert.equal(f.tabs.has(key), false);
    f.gmail.disconnect(); assert.equal(f.gmailAuth.connected(), false);
    assert.equal(f.auth.connected(), true); assert.equal(f.driveAuth.connected(), true); assert.equal(f.writeAuth.connected(), true);
    const individual = f.calendar.connect(); assert.equal(f.requests.length, 2);
    assert.ok(f.requests.at(-1).options.scope.includes(CALENDAR_SCOPE)); assert.equal(f.requests.at(-1).options.scope.includes(GMAIL_SCOPE), false);
    await f.reply(CALENDAR_SCOPE); await individual;
    f.connection.disconnectCalendar(); assert.equal(f.auth.connected(), false); assert.equal(f.writeAuth.connected(), false); assert.equal(f.driveAuth.connected(), true);
  } finally {f.close();}
});

test('部分授權只連線同意的服務，Calendar 未授權寫入仍可讀取；不新增雲端備份', async () => {
  const f = await fixture();
  try {
    const connecting = f.connection.connectAll(); await f.reply(`${CALENDAR_SCOPE} ${GMAIL_SCOPE}`); await connecting;
    assert.equal(f.auth.connected(), true); assert.equal(f.gmailAuth.connected(), true); assert.equal(f.driveAuth.connected(), false); assert.equal(f.writeAuth.connected(), false);
    assert.equal(f.store.drive().accountId, ''); assert.equal(f.store.drive().mode, 'off'); assert.deepEqual(f.counts(), [1, 0]);
    assert.match(f.connection.error(), /Drive/); assert.match(f.connection.error(), /Calendar 寫入/); assert.match(f.connection.message(), /Calendar、Gmail/);
  } finally {f.close();}
});

test('取消全部授權保留原有帳號與服務連線；Drive 待上傳時不啟動新授權', async () => {
  const f = await fixture();
  try {
    const first = f.connection.connectAll(); await f.reply(); await first;
    const saved = f.values.get('orbit-workspaces-v2'), preferences = f.values.get('gmail-preferences');
    const cancelled = f.connection.connectAll(); f.requests.at(-1).options.error_callback({type: 'popup_closed'}); await cancelled;
    assert.match(f.connection.error(), /已關閉/); assert.equal(f.values.get('orbit-workspaces-v2'), saved); assert.equal(f.values.get('gmail-preferences'), preferences);
    for (const auth of [f.auth, f.gmailAuth, f.driveAuth, f.writeAuth]) assert.equal(auth.connected(), true);
    f.drive.runtime.set({pending: {version: 'queued'}}); await f.connection.connectAll(); assert.equal(f.requests.length, 2); assert.match(f.connection.error(), /等待上傳/);
  } finally {f.close();}
});

test('授權途中設定或個別服務被撤銷時，不套用遲到授權，也不改變帳號設定', async () => {
  for (const change of ['client', 'revoke']) {
    const f = await fixture();
    try {
      const connecting = f.connection.connectAll();
      if (change === 'client') await f.store.updateGoogle({clientId: '456-new.apps.googleusercontent.com'});
      else f.writeAuth.disconnect();
      const saved = f.values.get('orbit-workspaces-v2');
      await f.reply(); await connecting;
      assert.match(f.connection.error(), /已變更/); assert.equal(f.values.get('orbit-workspaces-v2'), saved);
      assert.equal(f.store.google().accountId, ''); assert.equal(f.gmail.preferences().accountId, ''); assert.equal(f.store.drive().accountId, '');
      for (const auth of [f.auth, f.gmailAuth, f.driveAuth, f.writeAuth, f.combined]) assert.equal(auth.connected(), false);
      assert.deepEqual(f.counts(), [0, 0]);
    } finally {f.close();}
  }
});

test('設定關閉後的帳號驗證回覆不接續任何服務；拒絕全部權限可重新分別連線', async () => {
  const f = await fixture();
  try {
    const denied = f.connection.connectAll(); await f.reply('openid'); await denied;
    assert.match(f.connection.error(), /尚未取得任何/); assert.deepEqual(f.counts(), [0, 0]);
    let resolveIdentity;
    globalThis.fetch = () => new Promise(resolve => {resolveIdentity = resolve;});
    const connecting = f.connection.connectAll(), callback = f.reply();
    f.connection.ngOnDestroy(); await connecting;
    resolveIdentity(Response.json({sub: 'account', email: 'account@example.test'})); await callback;
    assert.equal(f.store.google().accountId, ''); assert.equal(f.gmail.preferences().accountId, ''); assert.equal(f.store.drive().accountId, '');
    for (const auth of [f.auth, f.gmailAuth, f.driveAuth, f.writeAuth, f.combined]) assert.equal(auth.connected(), false);
    assert.equal(f.connection.connectingAll(), false);
  } finally {f.close();}
});

test('全部服務連線才顯示已連線；只有保存 Client ID 或部分權限不提示過期', async () => {
  const f = await fixture();
  try {
    assert.equal(f.connections.allConnected(), false); assert.equal(f.connections.renewalNeeded(), false);
    const partial = f.connection.connectAll(); await f.reply(`${CALENDAR_SCOPE} ${GMAIL_SCOPE}`); await partial;
    assert.equal(f.connections.allConnected(), false); assert.equal(f.connections.renewalNeeded(), false);
    const complete = f.connection.connectAll(); await f.reply(); await complete;
    assert.equal(f.connections.allConnected(), true); assert.equal(f.connections.renewalNeeded(), false);
    f.connection.disconnectCalendar();
    assert.equal(f.connections.allConnected(), false); assert.equal(f.connections.renewalNeeded(), false);
  } finally {f.close();}
});

test('過期後可直接從共用入口開啟一次授權，無需設定元件；取消保留提醒，成功後隱藏', async () => {
  const f = await fixture();
  try {
    const first = f.connection.connectAll(); await f.reply(); await first;
    f.connection.ngOnDestroy();
    globalThis.fetch = async () => new Response(null, {status: 401});
    await assert.rejects(f.driveAuth.api('files'), /到期/);
    assert.equal(f.connections.renewalNeeded(), true); assert.equal(f.connections.allConnected(), false);
    assert.equal(f.connections.canConnect(), true);
    const cancelled = f.connections.connectAll();
    assert.equal(f.requests.length, 2); assert.equal(f.connections.canConnect(), false);
    f.requests.at(-1).options.error_callback({type: 'popup_closed'}); await cancelled;
    assert.equal(f.connections.renewalNeeded(), true); assert.equal(f.auth.connected(), true);
    globalThis.fetch = async () => Response.json({sub: 'account', email: 'account@example.test'});
    const renewed = f.connections.connectAll(); assert.equal(f.requests.length, 3);
    await f.reply(); await renewed;
    assert.equal(f.connections.allConnected(), true); assert.equal(f.connections.renewalNeeded(), false);
    assert.equal(f.driveAuth.expired(), false);
    const history = f.values.get(DRIVE_SESSION_KEY + ':authorization-history');
    assert.equal(history.includes('synthetic-only-token'), false);
    assert.deepEqual(Object.keys(JSON.parse(history)).sort(), ['accountId', 'clientId', 'expiresAt', 'generation', 'nonce', 'version']);
  } finally {f.close();}
});

test('頁首 G 入口直接啟動全部授權，避免重複點擊並回報結果；從未授權時不啟動', async () => {
  const f = await fixture();
  try {
    await f.button.renew(); assert.equal(f.requests.length, 0);
    const first = f.connection.connectAll(); await f.reply(); await first;
    f.driveAuth.disconnect('Google 授權已到期，請重新連線。', 'expired');
    let message = ''; f.button.result.subscribe(value => {message = value;});
    const renewing = f.button.renew(); assert.equal(f.requests.length, 2);
    await f.button.renew(); assert.equal(f.requests.length, 2);
    await f.reply(); await renewing;
    assert.match(message, /已連線：Calendar、Gmail、Drive/);
    assert.equal(f.connections.renewalNeeded(), false); assert.equal(f.connections.allConnected(), true);
  } finally {f.close();}
});
