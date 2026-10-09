import '@angular/compiler';
import { createEnvironmentInjector, runInInjectionContext, signal, ɵChangeDetectionScheduler, ɵEffectScheduler } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { CALENDAR_SCOPE } from '../src/app/google-data.ts';
import { GOOGLE_SESSION_KEY } from '../src/app/google-session.ts';
import { CALENDAR_SYNC_PREFIX } from '../src/app/calendar-sync.ts';

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('@angular/build/package.json'))('esbuild');
await mkdir('.angular', {recursive: true});
const directory = await mkdtemp(resolve('.angular/google-test-'));
const output = resolve(directory, 'google.mjs');
await build({stdin: {contents: "export {GoogleAuth} from './src/app/google-auth.ts'; export {GoogleCalendarService} from './src/app/google-calendar.ts'; export {CalendarSources} from './src/app/calendar-sources.ts'; export {CalendarCache} from './src/app/calendar-cache.ts'; export {BoardStore} from './src/app/board-store.ts';", resolveDir: process.cwd()}, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: output, tsconfig: 'tsconfig.json'});
const { GoogleAuth, GoogleCalendarService, CalendarSources, CalendarCache, BoardStore } = await import(pathToFileURL(output).href);
after(() => rm(directory, {recursive: true, force: true}));

function storage() {
  const values = new Map();
  globalThis.localStorage = {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key)};
  globalThis.sessionStorage = {getItem: () => null, setItem: () => {}, removeItem: () => {}};
  return values;
}

function tabStorage() {
  const values = new Map();
  return {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key)};
}
const sessionContext = {clientId: '123-example.apps.googleusercontent.com', generation: 'generation', accountId: 'account'};

test('Token Model 只申請讀取及帳號識別，憑證只存 sessionStorage，過期後清除', async () => {
  const values = storage();
  const sessions = tabStorage();
  let options, requested, callback;
  const oauth = {
    initTokenClient: config => { options = config; return {requestAccessToken: () => { callback = config.callback; }}; },
    hasGrantedAllScopes: () => true
  };
  const injector = createEnvironmentInjector([{provide: DOCUMENT, useValue: {defaultView: {google: {accounts: {oauth2: oauth}}, sessionStorage: sessions, localStorage: globalThis.localStorage}}}]);
  const auth = runInInjectionContext(injector, () => new GoogleAuth());
  auth.useSession(sessionContext);
  const originalFetch = globalThis.fetch, originalNow = Date.now;
  globalThis.fetch = async (url, config) => { requested = {url, config}; return {ok: true, json: async () => ({sub: 'account', email: 'a@example.com'})}; };
  try {
    await auth.prepare();
    const connected = auth.authorize('123-example.apps.googleusercontent.com');
    await callback({access_token: 'memory-only-token', expires_in: 3600});
    assert.deepEqual(await connected, {id: 'account', email: 'a@example.com'});
    assert.ok(options.scope.includes(CALENDAR_SCOPE));
    assert.equal(options.scope.includes('drive'), false);
    assert.equal(options.include_granted_scopes, false);
    assert.equal(requested.config.method, 'GET');
    assert.equal(requested.config.headers.Authorization, 'Bearer memory-only-token');
    assert.equal([...values.values()].join('').includes('token'), false);
    assert.equal(JSON.parse(sessions.getItem(GOOGLE_SESSION_KEY)).token, 'memory-only-token');
    Date.now = () => originalNow() + 3600000;
    await assert.rejects(auth.request('users/me/calendarList', {}), /到期/);
    assert.equal(auth.connected(), false);
    assert.equal(auth.token, '');
    assert.equal(sessions.getItem(GOOGLE_SESSION_KEY), null);
  } finally { Date.now = originalNow; globalThis.fetch = originalFetch; auth.ngOnDestroy(); injector.destroy(); }
});

function authController(sessions = tabStorage(), control = tabStorage()) {
  let options, closed = false;
  const oauth = {initTokenClient: config => { options = config; return {requestAccessToken: () => {}}; }, hasGrantedAllScopes: () => true};
  const injector = createEnvironmentInjector([{provide: DOCUMENT, useValue: {defaultView: {google: {accounts: {oauth2: oauth}}, sessionStorage: sessions, localStorage: control}}}]);
  const auth = runInInjectionContext(injector, () => new GoogleAuth());
  auth.useSession(sessionContext);
  return {auth, sessions, control, callback: () => options.callback, close: () => { if (!closed) { closed = true; auth.ngOnDestroy(); injector.destroy(); } }};
}
async function authorizeController(fixture, token = 'session-token') {
  await fixture.auth.prepare();
  const connection = fixture.auth.authorize(sessionContext.clientId);
  await fixture.callback()({access_token: token, expires_in: 3600});
  await connection;
}

