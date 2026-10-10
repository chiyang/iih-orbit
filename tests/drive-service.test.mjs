import '@angular/compiler';
import {createEnvironmentInjector, runInInjectionContext, signal, ɵChangeDetectionScheduler, ɵEffectScheduler} from '@angular/core';
import assert from 'node:assert/strict';
import {after, test} from 'node:test';
import {createRequire} from 'node:module';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {createDriveDocument, readDriveFile, versionGraph, versionProperties} from '../src/app/drive-data.ts';
import {expiredDriveVersions} from '../src/app/drive-retention.ts';

const require = createRequire(import.meta.url), {build} = createRequire(require.resolve('@angular/build/package.json'))('esbuild');
await mkdir('.angular', {recursive: true});
const directory = await mkdtemp(resolve('.angular/drive-service-test-')), output = resolve(directory, 'drive.mjs');
await build({stdin: {contents: "export {DriveService} from './src/app/drive-service.ts'; export {DrivePanel} from './src/app/drive-panel.ts'; export {DriveAuth} from './src/app/drive-auth.ts'; export {BoardStore} from './src/app/board-store.ts'; export {DriveCollectionDeleted} from './src/app/drive-data.ts';", resolveDir: process.cwd()}, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: output, tsconfig: 'tsconfig.json'});
const {DriveService, DrivePanel, DriveAuth, BoardStore, DriveCollectionDeleted} = await import(pathToFileURL(output).href);
after(() => rm(directory, {recursive: true, force: true}));
const settle = async () => {for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));};

// Signal controllers use memory storage, synthetic lifecycle events and API replies;
// no browser, user data, Google credentials or rendered page is accessed.
async function fixture() {
  const originals = new Map(['window', 'document', 'navigator', 'BroadcastChannel', 'localStorage', 'sessionStorage'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const values = new Map(), stored = new Map(), documents = new Map(), retired = new Map(), removed = new Map(), held = new Set(), channels = new Set(), listeners = new Map(), createdTimes = new Map();
  const createdTime = id => {if (!createdTimes.has(id)) createdTimes.set(id, new Date(Date.UTC(2026, 9, 1) + createdTimes.size * 1000).toISOString()); return createdTimes.get(id);};
  const storage = {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key)};
  const locks = {async request(name, options, callback) {const fn = typeof options === 'function' ? options : callback; if (held.has(name)) return fn(null); held.add(name); try {return await fn({name});} finally {held.delete(name);}}};
  const window = {addEventListener(name, fn) {const list = listeners.get(name) ?? new Set(); list.add(fn); listeners.set(name, list);}, removeEventListener(name, fn) {listeners.get(name)?.delete(fn);}};
  const navigator = {onLine: true, locks};
  class Channel {
    constructor(name) {this.name = name; this.onmessage = null; channels.add(this);}
    postMessage(value) {for (const peer of channels) if (peer !== this && peer.name === this.name) queueMicrotask(() => {if (channels.has(peer)) peer.onmessage?.({data: structuredClone(value)});});}
    close() {channels.delete(this);}
  }
  for (const [key, value] of Object.entries({window, document: {visibilityState: 'visible'}, navigator, BroadcastChannel: Channel, localStorage: storage, sessionStorage: storage})) Object.defineProperty(globalThis, key, {value, configurable: true, writable: true});
  const store = new BoardStore();
  await store.updateGoogle({clientId: '123-example.apps.googleusercontent.com'}); await store.updateDrive({accountId: 'account', email: 'a@example.com'});
  const effects = new Set(), scheduler = {add(e) {effects.add(e); queueMicrotask(() => this.flush());}, schedule() {queueMicrotask(() => this.flush());}, remove(e) {effects.delete(e);}, flush() {for (let i = 0; i < 30 && [...effects].some(e => e.dirty); i++) for (const e of effects) if (e.dirty) e.run();}};
  const auth = {connected: signal(true), connectionVersion: signal(0), ready: signal(true), preparing: signal(false), authorizing: signal(false), account: signal({id: 'account', email: 'a@example.com'}), sessionWarning: signal(''), useSession() {}, cancelRequests() {}, prepare: async () => {}, disconnect() {this.connected.set(false); this.connectionVersion.update(v => v + 1);}};
  const api = {
    removals: async () => [...removed.values()].map(file => structuredClone(file)),
    assertAvailable: async dataset => {if ([...removed.values()].some(file => file.cloud.datasetId === dataset)) throw new DriveCollectionDeleted(dataset);},
    list: async () => [...[...documents].map(([id, doc]) => readDriveFile({id, name: 'Orbit.json', mimeType: 'application/json', size: '100', createdTime: createdTime(id), appProperties: versionProperties(doc)})), ...retired.values()].map(file => structuredClone(file)),
    generateId: async () => 'drive_' + crypto.randomUUID(),
    save: async (doc, id) => {documents.set(id, structuredClone(doc)); return (await api.list()).find(f => f.id === id);},
    read: async file => structuredClone(documents.get(file.id)),
    organize: async () => ({files: await api.list(), changed: 0})
  };
  api.planCollection = async datasetId => ({kind: 'collection', datasetId, files: [...await api.list(), ...await api.removals()].filter(file => file.cloud.datasetId === datasetId)});
  api.trashCollection = async (plan, current, beforeDelete) => {
    const fresh = await api.planCollection(plan.datasetId);
    if (fresh.files.some(file => !plan.files.some(old => old.id === file.id && old.cloud.fileHash === file.cloud.fileHash))) throw new Error('確認期間雲端集合已更新，請重新確認。');
    await beforeDelete(); if (!current()) throw new Error('stale');
    if (fresh.files.length) removed.set(fresh.files[0].id, {...fresh.files[0], trashed: true});
    for (const file of fresh.files) {documents.delete(file.id); retired.delete(file.id);}
    return fresh.files.length;
  };
  api.trash = async (file, current, branchHeads) => {
    if (!current()) throw new Error('stale');
    if (file.cloud.purpose !== 'manual') {
      const heads = versionGraph((await api.list()).filter(value => value.cloud.datasetId === file.cloud.datasetId)).heads;
      if (branchHeads && (heads.length < 2 || !heads.some(head => head.id === file.id) || JSON.stringify(heads.map(head => head.cloud.versionId).sort()) !== JSON.stringify([...branchHeads].sort()))) throw new Error('待選擇的雲端內容已變更，請重新確認');
      if (!branchHeads && heads.some(head => head.id === file.id)) throw new Error('目前資料不能單獨刪除');
      retired.set(file.id, {...structuredClone(file), trashed: true});
    }
    documents.delete(file.id);
  };
  api.pruneHistory = async (current, protectedVersions = []) => {
    const files = await api.list(), expired = expiredDriveVersions(files, protectedVersions, [...removed.values()].map(file => file.cloud.datasetId));
    if (!expired.length) return {files, removed: 0};
    for (const file of expired) await api.trash(file, current);
    return {files: await api.list(), removed: expired.length};
  };
  const repository = {read: async key => structuredClone(stored.get(key) ?? {}), write: async (key, value, current) => {if (current && !current()) throw new Error('obsolete'); stored.set(key, structuredClone(value));}, clear: async () => {stored.clear();}};
  const services = [], injectors = [];
  function create() {
    const injector = createEnvironmentInjector([{provide: BoardStore, useValue: store}, {provide: DriveAuth, useValue: auth}, {provide: ɵEffectScheduler, useValue: scheduler}, {provide: ɵChangeDetectionScheduler, useValue: {notify() {}}}]);
    const service = runInInjectionContext(injector, () => new DriveService()); service.repository = repository; service.api = api;
    services.push(service); injectors.push(injector); return service;
  }
  const service = create(); await settle();
  function panel() {
    const injector = createEnvironmentInjector([{provide: DriveService, useValue: service}, {provide: ɵEffectScheduler, useValue: scheduler}, {provide: ɵChangeDetectionScheduler, useValue: {notify() {}}}]);
    injectors.push(injector); return runInInjectionContext(injector, () => new DrivePanel());
  }
  return {service, create, panel, store, auth, api, stored, documents, retired, removed, navigator, async event(name) {for (const fn of listeners.get(name) ?? []) fn({}); await settle();}, close() {for (const s of services) s.ngOnDestroy(); for (const i of injectors) i.destroy(); store.ngOnDestroy(); for (const [key, descriptor] of originals) {if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];}}};
}

