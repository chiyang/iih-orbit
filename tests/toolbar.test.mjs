import '@angular/compiler';
import {createEnvironmentInjector, runInInjectionContext, signal, ɵEffectScheduler, ɵChangeDetectionScheduler} from '@angular/core';
import assert from 'node:assert/strict';
import {after, test} from 'node:test';
import {createRequire} from 'node:module';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';

const require = createRequire(import.meta.url), {build} = createRequire(require.resolve('@angular/build/package.json'))('esbuild');
await mkdir('.angular', {recursive: true});
const directory = await mkdtemp(resolve('.angular/toolbar-test-')), output = resolve(directory, 'toolbar.mjs');
await build({stdin: {contents: "export {DriveSyncButton} from './src/app/drive-sync-button.ts'; export {DriveService} from './src/app/drive-service.ts'; export {GoogleConnections} from './src/app/google-connections.ts'; export {GmailNotifications} from './src/app/gmail-notifications.ts'; export {GmailService} from './src/app/gmail-service.ts'; export {panelAttention} from './src/app/panel-attention.ts';", resolveDir: process.cwd()}, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: output, tsconfig: 'tsconfig.json'});
const {DriveSyncButton, DriveService, GoogleConnections, GmailNotifications, GmailService, panelAttention} = await import(pathToFileURL(output).href);
after(() => rm(directory, {recursive: true, force: true}));

function syncButton() {
  const drive = {store: {drive: signal({accountId: 'account', mode: 'sync'}), pendingWrites: signal(0), hasUnsavedChanges: signal(false), taskConflicts: signal([])}, auth: {connected: signal(true)}, runtime: signal({link: {}}), online: signal(true), busy: signal(false), syncing: signal(false), lastSyncAt: signal(''), unavailable: signal(false), error: signal(''), message: signal('')};
  const connections = {renewalVisible: signal(false), loggingOut: signal(false)};
  const injector = createEnvironmentInjector([{provide: DriveService, useValue: drive}, {provide: GoogleConnections, useValue: connections}]);
  const button = runInInjectionContext(injector, () => new DriveSyncButton());
  return {drive, button, connections, close() {injector.destroy();}};
}

test('G 授權按鈕顯示時，遠端同步按鈕隱藏；授權完成後恢復', () => {
  const f = syncButton();
  try {
    assert.equal(f.button.visible(), true);
    f.connections.renewalVisible.set(true); assert.equal(f.button.visible(), false);
    f.connections.renewalVisible.set(false); assert.equal(f.button.visible(), true);
    f.drive.runtime.set({}); assert.equal(f.button.visible(), false);
  } finally {f.close();}
});

test('多功能側欄按鈕依衝突、提醒、新郵件優先顯示；沒有通知時保留一般開關', () => {
  assert.equal(panelAttention(2, 3, 4).target, 'tasks'); assert.equal(panelAttention(2, 3, 4).count, 2);
  assert.equal(panelAttention(0, 3, 4).target, 'reminders'); assert.equal(panelAttention(0, 3, 4).count, 3);
  assert.equal(panelAttention(0, 0, 4).target, 'gmail'); assert.match(panelAttention(0, 0, 4).label, /新郵件通知/);
  assert.equal(panelAttention(0, 0, 0).target, 'toggle'); assert.equal(panelAttention(0, 0, 0).icon, 'panelRight');
});

test('同步按鈕在處理中防止重複操作；過期或整份衝突開啟設定，不誤送同步', async () => {
  const f = syncButton(); let requests = 0, configured = 0;
  f.drive.sync = async () => {requests++; return 'complete';}; f.button.configure.subscribe(() => {configured++;});
  try {
    f.drive.busy.set(true); await f.button.sync(); assert.equal(requests, 0); assert.match(f.button.description(), /等候完成/);
    f.drive.busy.set(false); f.drive.auth.connected.set(false); assert.equal(f.button.attention(), true);
    await f.button.sync(); assert.equal(configured, 1); assert.equal(requests, 0);
    f.drive.auth.connected.set(true); f.drive.runtime.set({link: {}, conflict: ['one', 'two']});
    await f.button.sync(); assert.equal(configured, 2); assert.equal(requests, 0);
    f.drive.runtime.set({link: {}}); f.drive.online.set(false); await f.button.sync(); assert.equal(requests, 0);
  } finally {f.close();}
});