test('授權服務重新建立後恢復同一憑證及到期時間，不再要求授權或讀取帳號', async () => {
  const first = authController();
  const originalFetch = globalThis.fetch;
  let requests = 0, second;
  globalThis.fetch = async () => { requests++; return {ok: true, json: async () => ({sub: 'account', email: 'a@example.com'})}; };
  try {
    await authorizeController(first);
    const session = JSON.parse(first.sessions.getItem(GOOGLE_SESSION_KEY));
    first.close();
    second = authController(first.sessions, first.control);
    assert.equal(second.auth.connected(), true);
    assert.equal(second.auth.token, session.token);
    assert.equal(second.auth.expiresAt, session.expiresAt);
    assert.match(second.auth.message(), /恢復/);
    assert.equal(requests, 1);
    await second.auth.request('users/me/calendarList', {});
    assert.equal(requests, 2);
    assert.equal(JSON.parse(first.sessions.getItem(GOOGLE_SESSION_KEY)).expiresAt, session.expiresAt);
  } finally { second?.close(); first.close(); globalThis.fetch = originalFetch; }
});

test('Google 回覆 401 時清除分頁憑證並使未收到通知的舊副本失效', async () => {
  const fixture = authController();
  const originalFetch = globalThis.fetch;
  let restored;
  globalThis.fetch = async () => ({ok: true, json: async () => ({sub: 'account', email: 'a@example.com'})});
  try {
    await authorizeController(fixture);
    const oldSession = fixture.sessions.getItem(GOOGLE_SESSION_KEY);
    globalThis.fetch = async () => ({ok: false, status: 401});
    await assert.rejects(fixture.auth.request('users/me/calendarList', {}), /到期/);
    assert.equal(fixture.auth.connected(), false);
    assert.equal(fixture.sessions.getItem(GOOGLE_SESSION_KEY), null);
    fixture.close();
    fixture.sessions.setItem(GOOGLE_SESSION_KEY, oldSession);
    restored = authController(fixture.sessions, fixture.control);
    assert.equal(restored.auth.connected(), false);
    assert.equal(fixture.sessions.getItem(GOOGLE_SESSION_KEY), null);
  } finally { restored?.close(); fixture.close(); globalThis.fetch = originalFetch; }
});

test('舊請求延遲回覆 401 不會清掉重新授權取得的新憑證', async () => {
  const fixture = authController();
  const originalFetch = globalThis.fetch;
  let release;
  globalThis.fetch = async url => url.includes('/old?') ? new Promise(resolve => { release = resolve; }) : {ok: true, json: async () => ({sub: 'account', email: 'a@example.com'})};
  try {
    await authorizeController(fixture, 'old-token');
    const oldRequest = fixture.auth.request('old', {});
    const failure = assert.rejects(oldRequest, /到期/);
    await authorizeController(fixture, 'new-token');
    release({ok: false, status: 401}); await failure;
    assert.equal(fixture.auth.connected(), true);
    assert.equal(fixture.auth.token, 'new-token');
    assert.equal(JSON.parse(fixture.sessions.getItem(GOOGLE_SESSION_KEY)).token, 'new-token');
  } finally { release?.({ok: false, status: 401}); fixture.close(); globalThis.fetch = originalFetch; }
});

test('其他分頁取消後即使未收到通知，延遲的 Google 授權回覆也不能建立連線', async () => {
  const first = authController(), second = authController(tabStorage(), first.control);
  try {
    await first.auth.prepare();
    const pending = first.auth.authorize(sessionContext.clientId);
    const cancelled = assert.rejects(pending, /取消/);
    second.auth.disconnect();
    await first.callback()({access_token: 'stale-token', expires_in: 3600});
    await cancelled;
    assert.equal(first.auth.connected(), false);
    assert.equal(first.sessions.getItem(GOOGLE_SESSION_KEY), null);
  } finally { first.close(); second.close(); }
});

test('部分權限拒絕、彈出視窗關閉及啟動失敗不留下已連線狀態', async () => {
  let options, fail = false;
  const oauth = {initTokenClient: config => { if (fail) throw new Error('failed'); options = config; return {requestAccessToken: () => {}}; }, hasGrantedAllScopes: () => false};
  const injector = createEnvironmentInjector([{provide: DOCUMENT, useValue: {defaultView: {google: {accounts: {oauth2: oauth}}}}}]);
  const auth = runInInjectionContext(injector, () => new GoogleAuth());
  try {
    await auth.prepare();
    let promise = auth.authorize('123-example.apps.googleusercontent.com');
    options.callback({access_token: 'denied', expires_in: 3600});
    await assert.rejects(promise, /權限/);
    assert.equal(auth.token, '');
    promise = auth.authorize('123-example.apps.googleusercontent.com');
    options.error_callback({type: 'popup_closed'});
    await assert.rejects(promise, /已關閉/);
    fail = true;
    await assert.rejects(auth.authorize('123-example.apps.googleusercontent.com'), /無法啟動/);
    assert.equal(auth.authorizing(), false);
    assert.equal(auth.connected(), false);
  } finally { auth.ngOnDestroy(); injector.destroy(); }
});

