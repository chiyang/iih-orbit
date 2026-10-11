import '@angular/compiler';
import { DOCUMENT } from '@angular/common';
import { createEnvironmentInjector, runInInjectionContext, signal, ɵEffectScheduler, ɵChangeDetectionScheduler } from '@angular/core';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { COLUMNS } from '../src/app/models.ts';

const require = createRequire(import.meta.url), {build} = createRequire(require.resolve('@angular/build/package.json'))('esbuild');
await mkdir('.angular', {recursive: true});
const directory = await mkdtemp(resolve('.angular/gmail-test-')), output = resolve(directory, 'gmail.mjs');
await build({stdin: {contents: "export {GoogleHttpError, readGoogleHttpError} from './src/app/google-api.ts'; export {GmailReadQueue} from './src/app/gmail-requests.ts'; export * from './src/app/gmail-data.ts'; export * from './src/app/schedule-controls.ts'; export * from './src/app/schedule-time.ts'; export * from './src/app/gmail-api.ts'; export * from './src/app/gmail-content.ts'; export {MailReader} from './src/app/mail-reader.ts'; export {GmailPanel} from './src/app/gmail-panel.ts'; export {GmailSettings} from './src/app/gmail-settings.ts'; export {Settings} from './src/app/settings.ts'; export {MailPreview as MailPreviewDialog} from './src/app/mail-preview.ts'; export {GmailAuth} from './src/app/gmail-auth.ts'; export {GmailService} from './src/app/gmail-service.ts'; export {MailTasks} from './src/app/mail-tasks.ts'; export {BoardStore} from './src/app/board-store.ts'; export {Calendar} from './src/app/calendar.ts'; export {GoogleCalendarService} from './src/app/google-calendar.ts'; export {UiPreferences} from './src/app/ui-preferences.ts'; export {App} from './src/app/app.ts'; export {GoogleConnection} from './src/app/google-connection.ts'; export {GoogleCombinedAuth} from './src/app/google-combined-auth.ts'; export {CalendarWriteAuth} from './src/app/calendar-write-auth.ts'; export {DriveService} from './src/app/drive-service.ts';", resolveDir: process.cwd()}, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: output, tsconfig: 'tsconfig.json'});
const {GoogleHttpError, readGoogleHttpError, GmailReadQueue, mapMailRequests, GoogleConnection, GoogleCombinedAuth, CalendarWriteAuth, DriveService, GmailPanel, GmailSettings, Settings, ScheduleTime, DatePickerTrigger, adjacentHour, readMailLabels, fetchMailContent, readMailContent, MailReader, MailPreviewDialog, GmailApi, GmailAuth, GmailService, MailTasks, BoardStore, Calendar, GoogleCalendarService, UiPreferences, App, readMailPreview, decodeMailHeader, gmailMessageLink, mailTask, newMailCursor, mailHasMore, GMAIL_SCOPE, GMAIL_MIME} = await import(pathToFileURL(output).href);
after(() => rm(directory, {recursive: true, force: true}));
const base = {id: 'new', title: '', description: '', categoryId: '', projectId: 'project', status: 'todo', priority: 'medium', startDate: '', startTime: '', dueDate: '', dueTime: '', subtasks: []};
const raw = (id, date = 1000, labels = ['INBOX']) => ({id, threadId: 'thread-' + id, internalDate: String(date), labelIds: labels, snippet: '會議預覽 10/15 14:00', payload: {headers: [{name: 'From', value: '王小明 <sender@example.test>'}, {name: 'Subject', value: '會議邀請'}, {name: 'Message-ID', value: '<' + id + '@example.test>'}], body: {data: 'DO-NOT-COPY'}, parts: [{filename: 'private.pdf'}]}});
const preview = readMailPreview(raw('mail'));
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
after(() => Object.defineProperty(globalThis, 'navigator', originalNavigator));
function browserStorage() {
  let serial = Promise.resolve();
  const locks = {request(_name, operation) {const result = serial.then(operation); serial = result.catch(() => {}); return result;}};
  Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {onLine: true, locks}});
  const values = new Map(), storage = {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key)};
  globalThis.localStorage = storage; globalThis.window = {innerWidth: 1600, addEventListener() {}, removeEventListener() {}};
  globalThis.document = {visibilityState: 'visible', addEventListener() {}, removeEventListener() {}};
  return {values, storage};
}
function fixture(saved = []) {
  const {values} = browserStorage();
  for (const [key, value] of saved) values.set(key, value);
  const state = {version: 1, activeWorkspaceId: 'workspace', workspaces: [{version: 4, id: 'workspace', name: '工作', projects: [{id: 'project', name: '工作'}], categories: [], statuses: COLUMNS, tasks: []}, {version: 4, id: 'other', name: '其他', projects: [], categories: [], statuses: COLUMNS, tasks: []}]};
  values.set('orbit-workspaces-v1', JSON.stringify(state)); const store = new BoardStore(), effects = new Set();
  const scheduler = {add(effect) {effects.add(effect);}, schedule() {}, remove(effect) {effects.delete(effect);}};
  const auth = {connected: signal(false), authorizing: signal(false), ready: signal(false), preparing: signal(false), account: signal(null), connectionVersion: signal(0), cancelRequests() {}, useSession(context) {this.context = context;}, disconnect() {this.connected.set(false); this.account.set(null); this.connectionVersion.update(n => n + 1);}, api: async () => {throw new Error('未設定模擬 API');}};
  const injector = createEnvironmentInjector([{provide: BoardStore, useValue: store}, {provide: GmailAuth, useValue: auth}, {provide: ɵEffectScheduler, useValue: scheduler}, {provide: ɵChangeDetectionScheduler, useValue: {notify() {}}}]);
  const gmail = runInInjectionContext(injector, () => new GmailService());
  const child = createEnvironmentInjector([{provide: GmailService, useValue: gmail}, {provide: BoardStore, useValue: store}, MailTasks, MailReader], injector);
  const tasks = child.get(MailTasks), reader = child.get(MailReader);
  const flush = () => {for (let round = 0; round < 30 && [...effects].some(effect => effect.dirty); round++) for (const effect of effects) if (effect.dirty) effect.run();};
  gmail.preferences.set({generation: store.generation(), clientId: '123-example.apps.googleusercontent.com', accountId: 'account', email: 'me@example.test', selected: ['INBOX']});
  auth.connected.set(true); auth.account.set({id: 'account', email: 'me@example.test'}); flush();
  return {store, gmail, auth, tasks, reader, values, child, flush, close() {child.destroy(); gmail.ngOnDestroy(); injector.destroy();}};
}
const event = () => {const data = new Map(); return {dataTransfer: {types: [], effectAllowed: '', dropEffect: '', setData(type, value) {data.set(type, value); this.types.push(type);}, getData: type => data.get(type) ?? ''}, prevented: false, stopped: false, preventDefault() {this.prevented = true;}, stopPropagation() {this.stopped = true;}};};

