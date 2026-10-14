import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DriveBrowserApi, DRIVE_BROWSER_FIELDS, DRIVE_FOLDER_MIME, DRIVE_SHORTCUT_MIME, readDriveBrowserEntry, sourceFromDriveEntry, isDriveFolder, documentCardPosition, scheduleDocumentTask} from '../src/app/drive-browser-data.ts';
import {documentFromUrl} from '../src/app/document-data.ts';

const raw = (id, extra = {}) => ({id, name: id, mimeType: 'application/pdf', ...extra});
test('Drive API 只讀當前資料夾，選取 metadata 欄位、分頁與共用硬碟參數並轉義搜尋字串', async () => {
  const calls = [], api = new DriveBrowserApi({api: async (...args) => {calls.push(args); return {files: [raw('file')], nextPageToken: 'page-two'};}}), signal = new AbortController().signal;
  const page = await api.list({id: 'folder', name: 'folder', driveId: 'shared-drive', resourceKey: 'key'}, "A'B\\C", 'page-one', signal);
  assert.equal(page.files[0].id, 'file'); assert.equal(page.nextPageToken, 'page-two');
  const [path, parameters, receivedSignal, keys] = calls[0];
  assert.equal(path, 'files'); assert.ok(parameters.q.startsWith("'folder' in parents and trashed = false and not (mimeType = 'application/vnd.google-apps.folder'"));
  assert.ok(parameters.q.endsWith(" and name contains 'A\\'B\\\\C'"));
  assert.match(parameters.q, /appProperties has/); assert.match(parameters.q, /name = 'IIH Orbit'/);
  assert.equal(parameters.fields, `nextPageToken,incompleteSearch,files(${DRIVE_BROWSER_FIELDS})`);
  assert.equal(parameters.pageSize, '100'); assert.equal(parameters.pageToken, 'page-one'); assert.equal(parameters.driveId, 'shared-drive'); assert.equal(parameters.corpora, 'drive'); assert.equal(parameters.alt, undefined); assert.equal(receivedSignal, signal); assert.equal(keys, 'folder/key');
  await api.list({id: 'shared', name: 'shared', shared: true});
  assert.ok(calls[1][1].q.startsWith('sharedWithMe = true and trashed = false and not ('));  assert.equal(calls[1][1].corpora, 'user'); assert.equal(calls.length, 2);
});
test('Drive 拒絕損壞、重複識別與不完整結果，快照不含內文或權杖', async () => {
  for (const response of [{}, {files: [], incompleteSearch: true}, {files: [raw('one'), raw('one')]}, {files: [raw('bad/id')]}, {files: [raw('one', {size: '-1'})]}, {files: [], nextPageToken: 4}]) {
    await assert.rejects(new DriveBrowserApi({api: async () => response}).list({id: 'root', name: 'root'}));
  }
  const file = readDriveBrowserEntry(raw('one', {resourceKey: 'secret-key', content: 'PRIVATE', accessToken: 'PRIVATE'}));
  assert.equal(file.url, 'https://drive.google.com/file/d/one/view?resourcekey=secret-key'); assert.equal(file.content, undefined); assert.equal(file.accessToken, undefined);
});
test('排除備份資料夾與同名資料夾捷徑，保留一般檔案與其他資料夾，不保存 appProperties', async () => {
  const entries = [
    raw('backup', {name: 'IIH Orbit', mimeType: DRIVE_FOLDER_MIME}),
    raw('legacy', {name: ' iih orbit ', mimeType: DRIVE_FOLDER_MIME}),
    raw('renamed', {name: '我的 Orbit 備份', mimeType: DRIVE_FOLDER_MIME, appProperties: {orbit: 'v1', type: 'folder'}}),
    raw('shortcut', {name: 'iih orbit', mimeType: DRIVE_SHORTCUT_MIME, shortcutDetails: {targetId: 'backup', targetMimeType: DRIVE_FOLDER_MIME}}),
    raw('ordinary-file', {name: 'IIH Orbit'}),
    raw('ordinary-folder', {name: 'IIH Orbit 課程', mimeType: DRIVE_FOLDER_MIME, appProperties: {orbit: 'other', type: 'folder'}}),
    raw('metadata-file', {appProperties: {orbit: 'v1', type: 'folder', arbitrary: 'PRIVATE'}})
  ];
  const api = new DriveBrowserApi({api: async () => ({files: entries})});
  for (const folder of [{id: 'root', name: 'root'}, {id: 'nested', name: 'nested'}, {id: 'shared', name: 'shared', shared: true}]) {
    const page = await api.list(folder, 'Orbit');
    assert.deepEqual(page.files.map(file => file.id), ['ordinary-file', 'ordinary-folder', 'metadata-file']);
    assert.equal(JSON.stringify(page).includes('appProperties'), false); assert.equal(JSON.stringify(page).includes('PRIVATE'), false);
  }
});
test('整頁只有備份資料夾時仍保留分頁游標，可以讀取下一頁的正常檔案', async () => {
  const calls = [], api = new DriveBrowserApi({api: async (_, parameters) => {
    calls.push(parameters);
    return parameters.pageToken ? {files: [raw('normal')]} : {files: [raw('backup', {name: 'IIH Orbit', mimeType: DRIVE_FOLDER_MIME})], nextPageToken: 'next'};
  }});
  const first = await api.list({id: 'root', name: 'root'});
  assert.deepEqual(first.files, []); assert.equal(first.nextPageToken, 'next');
  const second = await api.list({id: 'root', name: 'root'}, '', first.nextPageToken);
  assert.equal(second.files[0].id, 'normal'); assert.equal(second.nextPageToken, ''); assert.equal(calls[1].pageToken, 'next');
});
test('其他編輯器的 webViewLink 不中止整份列表，改用已驗證的 Drive ID 開啟', async () => {
  const response = {files: [
    raw('script-file', {mimeType: 'application/vnd.google-apps.script', webViewLink: 'https://script.google.com/home/projects/script-file/edit'}),
    raw('site-file', {mimeType: 'application/vnd.google-apps.site', webViewLink: 'https://sites.google.com/d/site-file/edit'}),
    raw('map-file', {mimeType: 'application/vnd.google-apps.map', webViewLink: 'https://www.google.com/maps/d/viewer?mid=map-file'}),
    raw('doc-file', {mimeType: 'application/vnd.google-apps.document', webViewLink: 'https://docs.google.com/document/d/doc-file/edit'})
  ]}, api = new DriveBrowserApi({api: async () => response});
  const page = await api.list({id: 'folder', name: 'Folder'});
  assert.equal(page.files.length, 4);
  for (const file of page.files.slice(0, 3)) {
    assert.equal(file.url, `https://drive.google.com/file/d/${file.id}/view`);
    const source = sourceFromDriveEntry(file); assert.equal(source.fileId, file.id); assert.equal(source.id, documentFromUrl('google-drive', file.url, file.name).id);
  }
  assert.equal(page.files[3].url, response.files[3].webViewLink);
});
test('空白、損壞或不安全的開啟網址只使用 Drive 備用連結，保留 resource key 並可保存關聯', () => {
  for (const webViewLink of ['', null, 42, 'not a URL', 'http://drive.google.com/file/d/file/view', 'https://drive.google.com:8443/file/d/file/view', 'https://drive.google.com.evil.example/file', 'https://evil.example/file', 'javascript:alert(1)', 'https://docs.google.com/document/d/file/edit?access_token=PRIVATE-TOKEN', 'https://user:PRIVATE-PASSWORD@drive.google.com/file/d/file/view']) {
    for (const folder of [false, true]) {
      const file = readDriveBrowserEntry(raw('file', {mimeType: folder ? DRIVE_FOLDER_MIME : 'application/pdf', webViewLink, resourceKey: 'resource-key'}));
      assert.equal(file.url, `https://drive.google.com/${folder ? 'drive/folders/file' : 'file/d/file/view'}?resourcekey=resource-key`);
      assert.equal(JSON.stringify(sourceFromDriveEntry(file)).includes('PRIVATE'), false);
    }
  }
  assert.throws(() => readDriveBrowserEntry(raw('bad/id', {webViewLink: 'https://evil.example/file'})));
});
test('資料夾與捷徑可關聯，來源 ID 與 URL 手動加入一致', () => {
  const folder = readDriveBrowserEntry(raw('folder', {mimeType: DRIVE_FOLDER_MIME})), shortcut = readDriveBrowserEntry(raw('shortcut', {mimeType: DRIVE_SHORTCUT_MIME, shortcutDetails: {targetId: 'target', targetMimeType: DRIVE_FOLDER_MIME, targetResourceKey: 'key'}}));
  assert.equal(isDriveFolder(folder), true); assert.equal(isDriveFolder(shortcut), true); assert.equal(shortcut.shortcut.id, 'target');
  const source = sourceFromDriveEntry(folder, '我的雲端硬碟'); assert.equal(source.id, documentFromUrl('google-drive', folder.url, folder.name).id);
  assert.equal(source.sourceScope, 'drive'); assert.equal(sourceFromDriveEntry(shortcut).fileId, 'shortcut');
  assert.throws(() => readDriveBrowserEntry(raw('one', {shortcutDetails: {targetId: 'bad/id', targetMimeType: DRIVE_FOLDER_MIME}})));
});
test('卡片中央關聯，邊緣、空隙與空欄位提供精確新增位置', () => {
  const cards = [{id: 'a', top: 100, bottom: 200}, {id: 'b', top: 215, bottom: 315}];
  const position = y => documentCardPosition(cards, y, 'todo');
  for (const y of [20, 100, 121]) assert.deepEqual(position(y), {kind: 'create', beforeId: 'a', status: 'todo'});
  for (const y of [122, 150, 178]) assert.deepEqual(position(y), {kind: 'link', taskId: 'a', status: 'todo'});
  for (const y of [179, 200, 210, 215]) assert.deepEqual(position(y), {kind: 'create', beforeId: 'b', status: 'todo'});
  assert.deepEqual(position(260), {kind: 'link', taskId: 'b', status: 'todo'}); assert.deepEqual(position(315), {kind: 'create', status: 'todo'});
  assert.deepEqual(documentCardPosition([], 20), {kind: 'create'});
});
test('月日期與週全天建立同日任務，週時段對齊 15 分鐘並跨午夜保存一小時', () => {
  const source = sourceFromDriveEntry(readDriveBrowserEntry(raw('one'))), base = {id: 'task', title: 'old', startDate: '', dueDate: '', startTime: '', dueTime: ''};
  assert.equal(scheduleDocumentTask(base, source).title, 'one'); assert.equal(base.title, 'old');
  for (const kind of ['month', 'all-day']) assert.deepEqual(scheduleDocumentTask(base, source, {kind, day: '2026-12-31'}), {...base, title: 'one', startDate: '2026-12-31', dueDate: '2026-12-31'});
  const timed = scheduleDocumentTask(base, source, {kind: 'time', day: '2026-12-31', minute: 23 * 60 + 43});
  assert.equal(timed.startTime, '23:45'); assert.equal(timed.dueTime, '00:45'); assert.equal(timed.dueDate, '2027-01-01');
  assert.throws(() => scheduleDocumentTask(base, source, {kind: 'time', day: 'invalid', minute: 30})); assert.throws(() => scheduleDocumentTask(base, source, {kind: 'time', day: '2026-10-13', minute: NaN}));
});

