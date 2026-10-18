import '@angular/compiler';
import {DOCUMENT} from '@angular/common';
import {createEnvironmentInjector, runInInjectionContext, signal, ɵChangeDetectionScheduler, ɵEffectScheduler} from '@angular/core';
import assert from 'node:assert/strict';
import {test, after} from 'node:test';
import {createRequire} from 'node:module';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {COLUMNS} from '../src/app/models.ts';
import {DEFAULT_SYSTEM_NOTIFICATIONS, readNotificationTarget, readSystemNotificationPreferences, SYSTEM_NOTIFICATION_KEY, SYSTEM_NOTIFICATION_DELIVERY_KEY, SystemNotificationDelivery} from '../src/app/system-notification-data.ts';

const require = createRequire(import.meta.url), {build} = createRequire(require.resolve('@angular/build/package.json'))('esbuild');
await mkdir('.angular', {recursive: true}); const directory = await mkdtemp(resolve('.angular/system-notification-test-')), output = resolve(directory, 'test.mjs');
await build({stdin: {contents: "export {SystemNotifications} from './src/app/system-notifications.ts'; export {BrowserNotifications} from './src/app/browser-notifications.ts'; export {NotificationBridge} from './src/app/notification-bridge.ts'; export {Reminders} from './src/app/reminders.ts'; export {BoardStore} from './src/app/board-store.ts';", resolveDir: process.cwd()}, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: output, tsconfig: 'tsconfig.json'});
const {SystemNotifications, BrowserNotifications, NotificationBridge, Reminders, BoardStore} = await import(pathToFileURL(output).href);
after(() => rm(directory, {recursive: true, force: true}));
const now = new Date(2026, 9, 18, 10, 50), task = {id: 'task', title: '研究會議', description: '', projectId: '', categoryId: '', status: 'todo', priority: 'medium', startDate: '2026-10-18', startTime: '11:00', dueDate: '2026-10-18', dueTime: '12:00', subtasks: []};
const settle = async () => {for (let count = 0; count < 5; count++) await new Promise(resolve => setImmediate(resolve));};
function memory() {const values = new Map(); let failed = false; return {values, getItem: key => values.get(key) ?? null, setItem(key, value) {if (failed) throw Error('quota'); values.set(key, value);}, removeItem: key => values.delete(key), fail: () => {failed = true;}};}
function fixture(shared) {
  const storage = shared ?? memory(); globalThis.localStorage = storage;
  if (!storage.getItem('orbit-workspaces-v1') && !storage.getItem('orbit-workspaces-v2')) storage.setItem('orbit-workspaces-v1', JSON.stringify({version: 1, activeWorkspaceId: 'workspace', workspaces: [{version: 4, id: 'workspace', name: '研究', projects: [], categories: [], statuses: COLUMNS, tasks: [task]}]}));
  const store = new BoardStore(), items = signal([{id: 'orbit:task', workspaceId: 'workspace', generation: store.generation(), task: structuredClone(task), start: new Date(2026, 9, 18, 11).getTime(), allDay: false}]), history = [], viewed = [], events = new Map(), effects = new Set(), calls = [], closed = [];
  const reminders = {items, now: signal(new Date(now)), workspaceLabel: () => '研究', recordSystemNotification: (item, at) => history.push({item, at}), markViewed: values => viewed.push(...values)};
  const platform = {state: 'granted', requests: 0, permission() {return this.state;}, async requestPermission() {this.requests++; this.state = 'granted'; return this.state;}, async show(title, body, tag, target, open) {calls.push({title, body, tag, target, open}); return () => closed.push(tag);}, async reconcile(live) {this.live = live();}};
  const view = {addEventListener: (key, action) => events.set(key, action), removeEventListener() {}, navigator: {serviceWorker: {addEventListener: (key, action) => events.set('worker:' + key, action), removeEventListener() {}}}, location: {hash: '', pathname: '/', search: ''}};
  const document = {defaultView: view, addEventListener: (key, action) => events.set(key, action), removeEventListener() {}};
  const scheduler = {add: effect => effects.add(effect), schedule() {}, remove: effect => effects.delete(effect)};
  const injector = createEnvironmentInjector([{provide: DOCUMENT, useValue: document}, {provide: BoardStore, useValue: store}, {provide: Reminders, useValue: reminders}, {provide: BrowserNotifications, useValue: platform}, {provide: ɵEffectScheduler, useValue: scheduler}, {provide: ɵChangeDetectionScheduler, useValue: {notify() {}}}]);
  const notifications = runInInjectionContext(injector, () => new SystemNotifications()), child = createEnvironmentInjector([{provide: SystemNotifications, useValue: notifications}], injector);
  const bridge = runInInjectionContext(child, () => new NotificationBridge()); bridge.blocked = signal(false);
  const opened = [], notices = []; bridge.openItem.subscribe(item => opened.push(item)); bridge.notice.subscribe(text => notices.push(text));
  const flush = () => {for (let round = 0; round < 30 && [...effects].some(effect => effect.dirty); round++) for (const effect of effects) if (effect.dirty) effect.run();};
  return {store, storage, items, history, viewed, events, calls, closed, platform, notifications, bridge, opened, notices, flush, async deliver() {flush(); await settle(); flush(); await settle();}, close() {notifications.ngOnDestroy(); child.destroy(); injector.destroy();}};
}