test('同步成功提示包含已保存的任務衝突；新修改未完成及失敗不顯示可以離線', async () => {
  const f = syncButton(), messages = []; f.button.result.subscribe(value => messages.push(value));
  try {
    f.drive.store.taskConflicts.set([{}]); f.drive.sync = async () => 'complete'; await f.button.sync();
    assert.match(messages.at(-1), /可以離線/); assert.match(messages.at(-1), /各份內容也已保存/);
    f.drive.message.set('仍有新的修改等待同步'); f.drive.sync = async () => 'pending'; await f.button.sync();
    assert.equal(messages.at(-1), '仍有新的修改等待同步'); assert.doesNotMatch(messages.at(-1), /可以離線/);
    f.drive.error.set('network'); f.drive.sync = async () => 'failed'; await f.button.sync(); assert.equal(messages.at(-1), 'network');
  } finally {f.close();}
});

test('正常上傳中的暫存版本不亮紅點；完成後的任務衝突保留紅點與同步勾選，提示各自原因', () => {
  const f = syncButton();
  try {
    f.drive.runtime.set({link: {}, pending: {}}); f.drive.syncing.set(true);
    assert.equal(f.button.attention(), false); assert.equal(f.button.icon(), 'sync');
    f.drive.syncing.set(false); assert.equal(f.button.attention(), true); assert.match(f.button.description(), /等待上傳/);
    f.drive.runtime.set({link: {}}); f.drive.lastSyncAt.set('2026-10-14T12:00:00Z'); f.drive.store.taskConflicts.set([{}]);
    assert.equal(f.button.attention(), true); assert.equal(f.button.icon(), 'circleCheck'); assert.match(f.button.description(), /目前內容已同步.*1 個衝突任務/);
    f.drive.error.set('上傳失敗'); assert.equal(f.button.icon(), 'sync'); assert.match(f.button.description(), /上次同步未完成.*上傳失敗/);
    f.drive.error.set(''); f.drive.runtime.set({link: {}, conflict: ['one']}); assert.equal(f.button.icon(), 'sync'); assert.match(f.button.description(), /雲端有不同內容待選擇/);
  } finally {f.close();}
});

async function notifications() {
  const originals = new Map(['window', 'document', 'navigator', 'localStorage'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const values = new Map(), effects = new Set(), requests = [];
  const storage = {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value)};
  const window = {addEventListener() {}, removeEventListener() {}}, document = {visibilityState: 'visible', addEventListener() {}, removeEventListener() {}}, navigator = {onLine: true};
  for (const [key, value] of Object.entries({window, document, navigator, localStorage: storage})) Object.defineProperty(globalThis, key, {value, configurable: true});
  let refreshed;
  const gmail = {store: {generation: signal('generation')}, clientId: signal('client'), preferences: signal({accountId: 'account'}), auth: {connected: signal(false), connectionVersion: signal(1)}, newThreadIds: signal(new Set()), arrivalWarning: signal(''), onRefreshed(listener) {refreshed = listener; return () => {refreshed = undefined;};}, previewIdentity() {return JSON.stringify([this.store.generation(), this.clientId(), this.preferences().accountId, this.auth.connectionVersion()]);}};
  let history = {historyId: '100'}, failure;
  gmail.auth.api = async (path, params) => {requests.push([path, params]); if (failure) throw failure; if (path === 'profile') return {historyId: '100'}; if (path === 'history') return history; return {id: path.slice(9), threadId: path === 'messages/new' ? 'thread' : 'thread-' + path.slice(9), labelIds: ['INBOX', 'UNREAD']};};
  const scheduler = {add(effect) {effects.add(effect);}, schedule() {}, remove(effect) {effects.delete(effect);}};
  const injector = createEnvironmentInjector([{provide: GmailService, useValue: gmail}, {provide: ɵEffectScheduler, useValue: scheduler}, {provide: ɵChangeDetectionScheduler, useValue: {notify() {}}}]);
  const service = runInInjectionContext(injector, () => new GmailNotifications());
  const flush = async () => {for (let round = 0; round < 30 && [...effects].some(effect => effect.dirty); round++) for (const effect of effects) if (effect.dirty) effect.run();};
  await flush();
  return {service, gmail, requests, values, navigator, document, flush, refresh: () => refreshed?.(), setHistory(value) {history = value;}, setFailure(value) {failure = value;}, close() {service.ngOnDestroy(); injector.destroy(); for (const [key, descriptor] of originals) {if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];}}};
}

