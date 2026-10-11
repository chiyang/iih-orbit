import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url), {build} = createRequire(require.resolve('@angular/build/package.json'))('esbuild');
await mkdir('.angular', {recursive: true});
const directory = await mkdtemp(resolve('.angular/gmail-cache-test-')), output = resolve(directory, 'cache.mjs');
await build({entryPoints: ['src/app/gmail-cache.ts'], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: output, tsconfig: 'tsconfig.json'});
const {GmailPreviewCache} = await import(pathToFileURL(output).href);
after(() => rm(directory, {recursive: true, force: true}));
const key = 'iih-orbit-gmail-cache-v1';
const scope = (query = '', account = 'account') => JSON.stringify(['generation', 'client', account, ['INBOX'], query]);
const mail = id => ({id: 'mail' + id, threadId: 'thread' + id, from: 'Sender <sender@example.test>', senderName: 'Sender', senderEmail: 'sender@example.test', subject: 'Subject', snippet: 'Preview', receivedAt: 1000, messageId: 'message@example.test', labelIds: ['INBOX']});
const snapshot = (query = '', account = 'account', count = 1) => {
  const messages = Array.from({length: count}, (_, i) => mail(i));
  return {scope: scope(query, account), labels: [{id: 'INBOX', name: 'INBOX', type: 'system'}], messages, summaries: messages.map(mail => ({mail, count: 1, unread: false})), updatedAt: Date.now(), hasMore: false};
};
function storage() {
  const values = new Map();
  globalThis.localStorage = {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key)};
  return values;
}
test('Gmail 快取最多六組、每組 75 封，依使用順序清理；游標只留記憶體且另一帳號不可使用', () => {
  const values = storage(), cache = new GmailPreviewCache();
  for (let i = 0; i < 6; i++) cache.put(snapshot(String(i)));
  cache.get(scope('0')); cache.put(snapshot('6'));
  assert.equal(cache.get(scope('1')), undefined); assert.ok(cache.get(scope('0')));
  const large = {...snapshot('large', 'account', 100), cursor: {streams: [], seen: ['private-cursor'], query: 'large'}}; cache.put(large);
  assert.equal(cache.get(scope('large')).messages.length, 75); assert.equal(cache.get(scope('large')).cursor, undefined); assert.equal(cache.get(scope('large')).hasMore, true);
  assert.equal(JSON.parse(values.get(key)).entries.length, 6); assert.equal(values.get(key).includes('private-cursor'), false);
  const copied = cache.get(scope('0')); copied.messages[0].subject = 'modified'; assert.equal(cache.get(scope('0')).messages[0].subject, 'Subject');
  assert.equal(cache.get(scope('0', 'another')), undefined);
  cache.put(snapshot('0', 'another')); assert.equal(JSON.parse(values.get(key)).entries.length, 1); assert.equal(cache.get(scope('0')), undefined);
  cache.clear(); assert.equal(values.has(key), false); assert.equal(cache.get(scope('0', 'another')), undefined);
});
test('舊版快取可接續成功時間；損壞、未來、過舊與帳號不符的項目不取代有效快取', t => {
  t.mock.timers.enable({apis: ['Date'], now: 100000000});
  const values = storage(), old = snapshot(); values.set(key, JSON.stringify({version: 2, ...old}));
  const migrated = new GmailPreviewCache(); assert.equal(migrated.get(scope()).updatedAt, Date.now());
  assert.equal(migrated.get(scope()).hasMore, false);
  assert.equal(migrated.get(scope('', 'another')), undefined); migrated.put(old); assert.equal(JSON.parse(values.get(key)).version, 3);
  values.set(key, JSON.stringify({version: 3, entries: [old, {...snapshot('future'), updatedAt: Date.now() + 1}, {...snapshot('old'), updatedAt: Date.now() - 86400001}, {...snapshot('broken'), messages: [{id: 'bad'}]}]}));
  const cache = new GmailPreviewCache(); assert.ok(cache.get(scope()));
  for (const query of ['future', 'old', 'broken']) assert.equal(cache.get(scope(query)), undefined);
  t.mock.timers.tick(86400001); assert.equal(cache.get(scope()), undefined);
  values.set(key, '{broken'); assert.equal(new GmailPreviewCache().get(scope()), undefined);
});
test('localStorage 保存失敗仍有記憶體預覽，成功快取不含本文與附件', () => {
  const values = storage(), cache = new GmailPreviewCache(), entry = {...snapshot(), cursor: {streams: [], seen: [], query: ''}};
  entry.messages[0].body = 'PRIVATE-BODY'; entry.messages[0].attachments = ['PRIVATE-ATTACHMENT'];
  cache.put(entry); const reopened = new GmailPreviewCache(); assert.ok(reopened.get(scope())); assert.equal(reopened.get(scope()).cursor, undefined);
  assert.equal(values.get(key).includes('PRIVATE-'), false);
  const original = values.get(key); localStorage.setItem = () => {throw new Error('quota');};
  assert.throws(() => cache.put(snapshot('next')), /quota/); assert.ok(cache.get(scope('next'))); assert.equal(values.get(key), original);
});
test('郵件快取以 UTF-8 實際大小控制在一 MiB，優先清理舊篩選並保留最新結果', () => {
  const values = storage(), cache = new GmailPreviewCache();
  const labels = Array.from({length: 120}, (_, i) => ({id: 'label' + i, name: '信'.repeat(1000), type: 'user'}));
  for (let i = 0; i < 4; i++) cache.put({...snapshot(String(i)), labels});
  assert.ok(Buffer.byteLength(values.get(key)) <= 1024 * 1024); assert.ok(JSON.parse(values.get(key)).entries.length < 4); assert.ok(cache.get(scope('3')));
});