test('自動同步有新版本才整理該集合並更新列表，整理失敗不重複上傳，使用者可單獨重試整理', async () => {
  const f = await fixture(), calls = [];
  try {
    f.api.organize = async (current, id) => {assert.equal(current(), true); calls.push(id); return {files: await f.api.list(), changed: 1};};
    await f.service.start('full', [], 'sync'); const dataset = f.service.runtime().link.datasetId;
    assert.deepEqual(calls, [dataset]); await f.service.sync(false); assert.equal(calls.length, 1);
    await f.store.saveTask({...f.store.tasks()[0], title: '更新列表'}); await f.service.sync(false);
    assert.deepEqual(calls, [dataset, dataset]); assert.equal(f.service.files().length, 2); assert.equal(f.service.error(), '');
    f.api.organize = async () => {throw new Error('搬移暫時失敗');};
    await f.store.saveTask({...f.store.tasks()[0], title: '已保存且可重試整理'}); await f.service.sync(false);
    assert.equal(f.documents.size, 3); assert.equal(f.service.runtime().pending, undefined); assert.equal(f.service.files().length, 3); assert.match(f.service.error(), /備份已保存，資料夾整理未完成/);
    await f.service.sync(false); assert.equal(f.documents.size, 3);
    f.api.organize = async () => ({files: await f.api.list(), changed: 2}); await f.service.organize();
    assert.equal(f.documents.size, 3); assert.equal(f.service.error(), ''); assert.match(f.service.message(), /已整理 2 份檔案/);
    const list = f.api.list; let failList = false;
    f.api.list = async () => {if (failList) throw new Error('清單暫時失敗'); return list();};
    f.api.organize = async () => {failList = true; throw new Error('整理中斷');};
    await f.store.saveTask({...f.store.tasks()[0], title: '保存成功後無法更新清單'}); await f.service.sync(false);
    assert.equal(f.documents.size, 4); assert.equal(f.service.runtime().pending, undefined); assert.match(f.service.error(), /備份已保存.*清單未更新/);
    assert.equal(f.service.catalogFresh(), false); assert.equal(f.service.catalogState(), 'error'); assert.match(f.service.catalogError(), /清單未更新/);
    failList = false; await f.service.list(); assert.equal(f.service.catalogFresh(), true);
  } finally {f.close();}
});

test('既有自動備份讀取後保留八份，之後每次保存也維持八份，手動另存保留', async () => {
  const f = await fixture();
  try {
    const {backup} = await f.store.driveSnapshot('full', []), dataset = crypto.randomUUID(); let parent;
    for (let i = 0; i < 12; i++) {
      const document = await createDriveDocument(backup, dataset, parent ? [parent] : [], 'backup');
      await f.api.save(document, 'existing_backup_' + i); parent = document.cloud.versionId;
    }
    await f.service.manual('full', []);
    assert.equal(f.documents.size, 9); assert.equal(f.retired.size, 4); assert.equal(f.service.catalogFresh(), true);
    const latest = f.service.files().find(file => file.cloud.versionId === parent);
    await f.service.join(latest, f.store.revision());
    for (let i = 0; i < 3; i++) {await f.store.saveTask({...f.store.tasks()[0], title: '保存後清理 ' + i}); await f.service.sync(false);}
    assert.equal(f.documents.size, 9); assert.equal(f.retired.size, 7); assert.equal(f.service.runtime().pending, undefined);
    const group = f.panel().catalog().collections[0]; assert.equal(group.heads.length, 1); assert.equal(group.history.length, 7);
    assert.equal(f.service.cleanupError(), ''); assert.equal(f.service.runtime().conflict, undefined);
  } finally {f.close();}
});

test('清理失敗不把成功保存或雲端清單當成失敗，下次讀取會重試並清除提示', async () => {
  const f = await fixture();
  try {
    await f.service.start('full', [], 'sync'); const prune = f.api.pruneHistory;
    f.api.pruneHistory = async () => {throw new Error('垃圾桶暫時無法寫入');};
    await f.store.saveTask({...f.store.tasks()[0], title: '清理失敗但已保存'}); await f.service.sync(false);
    assert.equal(f.documents.size, 2); assert.equal(f.service.runtime().pending, undefined); assert.equal(f.service.error(), '');
    assert.equal(f.service.catalogFresh(), true); assert.equal(f.service.files().length, 2); assert.match(f.service.cleanupError(), /下次讀取會重試.*垃圾桶/);
    f.api.pruneHistory = prune; await f.service.list(); assert.equal(f.service.cleanupError(), ''); assert.equal(f.service.catalogFresh(), true);
  } finally {f.close();}
});

test('清理依跨分頁儲存的基準及佇列保護舊版本，基準接續後才清理', async () => {
  const f = await fixture();
  try {
    await f.service.start('full', [], 'sync'); const root = f.service.files()[0], {backup} = await f.store.driveSnapshot('full', []);
    let parent = root.cloud.versionId;
    for (let i = 1; i < 12; i++) {
      const document = await createDriveDocument(backup, root.cloud.datasetId, [parent], 'sync'); await f.api.save(document, 'remote_backup_' + i); parent = document.cloud.versionId;
    }
    // A peer persisted a queued version after this service last read runtime.
    const context = [...f.stored.keys()][0], state = f.stored.get(context);
    const pending = await createDriveDocument(backup, root.cloud.datasetId, [root.cloud.versionId], 'sync');
    state.pending = {fileId: 'pending_upload', document: pending};
    await f.service.list(); assert.ok(f.documents.has(root.id)); assert.equal(f.documents.size, 9); assert.equal(f.service.runtime().pending.fileId, 'pending_upload');
    const latestState = f.stored.get(context); delete latestState.pending; latestState.link.baseVersionId = parent;
    await f.service.list(); assert.equal(f.documents.size, 8); assert.equal(f.documents.has(root.id), false);
  } finally {f.close();}
});

test('檔案整理共用跨分頁鎖，另一分頁不能重複操作，同帳號重新授權後忽略舊整理回覆', async () => {
  const f = await fixture(); const peer = f.create(); await settle(); let finish, calls = 0;
  try {
    f.api.organize = () => {calls++; return new Promise(resolve => {finish = resolve;});};
    const organizing = f.service.organize(); while (!finish) await new Promise(resolve => setImmediate(resolve));
    await settle(); assert.equal(peer.busy(), true); await peer.organize(); assert.equal(calls, 1);
    f.auth.connectionVersion.update(value => value + 1); finish({files: [{id: 'old_account_file'}], changed: 10}); await organizing;
    assert.deepEqual(f.service.files(), []); assert.equal(f.service.message().includes('已整理'), false); assert.match(f.service.error(), /連線或設定已變更/);
  } finally {f.close();}
});

test('Drive 面板顯示目前資料與摘要，避免重新套用目前內容，多份最新內容仍可選用', async () => {
  const f = await fixture();
  try {
    await f.service.start('full', [], 'sync'); const panel = f.panel(); await settle();
    const rootFile = f.service.files()[0]; await panel.inspect(rootFile); assert.equal(panel.canJoin(), true); assert.equal(panel.useAction(), null); assert.ok(panel.savedAppearance());
    await f.store.saveTask({...f.store.tasks()[0], title: '新的集合版本'}); await f.service.sync();
    assert.equal(panel.currentCollection().heads.length, 1); assert.equal(panel.currentCollection().history.length, 1); assert.equal(panel.canJoin(), false);
    const latest = panel.currentCollection().heads[0]; await panel.inspect(latest); assert.equal(panel.canJoin(), true); assert.equal(panel.useAction(), null);
    const document = [...f.documents.values()].find(value => value.cloud.versionId === rootFile.cloud.versionId);
    const branch = await createDriveDocument(document, document.cloud.datasetId, [document.cloud.versionId], 'sync');
    f.documents.set('branch_' + branch.cloud.versionId, branch); await f.service.list(); assert.equal(panel.currentCollection().heads.length, 2); assert.equal(panel.canJoin(), true);
    await f.service.manual('workspaces', [f.store.currentWorkspace().id]); const manual = panel.catalog().manual[0]; await panel.inspect(manual);
    assert.equal(panel.canJoin(), false); assert.equal(panel.useAction(), null); assert.equal(panel.fileScope(manual), f.store.currentWorkspace().name); assert.equal(panel.savedAppearance(), null);
  } finally {f.close();}
});

test('刪除目前集合先停止自動處理、取消其待上傳版本，共用分頁更新列表，本機修改與其他集合保留', async () => {
  const f = await fixture(); let peer;
  try {
    await f.service.start('full', [], 'sync'); const dataset = f.service.runtime().link.datasetId;
    await f.service.manual('full', []); const independent = (await f.api.list()).find(file => file.cloud.purpose === 'manual');
    await f.store.saveTask({...f.store.tasks()[0], title: '本機未上傳修改'}); f.api.save = async () => {throw new Error('offline');}; await f.service.sync();
    assert.ok(f.service.runtime().pending); const local = structuredClone(f.store.workspaces());
    peer = f.create(); await settle(); await peer.list();
    const review = await f.service.prepareRemoval(dataset); assert.equal(review.currentCollection, true); assert.ok(review.pendingVersion);
    const trash = f.api.trashCollection;
    f.api.trashCollection = async (plan, current, beforeDelete) => trash(plan, current, async () => {await beforeDelete(); assert.equal(f.store.drive().mode, 'off'); assert.equal(f.service.runtime().pending, undefined); assert.equal(f.service.runtime().link, undefined);});
    assert.equal(await f.service.remove(review), true); await settle();
    assert.deepEqual(f.store.workspaces(), local); assert.equal(f.service.runtime().conflict, undefined); assert.equal(peer.runtime().link, undefined); assert.equal(peer.files().length, 1); assert.equal(peer.files()[0].id, independent.id);
    assert.equal(f.documents.size, 1); assert.equal(f.service.files()[0].id, independent.id); assert.match(f.service.message(), /本機工作資料保留/);
  } finally {f.close();}
});