test('解除連線期間尚未返回的帳號讀取不能重新建立舊連線', async () => {
  let callback, resolveIdentity;
  const oauth = {initTokenClient: config => { callback = config.callback; return {requestAccessToken: () => {}}; }, hasGrantedAllScopes: () => true};
  const injector = createEnvironmentInjector([{provide: DOCUMENT, useValue: {defaultView: {google: {accounts: {oauth2: oauth}}}}}]);
  const auth = runInInjectionContext(injector, () => new GoogleAuth());
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ok: true, json: () => new Promise(resolve => { resolveIdentity = resolve; })});
  try {
    await auth.prepare();
    const promise = auth.authorize('123-example.apps.googleusercontent.com');
    const response = callback({access_token: 'old-token', expires_in: 3600});
    await new Promise(resolve => setImmediate(resolve));
    auth.disconnect();
    await assert.rejects(promise, /取消/);
    resolveIdentity({sub: 'old-account', email: 'old@example.com'});
    await response;
    assert.equal(auth.connected(), false);
    assert.equal(auth.account(), null);
    assert.equal(auth.token, '');
  } finally { globalThis.fetch = originalFetch; auth.ngOnDestroy(); injector.destroy(); }
});

// Controller tests use Angular signals with in-memory storage and API replies, no browser or DOM.
function scheduler() {
  const effects = new Set();
  return {
    add(effect) { effects.add(effect); queueMicrotask(() => this.flush()); },
    schedule() { queueMicrotask(() => this.flush()); },
    remove(effect) { effects.delete(effect); },
    flush() { for (let round = 0; round < 30 && [...effects].some(effect => effect.dirty); round++) for (const effect of effects) if (effect.dirty) effect.run(); }
  };
}
const raw = {id: 'event', summary: '會議', start: {dateTime: '2026-10-09T09:00:00+08:00'}, end: {dateTime: '2026-10-09T10:00:00+08:00'}};
const settle = async () => { for (let tick = 0; tick < 8; tick++) await new Promise(resolve => setImmediate(resolve)); };

test('首次授權待帳號設定保存才暫存憑證，資料重置後不能恢復舊分頁連線', async () => {
  const values = storage(), store = new BoardStore();
  await store.updateGoogle({clientId: sessionContext.clientId});
  const authFixture = authController(tabStorage(), globalThis.localStorage);
  const snapshots = new Map(), rootEffects = scheduler();
  const cache = {get: async key => snapshots.get(key), put: async snapshot => snapshots.set(snapshot.key, snapshot), clear: async () => snapshots.clear(), remove: async key => snapshots.delete(key)};
  const injector = createEnvironmentInjector([{provide: BoardStore, useValue: store}, {provide: GoogleAuth, useValue: authFixture.auth}, {provide: CalendarCache, useValue: cache}, {provide: ɵEffectScheduler, useValue: rootEffects}, {provide: ɵChangeDetectionScheduler, useValue: {notify() {}}}]);
  const service = runInInjectionContext(injector, () => new GoogleCalendarService());
  const originalFetch = globalThis.fetch;
  let restored;
  globalThis.fetch = async value => {
    const url = new URL(value);
    return {ok: true, json: async () => url.pathname.endsWith('/userinfo') ? {sub: 'account', email: 'a@example.com'}
      : url.pathname.endsWith('/calendarList') ? {items: [{id: 'calendar', summary: '月曆'}]}
      : {items: [raw], ...(url.searchParams.get('singleEvents') === 'false' ? {nextSyncToken: 'cursor'} : {})}};
  };
  try {
    service.setMonthRange(new Date(2026, 9, 9)); await settle();
    await authFixture.auth.prepare();
    const connecting = service.connect();
    await authFixture.callback()({access_token: 'integration-token', expires_in: 3600});
    await connecting; await settle();
    const saved = authFixture.sessions.getItem(GOOGLE_SESSION_KEY);
    assert.equal(JSON.parse(saved).generation, store.generation());
    assert.equal(JSON.parse(saved).account.id, store.google().accountId);
    assert.equal([...values.values()].join('').includes('integration-token'), false);
    await service.bind(service.available()[0], store.currentWorkspace().id, true); await settle();
    await service.refresh();
    assert.equal(service.events().length, 1);
    await store.resetData(false, store.revision()); await settle();
    assert.equal(authFixture.auth.connected(), false);
    assert.equal(authFixture.sessions.getItem(GOOGLE_SESSION_KEY), null);
    authFixture.sessions.setItem(GOOGLE_SESSION_KEY, saved);
    restored = authController(authFixture.sessions, globalThis.localStorage);
    restored.auth.useSession({clientId: store.google().clientId, generation: store.generation(), accountId: store.google().accountId});
    assert.equal(restored.auth.connected(), false);
    assert.equal(authFixture.sessions.getItem(GOOGLE_SESSION_KEY), null);
    assert.equal(service.events().length, 0);
  } finally { restored?.close(); service.ngOnDestroy(); injector.destroy(); authFixture.close(); globalThis.fetch = originalFetch; }
});

