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
import { CALENDAR_SCOPE } from '../src/app/google-data.ts';
import { GMAIL_SCOPE } from '../src/app/gmail-data.ts';
import { DRIVE_SCOPE, DRIVE_SESSION_KEY } from '../src/app/drive-data.ts';
import { GOOGLE_SESSION_KEY } from '../src/app/google-session.ts';

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('@angular/build/package.json'))('esbuild');
await mkdir('.angular', {recursive: true});
const directory = await mkdtemp(resolve('.angular/combined-test-')), output = resolve(directory, 'combined.mjs');
await build({stdin: {contents: "export {GoogleConnection} from './src/app/google-connection.ts'; export {GoogleCombinedAuth, COMBINED_GOOGLE_SCOPE} from './src/app/google-combined-auth.ts'; export {GoogleAuth} from './src/app/google-auth.ts'; export {GmailAuth} from './src/app/gmail-auth.ts'; export {DriveAuth} from './src/app/drive-auth.ts'; export {CalendarWriteAuth} from './src/app/calendar-write-auth.ts'; export {GoogleCalendarService} from './src/app/google-calendar.ts'; export {GmailService} from './src/app/gmail-service.ts'; export {DriveService} from './src/app/drive-service.ts'; export {BoardStore} from './src/app/board-store.ts';", resolveDir: process.cwd()}, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: output, tsconfig: 'tsconfig.json'});
const {GoogleConnection, GoogleCombinedAuth, COMBINED_GOOGLE_SCOPE, GoogleAuth, GmailAuth, DriveAuth, CalendarWriteAuth, GoogleCalendarService, GmailService, DriveService, BoardStore} = await import(pathToFileURL(output).href);
after(() => rm(directory, {recursive: true, force: true}));

// Exercise real consent, credential storage and connect methods with synthetic API responses.
// Service constructors and their background network jobs are not started; no browser is used.
async function fixture() {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), previousFetch = globalThis.fetch;
  const values = new Map(), tabs = new Map(), requests = [], effects = new Set();
  const memory = map => ({getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key)});
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
  const drive = {auth: driveAuth, store, error: signal(''), busy: signal(false), online: signal(true), runtime: signal({}), coordinator: {activate() {}}, loadRuntime: async () => {}, list: async () => {driveLists++;}, schedule() {}, describe: error => error.message};
  drive.connect = DriveService.prototype.connect.bind(drive);
  const child = createEnvironmentInjector([{provide: GoogleCalendarService, useValue: calendar}, {provide: GmailService, useValue: gmail}, {provide: DriveService, useValue: drive}, {provide: CalendarWriteAuth, useValue: writeAuth}, {provide: GoogleCombinedAuth, useValue: combined}], injector);
  const connection = runInInjectionContext(child, () => new GoogleConnection());
  const flush = () => {for (let round = 0; round < 30 && [...effects].some(effect => effect.dirty); round++) for (const effect of effects) if (effect.dirty) effect.run();};
  flush(); await Promise.all([auth, gmailAuth, driveAuth, combined].map(auth => auth.prepare()));
  const reply = async (scopes = COMBINED_GOOGLE_SCOPE) => requests.at(-1).options.callback({access_token: 'synthetic-only-token', expires_in: 3600, scope: scopes});
  return {connection, store, calendar, gmail, drive, auth, gmailAuth, driveAuth, writeAuth, combined, requests, values, tabs, reply, flush, counts: () => [calendarLists, driveLists], close() {connection.ngOnDestroy(); child.destroy(); for (const item of [auth, gmailAuth, driveAuth, writeAuth, combined]) item.ngOnDestroy(); injector.destroy(); store.ngOnDestroy(); globalThis.fetch = previousFetch; if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage); else delete globalThis.localStorage;}};
}

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
    assert.equal(JSON.parse(f.tabs.get(GOOGLE_SESSION_KEY)).scope, CALENDAR_SCOPE);
    assert.equal(JSON.parse(f.values.get('iih-orbit-gmail-session-v1')).scope, GMAIL_SCOPE);
    assert.equal(JSON.parse(f.tabs.get(DRIVE_SESSION_KEY)).scope, DRIVE_SCOPE);
    assert.ok(f.tabs.get('iih-orbit-calendar-write-session-v1'));
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
