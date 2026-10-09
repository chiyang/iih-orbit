import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CALENDAR_SYNC_PREFIX, CalendarSyncCoordinator, SYNC_LEASE_MS } from '../src/app/calendar-sync.ts';

const scope = JSON.stringify(['generation', 'client', 'account']);
const settle = async () => { for (let tick = 0; tick < 4; tick++) await new Promise(resolve => setImmediate(resolve)); };
function fixture() {
  const values = new Map(), channels = new Set();
  const storage = {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key)};
  let writes = Promise.resolve();
  const atomic = operation => { const next = writes.then(operation); writes = next.catch(() => {}); return next; };
  const tab = (selected = scope, locks) => {
    let keys = [];
    const channel = {onmessage: null, postMessage(message) { for (const peer of channels) if (peer !== channel) queueMicrotask(() => peer.onmessage?.({data: structuredClone(message)})); }, close() { channels.delete(channel); }};
    channels.add(channel);
    const coordinator = new CalendarSyncCoordinator(storage, atomic, value => { keys = value; }, channel, locks);
    coordinator.activate(selected);
    return {coordinator, keys: () => keys};
  };
  return {storage, values, tab};
}

test('同步開始與完成通知所有分頁，新開分頁也顯示同步中；重複點擊不執行或排隊', async () => {
  const {tab, values} = fixture(), first = tab(), second = tab();
  let release, third, requests = 0;
  const pending = new Promise(resolve => { release = resolve; });
  try {
    const updating = first.coordinator.run(scope, ['calendar'], async current => { requests++; assert.equal(current(), true); await pending; });
    await settle();
    assert.deepEqual(first.keys(), ['calendar']); assert.deepEqual(second.keys(), ['calendar']);
    third = tab(); assert.deepEqual(third.keys(), ['calendar']);
    assert.equal(await second.coordinator.run(scope, ['calendar'], async () => { requests++; }), false);
    assert.equal(requests, 1);
    assert.equal([...values.keys()].every(key => key.startsWith(CALENDAR_SYNC_PREFIX)), true);
    release(); assert.equal(await updating, true); await settle();
    assert.deepEqual(second.keys(), []); assert.deepEqual(third.keys(), []);
    assert.equal(requests, 1);
    assert.equal(await second.coordinator.run(scope, ['calendar'], async () => { requests++; }), true);
    assert.equal(requests, 2);
  } finally { release(); first.coordinator.close(); second.coordinator.close(); third?.coordinator.close(); }
});

test('兩分頁同時搶同步只執行一次，失敗釋放同步狀態且能重試', async () => {
  const {tab} = fixture(), first = tab(), second = tab();
  let release, requests = 0;
  const pending = new Promise(resolve => { release = resolve; });
  try {
    const operation = async () => { requests++; await pending; throw new Error('network'); };
    const firstRun = first.coordinator.run(scope, ['calendar'], operation);
    const failure = assert.rejects(firstRun, /network/);
    const secondRun = second.coordinator.run(scope, ['calendar'], operation);
    await settle(); assert.equal(requests, 1); assert.equal(await secondRun, false);
    release(); await failure; await settle();
    assert.deepEqual(first.keys(), []); assert.deepEqual(second.keys(), []);
    assert.equal(await second.coordinator.run(scope, ['calendar'], async () => {}), true);
  } finally { release(); first.coordinator.close(); second.coordinator.close(); }
});

test('不同帳號與資料世代的同步分開；關閉舊分頁不清除新擁有者', async () => {
  const {tab, storage} = fixture(), first = tab(), other = tab('other');
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  try {
    const updating = first.coordinator.run(scope, ['calendar'], async () => pending);
    await settle(); assert.deepEqual(other.keys(), []);
    assert.equal(await other.coordinator.run('other', ['another'], async () => {}), true);
    storage.setItem(CALENDAR_SYNC_PREFIX + scope, JSON.stringify({id: 'new-owner', keys: ['new'], expiresAt: Date.now() + SYNC_LEASE_MS}));
    const cancelled = assert.rejects(updating, /頁面已離開/);
    first.coordinator.close(); release(); await cancelled;
    assert.equal(JSON.parse(storage.getItem(CALENDAR_SYNC_PREFIX + scope)).id, 'new-owner');
  } finally { release(); first.coordinator.close(); other.coordinator.close(); }
});

