import assert from 'node:assert/strict';
import {test} from 'node:test';
import {COLAB_MIME_TYPE, EMPTY_COLAB_NOTEBOOK, documentCreationName, DOCUMENT_TYPES, DOCUMENT_OPERATIONS_KEY, DOCUMENT_OPERATION_PROPERTY, DocumentCreationApi, DocumentCreationCoordinator, DocumentOperationJournal, readDocumentOperations} from '../src/app/document-create-data.ts';
import {sourceOpenUrl} from '../src/app/source-file-type.ts';
import {DRIVE_FOLDER_MIME} from '../src/app/drive-browser-data.ts';
import {GoogleHttpError} from '../src/app/google-api.ts';
import {documentCleanupCandidates} from '../src/app/document-source-cleanup.ts';
import {documentFromUrl} from '../src/app/document-data.ts';

const request = (patch = {}) => ({generation: 'generation', workspaceId: 'workspace', taskId: 'task', taskTitle: '研究任務', profileId: 'research', context: 'client/account/generation', clientId: '123.apps.googleusercontent.com', accountId: 'account', sourceName: '研究來源', name: '研究計畫', mimeType: DOCUMENT_TYPES[0].mimeType, folder: {id: 'root', name: '我的雲端硬碟'}, ...patch});
const raw = (id, name = '研究計畫', extra = {}) => ({id, name, mimeType: DOCUMENT_TYPES[0].mimeType, parents: ['folder'], ...extra});
function fixture() {
  const values = new Map(), calls = [], files = [], linked = [];
  let chain = Promise.resolve();
  const lock = write => {const work = chain.then(write); chain = work.catch(() => {}); return work;};
  const storage = {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value)};
  const journal = new DocumentOperationJournal(storage, lock), coordinator = new DocumentCreationCoordinator(journal);
  const transport = {async api(path, parameters, options = {}) {
    calls.push({path, parameters, options});
    if (options.method === 'POST') {const body = JSON.parse(options.body), file = raw('created-' + files.length, body.name, {mimeType: body.mimeType, appProperties: body.appProperties}); files.push(file); return file;}
    if (path.startsWith('files/')) return raw(path.slice(6), '保存資料夾', {mimeType: DRIVE_FOLDER_MIME, capabilities: {canAddChildren: true}});
    return {files: files.filter(file => parameters.q.includes(file.appProperties[DOCUMENT_OPERATION_PROPERTY]))};
  }};
  transport.createNotebook = async (metadata, resourceKeys) => {
    calls.push({path: 'notebook-upload', parameters: {}, options: {method: 'POST', body: JSON.stringify(metadata)}, resourceKeys, content: EMPTY_COLAB_NOTEBOOK});
    const file = raw('notebook-' + files.length, metadata.name, {mimeType: metadata.mimeType, parents: metadata.parents, appProperties: metadata.appProperties}); files.push(file); return file;
  };
  const api = new DocumentCreationApi(transport), link = async source => linked.push(source);
  return {values, calls, files, linked, storage, journal, coordinator, transport, api, link};
}

test('三種原生文件以獨立操作識別建立並保存連結，不使用預先產生 ID 或備份標記', async () => {
  for (const type of DOCUMENT_TYPES.filter(type => type.mimeType !== COLAB_MIME_TYPE)) {
    const f = fixture(), operation = await f.coordinator.create(request({mimeType: type.mimeType}), f.api, () => true, f.link);
    assert.equal(operation.phase, 'linked'); assert.equal(f.linked.length, 1); assert.equal(f.linked[0].mimeType, type.mimeType);
    assert.match(f.linked[0].location, /研究來源/);
    const body = JSON.parse(f.calls[0].options.body);
    assert.equal(body.id, undefined); assert.equal(body.parents, undefined); assert.deepEqual(Object.keys(body.appProperties), [DOCUMENT_OPERATION_PROPERTY]);
    assert.equal(f.calls.length, 1); assert.equal(f.journal.read()[0].phase, 'linked');
  }
});