test('刪除非目前集合保留現有同步連結與其他待上傳佇列，獨立備份也能單獨刪除', async () => {
  const f = await fixture();
  try {
    await f.service.start('full', [], 'backup'); const old = f.service.runtime().link.datasetId;
    await f.service.start('full', [], 'sync'); const linked = f.service.runtime().link.datasetId;
    await f.service.manual('full', []); const independent = (await f.api.list()).find(file => file.cloud.purpose === 'manual');
    await f.store.saveTask({...f.store.tasks()[0], title: '保留這份待上傳'}); f.api.save = async () => {throw new Error('offline');}; await f.service.sync();
    const pending = structuredClone(f.service.runtime().pending), local = structuredClone(f.store.workspaces());
    const review = await f.service.prepareRemoval(old); assert.equal(review.currentCollection, false); assert.equal(review.pendingVersion, '');
    assert.equal(await f.service.remove(review), true); assert.equal(f.store.drive().mode, 'sync'); assert.equal(f.service.runtime().link.datasetId, linked); assert.deepEqual(f.service.runtime().pending, pending);
    const fileReview = await f.service.prepareRemoval(independent); assert.equal(fileReview.kind, 'file'); assert.equal(await f.service.remove(fileReview), true);
    assert.equal(f.documents.size, 1); assert.equal(f.service.runtime().link.datasetId, linked); assert.deepEqual(f.store.workspaces(), local); assert.deepEqual(f.service.runtime().pending, pending);
  } finally {f.close();}
});

test('確認期間雲端更新、待上傳變更或重新授權都拒絕刪除；刪除失敗保持自動處理關閉且可重新確認繼續', async () => {
  const f = await fixture();
  try {
    await f.service.start('full', [], 'sync'); const dataset = f.service.runtime().link.datasetId;
    const first = await f.service.prepareRemoval(dataset); await f.store.saveTask({...f.store.tasks()[0], title: '確認後又更新'}); await f.service.sync();
    assert.equal(await f.service.remove(first), false); assert.equal(f.store.drive().mode, 'sync'); assert.equal(f.documents.size, 2); assert.match(f.service.error(), /雲端集合已更新/);
    const second = await f.service.prepareRemoval(dataset); f.auth.connectionVersion.update(value => value + 1); assert.equal(await f.service.remove(second), false); assert.equal(f.documents.size, 2);
    const pendingReview = await f.service.prepareRemoval(dataset), save = f.api.save;
    f.api.save = async () => {throw new Error('離線');}; await f.store.saveTask({...f.store.tasks()[0], title: '確認之後才進入佇列'}); await f.service.sync();
    assert.ok(f.service.runtime().pending); assert.equal(await f.service.remove(pendingReview), false); assert.equal(f.store.drive().mode, 'sync'); assert.equal(f.documents.size, 2); assert.match(f.service.error(), /待上傳內容已變更/);
    f.api.save = save; await f.service.retry();
    const third = await f.service.prepareRemoval(dataset), trash = f.api.trashCollection;
    f.api.trashCollection = async (plan, current, beforeDelete) => {await beforeDelete(); f.removed.set(plan.files[0].id, {...plan.files[0], trashed: true}); f.documents.delete(plan.files[0].id); throw new Error('搬入垃圾桶中斷');};
    assert.equal(await f.service.remove(third), false); assert.equal(f.store.drive().mode, 'off'); assert.equal(f.service.runtime().link, undefined); assert.match(f.service.error(), /刪除尚未完成/);
    const panel = f.panel(); await settle(); assert.equal(panel.catalog().collections[0].deleting, true); await panel.inspect(panel.catalog().collections[0].heads[0]); assert.equal(panel.canJoin(), false);
    f.api.trashCollection = trash; const resumed = await f.service.prepareRemoval(dataset); assert.equal(await f.service.remove(resumed), true); assert.equal(f.documents.size, 0);
  } finally {f.close();}
});

test('其他裝置刪除集合後，自動備份及同步停止，待上傳不被重送，本機內容保留並可建立新集合', async () => {
  for (const mode of ['backup', 'sync']) {
    const f = await fixture();
    try {
      await f.service.start('full', [], mode); const file = f.service.files()[0];
      f.removed.set(file.id, {...file, trashed: true}); f.documents.delete(file.id);
      await f.store.saveTask({...f.store.tasks()[0], title: '遠端刪除後本機仍在'}); const local = structuredClone(f.store.workspaces());
      await f.service.sync(false); assert.equal(f.store.drive().mode, 'off'); assert.equal(f.documents.size, 0); assert.deepEqual(f.store.workspaces(), local); assert.match(f.service.status(), /找不到雲端資料/);
      await f.service.start('full', [], mode); assert.equal(f.documents.size, 1); assert.notEqual(f.service.runtime().link.datasetId, file.cloud.datasetId); assert.deepEqual(f.store.workspaces(), local);
    } finally {f.close();}
  }
});

test('面板刪除需明確確認，取消不改變資料；設定變更會停用舊確認', async () => {
  const f = await fixture();
  try {
    await f.service.start('full', [], 'sync'); const dataset = f.service.runtime().link.datasetId, panel = f.panel(); await settle();
    await panel.requestRemoval(dataset); assert.equal(panel.removalCount(), 1); assert.equal(panel.removalPhrase(), '刪除這份雲端資料');
    await panel.confirmRemoval(); assert.equal(f.documents.size, 1); panel.cancelRemoval(); assert.equal(panel.removal(), null); assert.equal(f.store.drive().mode, 'sync');
    await panel.requestRemoval(dataset); panel.removalConfirmation = '刪除這份雲端資料'; await f.store.updateDrive({debounceSeconds: 30}); assert.equal(panel.removalStale(), true); await panel.confirmRemoval(); assert.equal(f.documents.size, 1);
    await panel.requestRemoval(dataset); panel.removalConfirmation = panel.removalPhrase(); await panel.confirmRemoval(); assert.equal(f.documents.size, 0); assert.equal(panel.removal(), null); assert.equal(f.store.drive().mode, 'off');
  } finally {f.close();}
});

test('本機無法持久保存停止設定時不刪除雲端，恢復儲存後可以重新確認', async () => {
  const f = await fixture();
  try {
    await f.service.start('full', [], 'sync'); const review = await f.service.prepareRemoval(f.service.runtime().link.datasetId), local = structuredClone(f.store.workspaces());
    const write = localStorage.setItem;
    localStorage.setItem = (key, value) => {if (key === 'orbit-workspaces-v2') throw new Error('儲存空間已滿'); write(key, value);};
    assert.equal(await f.service.remove(review), false); assert.equal(f.documents.size, 1); assert.equal(f.removed.size, 0); assert.equal(f.store.drive().mode, 'sync'); assert.deepEqual(f.store.workspaces(), local);
    localStorage.setItem = write;
    assert.equal(await f.service.remove(await f.service.prepareRemoval(review.datasetId)), true); assert.equal(f.documents.size, 0);
  } finally {f.close();}
});

test('遠端刪除且垃圾桶已清空時，可以解除剩餘本機連結與佇列後建立新集合', async () => {
  const f = await fixture();
  try {
    await f.service.start('full', [], 'sync'); const dataset = f.service.runtime().link.datasetId, save = f.api.save;
    await f.store.saveTask({...f.store.tasks()[0], title: '保留清空垃圾桶後的本機修改'}); f.api.save = async () => {throw new Error('offline');}; await f.service.sync();
    assert.ok(f.service.runtime().pending); f.documents.clear();
    const review = await f.service.prepareRemoval(dataset); assert.equal(review.files.length, 0); assert.equal(review.label, '全部資料'); assert.ok(review.pendingVersion);
    const panel = f.panel(); await settle(); panel.removal.set(review); assert.equal(panel.removalCount(), 0); panel.removalConfirmation = panel.removalPhrase(); await panel.confirmRemoval();
    assert.equal(f.service.runtime().link, undefined); assert.equal(f.service.runtime().pending, undefined); assert.equal(f.store.drive().mode, 'off');
    f.api.save = save; await f.service.start('full', [], 'sync'); assert.equal(f.documents.size, 1); assert.notEqual(f.service.runtime().link.datasetId, dataset);
    assert.equal(f.store.tasks()[0].title, '保留清空垃圾桶後的本機修改');
  } finally {f.close();}
});