test('未通知的分頁可重讀同步狀態；當機遺留租約到期可恢復，舊作業失去寫入權', async () => {
  const {tab, storage} = fixture(), first = tab(), second = tab();
  let release, current;
  const pending = new Promise(resolve => { release = resolve; });
  try {
    const updating = first.coordinator.run(scope, ['calendar'], async owns => { current = owns; await pending; });
    await settle();
    const record = JSON.parse(storage.getItem(CALENDAR_SYNC_PREFIX + scope));
    storage.setItem(CALENDAR_SYNC_PREFIX + scope, JSON.stringify({...record, expiresAt: Date.now() - 1}));
    second.coordinator.refresh(); assert.deepEqual(second.keys(), []);
    assert.equal(await second.coordinator.run(scope, ['calendar'], async () => { assert.equal(current(), false); }), true);
    release(); await updating;
    assert.deepEqual(first.keys(), []);
  } finally { release(); first.coordinator.close(); second.coordinator.close(); }
});

test('原生同步鎖採用 ifAvailable，忙碌時拒絕排隊；即使租約到期仍不重複執行', async () => {
  const {tab, storage} = fixture();
  let held = false;
  const locks = {async request(name, options, callback) {
    assert.match(name, /^iih-orbit-calendar-run:/); assert.equal(options.ifAvailable, true);
    if (held) return callback(null);
    held = true; try { return await callback({name}); } finally { held = false; }
  }};
  const first = tab(scope, locks), second = tab(scope, locks);
  let release, calls = 0;
  const pending = new Promise(resolve => { release = resolve; });
  try {
    const updating = first.coordinator.run(scope, ['calendar'], async () => { calls++; await pending; });
    await settle();
    const record = JSON.parse(storage.getItem(CALENDAR_SYNC_PREFIX + scope));
    storage.setItem(CALENDAR_SYNC_PREFIX + scope, JSON.stringify({...record, expiresAt: Date.now() - 1}));
    assert.equal(await second.coordinator.run(scope, ['calendar'], async () => { calls++; }), false);
    assert.equal(calls, 1); release(); await updating;
  } finally { release(); first.coordinator.close(); second.coordinator.close(); }
});

test('無法保存同步標記時不送出 Google 請求，避免各分頁不受控地重複同步', async () => {
  const coordinator = new CalendarSyncCoordinator({getItem: () => null, setItem: () => { throw new Error('quota'); }, removeItem() {}}, async operation => operation(), () => {});
  let calls = 0;
  try { coordinator.activate(scope); await assert.rejects(coordinator.run(scope, ['calendar'], async () => { calls++; }), /quota/); assert.equal(calls, 0); }
  finally { coordinator.close(); }
});

test('取得作業鎖後快取已由其他分頁更新時，重新確認可跳過且不廣播同步中', async () => {
  const {tab, values} = fixture(), first = tab();
  let calls = 0, locksChecked = 0;
  const locks = {async request(name, options, callback) { locksChecked++; return callback({name}); }};
  const second = tab(scope, locks);
  try {
    assert.equal(await second.coordinator.run(scope, ['calendar'], async () => { calls++; }, async () => []), false);
    assert.equal(locksChecked, 1); assert.equal(calls, 0); assert.equal(values.size, 0);
    assert.deepEqual(first.keys(), []); assert.deepEqual(second.keys(), []);
  } finally { first.coordinator.close(); second.coordinator.close(); }
});

function nativeLocks() {
  const held = new Set();
  return {async request(name, options, callback) {
    if (held.has(name)) return callback(null);
    held.add(name); try { return await callback({name}); } finally { held.delete(name); }
  }};
}

