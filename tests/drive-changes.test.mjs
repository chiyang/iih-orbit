import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DriveBrowserApi, DRIVE_CHANGES_FIELDS} from '../src/app/drive-browser-data.ts';
import {DriveChangesTracker, DRIVE_CHANGES_INTERVAL, DRIVE_CHANGES_PAGE_LIMIT} from '../src/app/drive-changes.ts';
import {GoogleHttpError} from '../src/app/google-api.ts';

const storageKey = 'iih-orbit-drive-changes-v1';
const file = id => ({id, name: id, mimeType: 'application/pdf'});
const change = id => ({fileId: id, removed: false, file: file(id), changeType: 'file'});
function fixture() {
  let now = 1800000000000;
  const values = new Map(), calls = [], applied = [], resets = [], warnings = [];
  const storage = {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value)};
  const connection = {id: 'a', key: 'generation/account-a/client-a', version: 1, available: true, api: {
    async startPageToken() {calls.push('start'); return 'baseline';},
    async changes(token) {calls.push(token); return {changes: [{fileId: token, removed: true}], nextPageToken: '', newStartPageToken: 'done'};}
  }};
  const options = {storage, now: () => now, apply: (id, changes) => applied.push({id, changes}), reset: id => resets.push(id), warning: value => warnings.push(value)};
  const tracker = new DriveChangesTracker(options); tracker.setConnections([connection]);
  return {tracker, connection, options, values, calls, applied, resets, warnings, tick: amount => now += amount};
}