test('刪除獨立備份的雲端副本只刪選定檔案，不取消另一個檔案識別碼的待上傳版本', async () => {
  const f = await fixture();
  try {
    const save = f.api.save;
    f.api.save = async (document, id) => {await save(document, id); throw new Error('保存後回覆遺失');};
    await f.service.manual('full', []); const pending = structuredClone(f.service.runtime().pending);
    const copyId = 'copy_' + crypto.randomUUID(); f.documents.set(copyId, structuredClone(pending.document));
    const copy = (await f.api.list()).find(file => file.id === copyId), review = await f.service.prepareRemoval(copy);
    assert.equal(review.kind, 'file'); assert.equal(review.pendingVersion, '');
    assert.equal(await f.service.remove(review), true); assert.equal(f.documents.has(copyId), false); assert.equal(f.documents.has(pending.fileId), true); assert.deepEqual(f.service.runtime().pending, pending);
  } finally {f.close();}
});

test('Drive 控制器建立集合、保存本機修改，列表更新保留成功提示與已保存狀態', async () => {
  const f = await fixture();
  try {
    await f.service.start('full', [], 'sync'); await settle(); assert.equal(f.store.drive().mode, 'sync'); assert.equal(f.documents.size, 1); assert.match(f.service.message(), /已開啟自動儲存/); assert.equal(f.service.error(), '');
    const task = f.store.tasks()[0]; await f.store.saveTask({...task, title: '新的進度'}); await f.service.sync();
    assert.equal(f.documents.size, 2); assert.equal(f.service.runtime().pending, undefined); assert.match(f.service.status(), /自動儲存已開啟/); assert.equal(f.service.error(), '');
    await f.service.manual('workspaces', [f.store.currentWorkspace().id]); assert.equal(f.documents.size, 3); assert.match(f.service.message(), /已另存一份備份/); assert.equal(f.service.files().length, 3);
  } finally {f.close();}
});

test('只更改主題色時，全部資料自動備份在等待時間後保存完整外觀與提醒設定', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const f = await fixture();
  try {
    await f.service.start('full', [], 'backup'); await f.service.sync(); await settle();
    const count = f.documents.size, sync = t.mock.method(f.service, 'sync', f.service.sync.bind(f.service));
    await f.store.updateAppearance({accent: '#3264ad'}); await settle();
    t.mock.timers.tick(14999); await settle(); assert.equal(sync.mock.callCount(), 0); assert.equal(f.documents.size, count);
    t.mock.timers.tick(1); assert.equal(sync.mock.callCount(), 1); await sync.mock.calls[0].result; assert.equal(f.documents.size, count + 1);
    assert.deepEqual([...f.documents.values()].at(-1).preferences, f.store.appearance());
    await f.store.updateAppearance({theme: 'dark', textSize: 'compact'});
    await f.store.updateReminders({leadMinutes: 60}); await settle();
    t.mock.timers.tick(15000); assert.equal(sync.mock.callCount(), 2); await sync.mock.calls[1].result; assert.equal(f.documents.size, count + 2);
    const saved = [...f.documents.values()].at(-1);
    assert.deepEqual(saved.preferences, f.store.appearance()); assert.equal(saved.reminders.leadMinutes, 60);
    t.mock.timers.tick(15000); await settle(); assert.equal(f.documents.size, count + 2);
  } finally {f.close(); t.mock.timers.reset();}
});

test('另一個分頁顯示 Drive 處理中並拒絕重複備份，完成後讀取同一個待上傳狀態', async () => {
  const f = await fixture(); const peer = f.create(); await settle(); let finish;
  try {
    f.api.save = () => new Promise(resolve => {finish = resolve;});
    const saving = f.service.manual('full', []);
    while (!finish) await new Promise(resolve => setImmediate(resolve)); await settle(); assert.equal(peer.busy(), true); assert.match(peer.status(), /處理中/);
    await peer.manual('full', []); assert.equal(f.stored.size, 1);
    finish({}); await saving; await settle(); assert.equal(peer.busy(), false); assert.equal(peer.runtime().pending, undefined); assert.ok(peer.runtime().lastSavedAt);
  } finally {f.close();}
});

test('帳號切換後延遲上傳不清除舊佇列，延遲列表也不帶入另一帳號', async () => {
  const f = await fixture(); let finish;
  try {
    f.api.save = () => new Promise(resolve => {finish = resolve;}); const saving = f.service.manual('full', []);
    while (!finish) await new Promise(resolve => setImmediate(resolve)); const oldKey = f.service.context;
    await f.store.updateDrive({accountId: 'other', email: 'other@example.com', mode: 'off'}); await settle(); finish({}); await saving;
    assert.ok(f.stored.get(oldKey).pending); assert.deepEqual(f.service.runtime(), {}); assert.equal(f.service.files().length, 0);
    let listFinish; f.api.list = () => new Promise(resolve => {listFinish = resolve;}); const listing = f.service.list(); while (!listFinish) await new Promise(resolve => setImmediate(resolve));
    await f.store.updateDrive({accountId: 'third', email: 'third@example.com'}); await settle(); listFinish([{id: 'old-account-file'}]); await listing;
    assert.equal(f.service.files().length, 0);
  } finally {f.close();}
});

test('關閉雲端輪詢時，離線修改在恢復網路後仍會安排保存；重置清理本機 Drive 狀態', async t => {
  const f = await fixture(), originalTimeout = globalThis.setTimeout; const scheduled = [];
  globalThis.setTimeout = (fn, ms, ...args) => {if (ms === 15000) scheduled.push(fn); return originalTimeout(fn, ms, ...args);};
  try {
    await f.service.start('full', [], 'sync'); await f.store.updateDrive({pollMinutes: 0}); await settle();
    f.navigator.onLine = false; await f.event('offline'); const task = f.store.tasks()[0]; await f.store.saveTask({...task, title: '離線修改'}); await settle();
    const count = scheduled.length; f.navigator.onLine = true; await f.event('online'); assert.ok(scheduled.length > count);
    const sync = t.mock.method(f.service, 'sync', f.service.sync.bind(f.service));
    scheduled.at(-1)(); assert.equal(sync.mock.callCount(), 1); assert.deepEqual(sync.mock.calls[0].arguments, [false]);
    await sync.mock.calls[0].result; assert.equal(f.documents.size, 2);
    await f.store.resetData(true, f.store.revision()); await settle(); assert.equal(f.stored.size, 0); assert.equal(f.store.drive().mode, 'off'); assert.equal(f.service.runtime().link, undefined);
  } finally {globalThis.setTimeout = originalTimeout; f.close();}
});

test('同帳號重新授權後也拒絕舊回覆，待上傳內容可用新的連線重試', async () => {
  const f = await fixture(); let finish;
  try {
    f.api.save = () => new Promise(resolve => {finish = resolve;}); const saving = f.service.manual('full', []);
    while (!finish) await new Promise(resolve => setImmediate(resolve)); f.auth.connectionVersion.update(v => v + 1); finish({}); await saving;
    assert.ok(f.service.runtime().pending); assert.equal(f.service.runtime().lastSavedAt, undefined); assert.match(f.service.error(), /帳號、資料或頁面/);
    f.api.save = async () => ({}); await f.service.retry(); assert.equal(f.service.runtime().pending, undefined);
  } finally {f.close();}
});

test('自動儲存設定沿用目前的範圍；同範圍切換模式、暫停與恢復不多建雲端資料', async () => {
  const f = await fixture();
  try {
    const id = f.store.currentWorkspace().id;
    await f.service.start('workspaces', [id], 'backup');
    const dataset = f.service.runtime().link.datasetId, panel = f.panel(); await settle();
    assert.equal(panel.kind(), 'workspaces'); assert.deepEqual(panel.ids(), [id]); assert.equal(panel.mode(), 'backup');
    assert.equal(panel.currentScope(), f.store.currentWorkspace().name); assert.equal(panel.otherCollections().length, 0);
    panel.editing.set(true); panel.mode.set('sync'); await panel.saveAutomatic(); await settle();
    assert.equal(f.service.runtime().link.datasetId, dataset); assert.equal(f.store.drive().mode, 'sync'); assert.equal(panel.editing(), false);
    await panel.options({mode: 'off'}); await settle(); assert.equal(panel.resumeMode(), 'sync');
    await panel.resume(); await settle(); assert.equal(f.store.drive().mode, 'sync'); assert.equal(f.service.runtime().link.datasetId, dataset);
    await panel.saveAutomatic(); assert.equal(new Set([...f.documents.values()].map(document => document.cloud.datasetId)).size, 1);
  } finally {f.close();}
});

test('更換儲存範圍才另存資料，舊資料移至其他清單；取消變更不影響既有儲存', async () => {
  const f = await fixture();
  try {
    await f.store.saveWorkspace('', '課程安排');
    await f.service.start('full', [], 'sync'); const old = f.service.runtime().link.datasetId, panel = f.panel(); await settle();
    panel.editing.set(true); panel.kind.set('workspaces'); panel.ids.set([f.store.currentWorkspace().id]);
    assert.equal(panel.sameScope(), false); assert.match(panel.startLabel(), /另建/);
    panel.editing.set(false); await settle(); assert.equal(panel.kind(), 'full'); assert.equal(f.service.runtime().link.datasetId, old);
    panel.editing.set(true); panel.kind.set('workspaces'); panel.ids.set([f.store.currentWorkspace().id]); await panel.saveAutomatic(); await settle();
    assert.notEqual(f.service.runtime().link.datasetId, old); assert.equal(panel.kind(), 'workspaces'); assert.equal(panel.editing(), false);
    assert.equal(panel.otherCollections().length, 1); assert.equal(panel.otherCollections()[0].id, old);
    assert.equal(panel.catalog().collections.length, 2); assert.ok([...f.documents.values()].some(document => document.cloud.datasetId === old));
  } finally {f.close();}
});