test('Google 403 依原因區分頻率、每日配額、管理員政策與權限，錯誤回應大小受限', async () => {
  const response = reason => Response.json({error: {errors: [{reason}], message: 'PRIVATE-ACCOUNT-DETAIL'}}, {status: 403, headers: {'Retry-After': '2'}});
  for (const reason of ['rateLimitExceeded', 'userRateLimitExceeded']) {
    const error = await readGoogleHttpError(response(reason), 'Gmail 郵件');
    assert.equal(error.reason, reason); assert.equal(error.retryable, true); assert.equal(error.retryAfterMs, 2000);
    assert.match(error.message, /限制讀取次數/); assert.equal(error.message.includes('PRIVATE'), false);
  }
  const daily = await readGoogleHttpError(response('dailyLimitExceeded'), 'Gmail 郵件'); assert.equal(daily.retryable, false); assert.match(daily.message, /今日配額/);
  const policy = await readGoogleHttpError(response('domainPolicy'), 'Gmail 郵件'); assert.equal(policy.retryable, false); assert.match(policy.message, /管理員/);
  const permission = await readGoogleHttpError(response('insufficientPermissions'), 'Gmail 郵件'); assert.equal(permission.retryable, false); assert.match(permission.message, /授權權限/);
  const modern = await readGoogleHttpError(Response.json({error: {details: [{reason: 'RATE_LIMIT_EXCEEDED'}]}}, {status: 403}), 'Gmail 郵件'); assert.equal(modern.retryable, true);
  const malformed = await readGoogleHttpError(new Response('<html>oops</html>', {status: 503}), 'Gmail 郵件'); assert.equal(malformed.status, 503); assert.equal(malformed.retryable, true);
  const oversized = await readGoogleHttpError(Response.json({error: {message: 'x'.repeat(20000), errors: [{reason: 'rateLimitExceeded'}]}}, {status: 403}), 'Gmail 郵件'); assert.equal(oversized.status, 403); assert.equal(oversized.reason, '');
  const retryDate = new Date(Date.now() + 60000).toUTCString();
  const delayed = await readGoogleHttpError(new Response(null, {status: 429, headers: {'Retry-After': retryDate}}), 'Gmail 郵件'); assert.ok(delayed.retryAfterMs > 58000);
});
test('多標籤巢狀讀取及討論串、內文共用最多四個 Gmail 請求', async () => {
  let active = 0, maximum = 0;
  const queue = new GmailReadQueue(async (path, params) => {
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setImmediate(resolve)); active--;
    if (path === 'messages') return {messages: Array.from({length: 8}, (_, i) => ({id: params.labelIds + i}))};
    if (path === 'threads/conversation') return {id: 'conversation', messages: [{...raw('reply'), threadId: 'conversation'}]};
    if (path === 'body') return 'body';
    return raw(path.split('/')[1]);
  });
  const api = new GmailApi((...args) => queue.read(...args));
  const [page, thread, body] = await Promise.all([api.page(newMailCursor(['INBOX', 'Work', 'Other'])), api.thread('conversation'), queue.read('body')]);
  assert.equal(maximum, 4); assert.equal(active, 0); assert.equal(page.messages.length, 24); assert.equal(thread.length, 1); assert.equal(body, 'body');
});
test('Gmail 暫時性 403／429 依退避與 Retry-After 重試，最多三次且不重試權限／每日配額', async t => {
  t.mock.timers.enable({apis: ['setTimeout', 'Date'], now: 100000});
  const times = [], queue = new GmailReadQueue(async () => {
    times.push(Date.now());
    if (times.length === 1) throw new GoogleHttpError(403, 'Gmail 郵件', {reason: 'userRateLimitExceeded', retryAfterMs: 1200});
    if (times.length === 2) throw new GoogleHttpError(429, 'Gmail 郵件', {retryAfterMs: 2200});
    return {labels: []};
  });
  const reading = queue.read('labels'); await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(1000); await new Promise(resolve => setImmediate(resolve)); assert.equal(times.length, 1);
  t.mock.timers.tick(250); await new Promise(resolve => setImmediate(resolve)); assert.equal(times.length, 2);
  t.mock.timers.tick(2250); assert.deepEqual(await reading, {labels: []}); assert.equal(times.length, 3);
  assert.ok(times[1] - times[0] >= 1200); assert.ok(times[2] - times[1] >= 2200);
  for (const error of [new GoogleHttpError(403, 'Gmail 郵件'), new GoogleHttpError(403, 'Gmail 郵件', {reason: 'dailyLimitExceeded'}), new GoogleHttpError(401), new GoogleHttpError(429, 'Gmail 郵件', {retryAfterMs: 60000})]) {
    let calls = 0; const denied = new GmailReadQueue(async () => {calls++; throw error;});
    await assert.rejects(denied.read('labels'), value => value === error); assert.equal(calls, 1);
  }
  let failures = 0; const unavailable = new GmailReadQueue(async () => {failures++; throw new GoogleHttpError(503);});
  const exhausted = assert.rejects(unavailable.read('labels'), value => value.status === 503);
  await new Promise(resolve => setImmediate(resolve)); t.mock.timers.tick(1250);
  await new Promise(resolve => setImmediate(resolve)); t.mock.timers.tick(2250);
  await exhausted; assert.equal(failures, 3);
});
test('取消 Gmail 排隊或退避讀取立即離開，不發送遲到重試，也不占住後續請求', async t => {
  t.mock.timers.enable({apis: ['setTimeout', 'Date'], now: 100000});
  const controller = new AbortController(); let attempts = 0;
  const retrying = new GmailReadQueue(async () => {attempts++; throw new GoogleHttpError(403, 'Gmail 郵件', {reason: 'rateLimitExceeded'});});
  const aborted = assert.rejects(retrying.read('labels', undefined, controller.signal), value => value.name === 'AbortError');
  await new Promise(resolve => setImmediate(resolve)); controller.abort(); await aborted;
  t.mock.timers.tick(5000); await new Promise(resolve => setImmediate(resolve)); assert.equal(attempts, 1);
  const releases = [], paths = [], queued = new GmailReadQueue(async path => {paths.push(path); return new Promise(resolve => releases.push(resolve));});
  const first = Array.from({length: 4}, (_, i) => queued.read(String(i))), waiting = new AbortController(); let current = true;
  const cancelled = assert.rejects(queued.read('cancelled', undefined, waiting.signal), value => value.name === 'AbortError');
  const wrongAccount = assert.rejects(queued.read('wrong-account', undefined, undefined, () => current), value => value.name === 'AbortError');
  waiting.abort(); current = false; await cancelled; releases.forEach(resolve => resolve({})); await Promise.all(first); await wrongAccount;
  assert.deepEqual(paths, ['0', '1', '2', '3']);
  const next = queued.read('next'); releases.at(-1)({ok: true}); assert.deepEqual(await next, {ok: true});
});
test('Google 長期 Retry-After 與重試耗盡會暫停所有 Gmail 讀取，冷卻期間不再送請求', async t => {
  t.mock.timers.enable({apis: ['setTimeout', 'Date'], now: 100000});
  let calls = 0, limited = true;
  const error = new GoogleHttpError(429, 'Gmail 郵件', {retryAfterMs: 120000});
  const queue = new GmailReadQueue(async () => {calls++; if (limited) throw error; return {ok: true};});
  queue.useContext('account'); await assert.rejects(queue.read('messages'), value => value === error);
  limited = false;
  await assert.rejects(queue.read('threads/thread'), value => value === error);
  queue.useContext('account'); t.mock.timers.tick(119999);
  await assert.rejects(queue.read('body'), value => value === error); assert.equal(calls, 1);
  t.mock.timers.tick(1); assert.deepEqual(await queue.read('messages'), {ok: true}); assert.equal(calls, 2);
  limited = true; await assert.rejects(queue.read('messages'), value => value === error);
  limited = false; queue.useContext('another-account'); await queue.read('messages'); assert.equal(calls, 4);
  let attempts = 0;
  const exhausted = new GmailReadQueue(async () => {attempts++; throw new GoogleHttpError(403, 'Gmail 郵件', {reason: 'userRateLimitExceeded'});});
  const reading = assert.rejects(exhausted.read('labels'), /限制讀取次數/);
  await new Promise(resolve => setImmediate(resolve)); t.mock.timers.tick(1250);
  await new Promise(resolve => setImmediate(resolve)); t.mock.timers.tick(2250); await reading;
  await assert.rejects(exhausted.read('messages'), /限制讀取次數/); assert.equal(attempts, 3);
  let rejectOld;
  const changing = new GmailReadQueue(async path => path === 'old' ? new Promise((_resolve, reject) => {rejectOld = reject;}) : {ok: true});
  changing.useContext('old-account'); const old = assert.rejects(changing.read('old'), error => error.name === 'AbortError');
  changing.useContext('new-account'); rejectOld(error); await old;
  assert.deepEqual(await changing.read('new'), {ok: true});
});
test('郵件批次首個失敗停止其他工作，等已啟動請求結束後保留原始錯誤', async () => {
  const starts = [], error = new GoogleHttpError(403, 'Gmail 郵件'); let fail, active = 0;
  const batch = mapMailRequests(Array.from({length: 20}, (_, i) => i), (id, signal) => {
    starts.push(id); active++;
    return new Promise((resolve, reject) => {
      if (id === 0) fail = () => {active--; reject(error);};
      else signal.addEventListener('abort', () => {active--; reject(new DOMException('cancelled', 'AbortError'));}, {once: true});
    });
  });
  const failed = assert.rejects(batch, value => value === error); fail(); await failed;
  assert.deepEqual(starts, [0, 1, 2, 3]); assert.equal(active, 0);
});
test('重疊標籤共用郵件請求時，巢狀批次取消仍保留真正的 Google 錯誤原因', async () => {
  const denied = new GoogleHttpError(403, 'Gmail 郵件', {reason: 'insufficientPermissions'});
  const api = new GmailApi(async (path, params, signal) => {
    if (path === 'messages') return {messages: [{id: 'shared'}, {id: params.labelIds === 'A' ? 'bad' : 'other'}]};
    if (path === 'messages/bad') {await new Promise(resolve => setImmediate(resolve)); throw denied;}
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once: true}));
  });
  await assert.rejects(api.page(newMailCursor(['A', 'B'])), error => error === denied);
});
test('切換 Gmail 篩選取消舊批次、停止後續讀取，保留新清單與正在閱讀的內文', async () => {
  const f = fixture(), oldDetails = [], paths = []; let panel, releaseBody, globalCancels = 0;
  try {
    f.gmail.labels.set([{id: 'INBOX', name: 'INBOX', type: 'system'}, {id: 'Work', name: '工作', type: 'user'}]);
    panel = runInInjectionContext(f.child, () => new GmailPanel()); panel.active = signal(false); f.flush();
    f.auth.cancelRequests = () => {globalCancels++;};
    f.auth.api = async (path, params, signal) => {
      paths.push(path);
      if (path === 'messages/mail') return new Promise(resolve => {releaseBody = resolve;});
      if (path === 'messages') return {messages: params.labelIds === 'INBOX' ? Array.from({length: 20}, (_, i) => ({id: 'old' + i})) : [{id: 'work'}]};
      if (path.startsWith('messages/old')) return new Promise(resolve => oldDetails.push({signal, release: () => resolve(raw(path.split('/')[1]))}));
      if (path.startsWith('threads/')) return {id: 'thread-work', messages: [raw('work')]};
      return raw('work');
    };
    const body = f.reader.read(preview, f.gmail.previewIdentity()), old = f.gmail.load();
    await new Promise(resolve => setImmediate(resolve)); assert.equal(oldDetails.length, 4);
    panel.toggleLabel('INBOX'); panel.toggleLabel('Work'); f.flush();
    assert.ok(oldDetails.every(request => !request.signal.aborted)); assert.deepEqual(f.gmail.selected(), ['INBOX']);
    panel.applyLabels(); assert.ok(oldDetails.every(request => request.signal.aborted)); f.flush();
    await f.gmail.load(); oldDetails.forEach(request => request.release()); await old;
    assert.equal(paths.filter(path => path.startsWith('messages/old')).length, 4); assert.equal(paths.some(path => path.startsWith('threads/thread-old')), false);
    assert.equal(f.gmail.messages()[0].id, 'work'); assert.equal(f.gmail.error(), ''); assert.equal(f.gmail.busy(), false); assert.equal(globalCancels, 0);
    releaseBody({id: 'mail', payload: {mimeType: 'text/html', body: {data: encodedBody('<p>Still reading</p>')}}});
    assert.match((await body).html, /Still reading/);
  } finally {panel?.ngOnDestroy(); f.close();}
});
test('標籤與快捷選擇只修改草稿，套用才讀取最終聯集；取消、重按與更新不套用草稿', async t => {
  t.mock.timers.enable({apis: ['setTimeout', 'Date'], now: Date.now()});
  const f = fixture(), pages = []; let panel, calls = 0;
  const labels = [{id: 'INBOX', name: 'INBOX', type: 'system'}, {id: 'Work', name: '工作', type: 'user'}, {id: 'Home', name: '家務', type: 'user'}];
  try {
    f.auth.api = async (path, params) => {
      calls++;
      if (path === 'labels') return {labels};
      if (path === 'messages') {pages.push(params.labelIds); return {messages: [{id: params.labelIds || 'all'}]};}
      const id = path.startsWith('threads/') ? path.slice('threads/thread-'.length) : path.split('/')[1];
      return path.startsWith('threads/') ? {id: 'thread-' + id, messages: [raw(id)]} : raw(id);
    };
    await f.gmail.load(); panel = runInInjectionContext(f.child, () => new GmailPanel()); f.flush();
    const count = calls, savedPreferences = f.values.get('iih-orbit-gmail-preferences-v1'), savedCache = f.values.get('iih-orbit-gmail-cache-v1'), updatedAt = f.gmail.updatedAt();
    panel.toggleLabel('INBOX'); panel.toggleLabel('Work'); panel.toggleLabel('Home'); panel.toggleLabel('Unknown'); f.flush();
    t.mock.timers.tick(5000); await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, count); assert.deepEqual(panel.labelDraft(), ['Work', 'Home']); assert.deepEqual(panel.draftLabelNames(), ['工作', '家務']); assert.equal(panel.labelsChanged(), true);
    assert.deepEqual(f.gmail.selected(), ['INBOX']); assert.equal(f.gmail.messages()[0].id, 'INBOX'); assert.equal(f.gmail.updatedAt(), updatedAt);
    assert.equal(f.values.get('iih-orbit-gmail-preferences-v1'), savedPreferences); assert.equal(f.values.get('iih-orbit-gmail-cache-v1'), savedCache);
    panel.resetLabels(); assert.equal(panel.labelsChanged(), false);
    panel.labelDraft.set([]); f.flush(); t.mock.timers.tick(1000); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, count);
    panel.labelDraft.set(['INBOX']); assert.equal(panel.labelsChanged(), false);
    panel.toggleLabel('Work'); panel.toggleLabel('Work'); assert.equal(panel.labelsChanged(), false); panel.applyLabels(); assert.equal(calls, count);
    panel.labelDraft.set(['Work', 'Home']); panel.applyLabels(); panel.applyLabels(); f.flush();
    t.mock.timers.tick(400); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(pages, ['INBOX', 'Work', 'Home']); assert.deepEqual(f.gmail.selected(), ['Work', 'Home']); assert.equal(panel.labelsChanged(), false); assert.equal(f.gmail.busy(), false);
    assert.deepEqual(JSON.parse(f.values.get('iih-orbit-gmail-preferences-v1')).selected, ['Work', 'Home']);
    panel.labelDraft.set(['INBOX']); await panel.refresh(); f.flush();
    assert.deepEqual(pages.slice(-2), ['Work', 'Home']); assert.deepEqual(panel.labelDraft(), ['INBOX']); assert.equal(panel.labelsChanged(), true); assert.deepEqual(f.gmail.selected(), ['Work', 'Home']);
    f.gmail.online.set(false); navigator.onLine = false; const before = calls; panel.applyLabels(); f.flush(); assert.equal(calls, before); assert.deepEqual(f.gmail.selected(), ['INBOX']); assert.equal(f.gmail.messages()[0].id, 'INBOX');
    f.gmail.online.set(true); navigator.onLine = true; panel.labelDraft.set([]); panel.applyLabels(); f.flush(); t.mock.timers.tick(400); await new Promise(resolve => setImmediate(resolve));
    assert.equal(pages.at(-1), undefined); assert.deepEqual(f.gmail.selected(), []); assert.equal(panel.labelsChanged(), false);
  } finally {panel?.ngOnDestroy(); f.close();}
});
test('未套用標籤不保存，重開側欄與切換 Gmail 帳號回到已套用選擇；外部更新重設草稿', async () => {
  const f = fixture(); let panel, reopened;
  try {
    f.gmail.labels.set([{id: 'INBOX', name: 'INBOX', type: 'system'}, {id: 'Work', name: '工作', type: 'user'}]);
    panel = runInInjectionContext(f.child, () => new GmailPanel()); panel.active = signal(false); f.flush();
    panel.toggleLabel('Work'); assert.equal(panel.labelsChanged(), true); panel.ngOnDestroy();
    reopened = runInInjectionContext(f.child, () => new GmailPanel()); reopened.active = signal(false); f.flush();
    assert.deepEqual(reopened.labelDraft(), ['INBOX']); assert.equal(reopened.labelsChanged(), false);
    reopened.toggleLabel('Work'); f.gmail.search('subject:meeting'); f.flush(); assert.equal(reopened.labelsChanged(), true); assert.deepEqual(f.gmail.selected(), ['INBOX']);
    f.gmail.applyLabels(['Work']); f.flush(); assert.deepEqual(reopened.labelDraft(), ['Work']); assert.equal(reopened.labelsChanged(), false);
    reopened.toggleLabel('INBOX'); f.gmail.preferences.set({...f.gmail.preferences(), accountId: 'another', email: 'other@example.test', selected: ['INBOX']}); f.auth.account.set({id: 'another', email: 'other@example.test'}); f.flush();
    assert.deepEqual(reopened.labelDraft(), ['INBOX']); assert.equal(reopened.labelsChanged(), false);
  } finally {panel?.ngOnDestroy(); reopened?.ngOnDestroy(); f.close();}
});
test('舊 Gmail 標籤回應到達後不能啟動過期搜尋；最新讀取失敗仍可重新更新', async () => {
  const f = fixture(); let release, labelCalls = 0, fail = false; const queries = [];
  try {
    f.auth.api = async (path, params) => {
      if (path === 'labels') {labelCalls++; if (labelCalls === 1) return new Promise(resolve => {release = resolve;}); return {labels: [{id: 'INBOX', name: 'INBOX', type: 'system'}]};}
      if (path === 'messages') {queries.push(params.q); if (fail) throw new GoogleHttpError(403, 'Gmail 郵件', {reason: 'userRateLimitExceeded'}); return {messages: [{id: 'new'}]};}
      return path.startsWith('threads/') ? {id: 'thread-new', messages: [raw('new')]} : raw('new');
    };
    const old = f.gmail.load(true); f.gmail.search('subject:new'); f.flush(); await f.gmail.load();
    release({labels: [{id: 'INBOX', name: 'INBOX', type: 'system'}]}); await old; assert.deepEqual(queries, ['subject:new']);
    fail = true; await f.gmail.load(true); assert.equal(f.gmail.busy(), false); assert.match(f.gmail.error(), /限制讀取次數/); assert.equal(f.gmail.messages()[0].id, 'new');
    fail = false; await f.gmail.load(true); assert.equal(f.gmail.busy(), false); assert.equal(f.gmail.error(), ''); assert.equal(f.gmail.messages()[0].id, 'new');
  } finally {f.close();}
});

