import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source = await readFile(new URL('../scripts/offline-worker.js', import.meta.url), 'utf8'), scope = 'https://example.test/iih-orbit/';
const target = {version: 1, generation: 'g', workspaceId: 'w', itemId: 'orbit:t', sourceContext: ''};
function fixture(clients = []) {
  const handlers = {}, opened = [], messages = [], focused = [];
  const windows = clients.map((url, index) => ({url, visibilityState: index === 1 ? 'visible' : 'hidden', async focus() {focused.push(url);}, postMessage: value => messages.push(JSON.parse(JSON.stringify(value)))}));
  vm.runInNewContext("const VERSION='test'; const ASSETS=[];\n" + source, {URL, self: {registration: {scope}, addEventListener: (name, callback) => {handlers[name] = callback;}, clients: {matchAll: async () => windows, openWindow: async url => opened.push(url)}}});
  return {opened, messages, focused, windows, async click(data = target, tag = 'iih-orbit-start:test') {let promise, closed = false; handlers.notificationclick({notification: {data: {orbitReminder: data}, tag, close() {closed = true;}}, waitUntil: value => {promise = value;}}); await promise; return closed;}};
}

test('Service Worker 通知點擊只聚焦此 App 的既有分頁，再交給編輯保護流程', async () => {
  const f = fixture(['https://example.test/other/', scope, scope + '?view=board']); assert.equal(await f.click(), true);
  assert.deepEqual(f.focused, [scope]); assert.deepEqual(f.opened, []); assert.deepEqual(f.messages, [{type: 'iih-orbit-notification-open', target}]);
});

test('通知冷開啟只到自身範圍，用 fragment 傳身份，忽略任意導向網址', async () => {
  const f = fixture(); await f.click({...target, url: 'https://evil.test'}); const url = new URL(f.opened[0]);
  assert.equal(url.origin + url.pathname, scope); assert.equal(url.search, ''); assert.deepEqual(JSON.parse(decodeURIComponent(url.hash.slice(20))), target);
  const closed = fixture([scope]); closed.windows[0].focus = async () => {throw Error('window closed');}; await closed.click(); assert.equal(closed.opened.length, 1);
});

test('無效通知身份與其他通知不進入任務路由', async () => {
  const f = fixture(); assert.equal(await f.click({...target, workspaceId: ''}), false); assert.equal(await f.click(target, 'unrelated'), false); assert.equal(await f.click({...target, version: 2}), false); assert.deepEqual(f.opened, []); assert.deepEqual(f.messages, []);
});
