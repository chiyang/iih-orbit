import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DocumentMetadataManager, DOCUMENT_METADATA_TTL} from '../src/app/document-metadata-manager.ts';
import {DRIVE_FOLDER_MIME, DRIVE_SHORTCUT_MIME, readDriveBrowserEntry, sourceFromDriveEntry} from '../src/app/drive-browser-data.ts';
import {GoogleHttpError} from '../src/app/google-api.ts';
import {documentLocationLabel} from '../src/app/document-data.ts';
import {syncHash} from '../src/app/drive-data.ts';
import {backup} from './helpers/backup-cloud.mjs';

const raw = (id, name = id, parents = [], mimeType = 'application/pdf', extra = {}) => readDriveBrowserEntry({id, name, parents, mimeType, ...extra});
const source = (id = 'file') => sourceFromDriveEntry(raw(id, '保存名稱'), '保存位置');
function fixture() {
  let now = 1800000000000;
  const calls = [], files = new Map([['root', raw('my-root', 'My Drive', [], DRIVE_FOLDER_MIME)], ['my-root', raw('my-root', 'My Drive', [], DRIVE_FOLDER_MIME)], ['folder', raw('folder', '研究資料夾', ['my-root'], DRIVE_FOLDER_MIME)], ['file', raw('file', '雲端名稱', ['folder'])]]);
  const manager = new DocumentMetadataManager(() => {}, () => now);
  const connection = {id: 'a', key: 'generation/account-a/client-a', label: 'Google Drive', available: true, version: 1, api: {async get(id, resourceKey, signal) {
    calls.push({id, resourceKey, signal}); const file = files.get(id); if (file instanceof Error) throw file; if (!file) throw new GoogleHttpError(404, '檔案'); return structuredClone(file);
  }}};
  manager.setConnections([connection]);
  return {manager, connection, files, calls, tick: value => now += value, now: () => now};
}

test('冷查驗讀取必要節點，多個引用與暖快取共用結果，手動更新才略過 TTL', async () => {
  const f = fixture(), saved = source();
  await Promise.all(Array.from({length: 10}, () => f.manager.refresh([saved])));
  assert.equal(f.calls.filter(call => call.id === 'file').length, 1); assert.equal(f.calls.length, 4);
  const view = f.manager.view(saved); assert.equal(view.source.name, '雲端名稱'); assert.equal(documentLocationLabel(view.source), 'Google Drive / 我的雲端硬碟 / 研究資料夾');
  assert.equal(view.status, 'available'); assert.equal(view.partialLocation, false); assert.equal(saved.name, '保存名稱');
  await f.manager.refresh([saved]); assert.equal(f.calls.length, 4);
  await f.manager.refresh([saved], '', true); assert.equal(f.calls.filter(call => call.id === 'file').length, 2);
  f.tick(DOCUMENT_METADATA_TTL + 1); await f.manager.refresh([saved]); assert.equal(f.calls.filter(call => call.id === 'file').length, 3);
});

test('列表同步名稱與位置節點，父資料夾改名及移動更新任務顯示，不逐檔補查名稱', async () => {
  const f = fixture(), saved = source(); await f.manager.refresh([saved]); const count = f.calls.length;
  const renamed = raw('folder', '新的資料夾名稱', ['my-root'], DRIVE_FOLDER_MIME);
  f.manager.observeList('a', [renamed], {id: 'root', name: '我的雲端硬碟'}, f.now());
  assert.match(documentLocationLabel(f.manager.view(saved).source), /新的資料夾名稱/);
  await f.manager.refresh([saved]); assert.equal(f.calls.length, count);
  f.files.set('new-parent', raw('new-parent', '新上層', ['my-root'], DRIVE_FOLDER_MIME));
  f.manager.observeList('a', [raw('folder', '新的資料夾名稱', ['new-parent'], DRIVE_FOLDER_MIME)], {id: 'new-parent', name: '不作為真實路徑'}, f.now());
  await f.manager.refresh([saved]); assert.equal(f.calls.length, count + 1); assert.equal(f.calls.at(-1).id, 'new-parent');
  assert.match(documentLocationLabel(f.manager.view(saved).source), /新上層 \/ 新的資料夾名稱/);
  assert.equal(f.manager.visibleIn('a', 'folder', {id: 'my-root', name: '我的雲端硬碟'}), false);
  assert.equal(f.manager.visibleIn('a', 'folder', {id: 'new-parent', name: '新上層'}), true);
  assert.equal(f.manager.visibleIn('a', 'folder', {id: 'shared', name: '與我共用', shared: true}), true);
  const firstList = raw('listed', '剛從列表取得', ['my-root']);
  f.manager.observeList('a', [firstList], {id: 'root', name: '我的雲端硬碟'}, f.now());
  await f.manager.refresh([sourceFromDriveEntry(firstList)]); assert.equal(f.calls.length, count + 1);
});