test('郵件只保留寄件人完整地址、主旨及預覽，解碼中文標頭，不攜帶本文與附件', () => {
  const source = raw('encoded'); source.payload.headers[0].value = '=?UTF-8?B?546L5bCP5piO?= <sender@example.test>';
  const mail = readMailPreview(source); assert.equal(mail.senderName, '王小明'); assert.equal(mail.senderEmail, 'sender@example.test');
  assert.equal(decodeMailHeader('=?UTF-8?Q?hello_world?='), 'hello world'); assert.equal(JSON.stringify(mail).includes('DO-NOT-COPY'), false); assert.equal('payload' in mail, false);
  assert.throws(() => readMailPreview({...source, internalDate: 'invalid'}), /不完整/);
  source.payload.headers[0].value = '"客服 <trusted@example.test>" <attacker@example.test>';
  assert.equal(readMailPreview(source).senderEmail, 'attacker@example.test');
  source.payload.headers[0].value = 'sender@example.test (客服 <trusted@example.test>)';
  assert.equal(readMailPreview(source).senderEmail, 'sender@example.test');
});
test('Gmail 原信連結使用來源帳號與 Message-ID 搜尋，不依瀏覽器帳號排序', () => {
  const chooser = new URL(gmailMessageLink(preview, 'me@example.test')), target = new URL(chooser.searchParams.get('continue'));
  assert.equal(chooser.hostname, 'accounts.google.com'); assert.equal(chooser.searchParams.get('Email'), 'me@example.test'); assert.equal(target.searchParams.get('authuser'), 'me@example.test');
  assert.match(decodeURIComponent(target.hash), /rfc822msgid:mail@example.test/); assert.equal(target.pathname, '/mail/'); assert.equal(gmailMessageLink(preview, 'invalid'), '');
});
test('郵件複製是獨立快照，月份建立全天，週時段一小時且跨午夜換日；長預覽仍保留原信連結', () => {
  const task = mailTask({...preview, snippet: '預覽'.repeat(2000)}, 'me@example.test', base, {date: '2026-10-10'});
  assert.equal(task.startDate, '2026-10-10'); assert.equal(task.dueDate, task.startDate); assert.equal(task.startTime, ''); assert.equal(task.dueTime, '');
  assert.ok(task.description.length <= 2000); assert.match(task.description, /sender@example.test/); assert.ok(task.description.endsWith(gmailMessageLink(preview, 'me@example.test') + '>)')); assert.equal('calendarOrigin' in task, false);
  const timed = mailTask(preview, 'me@example.test', base, {date: '2026-10-10', time: '23:30'}); assert.equal(timed.dueDate, '2026-10-11'); assert.equal(timed.dueTime, '00:30');
  assert.throws(() => mailTask(preview, 'me@example.test', base, {date: '2026-02-30'}), /日期/);
});
test('多標籤採聯集，各頁按日期合併去重，保留未顯示的舊郵件；不誤用 AND labelIds', async () => {
  const requests = [], pages = {INBOX: {first: ['a', 'shared', 'c'], next: ['old']}, Work: {first: ['b', 'shared', 'd'], next: ['older']}};
  const dates = {a: 100, b: 95, shared: 90, c: 80, d: 70, old: 60, older: 50};
  const api = new GmailApi(async (path, params) => {
    requests.push({path, params});
    if (path === 'messages') {const ids = pages[params.labelIds][params.pageToken || 'first']; return {messages: ids.map(id => ({id})), ...(params.pageToken ? {} : {nextPageToken: 'next'})};}
    return raw(path.split('/')[1], dates[path.split('/')[1]]);
  });
  const first = await api.page(newMailCursor(['INBOX', 'Work']), 3), second = await api.page(first.cursor, 3), third = await api.page(second.cursor, 3);
  assert.deepEqual([...first.messages, ...second.messages, ...third.messages].map(mail => mail.id), ['a', 'b', 'shared', 'c', 'd', 'old', 'older']); assert.equal(mailHasMore(third.cursor), false);
  assert.equal(requests.filter(request => request.path === 'messages/shared').length, 1);
  assert.ok(requests.filter(request => request.path === 'messages').every(request => typeof request.params.labelIds === 'string' && !request.params.labelIds.includes(',')));
  const details = requests.find(request => request.path === 'messages/a'); assert.equal(details.params.format, 'full'); assert.equal(details.params.fields.includes('body'), false); assert.equal(details.params.fields.includes('parts'), false);
});
test('Gmail 分頁失敗不破壞原游標，已刪信件跳過；空郵箱與垃圾桶標籤正確處理', async () => {
  const cursor = newMailCursor(['TRASH']), original = structuredClone(cursor); let fail = true, include;
  const api = new GmailApi(async (path, params) => {if (path === 'messages') {include = params.includeSpamTrash; return {messages: [{id: 'gone'}, {id: 'good'}]};} if (path.endsWith('gone')) throw Object.assign(new Error('gone'), {status: 404}); if (fail) throw new Error('network'); return raw('good');});
  await assert.rejects(api.page(cursor), /network/); assert.deepEqual(cursor, original); fail = false;
  assert.deepEqual((await api.page(cursor)).messages.map(mail => mail.id), ['good']); assert.equal(include, 'true');
  assert.deepEqual((await new GmailApi(async () => ({})).page(newMailCursor([]))).messages, []);
});
test('郵件快取只在本機：再次開啟沿用新鮮快取；舊標籤回覆不能覆蓋新篩選，全部還原清理', async () => {
  const f = fixture(); let calls = 0, release;
  try {
    f.auth.api = async (path, params) => {calls++; if (path === 'labels') return {labels: [{id: 'INBOX', name: 'INBOX', type: 'system'}, {id: 'Work', name: '工作', type: 'user'}]}; if (path === 'messages') return {messages: [{id: params.labelIds === 'Work' ? 'work' : 'inbox'}]}; if (path.startsWith('threads/')) {const id = path.slice('threads/thread-'.length); return {id: 'thread-' + id, messages: [raw(id)]};} return raw(path.split('/')[1]);};
    await f.gmail.load(); const count = calls; await f.gmail.load(); assert.equal(calls, count); assert.equal(f.gmail.messages()[0].id, 'inbox');
    assert.ok(f.values.has('iih-orbit-gmail-cache-v1')); assert.equal(JSON.stringify(await f.store.backupForExport('full')).includes('會議預覽'), false);
    f.auth.api = async (path, params) => {if (path === 'labels') return {labels: [{id: 'INBOX', name: 'INBOX', type: 'system'}, {id: 'Work', name: '工作', type: 'user'}]}; if (path === 'messages' && params.labelIds === 'INBOX') return new Promise(resolve => {release = resolve;}); if (path === 'messages') return {messages: [{id: 'work'}]}; if (path === 'threads/thread-work') return {id: 'thread-work', messages: [raw('work')]}; return raw('work');};
    const old = f.gmail.load(true); await new Promise(resolve => setImmediate(resolve));
    f.gmail.applyLabels(['Work']); f.flush(); assert.equal(f.gmail.labels().length, 2);
    await f.gmail.load(); release({messages: [{id: 'old'}]}); await old; assert.equal(f.gmail.messages()[0].id, 'work');
    await f.store.resetData(true, f.store.revision()); f.flush(); assert.equal(f.gmail.preferences().accountId, ''); assert.equal(f.gmail.messages().length, 0); assert.equal(f.values.has('iih-orbit-gmail-cache-v1'), false);
  } finally {f.close();}
});
test('各標籤與搜尋先顯示對應快取，五分鐘內不下載；過期更新失敗不覆蓋成功時間與原郵件', async t => {
  t.mock.timers.enable({apis: ['setTimeout', 'Date'], now: Date.now()});
  const f = fixture(), pages = []; let fail = false;
  try {
    f.auth.api = async (path, params) => {
      if (path === 'labels') return {labels: [{id: 'INBOX', name: 'INBOX', type: 'system'}, {id: 'Work', name: '工作', type: 'user'}]};
      if (path === 'messages') {pages.push(params.labelIds + ':' + (params.q ?? '')); if (fail) throw new Error('network'); return {messages: [{id: params.q ? 'search' : params.labelIds}]};}
      const id = path.startsWith('threads/') ? path.slice('threads/thread-'.length) : path.split('/')[1];
      return path.startsWith('threads/') ? {id: 'thread-' + id, messages: [raw(id)]} : raw(id);
    };
    await f.gmail.load(); const inboxTime = f.gmail.updatedAt();
    f.gmail.applyLabels(['Work']); f.flush(); assert.equal(f.gmail.showingPrevious(), true); await f.gmail.load();
    f.gmail.search('subject:meeting'); f.flush(); await f.gmail.load();
    f.gmail.search(''); f.flush(); assert.equal(f.gmail.messages()[0].id, 'Work'); assert.equal(f.gmail.showingPrevious(), false); await f.gmail.load();
    f.gmail.applyLabels(['INBOX']); f.flush(); assert.equal(f.gmail.messages()[0].id, 'INBOX'); assert.equal(f.gmail.updatedAt(), inboxTime); await f.gmail.load();
    assert.deepEqual(pages, ['INBOX:', 'Work:', 'Work:subject:meeting']);
    const persisted = f.values.get('iih-orbit-gmail-cache-v1');
    fail = true; t.mock.timers.tick(5 * 60000 + 1); await f.gmail.load();
    assert.equal(f.gmail.messages()[0].id, 'INBOX'); assert.equal(f.gmail.updatedAt(), inboxTime); assert.match(f.gmail.error(), /network/); assert.equal(f.gmail.busy(), false);
    assert.equal(f.values.get('iih-orbit-gmail-cache-v1'), persisted);
    await f.gmail.load(); f.gmail.active.set(true); f.flush(); t.mock.timers.tick(400); await new Promise(resolve => setImmediate(resolve)); assert.equal(pages.length, 4);
    fail = false; await f.gmail.load(true); assert.ok(f.gmail.updatedAt() > inboxTime); assert.equal(f.gmail.error(), '');
    assert.equal(JSON.parse(f.values.get('iih-orbit-gmail-cache-v1')).entries.length, 3);
  } finally {f.close();}
});
test('沒有快取的新篩選失敗保留上次清單並標示，成功後才換成新結果，失敗不建立空快取', async () => {
  const f = fixture(); let fail = false;
  try {
    f.auth.api = async (path, params) => {
      if (path === 'labels') return {labels: [{id: 'INBOX', name: 'INBOX', type: 'system'}, {id: 'Work', name: '工作', type: 'user'}]};
      if (path === 'messages') {if (fail) throw new GoogleHttpError(429, 'Gmail 郵件'); return {messages: [{id: params.labelIds}]};}
      const id = path.startsWith('threads/') ? path.slice('threads/thread-'.length) : path.split('/')[1];
      return path.startsWith('threads/') ? {id: 'thread-' + id, messages: [raw(id)]} : raw(id);
    };
    await f.gmail.load(); const original = f.values.get('iih-orbit-gmail-cache-v1');
    fail = true; f.gmail.applyLabels(['Work']); f.flush(); await f.gmail.load();
    assert.equal(f.gmail.messages()[0].id, 'INBOX'); assert.equal(f.gmail.showingPrevious(), true); assert.equal(f.gmail.hasMore(), false);
    assert.equal(f.values.get('iih-orbit-gmail-cache-v1'), original);
    f.gmail.applyLabels(['INBOX']); f.flush(); await f.gmail.load(); assert.equal(f.gmail.error(), ''); assert.equal(f.gmail.showingPrevious(), false);
    f.gmail.applyLabels(['Work']); f.flush(); assert.match(f.gmail.error(), /限制/);
    fail = false; await f.gmail.load(true); assert.equal(f.gmail.messages()[0].id, 'Work'); assert.equal(f.gmail.showingPrevious(), false);
    assert.equal(JSON.parse(f.values.get('iih-orbit-gmail-cache-v1')).entries.length, 2);
  } finally {f.close();}
});
test('重新整理保留快取時間，五分鐘內不讀取；載入更多重建游標後接續下一頁，失敗不破壞原清單', async t => {
  t.mock.timers.enable({apis: ['setTimeout', 'Date'], now: Date.now()});
  const f = fixture(); let reopened, saved, stamp;
  const handler = pages => async (path, params) => {
    if (path === 'labels') return {labels: [{id: 'INBOX', name: 'INBOX', type: 'system'}]};
    if (path === 'messages') {pages.push(params.pageToken ?? 'first'); const start = params.pageToken ? 25 : 0; return {messages: Array.from({length: 25}, (_, i) => ({id: 'mail' + (start + i)})), ...(start ? {} : {nextPageToken: 'next'})};}
    const id = path.startsWith('threads/') ? path.slice('threads/thread-'.length) : path.split('/')[1];
    return path.startsWith('threads/') ? {id: 'thread-' + id, messages: [raw(id, 1000 - Number(id.slice(4)))]} : raw(id, 1000 - Number(id.slice(4)));
  };
  try {
    f.auth.api = handler([]); await f.gmail.load(); stamp = f.gmail.updatedAt();
    f.values.set('iih-orbit-gmail-preferences-v1', JSON.stringify(f.gmail.preferences())); saved = [...f.values];
  } finally {f.close();}
  try {
    reopened = fixture(saved); const pages = []; reopened.auth.api = handler(pages);
    assert.equal(reopened.gmail.messages().length, 25); assert.equal(reopened.gmail.updatedAt(), stamp); assert.equal(reopened.gmail.hasMore(), true);
    reopened.gmail.active.set(true); reopened.flush(); t.mock.timers.tick(400); await new Promise(resolve => setImmediate(resolve)); await reopened.gmail.load(); assert.deepEqual(pages, []);
    await reopened.gmail.load(false, true); assert.deepEqual(pages, ['first', 'next']);
    assert.equal(reopened.gmail.messages().length, 50); assert.equal(new Set(reopened.gmail.messages().map(mail => mail.id)).size, 50); assert.equal(reopened.gmail.hasMore(), false);
    const original = reopened.values.get('iih-orbit-gmail-cache-v1'), mails = structuredClone(reopened.gmail.messages()), time = reopened.gmail.updatedAt();
    reopened.auth.api = async () => {throw new Error('network');}; await reopened.gmail.load(true);
    assert.deepEqual(reopened.gmail.messages(), mails); assert.equal(reopened.gmail.updatedAt(), time); assert.equal(reopened.values.get('iih-orbit-gmail-cache-v1'), original);
  } finally {reopened?.close();}
});
test('空郵箱的成功快取重新整理後仍有效，不因沒有郵件反覆下載', async () => {
  const f = fixture(); let saved, reopened;
  try {
    f.auth.api = async path => path === 'labels' ? {labels: [{id: 'INBOX', name: 'INBOX', type: 'system'}]} : {};
    await f.gmail.load(); f.values.set('iih-orbit-gmail-preferences-v1', JSON.stringify(f.gmail.preferences())); saved = [...f.values];
  } finally {f.close();}
  try {
    reopened = fixture(saved); let calls = 0; reopened.auth.api = async () => {calls++; throw new Error('不應下載');}; await reopened.gmail.load();
    assert.equal(calls, 0); assert.equal(reopened.gmail.messages().length, 0); assert.ok(reopened.gmail.updatedAt()); assert.equal(reopened.gmail.hasMore(), false);
  } finally {reopened?.close();}
});
test('不同篩選共用短期郵件與首封索引，手動更新、過期或切換帳號重新取得，不重用另一帳號', async t => {
  t.mock.timers.enable({apis: ['setTimeout', 'Date'], now: Date.now()});
  const f = fixture(), paths = [];
  try {
    f.auth.api = async path => {
      paths.push(path);
      if (path === 'labels') return {labels: [{id: 'INBOX', name: 'INBOX', type: 'system'}]};
      if (path === 'messages') return {messages: [{id: 'mail'}]};
      return path.startsWith('threads/') ? {id: 'thread-mail', messages: [raw('mail')]} : raw('mail');
    };
    await f.gmail.load(); f.gmail.search('subject:meeting'); f.flush(); await f.gmail.load();
    assert.equal(paths.filter(path => path === 'messages').length, 2); assert.equal(paths.filter(path => path === 'messages/mail').length, 1); assert.equal(paths.filter(path => path === 'threads/thread-mail').length, 1);
    await f.gmail.load(true); assert.equal(paths.filter(path => path === 'messages/mail').length, 2); assert.equal(paths.filter(path => path === 'threads/thread-mail').length, 2);
    t.mock.timers.tick(5 * 60000 + 1); await f.gmail.load(); assert.equal(paths.filter(path => path === 'messages/mail').length, 3);
    f.gmail.preferences.set({...f.gmail.preferences(), accountId: 'another', email: 'another@example.test'}); f.auth.account.set({id: 'another', email: 'another@example.test'}); f.flush(); await f.gmail.load();
    assert.equal(paths.filter(path => path === 'messages/mail').length, 4); assert.equal(paths.filter(path => path === 'threads/thread-mail').length, 4);
  } finally {f.close();}
});
test('郵件拖放只接受此分頁的拖曳來源，工作空間更換取消；一次放下只建立一次，可撤銷且不刪已修改任務', async () => {
  const f = fixture();
  try {
    f.gmail.messages.set([preview]); const drag = event(); f.tasks.start(drag, preview); assert.equal(drag.dataTransfer.effectAllowed, 'copy'); assert.equal(f.tasks.over(drag), true);
    await f.tasks.drop(drag, base, {date: '2026-10-10', time: '09:15'}); await f.tasks.drop(drag, base); assert.equal(f.store.tasks().length, 1); assert.equal(f.store.tasks()[0].dueTime, '10:15');
    await f.tasks.undo(); assert.equal(f.store.tasks().length, 0);
    f.tasks.start(drag, preview); await f.tasks.drop(drag, {...base, id: 'second'}); await f.store.saveTask({...f.store.tasks()[0], title: '已修改'}); await f.tasks.undo(); assert.equal(f.store.tasks()[0].title, '已修改'); assert.match(f.tasks.notice(), /已更新/);
    const next = event(); f.tasks.start(next, preview); f.store.switchWorkspace('other'); assert.equal(f.tasks.accepts(next), false); await f.tasks.drop(next, {...base, id: 'wrong', projectId: ''}); assert.equal(f.store.tasks().length, 0);
    const foreign = event(); foreign.dataTransfer.setData(GMAIL_MIME, 'fake-token'); assert.equal(f.tasks.accepts(foreign), false);
  } finally {f.close();}
});
test('已刪除的標籤不擴大成所有郵件；切換帳號不顯示另一帳號的快取，快取損壞可重建', async () => {
  const f = fixture();
  try {
    let labelReads = 0;
    f.auth.api = async (path) => { if (path === 'labels') {labelReads++; return {labels: [{id: 'INBOX', name: 'INBOX', type: 'system'}]};} return path === 'messages' ? {messages: [{id: 'inbox'}]} : path === 'threads/thread-inbox' ? {id: 'thread-inbox', messages: [raw('inbox')]} : raw('inbox'); };
    await f.gmail.load(); const cache = f.values.get('iih-orbit-gmail-cache-v1');
    f.gmail.preferences.set({...f.gmail.preferences(), selected: ['deleted']}); f.flush(); await f.gmail.load(); assert.match(f.gmail.error(), /標籤已不存在/); assert.equal(f.gmail.messages()[0].id, 'inbox'); assert.equal(f.gmail.showingPrevious(), true);
    await f.gmail.load(true); assert.equal(labelReads, 2); assert.equal(f.gmail.busy(), false);
    f.values.set('iih-orbit-gmail-cache-v1', cache); f.gmail.preferences.set({...f.gmail.preferences(), accountId: 'another', email: 'other@example.test', selected: ['INBOX']}); f.auth.account.set({id: 'another', email: 'other@example.test'}); f.flush(); assert.equal(f.gmail.messages().length, 0);
    f.values.set('iih-orbit-gmail-cache-v1', '{bad'); f.gmail.preferences.set({...f.gmail.preferences(), accountId: 'account', email: 'me@example.test'}); f.auth.account.set({id: 'account', email: 'me@example.test'}); f.flush(); await f.gmail.load(); assert.equal(f.gmail.messages()[0].id, 'inbox');
  } finally {f.close();}
});
test('授權到期仍可瀏覽已保存預覽與複製草稿；解除本機連線清理郵件快取', async () => {
  const f = fixture();
  try {
    f.auth.api = async path => path === 'labels' ? {labels: [{id: 'INBOX', name: 'INBOX', type: 'system'}]} : path === 'messages' ? {messages: [{id: 'mail'}]} : path === 'threads/thread-mail' ? {id: 'thread-mail', messages: [raw('mail')]} : raw('mail');
    f.gmail.applyLabels(['INBOX']); await f.gmail.load(); const updatedAt = f.gmail.updatedAt(); f.auth.disconnect(); f.flush();
    assert.equal(f.gmail.messages()[0].senderEmail, 'sender@example.test'); assert.equal(f.gmail.updatedAt(), updatedAt); assert.equal(f.auth.connected(), false);
    const draft = f.tasks.draft(f.gmail.messages()[0], base); assert.equal(draft.title, '會議邀請');
    f.gmail.disconnect(); f.flush(); assert.equal(f.gmail.messages().length, 0); assert.equal(f.values.has('iih-orbit-gmail-cache-v1'), false);
  } finally {f.close();}
});
test('右側欄切換不改動工作區視圖，郵件建立按鈕填入獨立草稿，關閉後可繼續瀏覽', () => {
  const f = fixture(); f.gmail.messages.set([preview]);
  const child = createEnvironmentInjector([{provide: UiPreferences, useValue: {textSize: () => 'standard'}}], f.child);
  try {
    const app = runInInjectionContext(child, () => new App()); app.view.set('week'); app.openMail(); assert.equal(app.mailOpen(), true); assert.equal(app.remindersOpen(), false);
    app.narrowPanelViewport.set(true); assert.equal(app.compactNavigation(), true); app.sidebarOpen.set(true); app.escape(); assert.equal(app.sidebarOpen(), false); assert.equal(app.mailOpen(), true); app.narrowPanelViewport.set(false);
    app.openReminders('tomorrow'); assert.equal(app.mailOpen(), false); assert.equal(app.remindersOpen(), true); assert.equal(app.view(), 'week');
    app.openMail(); app.openMailTask(preview); assert.equal(app.modal(), 'task'); assert.equal(app.draft.title, preview.subject); assert.equal(app.draft.projectId, 'project'); assert.equal(app.editing(), false); assert.equal(app.draft.startDate, '');
    app.closeModal(); assert.equal(app.mailOpen(), true); app.escape(); assert.equal(app.panelOpen(), false);
  } finally {child.destroy(); f.close();}
});
test('月／週拖放郵件沿用座標與十五分鐘對齊，建立副本而不移動既有任務', () => {
  const f = fixture(), google = {store: f.store, events: signal([]), visibleSources: signal([]), setMonthRange() {}};
  const child = createEnvironmentInjector([{provide: GoogleCalendarService, useValue: google}, {provide: UiPreferences, useValue: {scale: () => 1}}], f.child);
  globalThis.ngServerMode = true; let calendar;
  try {
    calendar = runInInjectionContext(child, () => new Calendar()); calendar.mailDragging = signal(true); calendar.mode = signal('week'); calendar.tasks = signal([]); calendar.categories = signal([]);
    const drag = event(); drag.clientX = 0; drag.clientY = calendar.hourHeight() / 2; drag.currentTarget = {getBoundingClientRect: () => ({top: 0})}; drag.dataTransfer.setData(GMAIL_MIME, 'token');
    let dropped; calendar.mailDrop.subscribe(value => {dropped = value;}); calendar.timeDragOver(drag, '2026-10-10'); assert.equal(calendar.dropPosition().minute, 30); assert.equal(drag.dataTransfer.dropEffect, 'copy');
    calendar.timeDrop(drag, '2026-10-10'); assert.equal(dropped.position.kind, 'time'); assert.equal(dropped.position.minute, 30); assert.equal(calendar.savingMove(), false);
    calendar.drop(drag, {kind: 'month', day: '2026-10-11'}); assert.equal(dropped.position.kind, 'month');
    calendar.drop(drag, {kind: 'all-day', day: '2026-10-12'}); assert.equal(dropped.position.kind, 'all-day');
  } finally {calendar?.endDrag(); delete globalThis.ngServerMode; child.destroy(); f.close();}
});
test('Gmail 授權獨立保存、只要求讀取郵件；403 保留連線，401 清除憑證', async () => {
  const {storage} = browserStorage(), sessions = new Map(); let options;
  const oauth = {initTokenClient(value) {options = value; return {requestAccessToken() {}};}, hasGrantedAllScopes: () => true};
  const injector = createEnvironmentInjector([{provide: DOCUMENT, useValue: {defaultView: {google: {accounts: {oauth2: oauth}}, localStorage: storage, sessionStorage: {getItem: key => sessions.get(key) ?? null, setItem: (key, value) => sessions.set(key, value), removeItem: key => sessions.delete(key)}}}}]);
  const auth = runInInjectionContext(injector, () => new GmailAuth()), previous = globalThis.fetch;
  auth.useSession({generation: 'generation', clientId: '123-example.apps.googleusercontent.com', accountId: 'account'});
  try {
    globalThis.fetch = async () => Response.json({sub: 'account', email: 'me@example.test'}); await auth.prepare(); const connecting = auth.authorize('123-example.apps.googleusercontent.com');
    assert.ok(options.scope.includes(GMAIL_SCOPE)); assert.equal(options.scope.includes('calendar'), false); assert.equal(options.scope.includes('gmail.modify'), false);
    await options.callback({access_token: 'synthetic', expires_in: 3600}); await connecting; assert.ok(storage.getItem('iih-orbit-gmail-session-v1')); assert.equal(sessions.has('iih-orbit-gmail-session-v1'), false); assert.equal(sessions.has('iih-orbit-google-session-v1'), false);
    const persisted = JSON.parse(storage.getItem('iih-orbit-gmail-session-v1'));
    const reopened = runInInjectionContext(injector, () => new GmailAuth());
    reopened.useSession({generation: 'generation', clientId: '123-example.apps.googleusercontent.com', accountId: 'account'});
    assert.equal(reopened.connected(), true); assert.equal(JSON.parse(storage.getItem('iih-orbit-gmail-session-v1')).expiresAt, persisted.expiresAt); reopened.ngOnDestroy();
    globalThis.fetch = async () => new Response(null, {status: 403}); await assert.rejects(auth.api('labels'), /API/); assert.equal(auth.connected(), true);
    const controller = new AbortController(); let requestSignal, releaseOther;
    globalThis.fetch = async (_url, config) => {
      if (_url.includes('/labels?')) {requestSignal = config.signal; return new Promise((_resolve, reject) => config.signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), {once: true}));}
      return new Promise(resolve => {releaseOther = resolve;});
    };
    const cancelled = assert.rejects(auth.api('labels', {}, controller.signal), error => error.name === 'AbortError'), other = auth.api('messages/mail');
    controller.abort(); await cancelled; assert.equal(requestSignal.aborted, true); assert.equal(auth.connected(), true);
    releaseOther(Response.json(raw('mail'))); assert.equal((await other).id, 'mail');
    globalThis.fetch = async () => new Response(null, {status: 401}); await assert.rejects(auth.api('messages'), /到期/); assert.equal(auth.connected(), false); assert.equal(storage.getItem('iih-orbit-gmail-session-v1'), null);
    assert.throws(() => auth.api('messages/../../outside'), /不正確/);
  } finally {globalThis.fetch = previous; auth.ngOnDestroy(); injector.destroy();}
});