test('Colab 以有效的空白 Python 筆記本單次建立，保存位置及查核標記與原生文件共用', async () => {
  const f = fixture(), operation = await f.coordinator.create(request({name: '資料分析', mimeType: COLAB_MIME_TYPE, folder: {id: 'research', name: '研究', resourceKey: 'key'}}), f.api, () => true, f.link);
  assert.equal(operation.phase, 'linked'); assert.equal(operation.name, '資料分析.ipynb'); assert.equal(operation.result.name, '資料分析.ipynb');
  const upload = f.calls.find(call => call.path === 'notebook-upload'), metadata = JSON.parse(upload.options.body), notebook = JSON.parse(upload.content);
  assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1); assert.deepEqual(metadata.parents, ['research']); assert.equal(upload.resourceKeys, 'research/key'); assert.equal(metadata.appProperties[DOCUMENT_OPERATION_PROPERTY], operation.id); assert.equal(metadata.mimeType, COLAB_MIME_TYPE);
  assert.equal(notebook.nbformat, 4); assert.equal(notebook.nbformat_minor, 5); assert.equal(notebook.metadata.kernelspec.name, 'python3');
  assert.equal(notebook.cells.length, 1); assert.deepEqual(notebook.cells[0].source, []); assert.deepEqual(notebook.cells[0].outputs, []); assert.equal(notebook.cells[0].execution_count, null); assert.equal(notebook.cells[0].cell_type, 'code'); assert.match(notebook.cells[0].id, /^[A-Za-z0-9_-]{1,64}$/);
  assert.equal(sourceOpenUrl(operation.result), 'https://colab.research.google.com/drive/notebook-0'); assert.equal(operation.result.url, 'https://drive.google.com/file/d/notebook-0/view'); assert.equal(f.journal.read()[0].mimeType, COLAB_MIME_TYPE);
});

test('Colab 回覆遺失後重載只查核同一筆記本，不能重送上傳', async () => {
  const f = fixture(), upload = f.transport.createNotebook;
  f.transport.createNotebook = async (...args) => {await upload(...args); throw new Error('reply lost');};
  let operation = await f.coordinator.create(request({name: '未確認筆記本.ipynb', mimeType: COLAB_MIME_TYPE}), f.api, () => true, f.link);
  assert.equal(operation.phase, 'uncertain'); assert.equal(f.files.length, 1);
  const coordinator = new DocumentCreationCoordinator(f.journal); await coordinator.create(request({mimeType: COLAB_MIME_TYPE}), f.api, () => true, f.link);
  operation = await coordinator.reconcile(f.journal.read()[0], f.api, () => true, f.link);
  assert.equal(operation.phase, 'linked'); assert.equal(operation.result.fileId, 'notebook-0'); assert.equal(f.files.length, 1); assert.equal(f.calls.filter(call => call.path === 'notebook-upload').length, 1);
});

test('Colab 已建立而任務保存失敗時保留入口，只重新加入原檔', async () => {
  const f = fixture(); let operation = await f.coordinator.create(request({mimeType: COLAB_MIME_TYPE}), f.api, () => true, async () => {throw new Error('save failed');});
  assert.equal(operation.phase, 'created'); assert.equal(sourceOpenUrl(operation.result), 'https://colab.research.google.com/drive/notebook-0');
  operation = await f.coordinator.reconcile(f.journal.read()[0], f.api, () => true, f.link);
  assert.equal(operation.phase, 'linked'); assert.equal(f.calls.length, 1); assert.equal(f.linked.length, 1);
});

