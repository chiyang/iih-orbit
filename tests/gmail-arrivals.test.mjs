import assert from 'node:assert/strict';
import {after, test} from 'node:test';
import {createRequire} from 'node:module';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const require = createRequire(import.meta.url), {build} = createRequire(require.resolve('@angular/build/package.json'))('esbuild');
await mkdir('.angular', {recursive: true});
const directory = await mkdtemp(resolve('.angular/arrivals-test-')), output = resolve(directory, 'arrivals.mjs');
await build({stdin: {contents: "export * from './src/app/gmail-arrivals.ts'; export {GoogleHttpError} from './src/app/google-api.ts';", resolveDir: process.cwd()}, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: output, tsconfig: 'tsconfig.json'});
const {GmailArrivalTracker, readGmailArrivalState, GoogleHttpError} = await import(pathToFileURL(output).href);
after(() => rm(directory, {recursive: true, force: true}));

const context = JSON.stringify(['generation', 'client', 'account']);
const initial = () => ({version: 1, context, historyId: '100', checkedAt: 2000, pending: [], viewed: []});
const mail = (id, labels = ['INBOX', 'UNREAD']) => ({id, threadId: 'thread-' + id, labelIds: labels});

test('首次建立基準不把舊未讀當新郵件；只追蹤新增且仍在收件匣未讀的信件', async () => {
  const saved = [], calls = [];
  const request = async (path, params) => {
    calls.push([path, params]);
    if (path === 'profile') return {historyId: '100'};
    if (path === 'history') return {historyId: '120', history: [{messagesAdded: ['new1', 'new2', 'sent', 'read'].map(id => ({message: {id}})), labelsAdded: [{message: {id: 'old-unread'}}]}]};
    if (path === 'messages/sent') return mail('sent', ['SENT', 'UNREAD']);
    if (path === 'messages/read') return mail('read', ['INBOX']);
    return mail(path.slice(9));
  };
  const tracker = new GmailArrivalTracker(context, request, undefined, state => saved.push(state));
  await tracker.check(() => true); assert.equal(saved.at(-1).pending.length, 0); assert.equal(calls.length, 1);
  await tracker.check(() => true); assert.deepEqual(saved.at(-1).pending.map(mail => mail.id).sort(), ['new1', 'new2']);
  assert.equal(calls.some(([path]) => path === 'messages/old-unread'), false);
});

test('Orbit 查看紀錄在重載後保留，不修改 Gmail 已讀；重複新增、刪除及外部已讀會正確減少提示', async () => {
  let saved = {...initial(), pending: [mail('one'), mail('two')].map(({id, threadId}) => ({id, threadId}))};
  const tracker = new GmailArrivalTracker(context, async () => {throw new Error('acknowledgement must not call Gmail');}, saved, state => {saved = state;});
  tracker.acknowledge(['one']); assert.deepEqual(saved.pending.map(mail => mail.id), ['two']);
  const restored = readGmailArrivalState(saved, context); assert.ok(restored); assert.equal(readGmailArrivalState(saved, 'other-account'), undefined);
  const next = new GmailArrivalTracker(context, async path => path === 'history' ? {historyId: '130', history: [{messagesAdded: [{message: {id: 'one'}}], labelsRemoved: [{message: {id: 'two'}}]}]} : mail(path.slice(9), ['INBOX']), restored, state => {saved = state;});
  await next.check(() => true); assert.equal(saved.pending.length, 0); assert.deepEqual(saved.viewed, ['one']);
});

test('查看發生於新郵件請求途中，遲到回覆不會重新增加通知', async () => {
  let saved = initial(), release;
  const tracker = new GmailArrivalTracker(context, async path => {
    if (path === 'history') return {historyId: '150', history: [{messagesAdded: [{message: {id: 'new'}}]}]};
    return new Promise(resolve => {release = resolve;});
  }, saved, state => {saved = state;});
  const checking = tracker.check(() => true);
  await new Promise(resolve => setImmediate(resolve)); tracker.acknowledge(['new']); release(mail('new')); await checking;
  assert.equal(saved.pending.length, 0); assert.equal(saved.historyId, '150'); assert.deepEqual(saved.viewed, ['new']);
});