test('開始儲存防止連按、尚未讀取設定與未選範圍；失敗保留上傳內容供重試', async () => {
  const f = await fixture(); let finish;
  try {
    const panel = f.panel(); await settle();
    f.service.runtimeReady.set(false); await panel.saveAutomatic(); assert.equal(f.documents.size, 0);
    f.service.runtimeReady.set(true); panel.kind.set('workspaces'); panel.ids.set([]); await panel.saveAutomatic(); assert.equal(f.documents.size, 0);
    panel.kind.set('full'); const save = f.api.save;
    f.api.save = async (document, id) => {await new Promise(resolve => {finish = resolve;}); return save(document, id);};
    const started = panel.saveAutomatic(); while (!finish) await new Promise(resolve => setImmediate(resolve));
    await panel.saveAutomatic(); assert.equal(panel.canSave(), false); finish(); await started; await settle();
    assert.equal(f.documents.size, 1); assert.equal(panel.saving(), false);
    await f.store.saveTask({...f.store.tasks()[0], title: '等待重新上傳'});
    f.api.save = async () => {throw new Error('網路中斷');}; panel.editing.set(true); await panel.saveAutomatic();
    assert.ok(f.service.runtime().pending); assert.equal(panel.editing(), true); assert.equal(panel.canSave(), false);
    f.api.save = save; await f.service.retry(); await panel.saveAutomatic(); assert.equal(panel.editing(), false);
    assert.equal(new Set([...f.documents.values()].map(document => document.cloud.datasetId)).size, 1);
  } finally {f.close();}
});

test('另存一份備份沿用顯示的範圍，不切換目前自動儲存；預覽顯示可辨識的數量或名稱', async () => {
  const f = await fixture();
  try {
    await f.service.start('workspaces', [f.store.currentWorkspace().id], 'sync'); const panel = f.panel(); await settle();
    const dataset = f.service.runtime().link.datasetId; await panel.saveCopy();
    assert.equal(f.service.runtime().link.datasetId, dataset); assert.equal(f.store.drive().mode, 'sync');
    const manual = panel.catalog().manual[0]; assert.equal(manual.kind, 'workspaces'); assert.equal(panel.scopeLabel(manual), f.store.currentWorkspace().name);
    await f.service.manual('full', []); const full = panel.catalog().manual.find(file => file.kind === 'full');
    assert.match(panel.scopeLabel(full), /所有工作空間（\d+ 個）/);
    assert.equal(panel.scopeLabel({...manual, summary: undefined}), '選定的工作空間（預覽可查看名稱）');
    await panel.inspect(manual); assert.equal(panel.preview().data.workspaces.length, 1); assert.equal(panel.canJoin(), false);
  } finally {f.close();}
});

test('從其他電腦接續前先預覽並確認，預覽或取消不改本機資料及自動儲存', async () => {
  const f = await fixture();
  try {
    await f.service.start('full', [], 'sync'); const remote = f.service.files()[0], source = structuredClone(f.documents.get(remote.id));
    source.data.workspaces[0].tasks[0].title = '另一台電腦的修改';
    const remoteDoc = await createDriveDocument(source, source.cloud.datasetId, [source.cloud.versionId], 'sync');
    f.documents.set('remote_' + remoteDoc.cloud.versionId, remoteDoc);
    await f.service.start('workspaces', [f.store.currentWorkspace().id], 'backup'); const current = f.service.runtime().link.datasetId, panel = f.panel(); await settle();
    const file = panel.otherCollections()[0].heads[0], local = structuredClone(f.store.workspaces());
    await panel.inspect(file); assert.equal(panel.canJoin(), true); assert.deepEqual(f.store.workspaces(), local);
    panel.prepare('join'); await panel.execute(); assert.equal(f.service.runtime().link.datasetId, current); assert.deepEqual(f.store.workspaces(), local);
    panel.action.set(null); assert.equal(f.store.drive().mode, 'backup');
    panel.prepare('join'); panel.confirmation = panel.confirmationPhrase(); await panel.execute();
    assert.equal(f.service.runtime().link.datasetId, remote.cloud.datasetId); assert.equal(f.store.drive().mode, 'sync'); assert.equal(f.store.tasks()[0].title, '另一台電腦的修改');
    assert.equal(panel.preview(), null);
  } finally {f.close();}
});

test('開啟 Drive 面板自動載入雲端清單一次，變更設定或焦點不重複載入，重新授權才再載入', async () => {
  const f = await fixture(); let lists = 0;
  try {
    const list = f.api.list; f.api.list = async () => {lists++; return list();};
    f.panel(); await settle(); assert.equal(lists, 1);
    await f.store.updateDrive({debounceSeconds: 30}); await settle(); await f.event('focus'); assert.equal(lists, 1);
    f.auth.connectionVersion.update(value => value + 1); await settle(); assert.equal(lists, 2);
    await f.event('focus'); assert.equal(lists, 2);
  } finally {f.close();}
});

test('初次設定預設跨裝置同步，使用者選擇在開始前、上傳中與完成後都不被暫停狀態覆寫', async () => {
  for (const mode of ['sync', 'backup']) {
    const f = await fixture(); let finish;
    try {
      const panel = f.panel(); await settle(); assert.equal(panel.mode(), 'sync');
      panel.mode.set(mode); await f.store.updateDrive({debounceSeconds: 30}); await settle(); assert.equal(panel.mode(), mode);
      const save = f.api.save;
      f.api.save = async (document, id) => {await new Promise(resolve => {finish = resolve;}); return save(document, id);};
      const started = panel.saveAutomatic(); while (!finish) await new Promise(resolve => setImmediate(resolve));
      await settle(); assert.equal(f.store.drive().mode, 'off'); assert.equal(panel.mode(), mode); assert.equal(panel.saving(), true);
      finish(); await started; await settle(); assert.equal(f.store.drive().mode, mode); assert.equal(panel.mode(), mode);
      assert.equal([...f.documents.values()][0].cloud.purpose, mode);
    } finally {f.close();}
  }
});

test('全部跨裝置同步接收只有設定的雲端更新，也套用外觀提醒與月曆顯示；保留登入且不回傳重複版本', async () => {
  const f = await fixture();
  try {
    const id = f.store.currentWorkspace().id;
    await f.store.updateGoogle({accountId: 'calendar-account', email: 'calendar@example.com'});
    await f.store.saveCalendarSource({id: 'local-calendar', accountId: 'calendar-account', calendarId: 'calendar', name: '行事曆', color: '#31584b', visible: true, workspaceIds: [id]});
    await f.service.start('full', [], 'sync'); const link = f.service.runtime().link;
    const document = structuredClone([...f.documents.values()][0]);
    document.preferences = {theme: 'dark', textSize: 'compact', accent: '#3264ad'};
    document.reminders = {...document.reminders, dueSoonDays: 3, leadMinutes: 60, popupEnabled: false, includeGoogle: false, allDayTime: '08:30'};
    document.google.refreshMinutes = 1; document.google.clientId = '456-remote.apps.googleusercontent.com'; document.google.email = 'remote@example.com';
    document.google.sources[0] = {...document.google.sources[0], id: 'remote-calendar', name: '研究行事曆', color: '#7951b0', visible: false};
    document.drive = {...document.drive, mode: 'off', debounceSeconds: 60, pollMinutes: 15};
    const remote = await createDriveDocument(document, link.datasetId, [link.baseVersionId], 'sync'); f.documents.set('remote_settings', remote);
    const localDrive = structuredClone(f.store.drive()), version = f.auth.connectionVersion();
    await f.service.sync(); assert.equal(f.service.error(), '');
    assert.deepEqual(f.store.appearance(), document.preferences); assert.deepEqual(f.store.reminders(), document.reminders);
    assert.equal(f.store.google().refreshMinutes, 1); assert.equal(f.store.google().sources[0].color, '#7951b0'); assert.equal(f.store.google().sources[0].name, '研究行事曆'); assert.equal(f.store.google().sources[0].visible, false);
    assert.equal(f.store.google().sources[0].id, 'local-calendar'); assert.equal(f.store.google().clientId, '123-example.apps.googleusercontent.com'); assert.equal(f.store.google().email, 'calendar@example.com');
    assert.deepEqual(f.store.drive(), localDrive); assert.equal(f.auth.connectionVersion(), version);
    assert.equal(f.service.runtime().link.baseVersionId, remote.cloud.versionId); assert.equal(f.documents.size, 2);
    await f.service.sync(); assert.equal(f.documents.size, 2); assert.equal(f.service.error(), '');
  } finally {f.close();}
});