test('Colab 名稱只補一次副檔名，含副檔名受 300 字限制且不接受空名稱', () => {
  assert.equal(documentCreationName(' 分析.ipynb ', COLAB_MIME_TYPE), '分析.ipynb'); assert.equal(documentCreationName('分析.IPYNB', COLAB_MIME_TYPE), '分析.IPYNB');
  assert.equal(documentCreationName('a'.repeat(294), COLAB_MIME_TYPE).length, 300); assert.throws(() => documentCreationName('a'.repeat(295), COLAB_MIME_TYPE)); assert.throws(() => documentCreationName('  ', COLAB_MIME_TYPE));
  assert.equal(documentCreationName('一般文件', DOCUMENT_TYPES[0].mimeType), '一般文件');
});

test('指定資料夾先以建立授權核對實際可建立能力與 resource key，不能選 Orbit 備份位置', async () => {
  const f = fixture(), folder = {id: 'folder', name: '舊名稱', resourceKey: 'folder-key'};
  const operation = await f.coordinator.create(request({folder}), f.api, () => true, f.link);
  assert.equal(operation.folder.name, '保存資料夾'); assert.equal(f.calls[0].options.headers['X-Goog-Drive-Resource-Keys'], 'folder/folder-key');
  assert.deepEqual(JSON.parse(f.calls[1].options.body).parents, ['folder']);
  for (const extra of [{capabilities: {canAddChildren: false}}, {name: 'IIH Orbit'}, {appProperties: {orbit: 'v1', type: 'folder'}}, {trashed: true}, {mimeType: 'application/pdf'}]) {
    const rejected = fixture(); rejected.transport.api = async () => raw('folder', '資料夾', {mimeType: DRIVE_FOLDER_MIME, capabilities: {canAddChildren: true}, ...extra});
    const result = await rejected.coordinator.create(request({folder}), rejected.api, () => true, rejected.link);
    assert.equal(result.phase, 'failed'); assert.equal(rejected.linked.length, 0);
  }
});

test('先保存操作紀錄才發出建立要求，儲存失敗不建立文件', async () => {
  const f = fixture(); f.storage.setItem = () => {throw new Error('quota');};
  await assert.rejects(f.coordinator.create(request(), f.api, () => true, f.link), /quota/);
  assert.equal(f.calls.length, 0); assert.equal(f.linked.length, 0);
  f.values.set(DOCUMENT_OPERATIONS_KEY, '{broken');
  await assert.rejects(f.coordinator.create(request(), f.api, () => true, f.link)); assert.equal(f.calls.length, 0);
});

test('重複點擊及其他分頁遇到進行中的操作不再建立第二份', async () => {
  const f = fixture(), original = f.transport.api; let finish;
  f.transport.api = async (...args) => {if (args[2]?.method === 'POST') await new Promise(resolve => finish = resolve); return original(...args);};
  const first = f.coordinator.create(request(), f.api, () => true, f.link);
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  const peer = new DocumentCreationCoordinator(new DocumentOperationJournal(f.storage, async write => write()));
  const repeated = await peer.create(request(), f.api, () => true, f.link);
  assert.equal(repeated.phase, 'uncertain'); assert.match(repeated.message, /不會重複建立/);
  finish(); await first; assert.equal(f.files.length, 1); assert.equal(f.linked.length, 1);
});

test('Google 已建立但回覆遺失時，重開只查核操作識別，不能重送 POST', async () => {
  const f = fixture(), original = f.transport.api;
  f.transport.api = async (...args) => {const result = await original(...args); if (args[2]?.method === 'POST') throw new Error('timeout'); return result;};
  let operation = await f.coordinator.create(request(), f.api, () => true, f.link);
  assert.equal(operation.phase, 'uncertain'); assert.equal(f.files.length, 1); assert.equal(f.linked.length, 0);
  const reloaded = new DocumentCreationCoordinator(f.journal); await reloaded.create(request(), f.api, () => true, f.link);
  operation = await reloaded.reconcile(f.journal.read()[0], f.api, () => true, f.link);
  assert.equal(operation.phase, 'linked'); assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1); assert.equal(f.linked.length, 1);
  assert.match(f.calls.at(-1).parameters.q, /iihOrbitDocumentOperation/);
});