test('通知偏好預設停用、驗證時間及點擊身份，去重只保存識別與期限', async () => {
  assert.deepEqual(readSystemNotificationPreferences({enabled: true}), DEFAULT_SYSTEM_NOTIFICATIONS);
  assert.equal(readSystemNotificationPreferences({version: 1, ...DEFAULT_SYSTEM_NOTIFICATIONS, enabled: true, revision: 'v', allDayTime: '25:00'}).enabled, false);
  assert.equal(readNotificationTarget({version: 1, generation: 'g', workspaceId: 'w', itemId: 'i', sourceContext: '', url: 'https://evil.test'}).url, undefined);
  assert.equal(readNotificationTarget({version: 1, generation: 'g', workspaceId: '', itemId: 'i', sourceContext: ''}), null);
  const storage = memory(), log = new SystemNotificationDelivery(storage, async action => action()), second = new SystemNotificationDelivery(storage, async action => action());
  const token = await log.reserve('identity', 200, 100, () => true); assert.ok(token); assert.equal(await second.reserve('identity', 200, 100, () => true), null);
  await log.release('identity', 'wrong-owner', 100); assert.equal(await second.reserve('identity', 200, 100, () => true), null);
  await log.release('identity', token, 100); assert.ok(await second.reserve('identity', 200, 100, () => true));
  assert.equal(await log.reserve('late', 100, 200, () => true), null); assert.equal(await log.reserve('stale', 300, 200, () => false), null);
  assert.equal(storage.getItem(SYSTEM_NOTIFICATION_DELIVERY_KEY).includes(task.title), false);
});

test('首次開啟不要求權限，手動允許／拒絕／關閉提示與測試通知各自處理', async () => {
  const f = fixture();
  try {
    f.platform.state = 'default'; await f.deliver(); assert.equal(f.platform.requests, 0); assert.equal(f.calls.length, 0);
    f.bridge.blocked.set(true); await f.notifications.enable(); await f.deliver(); assert.equal(f.platform.requests, 1); assert.equal(f.notifications.preferences().enabled, true); assert.equal(f.calls.length, 0);
    await f.notifications.test(); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].target, null); assert.equal(f.history.length, 0);
    const show = f.platform.show.bind(f.platform); f.platform.show = async () => {throw Error('rejected');}; await f.notifications.test(); assert.match(f.notifications.warning(), /測試通知未送出/);
    f.platform.show = show; await f.notifications.test(); assert.equal(f.notifications.warning(), ''); assert.equal(f.history.length, 0); assert.notEqual(f.calls[0].tag, f.calls[1].tag);
    f.notifications.disable(); f.platform.state = 'denied'; await f.notifications.enable(); assert.equal(f.platform.requests, 1); assert.equal(f.notifications.preferences().enabled, false); assert.match(f.notifications.warning(), /封鎖/);
    f.platform.state = 'default'; f.platform.requestPermission = async () => 'default'; await f.notifications.enable(); assert.equal(f.notifications.preferences().enabled, false);
    f.platform.state = 'unsupported'; await f.notifications.enable(); assert.match(f.notifications.warning(), /無法使用/);
  } finally {f.close();}
});