test('舊的查驗回覆與重新開啟的列表快取，不覆蓋已收到的新列表名稱', async () => {
  const f = fixture(), saved = source(); let finish;
  const connection = {...f.connection, api: {get: id => id === 'file' ? new Promise(resolve => finish = resolve) : f.connection.api.get(id)}};
  f.manager.setConnections([connection]); const work = f.manager.refresh([saved]);
  f.manager.observeList('a', [raw('file', '新列表名稱', ['my-root'])], {id: 'root', name: '我的雲端硬碟'}, f.now());
  finish(raw('file', '晚到舊名稱', ['folder'])); await work;
  assert.equal(f.manager.view(saved).source.name, '新列表名稱');
  f.manager.observeList('a', [raw('file', '舊列表快取', ['my-root'])], {id: 'root', name: '我的雲端硬碟'}, f.now(), true);
  assert.equal(f.manager.view(saved).source.name, '新列表名稱');
});

test('祖先讀取失敗、循環與追溯深度上限顯示部分位置，不假定瀏覽路徑或無父項即為根目錄', async () => {
  const f = fixture(), saved = source(); f.files.set('folder', new GoogleHttpError(403, '資料夾'));
  await f.manager.refresh([saved]); let view = f.manager.view(saved);
  assert.equal(view.status, 'available'); assert.equal(view.partialLocation, true); assert.match(documentLocationLabel(view.source), /部分位置/);
  const requests = f.calls.length; await f.manager.refresh([saved]); assert.equal(f.calls.length, requests);
  f.manager.clear(); f.files.set('folder', raw('folder', '循環資料夾', ['file'], DRIVE_FOLDER_MIME)); await f.manager.refresh([saved]);
  assert.equal(f.manager.view(saved).partialLocation, true);
  const orphan = source('orphan'); f.files.set('orphan', raw('orphan', '沒有父項')); await f.manager.refresh([orphan]);
  assert.equal(f.manager.view(orphan).partialLocation, true);
  f.files.set('file', raw('file', '深層檔案', ['parent-0']));
  for (let i = 0; i < 20; i++) f.files.set('parent-' + i, raw('parent-' + i, '第' + i + '層', ['parent-' + (i + 1)], DRIVE_FOLDER_MIME));
  f.manager.clear(); const before = f.calls.length; await f.manager.refresh([saved]);
  assert.ok(f.calls.length - before <= 13); assert.equal(f.manager.view(saved).partialLocation, true);
});

test('共用硬碟根目錄與捷徑自己的位置分開處理，不讀取目標檔案內文或目標位置', async () => {
  const f = fixture();
  f.files.set('shared-root', raw('shared-root', '實驗室硬碟', [], DRIVE_FOLDER_MIME, {driveId: 'shared-root'}));
  f.files.set('shortcut', raw('shortcut', '資料捷徑', ['shared-root'], DRIVE_SHORTCUT_MIME, {shortcutDetails: {targetId: 'target', targetMimeType: 'application/pdf'}}));
  const link = sourceFromDriveEntry(f.files.get('shortcut')); await f.manager.refresh([link]);
  const view = f.manager.view(link); assert.equal(view.partialLocation, false); assert.match(documentLocationLabel(view.source), /實驗室硬碟/);
  assert.match(view.pathNote, /捷徑所在位置/); assert.equal(f.calls.some(call => call.id === 'target'), false);
});

