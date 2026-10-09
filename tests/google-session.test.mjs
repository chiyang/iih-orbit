import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CALENDAR_SCOPE } from '../src/app/google-data.ts';
import { GOOGLE_SESSION_KEY, GoogleSessionBridge, readGoogleSession } from '../src/app/google-session.ts';

const context = {clientId: '123-example.apps.googleusercontent.com', generation: 'generation', accountId: 'account'};
function storage() {
  const values = new Map();
  return {values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key)};
}
function messaging() {
  const channels = new Set(), messages = [];
  return {
    messages,
    channel() {
      const channel = {onmessage: null, postMessage(message) { messages.push(structuredClone(message)); for (const other of channels) if (other !== channel) queueMicrotask(() => { if (channels.has(other)) other.onmessage?.({data: structuredClone(message)}); }); }, close() { channels.delete(channel); }};
      channels.add(channel);
      return channel;
    }
  };
}
const settle = async () => { for (let tick = 0; tick < 4; tick++) await new Promise(resolve => setImmediate(resolve)); };
function tab(local, bus, sessionStorage = storage()) {
  let current, pending = '', busy = false, warning = '', message = '';
  const channel = bus?.channel();
  const bridge = new GoogleSessionBridge(sessionStorage, local, channel, {
    current: () => current, pendingNonce: () => pending, busy: () => busy,
    receive: (session, shared) => { current = session; message = shared ? 'shared' : 'restored'; },
    clear: text => { current = undefined; pending = ''; busy = false; message = text; },
    warning: text => { warning = text; }
  });
  return {
    bridge, channel, storage: sessionStorage, current: () => current, message: () => message, warning: () => warning,
    login() {
      const nonce = bridge.invalidate('重新連線');
      current = {version: 1, id: crypto.randomUUID(), ...context, account: {id: context.accountId, email: 'a@example.com'}, scope: CALENDAR_SCOPE, token: 'short-lived-token', expiresAt: Date.now() + 3600000, nonce};
      bridge.remember(current); return current;
    },
    pending(value) { pending = value; busy = true; },
    disconnect() { bridge.invalidate('已解除連線', current?.nonce || pending || undefined); current = undefined; pending = ''; busy = false; }
  };
}

test('分頁憑證驗證期限、Client ID、帳號、資料世代及失效識別，讀取只保留已定義欄位', () => {
  const nonce = crypto.randomUUID(), now = Date.now();
  const session = {version: 1, id: 'session', clientId: context.clientId, generation: context.generation, account: {id: 'account', email: 'a@example.com'}, scope: CALENDAR_SCOPE, token: 'token', expiresAt: now + 10000, nonce, client_secret: 'discard'};
  assert.equal(readGoogleSession(session, context, nonce, now).client_secret, undefined);
  for (const patch of [{version: 2}, {clientId: 'other'}, {generation: 'other'}, {account: {id: 'other', email: 'a@example.com'}}, {expiresAt: now}, {expiresAt: now + 86400001}, {expiresAt: '999'}, {nonce: 'old'}, {scope: 'write'}, {token: 'has whitespace'}]) assert.equal(readGoogleSession({...session, ...patch}, context, nonce, now), undefined);
});

test('sessionStorage 可恢復未到期憑證，重新整理不延長期限，到期後清除', () => {
  const local = storage(), sessions = storage(), first = tab(local, undefined, sessions);
  first.bridge.activate(context);
  const session = first.login();
  first.bridge.close();
  const second = tab(local, undefined, sessions);
  second.bridge.activate(context);
  assert.equal(second.current().token, session.token);
  assert.equal(second.current().expiresAt, session.expiresAt);
  assert.equal(second.message(), 'restored');
  second.bridge.close();
  const originalNow = Date.now;
  Date.now = () => session.expiresAt;
  try {
    const third = tab(local, undefined, sessions);
    third.bridge.activate(context);
    assert.equal(third.current(), undefined);
    assert.equal(sessions.getItem(GOOGLE_SESSION_KEY), null);
    third.bridge.close();
  } finally { Date.now = originalNow; }
});