test('拖曳預覽浮在 body 上且不遮住指標，viewport 邊緣翻轉位置，drop 與 pagehide 清除', async () => {
  const {JSDOM} = await import('jsdom'), {readFileSync} = await import('node:fs'), {createDocumentDragPreview} = await import('../src/app/document-drag-preview.ts');
  const styles = readFileSync('src/document-drag-preview.css', 'utf8'), dom = new JSDOM(`<style>${styles}</style><article></article>`), document = dom.window.document, dataTransfer = {setDragImage() {}}, source = sourceFromDriveEntry(readDriveBrowserEntry(raw('one')));
  try {
    let ended = 0; const cleanup = createDocumentDragPreview({currentTarget: document.querySelector('article'), clientX: 1010, clientY: 750, dataTransfer}, source, () => ended++), preview = document.querySelector('.document-drag-preview');
    assert.equal(preview.parentElement, document.body); assert.equal(dom.window.getComputedStyle(preview).position, 'fixed'); assert.equal(dom.window.getComputedStyle(preview).pointerEvents, 'none');
    const coordinates = preview.style.transform.match(/\((\d+)px, (\d+)px/); assert.ok(Number(coordinates[1]) < 1010); assert.ok(Number(coordinates[2]) < 750); assert.ok(Number(coordinates[1]) >= 8); assert.ok(Number(coordinates[2]) >= 8); assert.equal(preview.textContent, 'one');
    document.dispatchEvent(new dom.window.Event('drop')); assert.equal(document.querySelector('.document-drag-preview'), null); assert.equal(document.querySelector('.document-drag-mask'), null); cleanup(); assert.equal(ended, 0);
    createDocumentDragPreview({currentTarget: document.querySelector('article'), clientX: 20, clientY: 30, dataTransfer}, source, () => ended++); dom.window.dispatchEvent(new dom.window.Event('pagehide')); assert.equal(ended, 1); assert.equal(document.querySelector('.document-drag-preview'), null);
    assert.match(readFileSync('src/styles.css', 'utf8'), /@import '.\/document-drag-preview.css'/);
  } finally {dom.window.close();}
});