const encodedBody = text => Buffer.from(text).toString('base64url');
test('點開郵件才取得巢狀 MIME 內文，優先 HTML，純文字支援字元集；附件不混入本文', async () => {
  const calls = [], source = {id: 'mail', payload: {mimeType: 'multipart/mixed', headers: [{name: 'To', value: '=?UTF-8?B?546L5bCP5piO?= <me@example.test>'}], parts: [
    {mimeType: 'multipart/alternative', parts: [{mimeType: 'text/plain', body: {data: encodedBody('純文字版本')}}, {mimeType: 'text/html', body: {attachmentId: 'inline-body', size: 45}}]},
    {mimeType: 'text/plain', filename: 'private.txt', body: {attachmentId: 'file-body', size: 10}},
    {mimeType: 'message/rfc822', parts: [{mimeType: 'text/html', body: {data: encodedBody('<p>附件裡的信</p>')}}]}
  ]}};
  const request = async (path, parameters) => {calls.push({path, parameters}); return path === 'messages/mail' ? source : {data: encodedBody('<h2>活動時間</h2><p>10/15 14:00</p>')};};
  const body = await fetchMailContent(request, 'mail', () => true);
  assert.match(body.html, /10\/15 14:00/); assert.equal(body.plain, ''); assert.match(body.to, /王小明/); assert.equal(body.attachments[0].name, 'private.txt'); assert.equal(body.html.includes('附件裡的信'), false);
  assert.deepEqual(calls.map(call => call.path), ['messages/mail', 'messages/mail/attachments/inline-body']); assert.equal(calls[0].parameters.fields, 'id,payload');
  const plain = await readMailContent({payload: {mimeType: 'text/plain', headers: [{name: 'Content-Type', value: 'text/plain; charset=windows-1252'}], body: {data: Buffer.from([0x63, 0x61, 0x66, 0xe9]).toString('base64url')}}}, async () => {throw new Error('不需額外讀取');});
  assert.equal(plain.plain, 'café'); assert.equal(plain.html, '');
});
test('郵件內文過大、編碼損壞或附件限定時保留可用內容與明確提示；帳號變更不繼續讀取本文附件', async () => {
  const body = await readMailContent({payload: {mimeType: 'multipart/mixed', parts: [
    {mimeType: 'text/html', body: {size: 1024 * 1024, attachmentId: 'oversize'}}, {mimeType: 'text/html', body: {data: 'invalid!!'}},
    {mimeType: 'text/plain', body: {data: encodedBody('請看這份活動資訊')}}, {mimeType: 'application/pdf', filename: '活動.pdf', body: {attachmentId: 'pdf', size: 100}}
  ]}}, async () => {throw new Error('不應下載過大本文或檔案');});
  assert.equal(body.plain, '請看這份活動資訊'); assert.match(body.warning, /部分內文/); assert.equal(body.attachments[0].name, '活動.pdf');
  await assert.rejects(fetchMailContent(async () => ({id: 'other', payload: {}}), 'mail', () => true), /不符/);
  let current = true, requests = 0;
  const request = async () => {requests++; current = false; return {id: 'mail', payload: {mimeType: 'text/html', body: {attachmentId: 'inline-body'}}};};
  await assert.rejects(fetchMailContent(request, 'mail', () => current), /帳號已變更/); assert.equal(requests, 1);
});
test('完整內文只短暫保留在記憶體，不進 localStorage 或備份；切換帳號與未完成的舊讀取均隔離', async () => {
  const f = fixture(); let calls = 0, release;
  try {
    f.gmail.messages.set([preview]); const identity = f.gmail.previewIdentity();
    f.auth.api = async () => {calls++; return {id: 'mail', payload: {mimeType: 'text/html', body: {data: encodedBody('<p>PRIVATE-FULL-CONTENT</p>')}}};};
    assert.match((await f.reader.read(preview, identity)).html, /PRIVATE-FULL/); await f.reader.read(preview, identity); assert.equal(calls, 1);
    f.gmail.preferences.set({...f.gmail.preferences(), selected: []}); f.flush(); await f.reader.read(preview, identity); assert.equal(calls, 1);
    assert.equal([...f.values.values()].join('').includes('PRIVATE-FULL-CONTENT'), false); assert.equal(JSON.stringify(await f.store.backupForExport('full')).includes('PRIVATE-FULL-CONTENT'), false);
    f.gmail.preferences.set({...f.gmail.preferences(), accountId: 'another', email: 'other@example.test'}); f.auth.account.set({id: 'another', email: 'other@example.test'});
    // Check before Angular effects run, too: the same message ID cannot reuse another account's body.
    const second = await f.reader.read(preview, f.gmail.previewIdentity()); assert.match(second.html, /PRIVATE-FULL/); assert.equal(calls, 2);
    f.flush();
    f.auth.api = async () => new Promise(resolve => {release = resolve;});
    const pending = f.reader.read(preview, f.gmail.previewIdentity()); await new Promise(resolve => setImmediate(resolve));
    f.gmail.disconnect(); f.flush(); release({id: 'mail', payload: {mimeType: 'text/html', body: {data: encodedBody('OLD-BODY')}}});
    await assert.rejects(pending, /帳號已變更/); await assert.rejects(f.reader.read(preview, identity), /帳號已變更/);
  } finally {f.close();}
});
test('描述專注模式 Escape 先返回完整任務，保留草稿；預覽視窗可建立任務但拒絕舊帳號來源', () => {
  const f = fixture(); f.gmail.messages.set([preview]);
  const child = createEnvironmentInjector([{provide: UiPreferences, useValue: {textSize: () => 'standard'}}], f.child);
  try {
    const app = runInInjectionContext(child, () => new App()); app.openTask(); app.draft.description = '**草稿**\n[連結](https://example.test)'; app.descriptionFocused.set(true);
    app.escape(); assert.equal(app.modal(), 'task'); assert.equal(app.descriptionFocused(), false); assert.match(app.draft.description, /草稿/); app.escape(); assert.equal(app.modal(), null);
    app.openMailPreview(preview); assert.equal(app.modal(), 'mail-preview'); f.gmail.messages.set([]); app.createPreviewTask(preview); assert.equal(app.modal(), 'task'); assert.match(app.draft.description, /在 Gmail 開啟原信/);
    f.gmail.messages.set([preview]);
    app.closeModal(); app.openMailPreview(preview); f.gmail.preferences.set({...f.gmail.preferences(), accountId: 'other'}); app.createPreviewTask(preview); assert.equal(app.modal(), 'mail-preview');
    app.closeModal(); assert.equal(app.mailPreview(), null);
    app.openTask(); app.draft.startDate = app.draft.dueDate = '2026-10-10'; app.draft.startTime = '23:30'; app.timeToggled('due', true);
    assert.equal(app.draft.dueDate, '2026-10-11'); assert.equal(app.draft.dueTime, '00:30');
    app.draft.startTime = ''; app.draft.startDate = app.draft.dueDate; app.draft.dueTime = '00:20'; app.timeToggled('start', true);
    assert.equal(app.draft.startDate, '2026-10-10'); assert.equal(app.draft.startTime, '23:20'); app.closeModal();
  } finally {child.destroy(); f.close();}
});
test('郵件視窗關閉後不顯示遲到的本文，授權切換清除已讀取內容', async () => {
  const f = fixture(); let release;
  try {
    const viewer = runInInjectionContext(f.child, () => new MailPreviewDialog());
    viewer.mail = signal(preview); viewer.identity = signal(f.gmail.previewIdentity()); viewer.email = signal('me@example.test');
    f.auth.api = async path => path.startsWith('threads/') ? {id: preview.threadId, messages: [raw('mail')]} : new Promise(resolve => {release = resolve;}); f.flush();
    await new Promise(resolve => setImmediate(resolve)); viewer.ngOnDestroy(); release({id: 'mail', payload: {mimeType: 'text/plain', body: {data: encodedBody('LATE-BODY')}}});
    await new Promise(resolve => setImmediate(resolve)); assert.equal(viewer.content(), null);
    const active = runInInjectionContext(f.child, () => new MailPreviewDialog()); active.mail = signal(preview); active.identity = signal(f.gmail.previewIdentity()); active.email = signal('me@example.test'); f.flush();
    await new Promise(resolve => setImmediate(resolve)); assert.equal(active.content()?.plain, 'LATE-BODY');
    f.gmail.disconnect(); f.flush(); assert.equal(active.expired(), true); assert.equal(active.content(), null); active.ngOnDestroy();
  } finally {f.close();}
});