async function calendarController({emptyAccount = false} = {}) {
  storage();
  const store = new BoardStore();
  await store.updateGoogle({clientId: '123-example.apps.googleusercontent.com'});
  if (!emptyAccount) {
    await store.updateGoogle({accountId: 'account', email: 'a@example.com', refreshMinutes: 0});
    await store.bindCalendar({id: 'source', accountId: 'account', calendarId: 'calendar', name: '月曆', color: '#759acb', workspaceIds: [], visible: true}, store.currentWorkspace().id, true);
  }
  const values = new Map(), requests = [];
  let fail = false, pending, failurePut = false, clears = 0, prepares = 0, authorizations = 0, prepareFailure = false;
  const cache = {
    get: async key => structuredClone(values.get(key)),
    put: async snapshot => { if (failurePut) throw new Error('quota'); values.set(snapshot.key, structuredClone(snapshot)); },
    remove: async key => values.delete(key), clear: async () => { clears++; values.clear(); }
  };
  const auth = {
    connected: signal(false), account: signal(null), ready: signal(false), preparing: signal(false), authorizing: signal(false), message: signal('尚未連線 Google'), sessionWarning: signal(''),
    useSession() {},
    cancelRequests() {},
    async prepare() { prepares++; if (prepareFailure) throw new Error('無法載入元件'); this.ready.set(true); },
    disconnect() { this.connected.set(false); this.account.set(null); },
    async authorize() { authorizations++; this.account.set({id: 'account', email: 'a@example.com'}); this.connected.set(true); return this.account(); },
    async request(path, parameters) {
      requests.push({path, parameters});
      if (pending) await pending;
      if (path === 'users/me/calendarList') return {items: [{id: 'calendar', summary: '月曆'}]};
      if (parameters.singleEvents === 'true' && fail) throw new Error('network');
      return parameters.singleEvents === 'true' ? {items: [raw]} : {items: [raw], nextSyncToken: 'cursor-' + requests.length};
    }
  };
  const rootEffects = scheduler();
  const injector = createEnvironmentInjector([{provide: BoardStore, useValue: store}, {provide: GoogleAuth, useValue: auth}, {provide: CalendarCache, useValue: cache}, {provide: ɵEffectScheduler, useValue: rootEffects}, {provide: ɵChangeDetectionScheduler, useValue: {notify() {}}}]);
  const service = runInInjectionContext(injector, () => new GoogleCalendarService());
  let sidebarInjector;
  const sidebar = () => {
    sidebarInjector = createEnvironmentInjector([{provide: GoogleCalendarService, useValue: service}], injector);
    return runInInjectionContext(sidebarInjector, () => new CalendarSources());
  };
  service.setRange('2026-10-01', '2026-10-31');
  await settle();
  return {store, auth, service, values, requests, sidebar, prepares: () => prepares, authorizations: () => authorizations, setPrepareFailure: value => { prepareFailure = value; }, setFail: value => { fail = value; }, setPending: value => { pending = value; }, setFailurePut: value => { failurePut = value; }, clears: () => clears, close: () => { sidebarInjector?.destroy(); service.ngOnDestroy(); injector.destroy(); }};
}

test('側欄先準備連線元件，點擊才啟動授權；失敗可直接重試', async () => {
  const fixture = await calendarController();
  try {
    fixture.setPrepareFailure(true);
    const sidebar = fixture.sidebar(); await settle();
    assert.equal(fixture.prepares(), 1);
    assert.equal(fixture.authorizations(), 0);
    assert.match(sidebar.error(), /無法載入/);
    fixture.setPrepareFailure(false); await sidebar.prepare();
    assert.equal(sidebar.error(), '');
    assert.equal(fixture.auth.ready(), true);
    const connecting = sidebar.connect();
    assert.equal(fixture.authorizations(), 1);
    await connecting; await settle();
    assert.equal(fixture.auth.connected(), true);
    assert.equal(fixture.service.events().length, 1);
    const prepares = fixture.prepares();
    await fixture.store.updateCalendarSource('source', {color: '#123456'}); await settle();
    assert.equal(fixture.prepares(), prepares);
  } finally { fixture.close(); }
});

test('側欄只採用目前工作空間綁定的月曆，切換至空白工作空間不提供同步來源', async () => {
  const fixture = await calendarController();
  try {
    const sidebar = fixture.sidebar();
    assert.equal(sidebar.workspaceSources().length, 1);
    const original = fixture.store.currentWorkspace().id;
    await fixture.store.saveWorkspace('', '沒有月曆的工作空間');
    assert.equal(sidebar.workspaceSources().length, 0); assert.equal(fixture.service.visibleSources().length, 0);
    fixture.store.switchWorkspace(original); assert.equal(sidebar.workspaceSources().length, 1);
    await fixture.store.updateCalendarSource('source', {visible: false});
    assert.equal(sidebar.workspaceSources().length, 1); assert.equal(fixture.service.visibleSources().length, 0);
  } finally { fixture.close(); }
});