test('背景也能發送跨空間提醒，兩分頁去重且歷史不自動變已讀，改期可再通知', async () => {
  const storage = memory(), first = fixture(storage), second = fixture(storage);
  try {
    first.notifications.setOptions({enabled: true}); second.events.get('storage')({key: SYSTEM_NOTIFICATION_KEY}); second.notifications.reminders.now.set(new Date(now));
    await Promise.all([first.deliver(), second.deliver()]); assert.equal(first.calls.length + second.calls.length, 1); assert.equal(first.history.length + second.history.length, 1); assert.equal(first.viewed.length + second.viewed.length, 0);
    first.items.update(items => items.map(item => ({...item, task: {...item.task, startTime: '11:05'}, start: item.start + 300000}))); await first.deliver(); assert.equal(first.calls.length + second.calls.length, 2);
    first.notifications.disable(); await first.deliver(); second.events.get('storage')({key: SYSTEM_NOTIFICATION_KEY}); await second.deliver(); assert.equal(second.notifications.preferences().enabled, false);
  } finally {second.close(); first.close();}
});

test('多於三筆分輪送出，睡眠返回不補過期，全天及 Google 開關沿用開始時限', async () => {
  const f = fixture();
  try {
    f.items.set(Array.from({length: 5}, (_, index) => ({...f.items()[0], id: 'orbit:t' + index, task: {...task, id: 't' + index}}))); f.notifications.setOptions({enabled: true}); await f.deliver(); assert.equal(f.calls.length, 3);
    f.notifications.reminders.now.set(new Date(now.getTime() + 10000)); await f.deliver(); assert.equal(f.calls.length, 5);
    f.items.set([{...f.items()[0], id: 'orbit:expired', start: now.getTime() - 600000, task: {...task, id: 'expired', startTime: '10:40'}}]); await f.deliver(); assert.equal(f.calls.length, 5);
    f.items.set([{...f.items()[0], id: 'orbit:all-day', allDay: true, start: new Date(2026, 9, 18).getTime(), task: {...task, id: 'all-day', startTime: ''}}]); f.notifications.setOptions({allDayTime: '11:00'}); await f.deliver(); assert.equal(f.calls.length, 5);
    f.notifications.setOptions({allDayTime: '09:00'}); await f.deliver(); assert.equal(f.calls.length, 6);
    f.items.set([{...f.items()[0], id: 'google:event', allDay: false, start: new Date(2026, 9, 18, 11).getTime(), task, external: {source: {id: 'calendar'}}}]); f.notifications.setOptions({includeGoogle: false}); await f.deliver(); assert.equal(f.calls.length, 6);
    f.notifications.setOptions({includeGoogle: true}); await f.deliver(); assert.equal(f.calls.length, 7);
  } finally {f.close();}
});