test('從雲端接續全部資料的預覽確認包含設定，確認後立即套用並追蹤本機設定修改', async () => {
  const f = await fixture();
  try {
    await f.store.updateAppearance({theme: 'dark', accent: '#7951b0', textSize: 'extra-small'}); await f.store.updateReminders({leadMinutes: 60, dueSoonDays: 7});
    await f.service.start('full', [], 'sync'); const file = f.service.files()[0], expected = structuredClone(f.documents.get(file.id));
    await f.service.start('workspaces', [f.store.currentWorkspace().id], 'sync');
    await f.store.updateAppearance({theme: 'light', accent: '#31584b', textSize: 'standard'}); await f.store.updateReminders({leadMinutes: 30, dueSoonDays: 1});
    const panel = f.panel(); await settle(); await panel.inspect(file); panel.prepare('join'); assert.equal(panel.confirmationPhrase(), '使用這份雲端資料');
    await panel.execute(); assert.equal(f.store.appearance().theme, 'light');
    panel.confirmation = panel.confirmationPhrase(); await panel.execute(); await settle();
    assert.deepEqual(f.store.appearance(), expected.preferences); assert.deepEqual(f.store.reminders(), expected.reminders); assert.equal(panel.mode(), 'sync');
    const count = f.documents.size; await f.service.sync(); assert.equal(f.documents.size, count);
    await f.store.updateAppearance({accent: '#3264ad'}); await f.service.sync(); assert.equal(f.documents.size, count + 1);
    assert.equal([...f.documents.values()].at(-1).preferences.accent, '#3264ad');
  } finally {f.close();}
});

test('刪除當前同步資料的單份過去備份保留同步、其他分頁及待上傳內容，後續同步不分歧', async () => {
  const f = await fixture(); let peer;
  try {
    await f.service.start('full', [], 'sync'); const rootFile = f.service.files()[0], root = f.documents.get(rootFile.id);
    await f.store.saveTask({...f.store.tasks()[0], title: '第二份內容'}); await f.service.sync();
    const middle = f.service.files().find(file => file.cloud.parents.includes(root.cloud.versionId));
    await f.store.saveTask({...f.store.tasks()[0], title: '第三份內容'}); await f.service.sync();
    const linked = structuredClone(f.service.runtime().link), save = f.api.save;
    await f.store.saveTask({...f.store.tasks()[0], title: '即將上傳的第四份內容'});
    f.api.save = async () => {throw new Error('暫時離線');}; await f.service.sync();
    const pending = structuredClone(f.service.runtime().pending), local = structuredClone(f.store.workspaces());
    peer = f.create(); await settle(); await peer.list();
    const panel = f.panel(); await settle(); await panel.requestRemoval(middle);
    assert.equal(panel.removalPhrase(), '刪除這份備份'); assert.equal(panel.removal().currentCollection, false); assert.equal(panel.removalCount(), 1);
    assert.equal(panel.removalConfirmation, ''); await panel.confirmRemoval(); await settle();
    assert.equal(panel.removal(), null); assert.equal(f.store.drive().mode, 'sync'); assert.deepEqual(f.service.runtime().link, linked);
    assert.deepEqual(f.service.runtime().pending, pending); assert.deepEqual(f.store.workspaces(), local); assert.deepEqual(peer.runtime().link, linked);
    assert.equal(panel.currentCollection().history.some(file => file.id === middle.id), false);
    assert.equal(peer.files().find(file => file.id === middle.id).trashed, true); assert.equal(f.removed.size, 0);
    assert.equal(versionGraph(await f.api.list()).descendant(linked.baseVersionId, root.cloud.versionId), true);
    f.api.save = save; await f.service.retry(); await f.service.sync();
    assert.equal(f.service.error(), ''); assert.equal(f.service.runtime().pending, undefined); assert.equal(f.service.runtime().conflict, undefined);
    assert.equal(f.store.drive().mode, 'sync'); assert.equal(f.service.runtime().link.datasetId, linked.datasetId);
    assert.equal([...f.documents.values()].at(-1).data.workspaces[0].tasks[0].title, '即將上傳的第四份內容');
  } finally {f.close();}
});

test('最新雲端內容不能當成單份過去備份刪除，確認後重新授權也不會刪除過去備份', async () => {
  const f = await fixture();
  try {
    await f.service.start('full', [], 'sync'); const root = f.service.files()[0];
    assert.equal(await f.service.prepareRemoval(root), undefined); assert.match(f.service.error(), /目前的雲端資料/); assert.equal(f.documents.size, 1);
    await f.store.saveTask({...f.store.tasks()[0], title: '新的內容'}); await f.service.sync();
    const review = await f.service.prepareRemoval(root); assert.equal(review.kind, 'file');
    f.auth.connectionVersion.update(value => value + 1); assert.equal(await f.service.remove(review), false);
    assert.equal(f.documents.size, 2); assert.equal(f.retired.size, 0); assert.equal(f.store.drive().mode, 'sync');
  } finally {f.close();}
});

test('其他自動備份有多份內容時可取消或逐份刪除，剩餘內容可接續且保留目前連結與資料', async () => {
  const f = await fixture();
  try {
    await f.service.start('full', [], 'backup'); const root = [...f.documents.values()][0];
    const a = await createDriveDocument(root, root.cloud.datasetId, [root.cloud.versionId], 'backup');
    const b = await createDriveDocument(root, root.cloud.datasetId, [root.cloud.versionId], 'backup');
    f.documents.set('branch_backup_a', a); f.documents.set('branch_backup_b', b);
    await f.service.start('workspaces', [f.store.currentWorkspace().id], 'sync');
    const panel = f.panel(); await settle(); const group = panel.otherCollections()[0], file = group.heads.find(file => file.id === 'branch_backup_a');
    const link = structuredClone(f.service.runtime().link), local = structuredClone(f.store.workspaces());
    assert.equal(group.heads.length, 2); assert.equal(panel.canRemoveBranch(file), true);
    await panel.requestRemoval(file); assert.equal(panel.removalPhrase(), '刪除這份內容'); assert.equal(panel.removalCount(), 1);
    assert.deepEqual(new Set(panel.removal().branchHeads), new Set([a.cloud.versionId, b.cloud.versionId]));
    panel.cancelRemoval(); assert.equal(panel.removal(), null); assert.equal(f.documents.has(file.id), true);
    await panel.inspect(file); await panel.requestRemoval(file); await panel.confirmRemoval(); await settle();
    assert.equal(panel.removal(), null); assert.equal(panel.preview(), null); assert.equal(f.retired.get(file.id).trashed, true);
    assert.deepEqual(f.service.runtime().link, link); assert.deepEqual(f.store.workspaces(), local); assert.equal(f.removed.size, 0);
    const remaining = panel.otherCollections()[0]; assert.deepEqual(remaining.heads.map(file => file.id), ['branch_backup_b']);
    assert.equal(remaining.history.length, 1); assert.equal(panel.canRemoveBranch(remaining.heads[0]), false);
    await panel.inspect(remaining.heads[0]); assert.equal(panel.canJoin(), true); assert.equal(panel.useAction(), 'join');
    assert.match(f.service.message(), /其他雲端內容/);
  } finally {f.close();}
});

test('刪除目前集合的另一份內容會解除分歧，保留本機修改、待上傳備份與其他分頁', async () => {
  const f = await fixture();
  try {
    await f.service.start('full', [], 'sync'); const root = [...f.documents.values()][0];
    const remoteBackup = structuredClone(root); remoteBackup.data.workspaces[0].tasks[0].title = '雲端修改';
    const remote = await createDriveDocument(remoteBackup, root.cloud.datasetId, [root.cloud.versionId], 'sync'); f.documents.set('branch_remote', remote);
    await f.store.saveTask({...f.store.tasks()[0], title: '本機修改'}); await f.service.sync(); assert.equal(f.service.runtime().conflict.length, 2);
    const link = structuredClone(f.service.runtime().link), save = f.api.save;
    f.api.save = async () => {throw new Error('暫時離線');}; await f.service.manual('full', []);
    const pending = structuredClone(f.service.runtime().pending), local = structuredClone(f.store.workspaces()), peer = f.create(); await settle();
    const panel = f.panel(); await settle(); const file = panel.heads().find(file => file.id === 'branch_remote');
    await panel.requestRemoval(file); await panel.confirmRemoval(); await settle();
    assert.equal(f.service.runtime().conflict, undefined); assert.deepEqual(f.service.runtime().link, link); assert.deepEqual(f.service.runtime().pending, pending);
    assert.deepEqual(f.store.workspaces(), local); assert.equal(f.store.drive().mode, 'sync'); assert.equal(peer.runtime().conflict, undefined);
    assert.equal(peer.files().find(value => value.id === file.id)?.trashed, true);
    f.api.save = save; await f.service.retry(); await f.service.sync(); assert.equal(f.service.error(), ''); assert.equal(f.service.runtime().conflict, undefined);
    assert.equal(f.store.tasks()[0].title, '本機修改'); assert.equal(f.documents.has('branch_remote'), false);
  } finally {f.close();}
});