test('月曆快取直接提供週日期，離線或授權到期切換視圖不清空已有活動', async () => {
  const fixture = await calendarController();
  try {
    await fixture.auth.authorize(); await settle(); await fixture.service.refresh();
    const requests = fixture.requests.length;
    fixture.service.setRange('2026-10-05', '2026-10-11');
    assert.equal(fixture.service.events().length, 1);
    await settle();
    assert.equal(fixture.requests.length, requests);
    fixture.auth.disconnect(); fixture.service.online.set(false);
    fixture.service.setRange('2026-10-01', '2026-10-31'); await settle();
    assert.equal(fixture.service.events().length, 1);
    fixture.service.setRange('2026-10-05', '2026-10-11'); await settle();
    assert.equal(fixture.service.events().length, 1);
    assert.match(fixture.service.status(fixture.store.google().sources[0]), /離線快取/);
    fixture.service.setRange('2026-11-05', '2026-11-11'); await settle();
    assert.equal(fixture.service.events().length, 0);
    assert.match(fixture.service.status(fixture.store.google().sources[0]), /沒有快取/);
  } finally { fixture.close(); }
});

test('同月不同週使用同一查詢及同步資料，跨月時才讀取新範圍', async () => {
  const fixture = await calendarController();
  try {
    fixture.service.setMonthRange(new Date(2026, 9, 9)); await settle();
    await fixture.auth.authorize(); await settle(); await fixture.service.refresh();
    const range = fixture.service.range(), requests = fixture.requests.length;
    fixture.service.setMonthRange(new Date(2026, 9, 16)); await settle();
    assert.equal(fixture.service.range(), range);
    assert.equal(fixture.service.events().length, 1);
    assert.equal(fixture.requests.length, requests);
    fixture.service.setMonthRange(new Date(2026, 10, 1)); await settle();
    assert.notEqual(fixture.service.range().key, range.key);
    assert.equal(fixture.requests.length, requests + 2);
  } finally { fixture.close(); }
});

test('近期提醒與月曆共用涵蓋範圍，同月不重複請求，瀏覽過去月份仍保留近期提醒快取', async () => {
  const fixture = await calendarController();
  try {
    fixture.service.setMonthRange(new Date(2026, 9, 9)); fixture.service.setReminderMonth(new Date(2026, 9, 9)); await settle();
    assert.equal(fixture.service.requestedRanges().length, 1);
    await fixture.auth.authorize(); await settle(); await fixture.service.refresh();
    assert.equal(fixture.service.reminderEvents().length, 1);
    const requests = fixture.requests.length;
    fixture.service.setReminderMonth(new Date(2026, 9, 10)); await settle(); await fixture.service.refresh(false);
    assert.equal(fixture.requests.length, requests);
    fixture.service.setMonthRange(new Date(2026, 6, 1)); await settle();
    assert.equal(fixture.service.requestedRanges().length, 2);
    assert.equal(fixture.service.reminderEvents().length, 1); assert.equal(fixture.requests.length, requests + 2);
    const recent = fixture.service.reminderRange();
    assert.match(fixture.service.status(fixture.service.visibleSources()[0], recent), /已同步/);
    for (let month = 0; month < 6; month++) {
      const previousRequests = fixture.requests.length;
      fixture.service.setMonthRange(new Date(2026, month, 1)); await settle();
      assert.equal(fixture.service.reminderEvents().length, 1);
      assert.equal(fixture.requests.length, previousRequests + 2);
      assert.ok(fixture.service.snapshots()[fixture.service.key(fixture.service.visibleSources()[0])].views.length <= 6);
    }
    fixture.auth.disconnect(); fixture.service.online.set(false); await settle();
    assert.equal(fixture.service.reminderEvents().length, 1);
    assert.match(fixture.service.status(fixture.service.visibleSources()[0], recent), /離線快取/);
    await fixture.store.updateCalendarSource('source', {visible: false}); assert.equal(fixture.service.reminderEvents().length, 0);
  } finally { fixture.close(); }
});

test('跨月提醒範圍按需更新，新資料不取代日曆檢視日期，快取有效時安靜檢查', async () => {
  const fixture = await calendarController();
  try {
    fixture.service.setMonthRange(new Date(2026, 9, 9)); fixture.service.setReminderMonth(new Date(2026, 9, 31)); await settle();
    await fixture.auth.authorize(); await settle(); await fixture.service.refresh();
    const range = fixture.service.range(), requests = fixture.requests.length;
    fixture.service.setReminderMonth(new Date(2026, 10, 1)); await settle();
    assert.equal(fixture.service.range(), range); assert.equal(fixture.requests.length, requests + 2);
    const settled = fixture.requests.length;
    for (let index = 0; index < 4; index++) await fixture.service.refresh(false);
    assert.equal(fixture.requests.length, settled); assert.equal(fixture.service.syncing(), false);
  } finally { fixture.close(); }
});