test('新郵件只隨有效連線的成功郵件更新檢查，連線與回到前景不獨立查詢', async () => {
  const f = await notifications();
  try {
    await f.refresh(); assert.equal(f.requests.length, 0);
    f.gmail.auth.connected.set(true); f.document.visibilityState = 'hidden'; await f.flush(); assert.equal(f.requests.length, 0);
    f.document.visibilityState = 'visible'; f.navigator.onLine = false; await f.refresh(); assert.equal(f.requests.length, 0);
    f.navigator.onLine = true; await f.refresh(); assert.equal(f.requests.length, 1); assert.equal(f.service.count(), 0);
    await f.flush(); assert.equal(f.requests.length, 1);
    f.setHistory({historyId: '120', history: [{messagesAdded: [{message: {id: 'new'}}]}]}); await f.refresh();
    assert.equal(f.service.count(), 1); assert.equal(f.gmail.newThreadIds().has('thread'), true);
  } finally {f.close();}
});

test('查看紀錄以當前 Gmail 身分處理；失敗保留提示，切換帳號不混入舊新郵件', async () => {
  const f = await notifications();
  try {
    f.gmail.auth.connected.set(true); await f.flush(); await f.refresh();
    f.setHistory({historyId: '120', history: [{messagesAdded: [{message: {id: 'new'}}]}]}); await f.refresh();
    assert.equal(f.service.acknowledgeCurrent('old-account'), false); assert.equal(f.service.count(), 1);
    f.setFailure(new Error('network')); await f.refresh(); assert.equal(f.service.count(), 1); assert.match(f.service.warning(), /network/);
    assert.equal(f.service.acknowledgeCurrent(f.gmail.previewIdentity()), true); assert.equal(f.service.count(), 0);
    assert.deepEqual(JSON.parse(f.values.get('iih-orbit-gmail-arrivals-v1')).viewed, ['new']);
    f.setFailure(undefined); f.gmail.preferences.set({accountId: 'different-account'}); await f.flush();
    await f.refresh();
    assert.equal(f.service.count(), 0); assert.equal(f.service.state().context.includes('different-account'), true);
  } finally {f.close();}
});

test('開啟 Gmail 整批收起通知與新郵件標記，保存本機識別；後續到信重新累計，Gmail 未讀不變', async () => {
  const f = await notifications();
  try {
    f.gmail.auth.connected.set(true); await f.flush(); await f.refresh();
    f.setHistory({historyId: '120', history: [{messagesAdded: ['one', 'two'].map(id => ({message: {id}}))}]}); await f.refresh();
    assert.equal(f.service.count(), 2);
    const requests = f.requests.length;
    f.service.acknowledgeCurrent(f.gmail.previewIdentity());
    assert.equal(f.service.count(), 0); assert.equal(f.gmail.newThreadIds().size, 0); assert.equal(f.requests.length, requests);
    const saved = JSON.parse(f.values.get('iih-orbit-gmail-arrivals-v1'));
    assert.deepEqual(saved.pending, []); assert.deepEqual(saved.viewed.sort(), ['one', 'two']);
    f.setHistory({historyId: '130', history: [{messagesAdded: ['one', 'two', 'three'].map(id => ({message: {id}}))}]}); await f.refresh();
    assert.equal(f.service.count(), 1); assert.deepEqual([...f.gmail.newThreadIds()], ['thread-three']);
    assert.equal(f.requests.every(([path]) => !path.includes('modify')), true);
  } finally {f.close();}
});

test('整批查看與新郵件請求重疊時，不復活舊通知，也不清除稍後取得的新郵件', async () => {
  const f = await notifications(); let release;
  try {
    f.gmail.auth.connected.set(true); await f.flush(); await f.refresh();
    f.setHistory({historyId: '120', history: [{messagesAdded: [{message: {id: 'new'}}]}]}); await f.refresh();
    const original = f.gmail.auth.api;
    f.gmail.auth.api = async (path, params) => path === 'history' ? new Promise(resolve => {release = resolve;}) : original(path, params);
    const checking = f.refresh(); await new Promise(resolve => setImmediate(resolve));
    f.service.acknowledgeCurrent(f.gmail.previewIdentity()); assert.equal(f.service.count(), 0);
    release({historyId: '130', history: [{messagesAdded: ['new', 'later'].map(id => ({message: {id}}))}]}); await checking;
    assert.equal(f.service.count(), 1); assert.deepEqual(f.service.state().pending.map(mail => mail.id), ['later']);
  } finally {f.close();}
});