test('自訂標籤按名稱優先呈現，系統標籤依收件匣、未讀、重要與分類排序', () => {
  const labels = readMailLabels({labels: [{id: 'CATEGORY_PROMOTIONS', name: 'CATEGORY_PROMOTIONS', type: 'system'}, {id: 'Work10', name: '工作10', type: 'user'}, {id: 'TRASH', name: 'TRASH', type: 'system'}, {id: 'Work2', name: '工作2', type: 'user'}, {id: 'UNREAD', name: 'UNREAD', type: 'system'}, {id: 'INBOX', name: 'INBOX', type: 'system'}]});
  assert.deepEqual(labels.map(label => label.id), ['Work2', 'Work10', 'INBOX', 'UNREAD', 'CATEGORY_PROMOTIONS', 'TRASH']);
});
test('Gmail 搜尋語法隨所有標籤游標及後續分頁送往 API，沒有搜尋快取時標示保留上次郵件', async () => {
  const requests = [];
  const api = new GmailApi(async (path, params) => {requests.push({path, params}); return path === 'messages' ? {messages: [{id: 'search-result'}]} : raw('search-result');});
  await api.page(newMailCursor(['INBOX', 'Work'], 'from:sender@example.test is:unread'));
  assert.ok(requests.filter(item => item.path === 'messages').every(item => item.params.q === 'from:sender@example.test is:unread'));
  const f = fixture();
  try {
    f.gmail.messages.set([preview]); f.gmail.updatedAt.set(Date.now()); f.gmail.search('subject:活動'); f.flush();
    assert.equal(f.gmail.messages()[0].id, preview.id); assert.equal(f.gmail.showingPrevious(), true); assert.equal(f.gmail.updatedAt(), 0); assert.equal(f.gmail.hasMore(), false);
    f.gmail.search(' '); f.flush(); assert.equal(f.gmail.query(), '');
    const version = f.auth.connectionVersion(); await f.store.updateGoogle({clientId: f.gmail.clientId()}); f.flush(); assert.equal(f.auth.connectionVersion(), version);
  } finally {f.close();}
});
test('郵件依 threadId 分組並保留每封的已讀狀態；討論串按時間排序，不讀取未選內文或修改信件', async () => {
  const f = fixture(); const first = {...raw('first', 100, ['INBOX']), threadId: 'thread'}, second = {...raw('second', 200, ['INBOX', 'UNREAD']), threadId: 'thread'};
  try {
    f.gmail.messages.set([readMailPreview(second), readMailPreview(first)]);
    assert.equal(f.gmail.threads().length, 1); assert.equal(f.gmail.threads()[0].unread, true); assert.equal(f.gmail.threads()[0].mail.id, 'first'); assert.deepEqual(f.gmail.threads()[0].messages.map(mail => mail.id), ['first', 'second']);
    const calls = []; f.auth.api = async (path, params) => {calls.push({path, params}); return {id: 'thread', messages: [second, first]};};
    const messages = await f.reader.thread(readMailPreview(second), f.gmail.previewIdentity());
    assert.deepEqual(messages.map(mail => mail.id), ['first', 'second']); assert.equal(messages[0].labelIds.includes('UNREAD'), false); assert.equal(messages[1].labelIds.includes('UNREAD'), true);
    assert.equal(calls[0].path, 'threads/thread'); assert.equal(calls[0].params.fields.includes('body'), false); assert.equal(calls.length, 1);
    let release; f.auth.api = async () => new Promise(resolve => {release = resolve;});
    const pending = f.reader.thread(readMailPreview(first), f.gmail.previewIdentity(), true); f.gmail.disconnect(); release({id: 'thread', messages: [first]});
    await assert.rejects(pending, /帳號已變更/);
  } finally {f.close();}
});
test('時間選擇以十分鐘為主，保留既有十五分鐘值；起訖預設相隔一小時並正確跨日', () => {
  assert.deepEqual(adjacentHour('2026-10-10', '23:30', 1), {date: '2026-10-11', time: '00:30'});
  assert.deepEqual(adjacentHour('2026-10-10', '00:20', -1), {date: '2026-10-09', time: '23:20'});
  assert.equal(adjacentHour('2026-02-30', '09:00', 1), null);
  const injector = createEnvironmentInjector([]);
  try {
    const picker = runInInjectionContext(injector, () => new ScheduleTime()); picker.value = signal('09:15');
    assert.deepEqual(picker.minutes(), ['00', '10', '15', '20', '30', '40', '50']); picker.value.set('09:00'); assert.deepEqual(picker.minutes(), ['00', '10', '20', '30', '40', '50']);
    picker.value.set(''); let chosen = ''; picker.valueChange.subscribe(value => {chosen = value;}); picker.opened.set(true); picker.finish(); assert.equal(chosen, '09:00'); assert.equal(picker.opened(), false);
    let calls = 0; const trigger = new DatePickerTrigger(); trigger.open({currentTarget: {showPicker() {calls++;}}}); assert.equal(calls, 1);
    trigger.open({currentTarget: {disabled: true, showPicker() {calls++;}}}); assert.equal(calls, 1);
  } finally {injector.destroy();}
});