test('其他分頁占用同步鎖時排隊讀取最新範圍，不漏讀或送出過期日期請求', async () => {
  const fixture = await calendarController();
  const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  try {
    Object.defineProperty(navigator, 'locks', {configurable: true, value: {async request(name, callback) { assert.match(name, /^iih-orbit-calendar:/); assert.equal(typeof callback, 'function'); await waiting; return callback({name}); }}});
    await fixture.auth.authorize(); await settle();
    assert.equal(fixture.service.loading().size, 1);
    assert.equal(fixture.requests.length, 0);
    fixture.service.setMonthRange(new Date(2026, 10, 1)); await settle();
    const range = fixture.service.range();
    release(); await settle(); await fixture.service.refresh(false);
    assert.equal(fixture.requests.length, 2);
    assert.equal(fixture.requests[1].parameters.timeMin, range.start);
    assert.equal(fixture.requests[1].parameters.timeMax, range.end);
    assert.equal(fixture.service.loading().size, 0);
  } finally { release?.(); if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks); else delete navigator.locks; fixture.close(); }
});

test('首次連線的帳號確認不被設定尚未保存的短暫狀態中斷', async () => {
  const fixture = await calendarController({emptyAccount: true});
  try {
    await fixture.service.connect(); await settle();
    assert.equal(fixture.auth.connected(), true);
    assert.equal(fixture.store.google().accountId, 'account');
    assert.equal(fixture.service.available().length, 1);
  } finally { fixture.close(); }
});

test('手動排程不自動重讀，活動顯示不改本機進度，隱藏來源立即移除顯示', async () => {
  const fixture = await calendarController();
  try {
    const count = fixture.store.tasks().length, progress = fixture.store.progress();
    await fixture.auth.authorize(); await settle(); await fixture.service.refresh();
    assert.equal(fixture.service.events().length, 1);
    const requests = fixture.requests.length;
    await fixture.service.refresh(false);
    assert.equal(fixture.requests.length, requests);
    assert.equal(fixture.store.tasks().length, count);
    assert.equal(fixture.store.progress(), progress);
    await fixture.store.updateCalendarSource('source', {visible: false}); await settle();
    assert.equal(fixture.service.events().length, 0);
  } finally { fixture.close(); }
});

test('網路失敗保留游標及顯示，離線快取保存失敗保留分頁內活動', async () => {
  const fixture = await calendarController();
  try {
    await fixture.auth.authorize(); await settle(); await fixture.service.refresh();
    const source = fixture.store.google().sources[0], key = fixture.service.key(source);
    const previous = structuredClone(fixture.service.snapshots()[key]);
    fixture.setFail(true); await fixture.service.refresh();
    assert.deepEqual(fixture.service.snapshots()[key], previous);
    assert.equal(fixture.service.events().length, 1);
    assert.match(fixture.service.sourceErrors()[key], /network/);
    fixture.setFail(false); fixture.setFailurePut(true);
    await new Promise(resolve => setTimeout(resolve, 2));
    await fixture.service.refresh();
    const next = fixture.service.snapshots()[key];
    assert.match(fixture.service.cacheWarning(), /無法保存/);
    fixture.auth.disconnect(); await settle();
    assert.equal(fixture.service.snapshots()[key].syncToken, next.syncToken);
    assert.equal(fixture.service.events().length, 1);
    assert.match(fixture.service.status(source), /需重新連線/);
  } finally { fixture.close(); }
});

test('重置中尚未返回的 Google 讀取不能寫回舊世代或復活活動', async () => {
  const fixture = await calendarController();
  let release;
  try {
    await fixture.auth.authorize(); await settle();
    fixture.setPending(new Promise(resolve => { release = resolve; }));
    const updating = fixture.service.refresh(); await settle();
    await fixture.store.resetData(false, fixture.store.revision()); await settle();
    release(); await updating; await settle();
    assert.equal(fixture.auth.connected(), false);
    assert.equal(fixture.service.events().length, 0);
    assert.equal(fixture.values.size, 0);
    assert.ok(fixture.clears() > 0);
  } finally { release?.(); fixture.close(); }
});

test('同步中其他分頁顯示同步狀態，重複手動同步不排隊，完成後讀取共用快取', async () => {
  const fixture = await calendarController();
  let injector, second, release;
  try {
    await fixture.auth.authorize(); await settle(); await fixture.service.refresh();
    const rootEffects = scheduler();
    const cache = {get: async key => structuredClone(fixture.values.get(key)), put: async snapshot => fixture.values.set(snapshot.key, structuredClone(snapshot)), remove: async key => fixture.values.delete(key), clear: async () => fixture.values.clear()};
    injector = createEnvironmentInjector([{provide: BoardStore, useValue: fixture.store}, {provide: GoogleAuth, useValue: fixture.auth}, {provide: CalendarCache, useValue: cache}, {provide: ɵEffectScheduler, useValue: rootEffects}, {provide: ɵChangeDetectionScheduler, useValue: {notify() {}}}]);
    second = runInInjectionContext(injector, () => new GoogleCalendarService());
    second.setRange('2026-10-01', '2026-10-31'); await settle();
    const before = fixture.requests.length;
    fixture.setPending(new Promise(resolve => { release = resolve; }));
    const updating = fixture.service.refresh(); await settle();
    second.coordinator.refresh();
    assert.equal(fixture.service.syncing(), true); assert.equal(second.syncing(), true);
    assert.equal(second.status(second.sources()[0]), '同步中');
    assert.equal(fixture.service.refresh(), updating);
    await second.refresh(); assert.equal(fixture.requests.length, before + 1);
    release(); await updating; second.coordinator.refresh(); await settle();
    assert.equal(fixture.service.syncing(), false); assert.equal(second.syncing(), false);
    assert.equal(fixture.requests.length, before + 2);
    assert.equal(second.snapshots()[second.key(second.sources()[0])].syncToken, fixture.service.snapshots()[fixture.service.key(fixture.service.sources()[0])].syncToken);
  } finally { release?.(); second?.ngOnDestroy(); injector?.destroy(); fixture.close(); }
});