test('新分頁從已連線分頁接續相同憑證，僅保存至各自 sessionStorage', async () => {
  const local = storage(), bus = messaging(), first = tab(local, bus), second = tab(local, bus);
  try {
    first.bridge.activate(context);
    const session = first.login(); await settle();
    second.bridge.activate(context); await settle();
    assert.equal(second.current().id, session.id);
    assert.equal(second.current().expiresAt, session.expiresAt);
    assert.equal(second.message(), 'shared');
    assert.equal(JSON.parse(second.storage.getItem(GOOGLE_SESSION_KEY)).token, session.token);
    assert.equal([...local.values.values()].join('').includes(session.token), false);
    assert.equal(bus.messages.filter(message => message.type === 'session').every(message => message.target && message.requestId), true);
  } finally { first.bridge.close(); second.bridge.close(); }
});

test('解除連線清除其他分頁，未收到通知的舊分頁也不能在重新整理後復活授權', async () => {
  const local = storage(), bus = messaging(), first = tab(local, bus), second = tab(local, bus), frozen = tab(local, bus);
  try {
    first.bridge.activate(context); first.login();
    second.bridge.activate(context); frozen.bridge.activate(context); await settle();
    assert.ok(second.current()); assert.ok(frozen.current());
    frozen.bridge.close(); // The stored copy deliberately misses the disconnect message.
    first.disconnect(); await settle();
    assert.equal(second.current(), undefined);
    assert.equal(second.storage.getItem(GOOGLE_SESSION_KEY), null);
    assert.ok(frozen.storage.getItem(GOOGLE_SESSION_KEY));
    const resumed = tab(local, bus, frozen.storage);
    resumed.bridge.activate(context); await settle();
    assert.equal(resumed.current(), undefined);
    assert.equal(frozen.storage.getItem(GOOGLE_SESSION_KEY), null);
    resumed.bridge.close();
  } finally { first.bridge.close(); second.bridge.close(); frozen.bridge.close(); }
});

test('錯誤帳號、Client ID 或世代不能分享或還原；過期與延遲回覆皆拒絕', async () => {
  const local = storage(), bus = messaging(), first = tab(local, bus), second = tab(local, bus);
  try {
    first.bridge.activate(context); const session = first.login(); await settle();
    for (const patch of [{accountId: 'other'}, {clientId: '456-other.apps.googleusercontent.com'}, {generation: 'new-generation'}]) {
      second.bridge.activate({...context, ...patch}); await settle();
      assert.equal(second.current(), undefined);
    }
    second.bridge.activate(context);
    const request = bus.messages.filter(message => message.type === 'request').at(-1);
    first.disconnect(); await settle();
    second.channel.onmessage({data: {type: 'session', context, session, target: request.sender, requestId: request.requestId}});
    assert.equal(second.current(), undefined);
    second.bridge.activate(context);
    second.channel.onmessage({data: {type: 'session', context, session: {...session, expiresAt: Date.now() - 1}, target: request.sender, requestId: request.requestId}});
    assert.equal(second.current(), undefined);
  } finally { first.bridge.close(); second.bridge.close(); }
});

test('另一分頁解除連線時取消尚未完成的授權，舊取消通知不能清除新連線', async () => {
  const local = storage(), bus = messaging(), first = tab(local, bus), second = tab(local, bus);
  try {
    first.bridge.activate(context); second.bridge.activate(context); await settle();
    const nonce = first.bridge.invalidate('開始授權'); first.pending(nonce); await settle();
    second.disconnect(); await settle();
    assert.equal(first.message(), '已解除連線');
    const oldClear = bus.messages.filter(message => message.type === 'clear').at(-1);
    const session = second.login(); await settle();
    assert.equal(first.current().id, session.id);
    first.channel.onmessage({data: oldClear});
    assert.equal(first.current().id, session.id);
  } finally { first.bridge.close(); second.bridge.close(); }
});

test('瀏覽器阻擋保存時提示，不能把憑證改存 localStorage 或從舊副本恢復', () => {
  const local = storage();
  const blocked = {getItem: () => null, setItem: () => { throw new Error('blocked'); }, removeItem: () => {}};
  const first = tab(local, undefined, blocked);
  first.bridge.activate(context); const session = first.login();
  assert.ok(first.current());
  assert.match(first.warning(), /無法保存/);
  assert.equal([...local.values.values()].join('').includes(session.token), false);
  first.bridge.close();
  const second = tab(blocked, undefined, first.storage);
  second.bridge.activate(context);
  assert.equal(second.current(), undefined);
  second.bridge.close();
});