test('篩選只命中回覆時仍以真正首封呈現討論串，分頁不更換首封且僅讀取標頭；離線可複製首封', async () => {
  const f = fixture(), calls = [];
  const first = {...raw('original', 10, ['SENT']), threadId: 'conversation'}, reply = {...raw('reply', 100, ['INBOX', 'UNREAD']), threadId: 'conversation'};
  first.payload.headers[1].value = '原始活動邀請'; reply.payload.headers[1].value = 'Re: 回覆變更';
  const older = Array.from({length: 24}, (_, i) => ({...raw('reply-' + i, 90 - i), threadId: 'conversation'}));
  const secondThread = raw('other', 5);
  try {
    f.auth.api = async (path, params) => {
      calls.push({path, params});
      if (path === 'labels') return {labels: [{id: 'INBOX', name: 'INBOX', type: 'system'}]};
      if (path === 'messages') return params.pageToken ? {messages: [{id: 'original'}, {id: 'other'}]} : {messages: [reply, ...older].map(mail => ({id: mail.id})), nextPageToken: 'next'};
      if (path === 'threads/conversation') return {id: 'conversation', messages: [reply, ...older, first]};
      if (path === 'threads/thread-other') return {id: 'thread-other', messages: [secondThread]};
      return [first, reply, ...older, secondThread].find(mail => path === 'messages/' + mail.id);
    };
    await f.gmail.load();
    assert.equal(f.gmail.messages().some(mail => mail.id === 'original'), false);
    assert.equal(f.gmail.threads().length, 1); assert.equal(f.gmail.threads()[0].mail.subject, '原始活動邀請'); assert.equal(f.gmail.threads()[0].count, 26); assert.equal(f.gmail.threads()[0].unread, true);
    const lead = f.gmail.threads()[0].mail;
    assert.equal(f.tasks.draft(lead, base).title, '原始活動邀請'); assert.throws(() => f.tasks.draft({...lead, snippet: '偽造快照'}, base), /列表已更新/);
    const drag = event(); f.tasks.start(drag, lead); assert.equal(f.tasks.accepts(drag), true); await f.tasks.drop(drag, base); assert.equal(f.store.tasks()[0].title, lead.subject);
    await f.gmail.load(false, true);
    assert.deepEqual(f.gmail.threads().map(thread => thread.mail.id), ['original', 'other']);
    assert.equal(calls.filter(call => call.path === 'threads/conversation').length, 1);
    assert.ok(calls.filter(call => call.path.startsWith('threads/')).every(call => !call.params.fields.includes('body') && !call.params.fields.includes('parts')));
    const cache = JSON.parse(f.values.get('iih-orbit-gmail-cache-v1'));
    assert.equal(cache.entries[0].summaries[0].mail.id, 'original'); assert.equal(JSON.stringify(cache).includes('DO-NOT-COPY'), false);
    f.auth.disconnect(); f.flush(); assert.equal(f.gmail.threads()[0].mail.id, 'original'); assert.equal(f.tasks.draft(f.gmail.threads()[0].mail, base).title, '原始活動邀請');
    const child = createEnvironmentInjector([{provide: UiPreferences, useValue: {textSize: () => 'standard'}}], f.child);
    try {const app = runInInjectionContext(child, () => new App()); app.openMailPreview(f.gmail.threads()[0].mail); assert.equal(app.modal(), 'mail-preview'); app.closeModal();} finally {child.destroy();}
    f.gmail.disconnect(); f.flush(); assert.equal(f.gmail.threads().length, 0);
  } finally {f.close();}
});
test('討論串讀取失敗保留原列表及游標，已刪討論串略過；帳號切換不發布遲到的首封', async () => {
  const f = fixture(); let fail = false, release;
  try {
    f.auth.api = async path => {
      if (path === 'labels') return {labels: [{id: 'INBOX', name: 'INBOX', type: 'system'}]};
      if (path === 'messages') return {messages: [{id: 'mail'}]};
      if (path === 'messages/mail') return raw('mail');
      if (fail) throw new Error('thread network failure');
      return {id: 'thread-mail', messages: [raw('mail')]};
    };
    await f.gmail.load(); const previous = structuredClone(f.gmail.threads()); fail = true;
    await f.gmail.load(true); assert.deepEqual(f.gmail.threads(), previous); assert.match(f.gmail.error(), /network failure/);
    f.auth.api = async path => {
      if (path === 'labels') return {labels: [{id: 'INBOX', name: 'INBOX', type: 'system'}]};
      if (path === 'messages') return {messages: [{id: 'mail'}]};
      if (path === 'messages/mail') return raw('mail');
      return new Promise(resolve => {release = resolve;});
    };
    const pending = f.gmail.load(true); await new Promise(resolve => setImmediate(resolve));
    f.gmail.preferences.set({...f.gmail.preferences(), accountId: 'other', email: 'other@example.test'}); f.auth.account.set({id: 'other', email: 'other@example.test'}); f.flush();
    release({id: 'thread-mail', messages: [raw('mail')]}); await pending; assert.equal(f.gmail.threads().length, 0);
    f.auth.api = async path => {
      if (path === 'labels') return {labels: [{id: 'INBOX', name: 'INBOX', type: 'system'}]};
      if (path === 'messages') return {messages: [{id: 'mail'}]};
      if (path === 'messages/mail') return raw('mail');
      throw Object.assign(new Error('removed'), {status: 404});
    };
    await f.gmail.load(); assert.equal(f.gmail.error(), ''); assert.equal(f.gmail.threads().length, 0);
  } finally {f.close();}
});
test('討論串切換依首封與回覆排序，收合再開不重讀；遲到內文與舊討論串錯誤不覆蓋選取', async () => {
  const f = fixture(), first = {...raw('first', 10), threadId: 'thread'}, reply = {...raw('reply', 20, ['UNREAD']), threadId: 'thread'};
  let viewer, releaseBody, rejectThread, threadReads = 0;
  try {
    f.auth.api = async path => {
      if (path === 'threads/thread') {threadReads++; return {id: 'thread', messages: [reply, first]};}
      if (path === 'messages/first') return new Promise(resolve => {releaseBody = resolve;});
      return {id: 'reply', payload: {mimeType: 'text/plain', body: {data: encodedBody('回覆內文')}}};
    };
    viewer = runInInjectionContext(f.child, () => new MailPreviewDialog()); viewer.mail = signal(readMailPreview(first)); viewer.identity = signal(f.gmail.previewIdentity()); viewer.email = signal('me@example.test'); f.flush();
    await new Promise(resolve => setImmediate(resolve)); assert.equal(viewer.threadOpen(), true); assert.deepEqual(viewer.messages().map(mail => mail.id), ['first', 'reply']); assert.equal(viewer.shown().id, 'first');
    viewer.selectMessage(viewer.messages()[1]); await new Promise(resolve => setImmediate(resolve)); assert.equal(viewer.content().plain, '回覆內文');
    releaseBody({id: 'first', payload: {mimeType: 'text/plain', body: {data: encodedBody('遲到的首封')}}}); await new Promise(resolve => setImmediate(resolve)); assert.equal(viewer.content().plain, '回覆內文');
    viewer.toggleThread(); assert.equal(viewer.threadOpen(), false); viewer.toggleThread(); assert.equal(viewer.threadOpen(), true); assert.equal(threadReads, 1);
    let copied; viewer.createTask.subscribe(mail => {copied = mail;}); viewer.createTask.emit(viewer.shown()); assert.equal(copied.id, 'reply');
    f.auth.api = async path => path === 'threads/thread' ? new Promise((_resolve, reject) => {rejectThread = reject;}) : path === 'threads/thread-other' ? {id: 'thread-other', messages: [raw('other')]} : {id: 'other', payload: {mimeType: 'text/plain', body: {data: encodedBody('新的討論串')}}};
    const old = viewer.openThread(true); viewer.mail.set(readMailPreview(raw('other'))); f.flush(); rejectThread(new Error('舊討論串錯誤')); await old;
    await new Promise(resolve => setImmediate(resolve)); assert.equal(viewer.threadError(), ''); assert.equal(viewer.threadBusy(), false); assert.equal(viewer.threadOpen(), true); assert.equal(viewer.shown().id, 'other');
  } finally {viewer?.ngOnDestroy(); f.close();}
});