test('同一毫秒連續同步仍增加快取時間版本，不讓其他分頁忽略新活動', async () => {
  const fixture = await calendarController(), originalNow = Date.now;
  try {
    await fixture.auth.authorize(); await settle(); await fixture.service.refresh();
    const key = fixture.service.key(fixture.service.sources()[0]);
    const previous = fixture.service.snapshots()[key];
    const now = Date.parse(previous.updatedAt);
    Date.now = () => now;
    await fixture.service.refresh(); const first = fixture.service.snapshots()[key];
    await fixture.service.refresh(); const second = fixture.service.snapshots()[key];
    assert.equal(Date.parse(first.updatedAt), now + 1); assert.equal(Date.parse(second.updatedAt), now + 2);
    assert.notEqual(first.syncToken, second.syncToken);
    assert.equal(fixture.values.get(key).updatedAt, second.updatedAt);
  } finally { Date.now = originalNow; fixture.close(); }
});

test('有效快取下反覆切換分頁檢查不寫入同步標記、不閃爍，也不呼叫 Google', async () => {
  const fixture = await calendarController();
  const writes = [], storage = globalThis.localStorage, originalSet = storage.setItem;
  try {
    await fixture.auth.authorize(); await settle(); await fixture.service.refresh();
    const requests = fixture.requests.length;
    storage.setItem = (key, value) => { if (key.startsWith(CALENDAR_SYNC_PREFIX)) writes.push(key); originalSet(key, value); };
    for (let index = 0; index < 10; index++) {
      await fixture.service.refresh(false);
      fixture.service.coordinator.refresh();
      assert.equal(fixture.service.syncing(), false);
    }
    assert.equal(fixture.requests.length, requests); assert.equal(writes.length, 0);
  } finally { storage.setItem = originalSet; fixture.close(); }
});

test('兩個分頁收到同步結束通知後只讀快取，不互相廣播或反覆啟動同步', async () => {
  const fixture = await calendarController();
  let injector, second, release;
  const channels = new Set(), messages = [];
  const attach = service => {
    const channel = {onmessage: () => service.coordinator.refresh(), postMessage(message) {
      messages.push(message);
      // Bound a regression loop so a broken implementation fails instead of hanging the suite.
      if (messages.length < 30) for (const peer of channels) if (peer !== channel) queueMicrotask(() => { if (channels.has(peer)) peer.onmessage(); });
    }, close() { channels.delete(channel); }};
    channels.add(channel); service.coordinator.channel = channel;
  };
  try {
    await fixture.auth.authorize(); await settle(); await fixture.service.refresh();
    const cache = {get: async key => structuredClone(fixture.values.get(key)), put: async snapshot => fixture.values.set(snapshot.key, structuredClone(snapshot)), remove: async key => fixture.values.delete(key), clear: async () => fixture.values.clear()};
    injector = createEnvironmentInjector([{provide: BoardStore, useValue: fixture.store}, {provide: GoogleAuth, useValue: fixture.auth}, {provide: CalendarCache, useValue: cache}, {provide: ɵEffectScheduler, useValue: scheduler()}, {provide: ɵChangeDetectionScheduler, useValue: {notify() {}}}]);
    second = runInInjectionContext(injector, () => new GoogleCalendarService());
    second.setRange('2026-10-01', '2026-10-31'); await settle();
    attach(fixture.service); attach(second);
    const before = fixture.requests.length;
    fixture.setPending(new Promise(resolve => { release = resolve; }));
    const updating = fixture.service.refresh(); await settle();
    assert.equal(second.syncing(), true);
    release(); await updating; await settle();
    assert.equal(messages.length, 2); assert.equal(fixture.requests.length, before + 2);
    assert.equal(fixture.service.syncing(), false); assert.equal(second.syncing(), false);
    for (let index = 0; index < 5; index++) { await fixture.service.refresh(false); await second.refresh(false); }
    await settle(); assert.equal(messages.length, 2); assert.equal(fixture.requests.length, before + 2);
  } finally { release?.(); second?.ngOnDestroy(); injector?.destroy(); fixture.close(); }
});