test('明確發送失敗可重試，儲存失敗則不發送，停用或改期中的晚到結果關閉且不記成功', async () => {
  const f = fixture();
  try {
    const show = f.platform.show.bind(f.platform); f.platform.show = async () => {throw Error('rejected');}; f.notifications.setOptions({enabled: true}); await f.deliver(); assert.equal(f.history.length, 0); assert.match(f.notifications.warning(), /無法送出/);
    f.platform.show = show; f.notifications.setOptions({enabled: true}); await f.deliver(); assert.equal(f.calls.length, 1);
    f.items.update(items => items.map(item => ({...item, start: item.start + 60000, task: {...item.task, startTime: '11:01'}}))); let finish;
    f.platform.show = async (...args) => {f.calls.push({title: args[0]}); return await new Promise(resolve => {finish = resolve;});}; await f.deliver(); assert.ok(finish);
    f.notifications.disable(); finish(() => f.closed.push('late')); await f.deliver(); assert.ok(f.closed.includes('late')); assert.equal(f.history.length, 1);
    f.notifications.setOptions({enabled: true}); f.storage.fail(); f.items.update(items => items.map(item => ({...item, start: item.start + 60000, task: {...item.task, startTime: '11:02'}}))); await f.deliver(); assert.equal(f.calls.length, 2);
  } finally {f.close();}
});

test('點擊通知先保護編輯、開啟最新內容，完成任務仍可查看；舊世代及刪除不開啟', async () => {
  const f = fixture();
  try {
    f.notifications.setOptions({enabled: true}); await f.deliver(); const call = f.calls[0]; f.bridge.blocked.set(true); call.open(call.target); await f.deliver(); assert.equal(f.opened.length, 0); assert.ok(f.notifications.openRequest()); assert.match(f.notices.at(-1), /完成或取消/);
    f.items.update(items => items.map(item => ({...item, task: {...item.task, title: '最新任務名稱'}}))); f.bridge.blocked.set(false); await f.deliver(); assert.equal(f.opened[0].task.title, '最新任務名稱'); assert.equal(f.viewed.length, 1);
    await f.store.saveTask({...f.store.tasks()[0], status: 'done'}); f.items.set([]); call.open(call.target); await f.deliver(); assert.equal(f.opened.at(-1).historical, true);
    f.events.get('worker:message')({data: {type: 'iih-orbit-notification-open', target: {...call.target, generation: 'old-generation'}}}); await f.deliver(); assert.equal(f.opened.length, 2); assert.match(f.notices.at(-1), /已移除/);
    await f.store.deleteTask('task'); call.open(call.target); await f.deliver(); assert.equal(f.opened.length, 2);
  } finally {f.close();}
});

test('重置期間晚到的權限不重新啟用，整個重置清除偏好且匯出不帶通知設定', async () => {
  const f = fixture();
  try {
    f.platform.state = 'default'; let approve; f.platform.requestPermission = () => new Promise(resolve => {approve = resolve;}); const pending = f.notifications.enable();
    await f.store.resetData(true, f.store.revision()); approve('granted'); await pending; await f.deliver(); assert.equal(f.notifications.preferences().enabled, false); assert.equal(f.storage.getItem(SYSTEM_NOTIFICATION_KEY), null);
    f.platform.state = 'granted'; f.notifications.setOptions({enabled: true}); const backup = JSON.stringify(await f.store.backupForExport('full')); assert.equal(backup.includes(SYSTEM_NOTIFICATION_KEY), false);
  } finally {f.close();}
});

test('本機資料尚未載入時不清理系統通知，載入完成後才判定與送出', async () => {
  const f = fixture();
  try {
    f.notifications.setOptions({enabled: true}); f.store.storageLoading.set(true); f.platform.live = undefined;
    await f.deliver(); assert.equal(f.platform.live, undefined); assert.equal(f.calls.length, 0);
    f.store.storageLoading.set(false); await f.deliver(); assert.equal(f.platform.live.size, 1); assert.equal(f.calls.length, 1);
    f.store.storageLoading.set(true);
    const target = {...f.calls[0].target, generation: 'loaded-generation'}; f.notifications.openRequest.set(target); f.store.generation.set(target.generation);
    f.items.update(items => items.map(item => ({...item, generation: target.generation}))); await f.deliver(); assert.deepEqual(f.notifications.openRequest(), target); assert.equal(f.opened.length, 0);
    f.store.storageLoading.set(false); await f.deliver(); assert.equal(f.opened[0].generation, target.generation);
  } finally {f.close();}
});