test('刪除本機正在使用的分支後仍保留本機內容，剩餘雲端內容經明確確認才套用', async () => {
  for (const mode of ['sync', 'backup']) {
    const f = await fixture();
    try {
      await f.service.start('full', [], mode); const root = [...f.documents.values()][0];
      const remoteBackup = structuredClone(root); remoteBackup.data.workspaces[0].tasks[0].title = '保留的雲端修改';
      const remote = await createDriveDocument(remoteBackup, root.cloud.datasetId, [root.cloud.versionId], mode); f.documents.set('branch_remote', remote);
      await f.store.saveTask({...f.store.tasks()[0], title: '刪除雲端副本後仍在本機'}); await f.service.sync();
      const panel = f.panel(); await settle(); const localBranch = panel.currentCollection().heads.find(file => file.cloud.versionId === f.service.runtime().link.baseVersionId);
      const link = structuredClone(f.service.runtime().link);
      await panel.requestRemoval(localBranch); await panel.confirmRemoval(); await settle();
      assert.deepEqual(f.service.runtime().conflict, [remote.cloud.versionId]); assert.deepEqual(f.service.runtime().link, link);
      assert.equal(f.store.tasks()[0].title, '刪除雲端副本後仍在本機'); assert.equal(panel.heads().length, 1);
      const count = f.documents.size; await f.service.sync(); assert.equal(f.documents.size, count);
      await panel.inspect(panel.heads()[0]); assert.equal(panel.useAction(), 'cloud');
      assert.match(panel.useDescription(), mode === 'backup' ? /自動備份/ : /跨裝置同步/); panel.prepare('cloud');
      await panel.execute(); assert.equal(f.store.tasks()[0].title, '刪除雲端副本後仍在本機');
      panel.confirmation = panel.confirmationPhrase(); await panel.execute(); await settle();
      assert.equal(f.store.tasks()[0].title, '保留的雲端修改'); assert.equal(f.service.runtime().conflict, undefined);
      assert.equal(f.retired.get(localBranch.id).trashed, true); assert.equal(versionGraph(await f.api.list()).heads.length, 1);
      assert.equal(versionGraph(await f.api.list()).heads[0].cloud.purpose, mode);
      assert.equal(f.store.drive().mode, mode); assert.match(f.service.message(), mode === 'backup' ? /自動備份已繼續/ : /跨裝置同步已繼續/);
    } finally {f.close();}
  }
});

test('確認刪除待選擇內容後雲端又更新時，保留全部內容並要求重新確認', async () => {
  const f = await fixture();
  try {
    await f.service.start('full', [], 'backup'); const root = [...f.documents.values()][0];
    const a = await createDriveDocument(root, root.cloud.datasetId, [root.cloud.versionId], 'backup');
    const b = await createDriveDocument(root, root.cloud.datasetId, [root.cloud.versionId], 'backup');
    f.documents.set('branch_backup_a', a); f.documents.set('branch_backup_b', b); await f.service.list();
    const panel = f.panel(); await settle(); await panel.requestRemoval(panel.currentCollection().heads.find(file => file.id === 'branch_backup_a'));
    const newer = await createDriveDocument(a, root.cloud.datasetId, [a.cloud.versionId], 'backup'); f.documents.set('branch_backup_new', newer);
    const count = f.documents.size, local = structuredClone(f.store.workspaces()); await panel.confirmRemoval();
    assert.equal(f.documents.size, count); assert.equal(f.retired.size, 0); assert.match(f.service.error(), /已變更/);
    assert.ok(panel.removal()); assert.deepEqual(f.store.workspaces(), local); assert.equal(f.store.drive().mode, 'backup');
  } finally {f.close();}
});

test('雲端預覽只有一個一致的使用動作，過去備份套用設定而加入工作空間保留目前設定', async () => {
  const f = await fixture();
  try {
    await f.store.updateAppearance({theme: 'dark', accent: '#7951b0', textSize: 'extra-small'});
    await f.service.start('full', [], 'sync'); const old = f.service.files()[0], panel = f.panel(); await settle();
    await panel.inspect(old); assert.equal(panel.useAction(), null); assert.equal(panel.useLabel, '使用這份雲端資料');
    panel.prepare('restore'); assert.equal(panel.action(), null);
    await f.store.saveTask({...f.store.tasks()[0], title: '新的內容'}); await f.service.sync();
    await f.store.updateAppearance({theme: 'light', accent: '#3264ad', textSize: 'standard'});
    await panel.inspect(old); assert.equal(panel.useAction(), 'restore'); panel.prepare('restore');
    assert.equal(panel.confirmationPhrase(), panel.useLabel); await panel.execute(); assert.equal(f.store.appearance().theme, 'light');
    panel.action.set(null); const appearance = structuredClone(f.store.appearance()), before = f.store.workspaces().length;
    await panel.copy(); await settle(); assert.equal(f.store.workspaces().length, before + 1); assert.deepEqual(f.store.appearance(), appearance);
    assert.match(f.service.message(), /已加入工作空間/); assert.equal(f.store.drive().mode, 'sync');
    await panel.inspect(old); panel.prepare('restore'); panel.confirmation = panel.useLabel; await panel.execute(); await settle();
    assert.equal(f.store.workspaces().length, before); assert.equal(f.store.appearance().theme, 'dark'); assert.equal(f.store.appearance().accent, '#7951b0'); assert.equal(f.store.drive().mode, 'off');
  } finally {f.close();}
});

test('重新載入呈現全部雲端資料，包含目前使用的那份，沒有其他資料也不會顯示空清單', async () => {
  const f = await fixture();
  try {
    await f.service.start('full', [], 'sync'); const panel = f.panel(); await settle();
    const id = f.service.runtime().link.datasetId;
    await f.service.list(); assert.equal(f.service.catalogFresh(), true); assert.equal(panel.cloudCount(), 1);
    assert.equal(panel.catalog().collections[0].id, id); assert.equal(panel.catalog().collections[0].current, true);
    assert.equal(panel.hasFiles(), true); assert.equal(panel.showCreateForm(), false); assert.ok(f.service.catalogCheckedAt());
    await f.service.manual('full', []); await f.service.list(); assert.equal(panel.cloudCount(), 2);
    assert.equal(panel.catalog().collections.length, 1); assert.equal(panel.catalog().manual.length, 1);
  } finally {f.close();}
});

test('連線前及雲端清單尚未完成時不提供建立，成功確認沒有資料後才可建立自動儲存', async () => {
  const f = await fixture(); let finish;
  try {
    f.auth.connected.set(false); const panel = f.panel(); await settle();
    assert.equal(panel.showCreateForm(), false); assert.equal(panel.canSave(), false);
    const list = f.api.list; f.api.list = () => new Promise(resolve => {finish = resolve;});
    f.auth.connected.set(true); f.auth.connectionVersion.update(value => value + 1); await settle();
    assert.equal(f.service.catalogState(), 'loading'); assert.equal(panel.showCreateForm(), false);
    await panel.saveAutomatic(); assert.equal(f.documents.size, 0);
    f.api.list = list; finish([]); await settle();
    assert.equal(f.service.catalogFresh(), true); assert.equal(panel.showCreateForm(), true); assert.equal(panel.canSave(), true);
    await panel.saveAutomatic(); await settle(); assert.equal(f.documents.size, 1); assert.equal(panel.cloudCount(), 1);
    assert.equal(panel.showCreateForm(), false); assert.equal(panel.catalog().collections[0].current, true);
  } finally {f.close();}
});

test('讀取失敗保留上次清單並禁用換用或新建，不會把失敗當成沒有資料', async () => {
  const f = await fixture();
  try {
    await f.service.start('full', [], 'sync'); const file = f.service.files()[0];
    await f.service.start('workspaces', [f.store.currentWorkspace().id], 'backup');
    const panel = f.panel(); await settle(); await panel.inspect(file, true); assert.equal(panel.action(), 'join');
    const local = structuredClone(f.store.workspaces()), link = structuredClone(f.service.runtime().link), list = f.api.list;
    f.api.list = async () => {throw new Error('清單連線中斷');}; await f.service.list();
    assert.equal(f.service.catalogState(), 'error'); assert.match(f.service.catalogError(), /連線中斷/);
    assert.equal(panel.cloudCount(), 2); assert.equal(panel.showCreateForm(), false); assert.equal(panel.useAction(), null);
    await panel.confirmUse(); assert.deepEqual(f.store.workspaces(), local); assert.deepEqual(f.service.runtime().link, link);
    f.api.list = list; await f.service.list(); assert.equal(f.service.catalogFresh(), true); assert.equal(panel.useAction(), 'join');
  } finally {f.close();}
});