test('404／403 不誤判為確定刪除，trash、401、網路與配額各自區分並保留最後成功資訊', async () => {
  for (const [error, status] of [[new GoogleHttpError(404), 'unavailable'], [new GoogleHttpError(403), 'unavailable'], [new GoogleHttpError(401), 'authorization'], [new TypeError('network'), 'error'], [new GoogleHttpError(429), 'limited'], [new GoogleHttpError(403, '檔案', {reason: 'DAILY_LIMIT_EXCEEDED'}), 'limited'], [new GoogleHttpError(403, '檔案', {reason: 'quotaExceeded'}), 'limited'], [new GoogleHttpError(403, '檔案', {reason: 'insufficientPermissions'}), 'authorization'], [new GoogleHttpError(403, '檔案', {reason: 'SERVICE_DISABLED'}), 'error']]) {
    const f = fixture(), saved = source(); await f.manager.refresh([saved]); f.files.set('file', error);
    await f.manager.refresh([saved], '', true); const view = f.manager.view(saved);
    assert.equal(view.status, status); assert.equal(view.source.name, '雲端名稱'); assert.ok(view.checkedAt);
    if (status === 'unavailable') assert.match(view.label, /可能已刪除或權限變更/);
  }
  const f = fixture(); f.files.set('file', raw('file', '垃圾桶檔案', ['folder'], 'application/pdf', {trashed: true}));
  await f.manager.refresh([source()]); assert.equal(f.manager.view(source()).status, 'trashed');
});

test('失敗到期後重新詢問服務，不用舊的成功快取誤報恢復；重新授權立即重試權限錯誤', async () => {
  const f = fixture(), saved = source(); await f.manager.refresh([saved]); f.files.set('file', new GoogleHttpError(404));
  await f.manager.refresh([saved], '', true); const calls = f.calls.length; f.tick(5 * 60000 + 1); await f.manager.refresh([saved]);
  assert.equal(f.calls.length, calls + 1); assert.equal(f.manager.view(saved).status, 'unavailable');
  f.files.set('file', raw('file', '授權後可讀取', ['folder'])); f.manager.setConnections([{...f.connection, version: 2}]); await f.manager.refresh([saved]);
  assert.equal(f.manager.view(saved).status, 'available'); assert.equal(f.manager.view(saved).source.name, '授權後可讀取');
  f.files.set('folder', new GoogleHttpError(403)); await f.manager.refresh([saved], '', true);
  assert.equal(f.manager.view(saved).partialLocation, true); assert.equal(f.manager.view(saved).status, 'available');
});

test('另一來源仍可讀取時保留成功結果，各帳號／Client ID／世代的權限結果隔離', async () => {
  const f = fixture(), saved = source(); f.files.set('file', new GoogleHttpError(404));
  const second = {...f.connection, id: 'b', key: 'generation/account-b/client-b', label: '研究來源', api: {get: async id => id === 'file' ? raw('file', '另一來源名稱', ['folder']) : f.connection.api.get(id)}};
  f.manager.setConnections([f.connection, second]); await f.manager.refresh([saved]);
  let view = f.manager.view(saved); assert.equal(view.status, 'available'); assert.equal(view.connectionId, 'b'); assert.equal(view.source.name, '另一來源名稱');
  await f.manager.refresh([saved], 'a', true); view = f.manager.view(saved, 'a');
  assert.equal(view.status, 'available'); assert.equal(view.connectionId, 'b'); assert.match(view.alternate, /所選來源/);
  f.manager.setConnections([{...f.connection, key: 'replacement/account-a/client-a', available: false}]);
  view = f.manager.view(saved); assert.equal(view.source.name, saved.name); assert.equal(view.status, 'authorization'); assert.equal(f.manager.stats().checked, 0);
});

test('每來源最多兩筆、全體最多四筆，同時查驗會合併，批次不掃描整份硬碟', async () => {
  const pending = [], active = new Map(), peaks = new Map(); let total = 0, peak = 0;
  const manager = new DocumentMetadataManager();
  const connections = ['a', 'b'].map(id => ({id, key: id, label: id, available: true, version: 1, api: {get(fileId) {
    active.set(id, (active.get(id) ?? 0) + 1); total++; peak = Math.max(peak, total); peaks.set(id, Math.max(peaks.get(id) ?? 0, active.get(id)));
    return new Promise(resolve => pending.push(() => {active.set(id, active.get(id) - 1); total--; resolve(raw(fileId === 'root' ? 'my-root' : fileId));}));
  }}}));
  manager.setConnections(connections);
  let completed = false;
  const work = Promise.all(connections.map(connection => manager.refresh(Array.from({length: 25}, (_, i) => source(connection.id + '-' + i)), connection.id))).then(() => completed = true);
  for (let i = 0; i < 100 && !completed; i++) {await new Promise(resolve => setImmediate(resolve)); for (const finish of pending.splice(0)) finish();}
  await work; assert.equal(peak, 4); assert.deepEqual([...peaks.values()], [2, 2]); assert.ok(manager.metrics.requests <= 54);
});