function browserFixture(registration) {
  const shown = [], opened = [], target = {version: 1, generation: 'g', workspaceId: 'w', itemId: 'orbit:t', sourceContext: ''}; let requests = 0, focused = 0;
  class MockNotification {static permission = 'granted'; static async requestPermission() {requests++; return 'granted';} constructor(title, options) {this.title = title; this.options = options; this.tag = options.tag; this.closed = false; shown.push(this);} close() {this.closed = true; this.onclose?.();}}
  const document = {baseURI: 'https://example.test/iih-orbit/', defaultView: {isSecureContext: true, Notification: MockNotification, navigator: {serviceWorker: {getRegistration: async () => registration}}, focus: () => focused++}};
  const injector = createEnvironmentInjector([{provide: DOCUMENT, useValue: document}]);
  const browser = runInInjectionContext(injector, () => new BrowserNotifications());
  return {browser, shown, opened, target, MockNotification, document, requests: () => requests, focused: () => focused, close: () => injector.destroy()};
}

test('桌面無 Service Worker 時使用通知建構子，點擊先聚焦且不自動要求權限', async () => {
  const f = browserFixture();
  try {
    const close = await f.browser.show('任務', '開始', 'iih-orbit-start:key', f.target, target => f.opened.push(target));
    assert.equal(f.requests(), 0); assert.equal(f.shown.length, 1); assert.equal(f.shown[0].options.icon, 'https://example.test/iih-orbit/icons/app-icon-192.png');
    f.shown[0].onclick(); assert.equal(f.focused(), 1); assert.deepEqual(f.opened, [f.target]); assert.equal(f.shown[0].closed, true); close();
    f.MockNotification.permission = 'denied'; await assert.rejects(() => f.browser.show('任務', '', 'iih-orbit-start:key', f.target, () => {})); assert.equal(f.shown.length, 1);
    f.document.defaultView.isSecureContext = false; assert.equal(f.browser.permission(), 'unsupported');
  } finally {f.close();}
});

test('PWA 優先走 showNotification，延遲清理依最新條件，不關閉其他來源通知', async () => {
  const sent = [], existing = [{tag: 'iih-orbit-start:old', close() {this.closed = true;}}, {tag: 'other-app', close() {this.closed = true;}}];
  const registration = {active: {}, showNotification: async (title, options) => sent.push({title, options}), getNotifications: async () => existing};
  const f = browserFixture(registration);
  try {
    await f.browser.show('任務', '開始', 'iih-orbit-start:key', f.target, () => {}); assert.equal(f.shown.length, 0); assert.deepEqual(sent[0].options.data, {orbitReminder: f.target});
    await f.browser.reconcile(() => new Set(['iih-orbit-start:old'])); assert.equal(existing[0].closed, undefined);
    await f.browser.reconcile(() => new Set()); assert.equal(existing[0].closed, true); assert.equal(existing[1].closed, undefined);
    registration.showNotification = async () => {throw Error('permission changed');}; await assert.rejects(() => f.browser.show('任務', '', 'iih-orbit-start:key', f.target, () => {})); assert.equal(f.shown.length, 0);
  } finally {f.close();}
});

test('通知去重資料毀損與額滿不遺忘已保留識別，已知失敗只釋放自己的保留', async () => {
  const storage = memory(), log = new SystemNotificationDelivery(storage, async action => action());
  storage.setItem(SYSTEM_NOTIFICATION_DELIVERY_KEY, 'broken'); await assert.rejects(() => log.reserve('new', 200, 100, () => true));
  storage.setItem(SYSTEM_NOTIFICATION_DELIVERY_KEY, JSON.stringify({version: 1, records: Array.from({length: 2000}, (_, index) => ({key: 'k' + index, token: 't' + index, expires: 200}))}));
  await assert.rejects(() => log.reserve('new', 200, 100, () => true)); assert.equal(JSON.parse(storage.getItem(SYSTEM_NOTIFICATION_DELIVERY_KEY)).records.length, 2000);
  assert.ok(await log.reserve('new', 400, 300, () => true));
});