test('自動同步仍遵守五分鐘設定：未到期檢查安靜，到期只更新一次', async () => {
  const fixture = await calendarController(), originalNow = Date.now;
  const storage = globalThis.localStorage, originalSet = storage.setItem;
  let published = 0;
  try {
    await fixture.auth.authorize(); await settle(); await fixture.service.refresh();
    await fixture.store.updateGoogle({refreshMinutes: 5}); await settle();
    const snapshot = fixture.service.snapshots()[fixture.service.key(fixture.service.sources()[0])];
    let now = Date.parse(snapshot.updatedAt) + 299999;
    Date.now = () => now;
    storage.setItem = (key, value) => { if (key.startsWith(CALENDAR_SYNC_PREFIX)) published++; originalSet(key, value); };
    const requests = fixture.requests.length;
    for (let index = 0; index < 10; index++) await fixture.service.refresh(false);
    assert.equal(fixture.requests.length, requests); assert.equal(published, 0);
    now++;
    await fixture.service.refresh(false);
    assert.equal(fixture.requests.length, requests + 2); assert.equal(published, 1);
    for (let index = 0; index < 10; index++) await fixture.service.refresh(false);
    assert.equal(fixture.requests.length, requests + 2); assert.equal(published, 1);
  } finally { Date.now = originalNow; storage.setItem = originalSet; fixture.close(); }
});

test('同步期間頁面離開釋放狀態，返回可同步；晚到舊回覆不清除新作業的同步中', async () => {
  const fixture = await calendarController();
  let releaseOld, releaseNew, cancelled = 0;
  fixture.auth.cancelRequests = () => { cancelled++; };
  try {
    await fixture.auth.authorize(); await settle(); await fixture.service.refresh();
    const key = fixture.service.key(fixture.service.sources()[0]);
    const previous = structuredClone(fixture.service.snapshots()[key]);
    fixture.setPending(new Promise(resolve => { releaseOld = resolve; }));
    const oldRun = fixture.service.refresh(); await settle();
    fixture.service.pageHide(); await oldRun;
    assert.equal(fixture.service.syncing(), false); assert.equal(fixture.service.loading().size, 0);
    assert.equal(fixture.auth.connected(), true); assert.equal(cancelled, 1);
    await fixture.service.refresh(); assert.deepEqual(fixture.service.snapshots()[key], previous);
    fixture.service.pageShow({persisted: true}); await settle();
    fixture.setPending(new Promise(resolve => { releaseNew = resolve; }));
    const newRun = fixture.service.refresh(); await settle();
    assert.equal(fixture.service.loading().size, 1); assert.equal(fixture.service.syncing(), true);
    releaseOld(); await settle();
    assert.equal(fixture.service.loading().size, 1); assert.equal(fixture.service.syncing(), true);
    assert.deepEqual(fixture.service.snapshots()[key], previous);
    releaseNew(); await newRun; assert.equal(fixture.service.syncing(), false); assert.equal(fixture.service.loading().size, 0);
  } finally { releaseOld?.(); releaseNew?.(); fixture.close(); }
});

test('Google 同步整次逾時後解鎖且保留快取與授權，顯示原因並可手動重試', async () => {
  const fixture = await calendarController();
  let release, cancelled = 0;
  fixture.auth.cancelRequests = () => { cancelled++; };
  try {
    await fixture.auth.authorize(); await settle(); await fixture.service.refresh();
    const key = fixture.service.key(fixture.service.sources()[0]);
    const previous = structuredClone(fixture.service.snapshots()[key]);
    fixture.service.coordinator.timeoutMs = 15;
    fixture.setPending(new Promise(resolve => { release = resolve; }));
    await fixture.service.refresh();
    assert.match(fixture.service.error(), /同步逾時/); assert.equal(fixture.service.syncing(), false);
    assert.equal(fixture.service.loading().size, 0); assert.deepEqual(fixture.service.snapshots()[key], previous);
    assert.equal(fixture.auth.connected(), true); assert.equal(cancelled, 1);
    release(); await settle(); fixture.setPending(undefined);
    await fixture.service.refresh(); assert.equal(fixture.service.error(), ''); assert.equal(fixture.service.syncing(), false);
  } finally { release?.(); fixture.close(); }
});

test('取消頁面內的網路請求不清除有效憑證，取消後到達的 401 不解除連線', async () => {
  const fixture = authController(), originalFetch = globalThis.fetch;
  let release;
  try {
    globalThis.fetch = async () => ({ok: true, json: async () => ({sub: 'account', email: 'a@example.com'})});
    await authorizeController(fixture);
    const saved = fixture.sessions.getItem(GOOGLE_SESSION_KEY);
    let requestSignal;
    globalThis.fetch = async (url, options) => { requestSignal = options.signal; return new Promise(resolve => { release = resolve; }); };
    const reading = fixture.auth.request('calendars/calendar/events', {});
    fixture.auth.cancelRequests(); assert.equal(requestSignal.aborted, true);
    release({ok: false, status: 401}); await assert.rejects(reading, error => error.status === 401);
    assert.equal(fixture.auth.connected(), true); assert.equal(fixture.sessions.getItem(GOOGLE_SESSION_KEY), saved);
  } finally { release?.({ok: false, status: 401}); globalThis.fetch = originalFetch; fixture.close(); }
});