test('Drive 變更 API 只讀 metadata，驗證整頁及游標後才回傳，保留刪除及共用硬碟變更', async () => {
  const calls = [], signal = new AbortController().signal;
  const api = new DriveBrowserApi({api: async (...args) => {calls.push(args); return args[0] === 'changes/startPageToken' ? {startPageToken: 'begin'} : {changes: [change('known'), {fileId: 'gone', removed: true, changeType: 'file'}, {changeType: 'drive', driveId: 'shared-drive', removed: true}], newStartPageToken: 'end'};}});
  assert.equal(await api.startPageToken(signal), 'begin');
  const page = await api.changes('begin', signal);
  assert.deepEqual(page.changes.map(item => item.fileId), ['known', 'gone', 'shared-drive']);
  assert.equal(page.changes[0].file.name, 'known'); assert.equal(page.newStartPageToken, 'end');
  assert.equal(calls[1][1].fields, DRIVE_CHANGES_FIELDS); assert.equal(calls[1][1].includeItemsFromAllDrives, 'true');
  assert.equal(calls[1][1].includeRemoved, 'true'); assert.equal(calls[1][2], signal); assert.equal(calls[1][1].alt, undefined);
  for (const response of [{}, {changes: [], nextPageToken: 'a', newStartPageToken: 'b'}, {changes: [change('one'), {...change('two'), file: file('wrong')}], newStartPageToken: 'end'}, {changes: [{changeType: 'file', removed: false, fileId: 'missing'}], newStartPageToken: 'end'}, {changes: Array.from({length: 101}, () => change('one')), newStartPageToken: 'end'}]) {
    await assert.rejects(new DriveBrowserApi({api: async () => response}).changes('begin'));
  }
  await assert.rejects(api.changes('')); await assert.rejects(new DriveBrowserApi({api: async () => ({startPageToken: 5})}).startPageToken());
});
test('每來源最多三頁、處理完成才保存游標，未完一分鐘接續，完成後五分鐘再檢查', async () => {
  const f = fixture(); let page = 0;
  f.connection.api.changes = async token => {f.calls.push(token); page++; return {changes: [{fileId: 'known', removed: true}], nextPageToken: page <= DRIVE_CHANGES_PAGE_LIMIT ? 'page-' + page : '', newStartPageToken: page > DRIVE_CHANGES_PAGE_LIMIT ? 'complete' : ''};};
  await Promise.all([f.tracker.poll(), f.tracker.poll()]);
  assert.deepEqual(f.calls, ['start', 'baseline', 'page-1', 'page-2']); assert.equal(f.applied.length, 3);
  assert.equal(JSON.parse(f.values.get(storageKey)).cursors[0].token, 'page-3');
  await f.tracker.poll(); assert.equal(f.calls.length, 4);
  f.tick(60000); await f.tracker.poll(); assert.equal(f.calls.at(-1), 'page-3');
  f.tick(DRIVE_CHANGES_INTERVAL - 1); await f.tracker.poll(); assert.equal(f.calls.length, 5);
  f.tick(1); await f.tracker.poll(); assert.equal(f.calls.at(-1), 'complete'); f.tracker.destroy();
});
test('快取處理或第二頁失敗不跳過變更，重開從最後完成頁接續；保存失敗仍可本次接續', async () => {
  const f = fixture(); let fail = true;
  f.options.apply = () => {if (fail) throw new Error('cache failed');};
  await f.tracker.poll(); assert.equal(JSON.parse(f.values.get(storageKey)).cursors[0].token, 'baseline');
  assert.match(f.warnings.at(-1), /暫時未完成/); fail = false; f.tick(60000); await f.tracker.poll();
  assert.equal(JSON.parse(f.values.get(storageKey)).cursors[0].token, 'done');
  const restored = new DriveChangesTracker(f.options); restored.setConnections([f.connection]); await restored.poll();
  assert.equal(f.calls.filter(value => value === 'start').length, 1); assert.equal(f.calls.at(-1), 'done');
  f.options.storage.setItem = () => {throw new Error('quota');};
  f.tick(DRIVE_CHANGES_INTERVAL); await restored.poll(); assert.match(f.warnings.at(-1), /無法保存/);
  restored.destroy(); f.tracker.destroy();
});
test('背景與離線不發請求；進行中切帳號、世代或授權版本時，舊回覆不套用也不保存', async () => {
  const f = fixture(); let finish;
  f.tracker.setEnvironment(false, true); await f.tracker.poll(); assert.equal(f.calls.length, 0);
  f.tracker.setEnvironment(true, false); await f.tracker.poll(); assert.equal(f.calls.length, 0);
  f.tracker.setEnvironment(true, true);
  f.connection.api.startPageToken = () => new Promise(resolve => {finish = resolve;});
  const pending = f.tracker.poll(); await Promise.resolve();
  f.tracker.setConnections([{...f.connection, key: 'generation/account-b/client-a', version: 2, available: false}]); finish('old'); await pending;
  assert.equal(f.applied.length, 0); assert.equal(f.resets.length, 1); assert.equal(f.values.has(storageKey), true);
  assert.deepEqual(JSON.parse(f.values.get(storageKey)).cursors, []);
  f.tracker.setConnections([{...f.connection, version: 3}]);
  f.connection.api.startPageToken = async () => 'new';
  let reply; f.connection.api.changes = () => new Promise(resolve => {reply = resolve;});
  const next = f.tracker.poll(); await new Promise(resolve => setImmediate(resolve));
  f.tracker.setEnvironment(true, false); reply({changes: [{fileId: 'late', removed: true}], nextPageToken: '', newStartPageToken: 'late-end'}); await next;
  assert.equal(f.applied.length, 0); assert.equal(JSON.parse(f.values.get(storageKey)).cursors[0].token, 'new'); f.tracker.destroy();
});
test('游標失效重新建立起點，限流尊重 Retry-After，授權續接保留原游標', async () => {
  const f = fixture();
  f.connection.api.changes = async token => {f.calls.push(token); throw new GoogleHttpError(410, '檔案');};
  await f.tracker.poll(); assert.equal(f.resets.length, 2); assert.deepEqual(JSON.parse(f.values.get(storageKey)).cursors, []);
  f.tick(60000); f.connection.api.changes = async () => {throw new GoogleHttpError(429, '檔案', {retryAfterMs: 900000});}; await f.tracker.poll();
  const count = f.calls.length; f.tick(899999); await f.tracker.poll(); assert.equal(f.calls.length, count);
  f.tracker.setConnections([{...f.connection, version: 2}]);
  f.connection.api.changes = async token => {f.calls.push(token); return {changes: [], nextPageToken: '', newStartPageToken: 'renewed'};};
  await f.tracker.poll(); assert.equal(f.calls.at(-1), 'baseline'); assert.equal(JSON.parse(f.values.get(storageKey)).cursors[0].token, 'renewed'); f.tracker.destroy();
});
test('多來源隔離游標且最多兩個來源並行，移除來源清除其保存位置', async () => {
  const f = fixture(); let active = 0, peak = 0;
  const connections = Array.from({length: 5}, (_, index) => ({...f.connection, id: String(index), key: 'owner-' + index, api: {
    async startPageToken() {active++; peak = Math.max(peak, active); await new Promise(resolve => setImmediate(resolve)); active--; return 'baseline-' + index;},
    async changes(token) {return {changes: [], nextPageToken: '', newStartPageToken: token};}
  }}));
  f.tracker.setConnections(connections); await f.tracker.poll(); assert.equal(peak, 2);
  assert.equal(JSON.parse(f.values.get(storageKey)).cursors.length, 5);
  f.tracker.setConnections(connections.slice(0, 1)); assert.deepEqual(JSON.parse(f.values.get(storageKey)).cursors.map(item => item.key), ['owner-0']); f.tracker.destroy();
});