test('已有雲端資料時優先選用，只有明確按另建一份才顯示新建流程', async () => {
  const f = await fixture();
  try {
    const remote = await createDriveDocument(await f.store.backupForExport('full'), crypto.randomUUID(), [], 'backup'); f.documents.set('remote_collection', remote);
    const panel = f.panel(); await settle(); assert.equal(panel.cloudCount(), 1); assert.equal(panel.showCreateForm(), false);
    assert.equal(panel.canSave(), false); await panel.saveAutomatic(); assert.equal(f.documents.size, 1);
    panel.beginCreate(); assert.equal(panel.showCreateForm(), true); assert.equal(panel.creating(), true); assert.equal(panel.canSave(), true);
    panel.creating.set(false); assert.equal(panel.showCreateForm(), false); assert.equal(f.documents.size, 1);
    const local = structuredClone(f.store.workspaces()); await panel.inspect(panel.catalog().collections[0].heads[0], true);
    assert.equal(panel.action(), 'join'); assert.deepEqual(f.store.workspaces(), local); assert.equal(panel.confirmation, '');
    await panel.confirmUse(); await settle(); assert.equal(f.service.runtime().link.datasetId, remote.cloud.datasetId);
    assert.equal(panel.cloudCount(), 1); assert.equal(panel.showCreateForm(), false); assert.equal(f.documents.size, 1);
  } finally {f.close();}
});

test('空清單確認後另一裝置新增資料，建立前再次檢查並顯示既有資料，不產生重複集合', async () => {
  const f = await fixture();
  try {
    const panel = f.panel(); await settle(); assert.equal(panel.showCreateForm(), true);
    const remote = await createDriveDocument(await f.store.backupForExport('full'), crypto.randomUUID(), [], 'backup'); f.documents.set('remote_collection', remote);
    await panel.saveAutomatic(); await settle(); assert.equal(f.documents.size, 1); assert.equal(f.service.runtime().link, undefined);
    assert.equal(panel.showCreateForm(), false); assert.equal(panel.cloudCount(), 1); assert.match(f.service.error(), /已有雲端資料/);
    assert.equal(f.store.drive().mode, 'off');
  } finally {f.close();}
});

test('多份雲端內容可直接查看並選用其中一份，確認後自動儲存接續且所有舊版本保留', async () => {
  const f = await fixture();
  try {
    const root = await createDriveDocument(await f.store.backupForExport('full'), crypto.randomUUID(), [], 'backup');
    const selectedBackup = structuredClone(root); selectedBackup.data.workspaces[0].tasks[0].title = '要使用的那份內容';
    const a = await createDriveDocument(selectedBackup, root.cloud.datasetId, [root.cloud.versionId], 'backup');
    const b = await createDriveDocument(root, root.cloud.datasetId, [root.cloud.versionId], 'backup');
    f.documents.set('remote_root', root); f.documents.set('remote_a', a); f.documents.set('remote_b', b);
    const before = structuredClone([...f.documents]), local = structuredClone(f.store.workspaces()), panel = f.panel(); await settle();
    const file = panel.catalog().collections[0].heads.find(file => file.id === 'remote_a');
    await panel.inspect(file, true); assert.equal(panel.action(), 'join'); assert.equal(panel.reviewedBranchCount(), 2);
    assert.deepEqual(f.store.workspaces(), local); panel.clearPreview(); assert.deepEqual([...f.documents], before);
    await panel.inspect(file, true); await panel.confirmUse(); await settle();
    assert.equal(f.store.tasks()[0].title, '要使用的那份內容'); assert.equal(f.service.runtime().link.datasetId, root.cloud.datasetId);
    assert.equal(f.store.drive().mode, 'sync'); assert.equal(f.service.runtime().conflict, undefined); assert.equal(panel.cloudCount(), 1);
    const group = panel.catalog().collections[0]; assert.equal(group.current, true); assert.equal(group.heads.length, 1); assert.equal(group.history.length, 3);
    assert.deepEqual(new Set(group.heads[0].cloud.parents), new Set([a.cloud.versionId, b.cloud.versionId]));
    for (const [id, document] of before) assert.deepEqual(f.documents.get(id), document);
    const count = f.documents.size; await f.service.sync(); assert.equal(f.documents.size, count);
  } finally {f.close();}
});

test('簡化確認仍拒絕確認期間的雲端及本機修改，重新查看才可選用', async () => {
  for (const change of ['cloud', 'local']) {
    const f = await fixture();
    try {
      const remote = await createDriveDocument(await f.store.backupForExport('full'), crypto.randomUUID(), [], 'sync'); f.documents.set('remote_collection', remote);
      const panel = f.panel(); await settle(); await panel.inspect(panel.catalog().collections[0].heads[0], true);
      if (change === 'cloud') f.documents.set('remote_new', await createDriveDocument(remote, remote.cloud.datasetId, [remote.cloud.versionId], 'sync'));
      else await f.store.saveTask({...f.store.tasks()[0], title: '確認後本機又更新'});
      const local = structuredClone(f.store.workspaces()); await panel.confirmUse();
      assert.deepEqual(f.store.workspaces(), local); assert.equal(f.service.runtime().link, undefined); assert.match(panel.error() || f.service.error(), /更新|變更/);
      if (change === 'local') {
        assert.equal(panel.useStale(), true); panel.prepare('join'); assert.equal(panel.useStale(), false);
        await panel.confirmUse(); assert.equal(f.service.runtime().link.datasetId, remote.cloud.datasetId);
      }
    } finally {f.close();}
  }
});

test('刪除雲端資料只需確認按鈕，取消不變更，確認後本機內容保留', async () => {
  const f = await fixture();
  try {
    await f.service.start('full', [], 'backup'); const id = f.service.runtime().link.datasetId, panel = f.panel(); await settle();
    const local = structuredClone(f.store.workspaces()); await panel.requestRemoval(id); panel.cancelRemoval(); assert.equal(f.documents.size, 1);
    await panel.requestRemoval(id); assert.equal(panel.removalConfirmation, ''); await panel.acceptRemoval(); await settle();
    assert.equal(panel.removal(), null); assert.equal(f.documents.size, 0); assert.deepEqual(f.store.workspaces(), local);
    assert.equal(f.store.drive().mode, 'off'); assert.equal(panel.showCreateForm(), true);
  } finally {f.close();}
});

test('重新載入發現新的不同內容時，原確認失效，重新確認後可接續並保留全部版本', async () => {
  const f = await fixture();
  try {
    const root = await createDriveDocument(await f.store.backupForExport('full'), crypto.randomUUID(), [], 'sync');
    const a = await createDriveDocument(root, root.cloud.datasetId, [root.cloud.versionId], 'sync');
    const b = await createDriveDocument(root, root.cloud.datasetId, [root.cloud.versionId], 'sync');
    f.documents.set('remote_root', root); f.documents.set('remote_branch_a', a); f.documents.set('remote_branch_b', b);
    const panel = f.panel(); await settle();
    await panel.inspect(panel.catalog().collections[0].heads.find(file => file.id === 'remote_branch_a'), true);
    assert.equal(panel.useStale(), false); assert.equal(panel.reviewedBranchCount(), 2);
    const c = await createDriveDocument(root, root.cloud.datasetId, [root.cloud.versionId], 'sync'); f.documents.set('remote_branch_c', c);
    await f.service.list(); assert.equal(panel.useAction(), 'join'); assert.equal(panel.useStale(), true);
    const local = structuredClone(f.store.workspaces()); await panel.confirmUse();
    assert.deepEqual(f.store.workspaces(), local); assert.equal(f.service.runtime().link, undefined); assert.equal(f.documents.size, 4);
    panel.prepare('join'); assert.equal(panel.useStale(), false); assert.equal(panel.reviewedBranchCount(), 3);
    await panel.confirmUse(); await settle(); assert.equal(f.documents.size, 5); assert.equal(panel.currentCollection().history.length, 4);
    assert.deepEqual(new Set(panel.currentCollection().heads[0].cloud.parents), new Set([a.cloud.versionId, b.cloud.versionId, c.cloud.versionId]));
  } finally {f.close();}
});

test('重新授權與換帳號期間舊清單不變成有效結果，找不到原連結時不假裝正在使用', async () => {
  const f = await fixture(); let finish;
  try {
    await f.service.start('full', [], 'sync'); const panel = f.panel(); await settle(); const list = f.api.list;
    f.api.list = () => new Promise(resolve => {finish = resolve;}); const loading = f.service.list();
    while (!finish) await new Promise(resolve => setImmediate(resolve)); f.auth.connectionVersion.update(value => value + 1);
    finish([]); await loading; assert.equal(f.service.catalogFresh(), false);
    f.api.list = list; await settle();
    f.documents.clear(); await f.service.list(); assert.equal(f.service.catalogFresh(), true); assert.equal(f.service.unavailable(), true);
    assert.equal(panel.currentCollection(), undefined); assert.equal(panel.showCreateForm(), false); assert.ok(f.service.runtime().link);
    await panel.requestRemoval(f.service.runtime().link.datasetId); await panel.acceptRemoval(); await settle();
    assert.equal(f.service.runtime().link, undefined); assert.equal(panel.showCreateForm(), true);
  } finally {f.close();}
});