test('重新整理遺留未到期標記但原生作業鎖已釋放時，立即解除同步中並可重試', async () => {
  const {tab, storage} = fixture(), locks = nativeLocks();
  storage.setItem(CALENDAR_SYNC_PREFIX + scope, JSON.stringify({id: 'discarded-page', keys: ['calendar'], expiresAt: Date.now() + SYNC_LEASE_MS}));
  const restored = tab(scope, locks);
  try {
    await settle(); assert.deepEqual(restored.keys(), []); assert.equal(storage.getItem(CALENDAR_SYNC_PREFIX + scope), null);
    assert.equal(await restored.coordinator.run(scope, ['calendar'], async () => {}), true);
  } finally { restored.coordinator.close(); }
});

test('重新整理時另一分頁仍持有原生同步鎖，不清除其標記或允許重複同步', async () => {
  const {tab, storage} = fixture(), locks = nativeLocks(), first = tab(scope, locks);
  let release, restored;
  const pending = new Promise(resolve => { release = resolve; });
  try {
    const updating = first.coordinator.run(scope, ['calendar'], async () => pending); await settle();
    const id = JSON.parse(storage.getItem(CALENDAR_SYNC_PREFIX + scope)).id;
    restored = tab(scope, locks); await settle();
    assert.deepEqual(restored.keys(), ['calendar']); assert.equal(JSON.parse(storage.getItem(CALENDAR_SYNC_PREFIX + scope)).id, id);
    assert.equal(await restored.coordinator.run(scope, ['calendar'], async () => assert.fail('duplicate')), false);
    release(); await updating; await settle(); assert.deepEqual(restored.keys(), []);
  } finally { release(); first.coordinator.close(); restored?.coordinator.close(); }
});

test('頁面離開立即釋放標記與原生鎖，返回後可重新同步，舊作業失去寫入權', async () => {
  const {tab, storage} = fixture(), locks = nativeLocks(), first = tab(scope, locks), second = tab(scope, locks);
  let release, current;
  const pending = new Promise(resolve => { release = resolve; });
  try {
    const updating = first.coordinator.run(scope, ['calendar'], async owns => { current = owns; await pending; });
    await settle();
    const cancelled = assert.rejects(updating, /頁面已離開/);
    first.coordinator.suspend(); await cancelled; await settle();
    assert.equal(current(), false); assert.deepEqual(second.keys(), []); assert.equal(storage.getItem(CALENDAR_SYNC_PREFIX + scope), null);
    assert.equal(await first.coordinator.run(scope, ['calendar'], async () => {}), false);
    assert.equal(await second.coordinator.run(scope, ['calendar'], async () => {}), true);
    first.coordinator.resume(); assert.equal(await first.coordinator.run(scope, ['calendar'], async () => {}), true);
  } finally { release(); first.coordinator.close(); second.coordinator.close(); }
});

test('永不返回的作業超時後釋放同步狀態與鎖，可重試且晚到的舊回覆不能寫回', async () => {
  const {storage} = fixture(), locks = nativeLocks();
  let keys = [], current, release;
  const coordinator = new CalendarSyncCoordinator(storage, async operation => operation(), value => { keys = value; }, undefined, locks, 15);
  const pending = new Promise(resolve => { release = resolve; });
  try {
    coordinator.activate(scope);
    await assert.rejects(coordinator.run(scope, ['calendar'], async owns => { current = owns; await pending; }), /同步逾時/);
    assert.equal(current(), false); assert.deepEqual(keys, []); assert.equal(storage.getItem(CALENDAR_SYNC_PREFIX + scope), null);
    assert.equal(await coordinator.run(scope, ['calendar'], async () => {}), true);
  } finally { release(); coordinator.close(); }
});

test('明確使用替代協調的分頁標記不能被原生鎖探測誤清除', async () => {
  const {tab, storage} = fixture();
  const record = {id: 'fallback-owner', keys: ['calendar'], expiresAt: Date.now() + SYNC_LEASE_MS, lockProtected: false};
  storage.setItem(CALENDAR_SYNC_PREFIX + scope, JSON.stringify(record));
  const restored = tab(scope, nativeLocks());
  try { await settle(); assert.deepEqual(restored.keys(), ['calendar']); assert.deepEqual(JSON.parse(storage.getItem(CALENDAR_SYNC_PREFIX + scope)), record); }
  finally { restored.coordinator.close(); }
});