test('分頁全部完成才更新游標，重複分頁及中途失敗保留原有提示與基準', async () => {
  let saved = initial(), fail = true;
  const tracker = new GmailArrivalTracker(context, async (path, params) => {
    if (path !== 'history') return mail(path.slice(9));
    if (!params.pageToken) return {historyId: '200', nextPageToken: 'second', history: [{messagesAdded: [{message: {id: 'first'}}]}]};
    if (fail) throw new Error('network');
    return {historyId: '200', history: [{messagesAdded: [{message: {id: 'second'}}]}]};
  }, saved, state => {saved = state;});
  await assert.rejects(tracker.check(() => true), /network/); assert.equal(saved.historyId, '100'); assert.equal(saved.pending.length, 0);
  fail = false; await tracker.check(() => true); assert.equal(saved.historyId, '200'); assert.equal(saved.pending.length, 2);
  const broken = new GmailArrivalTracker(context, async () => ({historyId: '300', nextPageToken: 'repeat'}), saved, state => {saved = state;});
  await assert.rejects(broken.check(() => true), /未前進/); assert.equal(saved.historyId, '200');
});

test('歷史游標過期時重查上次檢查後的未讀收件匣，保留查看紀錄並移除已讀提示', async () => {
  let saved = {...initial(), pending: [{id: 'old', threadId: 'thread-old'}], viewed: ['seen']}, query;
  const tracker = new GmailArrivalTracker(context, async (path, params) => {
    if (path === 'history') throw new GoogleHttpError(404);
    if (path === 'profile') return {historyId: '400'};
    if (path === 'messages') {query = params; return {messages: [{id: 'new'}, {id: 'seen'}]};}
    return mail(path.slice(9), path.endsWith('/old') ? ['INBOX'] : ['INBOX', 'UNREAD']);
  }, saved, state => {saved = state;});
  await tracker.check(() => true);
  assert.equal(query.labelIds, 'INBOX'); assert.equal(query.q, 'is:unread after:1');
  assert.equal(saved.historyId, '400'); assert.deepEqual(saved.pending.map(mail => mail.id), ['new']);
});

test('帳號變更、權限失效或格式錯誤不套用部分新郵件結果', async () => {
  let saved = initial(), current = true, release;
  const tracker = new GmailArrivalTracker(context, () => new Promise(resolve => {release = resolve;}), saved, state => {saved = state;});
  const checking = tracker.check(() => current); current = false; release({historyId: '200'});
  await assert.rejects(checking, /已變更/); assert.equal(saved.historyId, '100');
  for (const failure of [new GoogleHttpError(401), new Error('network')]) {
    const failed = new GmailArrivalTracker(context, async () => {throw failure;}, saved, state => {saved = state;});
    await assert.rejects(failed.check(() => true)); assert.equal(saved.historyId, '100');
  }
  const malformed = new GmailArrivalTracker(context, async () => ({historyId: '500', history: [{messagesAdded: [{message: {id: '../bad'}}]}]}), saved, state => {saved = state;});
  await assert.rejects(malformed.check(() => true), /識別碼/); assert.equal(saved.historyId, '100');
});

test('同瀏覽器其他分頁的查看紀錄可接續，舊狀態不讓提示復活或覆蓋較新的基準', () => {
  let saved = {...initial(), pending: [{id: 'one', threadId: 'thread-one'}]};
  const tracker = new GmailArrivalTracker(context, async () => {throw new Error('no request expected');}, saved, state => {saved = state;});
  tracker.acknowledge(['one']);
  tracker.adopt({...initial(), pending: [{id: 'one', threadId: 'thread-one'}]}); assert.equal(saved.pending.length, 0);
  tracker.adopt({...initial(), historyId: '200', pending: [{id: 'one', threadId: 'thread-one'}, {id: 'two', threadId: 'thread-two'}]});
  assert.deepEqual(saved.pending.map(mail => mail.id), ['two']); assert.deepEqual(saved.viewed, ['one']);
  tracker.adopt({...initial(), historyId: '150', pending: [{id: 'three', threadId: 'thread-three'}]});
  assert.equal(saved.historyId, '200'); assert.deepEqual(saved.pending.map(mail => mail.id), ['two']);
  tracker.adopt({...initial(), context: 'other-account', historyId: '300'}); assert.equal(saved.historyId, '200');
});