test('雲端成功而任務保存失敗，只重新加入原檔；保存結果仍保留 ID 與外開連結', async () => {
  const f = fixture(); let operation = await f.coordinator.create(request(), f.api, () => true, async () => {throw new Error('disk full');});
  assert.equal(operation.phase, 'created'); assert.equal(operation.result.fileId, 'created-0'); assert.match(operation.result.url, /created-0/);
  operation = await f.coordinator.reconcile(f.journal.read()[0], f.api, () => true, f.link);
  assert.equal(operation.phase, 'linked'); assert.equal(f.files.length, 1); assert.equal(f.calls.length, 1);
});

test('帳號／世代／任務在建立期間改變時，保存結果但不寫回原任務', async () => {
  const f = fixture(), original = f.transport.api; let current = true;
  f.transport.api = async (...args) => {const result = await original(...args); current = false; return result;};
  const operation = await f.coordinator.create(request(), f.api, () => current, f.link);
  assert.equal(operation.phase, 'created'); assert.equal(f.linked.length, 0); assert.equal(f.journal.read()[0].result.fileId, 'created-0');
  await assert.rejects(f.coordinator.reconcile(operation, f.api, () => false, f.link), /原資料世代/);
});

test('查核零筆／多筆／垃圾桶結果皆不盲目重新建立或自動選擇檔案', async () => {
  for (const count of [0, 2, 1]) {
    const f = fixture(), {operation} = await f.journal.begin(request()); operation.phase = 'uncertain'; await f.journal.update(operation);
    for (let i = 0; i < count; i++) f.files.push(raw('found-' + i, '找到的文件', {appProperties: {[DOCUMENT_OPERATION_PROPERTY]: operation.id}, ...(count === 1 ? {trashed: true} : {})}));
    const result = await f.coordinator.reconcile(operation, f.api, () => true, f.link);
    assert.equal(result.phase, count === 1 ? 'created' : 'uncertain'); assert.equal(f.linked.length, 0); assert.equal(f.calls.some(call => call.options.method === 'POST'), false);
    if (count === 1) assert.match(result.message, /垃圾桶/);
  }
});

test('明確拒絕與不確定的服務錯誤分開保存，不完整回覆不當作成功', async () => {
  for (const status of [400, 401, 403, 404, 429, 500, 503]) {
    const f = fixture(); f.transport.api = async () => {throw new GoogleHttpError(status, '文件');};
    const result = await f.coordinator.create(request(), f.api, () => true, f.link);
    assert.equal(result.phase, status < 500 ? 'failed' : 'uncertain'); assert.equal(f.linked.length, 0);
  }
  const f = fixture(); f.transport.api = async () => raw('wrong-file', '缺少操作識別');
  const result = await f.coordinator.create(request(), f.api, () => true, f.link); assert.equal(result.phase, 'uncertain');
});

test('建立紀錄讀取拒絕損壞與不安全結果，不保存未知欄位或憑證', async () => {
  const f = fixture(), {operation} = await f.journal.begin(request());
  assert.throws(() => readDocumentOperations([{...operation, mimeType: 'text/plain'}]));
  assert.throws(() => readDocumentOperations([{...operation, phase: 'created', result: {...documentFromUrl('google-drive', 'https://drive.google.com/file/d/file/view', '檔案'), url: 'javascript:alert(1)'}}]));
  assert.equal(readDocumentOperations([{...operation, access_token: 'secret'}])[0].access_token, undefined);
});