test('限流尊重 Retry-After 與退避，手動更新也不能立即重打同一來源', async () => {
  const f = fixture(), saved = source(); f.files.set('file', new GoogleHttpError(403, '檔案', {reason: 'userRateLimitExceeded', retryAfterMs: 120000}));
  await f.manager.refresh([saved]); assert.equal(f.manager.view(saved).status, 'limited'); assert.equal(f.calls.length, 1);
  await f.manager.refresh([saved], '', true); assert.equal(f.calls.length, 1);
  f.tick(119999); await f.manager.refresh([saved], '', true); assert.equal(f.calls.length, 1);
  f.tick(2); f.files.set('file', raw('file', '已恢復', ['folder'])); await f.manager.refresh([saved], '', true);
  assert.equal(f.manager.view(saved).status, 'available'); assert.equal(f.manager.view(saved).source.name, '已恢復');
  const long = fixture(); long.files.set('file', new GoogleHttpError(429, '檔案', {retryAfterMs: 2 * 3600000}));
  await long.manager.refresh([saved]); long.tick(3600001); await long.manager.refresh([saved], '', true); assert.equal(long.calls.length, 1);
});

test('離線及背景暫停；恢復只查驗已要求的項目，Gmail 與示範資料不走 Drive 查驗', async () => {
  const f = fixture(), saved = source(); f.manager.setEnvironment(false, true); await f.manager.refresh([saved], '', true);
  assert.equal(f.calls.length, 0); assert.equal(f.manager.view(saved).status, 'offline');
  f.manager.setEnvironment(true, false); await f.manager.refresh([saved]); assert.equal(f.calls.length, 0);
  f.manager.setEnvironment(true, true); await f.manager.refresh([saved]); assert.ok(f.calls.length);
  const before = f.calls.length; await f.manager.refresh([{...saved, provider: 'gmail'}, {...saved, sourceScope: 'demo-drive'}]); assert.equal(f.calls.length, before);
  assert.match(f.manager.view({...saved, provider: 'gmail'}).label, /原信連結/);
});

test('換帳號、token 更新、來源移除及清快取取消舊工作，晚到回覆不能回寫', async () => {
  for (const action of ['account', 'token', 'remove', 'clear']) {
    let finish, signal;
    const manager = new DocumentMetadataManager(), connection = {id: 'a', key: 'account-a', label: 'A', available: true, version: 1, api: {get: (id, resourceKey, value) => {signal = value; return new Promise(resolve => finish = resolve);}}};
    manager.setConnections([connection]); const request = manager.refresh([source()]);
    if (action === 'clear') manager.clear(); else manager.setConnections(action === 'remove' ? [] : [{...connection, key: action === 'account' ? 'account-b' : connection.key, version: 2}]);
    assert.equal(signal.aborted, true); await request; finish(raw('file', '不應顯示'));
    await new Promise(resolve => setImmediate(resolve)); assert.equal(manager.view(source()).source.name, '保存名稱'); assert.equal(manager.stats().checked, 0);
  }
});

test('快取清理可重建，過期整理保留有效紀錄，查驗不改工作資料或同步雜湊', async () => {
  const f = fixture(), saved = backup(1), hash = await syncHash(saved); await f.manager.refresh([source()]);
  assert.equal(f.manager.clear(true), 0); assert.equal(f.manager.view(source()).status, 'available');
  assert.equal(await syncHash(saved), hash); f.tick(DOCUMENT_METADATA_TTL + 1);
  assert.ok(f.manager.clear(true) > 0); assert.equal(f.manager.stats().checked, 0);
  await f.manager.refresh([source()]); assert.equal(f.manager.view(source()).status, 'available');
  assert.ok(f.manager.clear() > 0); assert.equal(f.manager.view(source()).source.name, '保存名稱'); assert.equal(await syncHash(saved), hash);
});