test('清單只讀討論串索引與首封預覽，不預先下載其他信件的標頭與 snippet', async () => {
  const first = {...raw('first', 10, ['SENT']), threadId: 'thread'}, reply = {...raw('reply', 20, ['UNREAD']), threadId: 'thread'}, calls = [];
  const api = new GmailApi(async (path, params) => {
    calls.push({path, params});
    if (path === 'threads/thread') return {id: 'thread', messages: [reply, first].map(({id, threadId, labelIds, internalDate}) => ({id, threadId, labelIds, internalDate}))};
    if (path === 'messages/first') return first;
    throw new Error('不應讀取回覆預覽');
  });
  const summary = await api.summary('thread', [readMailPreview(reply)]);
  assert.equal(summary.mail.id, 'first'); assert.equal(summary.count, 2); assert.equal(summary.unread, true);
  assert.equal(calls[0].params.fields.includes('snippet'), false); assert.equal(calls[0].params.fields.includes('payload'), false);
  assert.deepEqual(calls.map(call => call.path), ['threads/thread', 'messages/first']);
  calls.length = 0; await api.summary('thread', [readMailPreview(first)]); assert.deepEqual(calls.map(call => call.path), []);
  await api.summary('thread', [readMailPreview(first)], undefined, true); assert.deepEqual(calls.map(call => call.path), ['threads/thread']);
  await assert.rejects(new GmailApi(async () => ({id: 'thread', messages: [{threadId: 'thread', internalDate: '10', labelIds: []}]})).summary('thread', []), /來源不一致/);
});
test('封數按鈕按需展開回覆，每封可拖曳及複製；收合、預覽共用快取，切換篩選清除展開來源', async () => {
  const f = fixture(); let panel, fullReads = 0;
  const first = {...raw('first', 10, ['SENT']), threadId: 'thread'}, replies = [20, 30, 40].map((date, i) => ({...raw('reply-' + i, date), threadId: 'thread'}));
  replies[0].payload.headers[1].value = '第一封回覆的內容';
  try {
    f.auth.api = async (path, params) => {
      if (path === 'labels') return {labels: [{id: 'INBOX', name: 'INBOX', type: 'system'}]};
      if (path === 'messages') return {messages: [{id: replies[2].id}]};
      if (path === 'threads/thread') {
        if (params.fields.includes('snippet')) {fullReads++; return {id: 'thread', messages: [...replies].reverse().concat(first)};}
        return {id: 'thread', messages: [first, ...replies].map(({id, threadId, labelIds, internalDate}) => ({id, threadId, labelIds, internalDate}))};
      }
      return [first, ...replies].find(mail => path === 'messages/' + mail.id);
    };
    await f.gmail.load(); assert.equal(fullReads, 0); assert.equal(f.gmail.messages().length, 1);
    panel = runInInjectionContext(f.child, () => new GmailPanel()); panel.active = signal(false); f.flush();
    const lead = f.gmail.threads()[0].mail, reply = readMailPreview(replies[0]);
    assert.equal(panel.expanded().size, 0); assert.equal(f.gmail.isListed(reply), false);
    await panel.toggleThread(lead); f.flush(); assert.equal(panel.expanded().has('thread'), true); assert.deepEqual(panel.replies(lead).map(mail => mail.id), ['reply-0', 'reply-1', 'reply-2']);
    assert.equal(fullReads, 1); assert.equal(f.tasks.draft(reply, base).title, '第一封回覆的內容');
    const drag = event(); f.tasks.start(drag, reply); await f.tasks.drop(drag, base, {date: '2026-10-10', time: '10:00'});
    assert.equal(f.store.tasks()[0].title, '第一封回覆的內容'); assert.equal(f.store.tasks()[0].startTime, '10:00');
    const child = createEnvironmentInjector([{provide: UiPreferences, useValue: {textSize: () => 'standard'}}], f.child);
    try {const app = runInInjectionContext(child, () => new App()); app.openMailPreview(reply); assert.equal(app.mailPreview().mail.id, reply.id); app.closeModal();} finally {child.destroy();}
    await f.reader.thread(lead, f.gmail.previewIdentity()); assert.equal(fullReads, 1);
    await panel.toggleThread(lead); assert.equal(f.gmail.isListed(reply), false);
    await panel.toggleThread(lead); assert.equal(fullReads, 1); assert.equal(f.gmail.isListed(reply), true);
    await panel.refresh(); f.flush(); assert.equal(fullReads, 2); assert.equal(panel.expanded().has('thread'), true); assert.equal(panel.replies(lead).length, 3);
    f.gmail.search('subject:其他'); f.flush(); assert.equal(panel.expanded().size, 0); assert.equal(f.gmail.expandedMessages().length, 0); assert.equal(f.gmail.isListed(reply), false);
  } finally {panel?.ngOnDestroy(); f.close();}
});
test('討論串快取合併同時讀取，五分鐘到期及手動更新重新下載，帳號切換立即隔離', async () => {
  const f = fixture(), previousNow = Date.now; let now = previousNow(), reads = 0;
  try {
    Date.now = () => now;
    f.auth.api = async () => {reads++; return {id: 'thread-mail', messages: [raw('mail')]};};
    const identity = f.gmail.previewIdentity();
    const [one, two] = await Promise.all([f.gmail.readThread(preview, identity), f.reader.thread(preview, identity)]);
    assert.equal(reads, 1); one[0].subject = '修改副本'; assert.equal(two[0].subject, '會議邀請'); assert.equal((await f.gmail.readThread(preview, identity))[0].subject, '會議邀請');
    await f.reader.thread(preview, identity, true); assert.equal(reads, 2);
    now += 5 * 60000 + 1; await f.gmail.readThread(preview, identity); assert.equal(reads, 3);
    f.gmail.preferences.set({...f.gmail.preferences(), accountId: 'another', email: 'other@example.test'}); f.auth.account.set({id: 'another', email: 'other@example.test'});
    f.auth.api = async () => {reads++; const mail = raw('mail'); mail.payload.headers[1].value = '另一帳號的郵件'; return {id: 'thread-mail', messages: [mail]};};
    assert.equal((await f.gmail.readThread(preview, f.gmail.previewIdentity()))[0].subject, '另一帳號的郵件'); assert.equal(reads, 4);
    await assert.rejects(f.gmail.readThread(preview, identity), /帳號已變更/);
    assert.equal([...f.values.values()].join('').includes('另一帳號的郵件'), false);
  } finally {Date.now = previousNow; f.close();}
});
test('郵件預覽直接開啟討論串並重用快取；Gmail 連線入口集中到 Google 設定分頁', async () => {
  const f = fixture(), first = raw('mail'), reply = {...raw('reply', 2000), threadId: first.threadId}; let viewer, reopened, panel, reads = 0, bodyReads = 0;
  const child = createEnvironmentInjector([{provide: UiPreferences, useValue: {textSize: () => 'standard'}}, {provide: DOCUMENT, useValue: {defaultView: {location: {origin: 'https://chiyang.github.io'}}}}], f.child);
  try {
    f.auth.api = async path => {if (path.startsWith('threads/')) {reads++; return {id: first.threadId, messages: [reply, first]};} bodyReads++; return {id: 'mail', payload: {mimeType: 'text/plain', body: {data: encodedBody('首封內文')}}};};
    viewer = runInInjectionContext(f.child, () => new MailPreviewDialog()); viewer.mail = signal(preview); viewer.identity = signal(f.gmail.previewIdentity()); viewer.email = signal('me@example.test'); f.flush();
    await new Promise(resolve => setImmediate(resolve)); assert.equal(viewer.threadOpen(), true); assert.equal(viewer.messages().length, 2); viewer.ngOnDestroy();
    reopened = runInInjectionContext(f.child, () => new MailPreviewDialog()); reopened.mail = signal(preview); reopened.identity = signal(f.gmail.previewIdentity()); reopened.email = signal('me@example.test'); f.flush();
    await new Promise(resolve => setImmediate(resolve)); assert.equal(reopened.threadOpen(), true); assert.equal(reads, 1); assert.equal(bodyReads, 1);
    const app = runInInjectionContext(child, () => new App()); panel = runInInjectionContext(f.child, () => new GmailPanel()); panel.active = signal(false);
    panel.configure.subscribe(() => app.openSettings('google')); panel.configure.emit(); assert.equal(app.settingsTab(), 'google'); assert.equal(app.modal(), 'settings');
    const settings = runInInjectionContext(child, () => new Settings()); assert.ok(settings.tabs.some(tab => tab.id === 'gmail')); settings.activeTab.set('gmail');
    settings.tabKeydown({key: 'ArrowRight', preventDefault() {}, currentTarget: {closest: () => null}}); assert.equal(settings.activeTab(), 'drive');
    const gmailSettings = runInInjectionContext(child, () => new GmailSettings()); let configured = false;
    gmailSettings.configure.subscribe(() => {configured = true;}); gmailSettings.configure.emit(); assert.equal(configured, true);
  } finally {viewer?.ngOnDestroy(); reopened?.ngOnDestroy(); panel?.ngOnDestroy(); child.destroy(); f.close();}
});