test('來源整理只允許真孤立紀錄，保護垃圾桶、衝突、事件、復原、草稿及其他空間引用', () => {
  const sources = Array.from({length: 7}, (_, i) => documentFromUrl('google-drive', 'https://drive.google.com/file/d/source-' + i + '/view', '來源' + i));
  const board = {version: 5, id: 'workspace', name: '工作', tasks: [{id: 'trash', deletedAt: '2026-10-15'}, {id: 'active'}], documentSources: sources, documentLinks: [{id: 'a', taskId: 'trash', documentId: sources[1].id}, {id: 'b', taskId: 'missing', documentId: sources[2].id, removed: true}, {id: 'c', taskId: 'conflict', documentId: sources[3].id, removed: true}, {id: 'd', taskId: 'active', documentId: sources[6].id}], taskConflicts: [{id: 'conflict', versions: []}]};
  const other = {...board, id: 'other', documentSources: [], documentLinks: [{id: 'other-link', taskId: 'active', documentId: sources[5].id}]};
  const candidates = documentCleanupCandidates([board, other], [{before: {documentSources: [sources[4]]}, after: {}}], new Set([sources[4].id]));
  assert.deepEqual(candidates.filter(item => !item.reasons.length).map(item => item.documentId), [sources[0].id]);
  assert.match(candidates.find(item => item.documentId === sources[1].id).reasons.join(), /垃圾桶/);
  assert.match(candidates.find(item => item.documentId === sources[3].id).reasons.join(), /衝突/);
  assert.match(candidates.find(item => item.documentId === sources[4].id).reasons.join(), /復原.*草稿/);
  assert.match(candidates.find(item => item.documentId === sources[5].id).reasons.join(), /其他工作空間/);
  assert.equal(candidates.some(item => item.documentId === sources[6].id), false);
});

test('晚到的查核不能重開已完成／已結束的紀錄，結束期間回覆的新檔仍保留開啟入口', async () => {
  const f = fixture(), {operation} = await f.journal.begin(request());
  const linked = {...operation, phase: 'linked', result: documentFromUrl('google-drive', 'https://drive.google.com/file/d/linked-file/view', '已連結')};
  await f.journal.update(linked); await f.journal.update({...operation, phase: 'uncertain'});
  assert.equal(f.journal.read()[0].phase, 'linked'); assert.equal(f.journal.read()[0].result.fileId, 'linked-file');
  const g = fixture(), start = await g.journal.begin(request()); await g.journal.update({...start.operation, phase: 'closed'});
  await g.journal.update({...start.operation, phase: 'created', result: linked.result});
  assert.equal(g.journal.read()[0].phase, 'closed'); assert.equal(g.journal.read()[0].result.fileId, 'linked-file');
});

test('Google 回覆後建立紀錄無法更新，仍保留已知文件入口，恢復後查回同一份', async () => {
  const f = fixture(), write = f.storage.setItem; let writes = 0;
  f.storage.setItem = (...args) => {if (++writes >= 3) throw new Error('quota'); return write(...args);};
  const result = await f.coordinator.create(request(), f.api, () => true, f.link);
  assert.equal(result.phase, 'created'); assert.equal(result.result.fileId, 'created-0'); assert.match(result.message, /本機紀錄未能更新/);
  assert.equal(f.journal.read()[0].phase, 'uncertain'); assert.equal(f.linked.length, 0);
  f.storage.setItem = write; const recovered = await f.coordinator.reconcile(f.journal.read()[0], f.api, () => true, f.link);
  assert.equal(recovered.phase, 'linked'); assert.equal(f.files.length, 1);
});

test('建立紀錄達上限時只回收已結束紀錄，所有未確認建立都受保護', async () => {
  const f = fixture();
  for (let i = 0; i < 100; i++) await f.journal.begin(request({taskId: 'task-' + i}));
  await assert.rejects(f.journal.begin(request({taskId: 'new-task'})), /待接續.*上限/);
  const original = f.journal.read(), failed = {...original[0], phase: 'failed'}; await f.journal.update(failed);
  await f.journal.begin(request({taskId: 'new-task'}));
  const saved = f.journal.read(); assert.equal(saved.length, 100); assert.equal(saved.some(operation => operation.id === failed.id), false);
  assert.ok(original.slice(1).every(operation => saved.some(item => item.id === operation.id)));
});