test('Gmail 沿用共用 Client ID，變更 ID 清除舊帳號授權與快取；相同 ID 保留連線', async () => {
  const f = fixture();
  try {
    const original = f.gmail.clientId(); f.gmail.messages.set([preview]);
    await f.store.updateGoogle({clientId: original}); f.flush();
    assert.equal(f.gmail.preferences().accountId, 'account'); assert.equal(f.auth.connected(), true);
    await f.store.updateGoogle({clientId: '456-other.apps.googleusercontent.com'}); f.flush();
    assert.equal(f.gmail.clientId(), '456-other.apps.googleusercontent.com'); assert.equal(f.gmail.preferences().clientId, f.gmail.clientId());
    assert.equal(f.auth.connected(), false); assert.equal(f.gmail.preferences().accountId, ''); assert.equal(f.gmail.messages().length, 0);
    assert.equal(f.auth.context.clientId, f.gmail.clientId());
  } finally {f.close();}
});

test('Google 連線頁集中保存 ID 與各服務入口，待上傳的 Drive 資料阻止更換設定', async () => {
  const f = fixture(), original = f.gmail.clientId();
  const makeAuth = () => ({ready: signal(false), authorizing: signal(false), connected: signal(false), async prepare() {this.ready.set(true);}, disconnect() {this.connected.set(false);}});
  const calendarAuth = makeAuth(), driveAuth = makeAuth(); f.auth.prepare = async () => f.auth.ready.set(true);
  const pending = signal({}), write = {authorizing: signal(false), useSession() {}, disconnect() {}};
  const child = createEnvironmentInjector([
    {provide: GoogleCalendarService, useValue: {auth: calendarAuth}}, {provide: CalendarWriteAuth, useValue: write},
    {provide: GoogleCombinedAuth, useValue: makeAuth()},
    {provide: DriveService, useValue: {auth: driveAuth, busy: signal(false), runtime: pending}},
    {provide: DOCUMENT, useValue: {defaultView: {location: {origin: 'https://chiyang.github.io'}}}}
  ], f.child);
  try {
    const settings = runInInjectionContext(child, () => new GoogleConnection());
    assert.equal(settings.draft(), original); await settings.save(); f.flush(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.store.google().clientId, original); assert.equal(f.gmail.preferences().accountId, 'account'); assert.equal(f.auth.connected(), true);
    assert.equal(calendarAuth.ready(), true); assert.equal(driveAuth.ready(), true); assert.equal(f.auth.ready(), true);
    let tab = ''; settings.configure.subscribe(value => {tab = value;}); settings.configure.emit('drive'); assert.equal(tab, 'drive');
    pending.set({pending: {version: 'queued'}}); settings.draft.set('456-new.apps.googleusercontent.com'); await settings.save();
    assert.equal(f.store.google().clientId, original); assert.match(settings.error(), /等待上傳/);
    pending.set({}); await settings.save(); f.flush(); assert.equal(f.gmail.clientId(), '456-new.apps.googleusercontent.com'); assert.equal(f.auth.connected(), false);
    settings.draft.set('not-a-client'); await settings.save(); assert.match(settings.error(), /Client ID/); assert.equal(f.store.google().clientId, '456-new.apps.googleusercontent.com');
  } finally {child.destroy(); f.close();}
});
