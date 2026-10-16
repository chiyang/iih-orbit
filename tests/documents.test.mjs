import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createDocumentSource, documentFromUrl, documentLocationLabel, documentLocationSnapshot, documentsForTask, setTaskDocuments, tasksForDocument, mergeDocumentLinks} from '../src/app/document-data.ts';
import {DocumentMetadataCache} from '../src/app/document-metadata.ts';
import {readBoardState} from '../src/app/board-data.ts';
import {createBackup, copyWorkspaces, readBackup} from '../src/app/backup-data.ts';
import {emptyWorkspace} from '../src/app/workspace-data.ts';
import {mergeDriveBackups} from '../src/app/drive-merge.ts';
import {createDriveDocument, readDriveDocument, readDriveFile, versionProperties, syncHash} from '../src/app/drive-data.ts';
import {splitWorkspaceRecords, joinWorkspaceRecords, changedWorkspaceRecords} from '../src/app/workspace-records.ts';
import {backup, cloud} from './helpers/backup-cloud.mjs';
import {sourceOpenUrl} from '../src/app/source-file-type.ts';

const google = (id = 'source-one', name = '研究文件') => documentFromUrl('google-drive', `https://docs.google.com/document/d/${id}/edit`, name);
const workspace = () => backup(2).data.workspaces[0];
const wrap = board => createBackup({version: 1, activeWorkspaceId: board.id, workspaces: [board]}, 'full');

test('Colab 仍保存可攜 Drive 身份及連結，還原後在介面開啟 Colab 編輯器', () => {
  const source = createDocumentSource({provider: 'google-drive', sourceScope: 'drive', fileId: 'notebook', name: '分析.ipynb', mimeType: 'application/vnd.google.colaboratory', url: 'https://drive.google.com/file/d/notebook/view?resourcekey=key'});
  const restored = readBackup(JSON.parse(JSON.stringify(wrap(setTaskDocuments(workspace(), 'task-0', [source]))))).data.workspaces[0].documentSources.find(item => item.id === source.id);
  assert.equal(restored.id, source.id); assert.equal(restored.url, source.url); assert.equal(sourceOpenUrl(restored), 'https://colab.research.google.com/drive/notebook?resourcekey=key');
  assert.equal(sourceOpenUrl({...source, mimeType: 'application/octet-stream'}), 'https://colab.research.google.com/drive/notebook?resourcekey=key');
  for (const other of [{...source, provider: 'pcloud', url: 'https://my.pcloud.com/file/notebook'}, {...source, mimeType: 'application/vnd.google-apps.document'}, {...source, url: 'https://drive.google.com.evil.test/file/d/notebook/view'}]) assert.equal(sourceOpenUrl(other), other.url);
});

test('資訊連結保留來源名稱與路徑快照，JSON 還原後仍可顯示，舊來源不誤認為其他帳號', () => {
  const source = {...google(), location: documentLocationSnapshot('研究 / 計畫：來源', '我的雲端硬碟 / 教材')};
  const restored = readBackup(JSON.parse(JSON.stringify(wrap(setTaskDocuments(workspace(), 'task-0', [source]))))).data.workspaces[0].documentSources[0];
  assert.equal(documentLocationLabel(restored), '研究 / 計畫：來源 / 我的雲端硬碟 / 教材');
  assert.equal(restored.id, google().id); assert.equal(restored.url, google().url);
  assert.equal(documentLocationLabel({...google(), location: '我的雲端硬碟 / 教材'}), 'Google Drive · 我的雲端硬碟 / 教材');
  assert.equal(documentLocationLabel(google()), 'Google Drive');
  assert.equal(documentLocationLabel({...google(), provider: 'gmail', location: '寄件人@example.test'}), 'Gmail · 寄件人@example.test');
});

test('來源識別優先，改名／移動不新增來源；跨服務／範圍與同名不同 ID 不合併', () => {
  const source = google(), renamed = google('source-one', '新名稱');
  assert.equal(source.id, renamed.id);
  assert.notEqual(source.id, google('source-two').id);
  const pcloud = createDocumentSource({provider: 'pcloud', sourceScope: 'eu/account-a', fileId: '123', name: '研究文件', url: 'https://e.pcloud.link/publink/show?code=share'});
  assert.notEqual(pcloud.id, createDocumentSource({...pcloud, sourceScope: 'us/account-a', id: undefined}).id);
  const moved = createDocumentSource({...pcloud, location: '/新資料夾', name: '新名稱'});
  assert.equal(pcloud.id, moved.id);
  const path = createDocumentSource({provider: 'pcloud', sourceScope: 'eu/account-a', locator: '/研究/檔案.pdf', name: '檔案', url: pcloud.url});
  assert.notEqual(path.id, pcloud.id);
  const unresolved = documentFromUrl('pcloud', pcloud.url, '只有分享連結');
  assert.notEqual(unresolved.id, pcloud.id);
  assert.equal(documentFromUrl('pcloud', pcloud.url, '再次加入', [pcloud]).fileId, '123');
});

test('多對多查找一致，重複加入不增加事件；移除只解除觀察到的關聯', () => {
  const source = google(), second = google('source-two');
  let board = setTaskDocuments(workspace(), 'task-0', [source, second]);
  board = setTaskDocuments(board, 'task-1', [source]);
  assert.equal(board.documentSources.length, 2); assert.equal(board.documentLinks.length, 3);
  assert.equal(tasksForDocument([board], source).length, 2);
  const repeated = setTaskDocuments(board, 'task-0', [source, second]);
  assert.deepEqual(repeated, board);
  const removed = setTaskDocuments(board, 'task-0', [second]);
  assert.equal(removed.documentSources.length, 2); assert.equal(removed.documentLinks.filter(link => link.removed).length, 1);
  assert.equal(tasksForDocument([removed], source).length, 1); assert.equal(documentsForTask(removed, 'task-0')[0].id, second.id);
  assert.equal(source.url, google().url);
  const trashed = {...board, tasks: board.tasks.map(task => task.id === 'task-0' ? {...task, deletedAt: '2026-10-13T00:00:00.000Z'} : task)};
  assert.equal(tasksForDocument([trashed], source).length, 1); assert.equal(tasksForDocument([trashed], source, true).length, 2);
});

test('第一份文件從舊格式基準並行新增，可保留不同文件與不同任務的關聯', () => {
  const original = workspace(), base = wrap(original), a = wrap(setTaskDocuments(original, 'task-0', [google()])), b = wrap(setTaskDocuments(original, 'task-0', [google('two')]));
  const result = mergeDriveBackups(base, [a, b], undefined, true);
  assert.deepEqual(result.conflicts, []); assert.equal(result.backup.formatVersion, 6);
  assert.equal(documentsForTask(result.backup.data.workspaces[0], 'task-0').length, 2);
  const otherTask = wrap(setTaskDocuments(original, 'task-1', [google()]));
  const related = mergeDriveBackups(base, [a, otherTask], undefined, true);
  assert.deepEqual(related.conflicts, []); assert.equal(related.backup.data.workspaces[0].documentSources.length, 1);
  assert.equal(tasksForDocument(related.backup.data.workspaces, google()).length, 2);
});

test('並行加入同一來源只顯示一次，刪除勝過同一事件的舊副本，再加入保留新事件', () => {
  const original = workspace(), source = google(), base = wrap(original);
  const a = wrap(setTaskDocuments(original, 'task-0', [source])), b = wrap(setTaskDocuments(original, 'task-0', [google('source-one', '另一裝置名稱')]));
  const merged = mergeDriveBackups(base, [a, b], undefined, true).backup;
  assert.equal(merged.data.workspaces[0].documentSources.length, 1); assert.equal(documentsForTask(merged.data.workspaces[0], 'task-0').length, 1);
  const removed = wrap(setTaskDocuments(merged.data.workspaces[0], 'task-0', []));
  const stale = mergeDriveBackups(base, [removed, a, b], undefined, true);
  assert.deepEqual(stale.conflicts, []); assert.equal(documentsForTask(stale.backup.data.workspaces[0], 'task-0').length, 0);
  const readded = wrap(setTaskDocuments(removed.data.workspaces[0], 'task-0', [source]));
  const again = mergeDriveBackups(merged, [removed, readded], undefined, true);
  assert.deepEqual(again.conflicts, []); assert.equal(documentsForTask(again.backup.data.workspaces[0], 'task-0').length, 1);
  assert.equal(again.backup.data.workspaces[0].documentLinks.filter(link => !link.removed).length, 1);
});

test('文件新增與任務內容衝突分開保留，待選版本讀取不丟文件', () => {
  const board = setTaskDocuments(workspace(), 'task-0', [google()]), base = wrap(board), a = structuredClone(base), b = wrap(setTaskDocuments(board, 'task-0', [google(), google('new')]));
  a.data.workspaces[0].tasks[0].description = '裝置 A'; b.data.workspaces[0].tasks[0].description = '裝置 B';
  const result = mergeDriveBackups(base, [a, b], undefined, true);
  assert.deepEqual(result.conflicts, []); assert.equal(result.backup.data.workspaces[0].taskConflicts.length, 1);
  assert.equal(documentsForTask(result.backup.data.workspaces[0], 'task-0').length, 2);
  assert.ok(readBackup(result.backup));
});

test('驗證整份來源與關聯，拒絕錯誤參照、重複 ID、低格式夾帶文件及不安全 URL', () => {
  const board = setTaskDocuments(workspace(), 'task-0', [google()]);
  assert.ok(readBoardState(board));
  for (const change of [
    value => value.documentLinks[0].documentId = 'missing',
    value => value.documentLinks[0].taskId = 'missing',
    value => value.documentLinks.push({...value.documentLinks[0]}),
    value => value.documentSources[0].fileId = 'different',
    value => value.version = 4,
    value => value.documentSources[0].url = 'javascript:alert(1)',
    value => value.documentSources[0].url = 'https://docs.google.com/document/d/source-one/edit?access_token=secret'
  ]) {const value = structuredClone(board); change(value); assert.equal(readBoardState(value), null);}
  assert.throws(() => mergeDocumentLinks([[board.documentLinks[0]], [{...board.documentLinks[0], taskId: 'task-1'}]]));
  assert.throws(() => documentFromUrl('google-drive', 'https://docs.google.com.evil.example/document/d/source-one', '錯誤'));
  assert.throws(() => readBackup({...wrap(board), formatVersion: 5}), /新版/);
  const extra = wrap(board); Object.assign(extra.data.workspaces[0].documentSources[0], {content: '原文件本文', accessToken: 'secret'});
  const sanitized = readBackup(extra).data.workspaces[0].documentSources[0];
  assert.equal(sanitized.content, undefined); assert.equal(sanitized.accessToken, undefined);
});

test('新版單一 JSON 可獨立還原，選定空間與副本保留來源並重新編號任務及事件', () => {
  const board = setTaskDocuments(workspace(), 'task-0', [google()]), second = emptyWorkspace('second', '第二空間');
  const selected = createBackup({version: 1, activeWorkspaceId: board.id, workspaces: [board, second]}, 'workspaces', [board.id]);
  assert.equal(selected.formatVersion, 6); assert.equal(readBackup(JSON.parse(JSON.stringify(selected))).data.workspaces[0].documentSources.length, 1);
  const [copied] = copyWorkspaces(selected.data.workspaces);
  assert.notEqual(copied.id, board.id); assert.notEqual(copied.tasks[0].id, board.tasks[0].id);
  assert.notEqual(copied.documentLinks[0].id, board.documentLinks[0].id);
  assert.deepEqual(copied.documentSources, board.documentSources); assert.equal(documentsForTask(copied, copied.tasks[0].id)[0].url, google().url);
  assert.ok(readBoardState(copied)); assert.equal(readBackup(wrap(workspace())).formatVersion, 5);
});

test('按紀錄保存文件和事件，單筆關聯修改不重寫所有任務', () => {
  const board = setTaskDocuments(workspace(), 'task-0', [google()]);
  const stored = {formatVersion: 2, generation: 'test', revision: 'one', updatedAt: '2026-10-13T00:00:00.000Z', state: wrap(board).data};
  const before = splitWorkspaceRecords(stored); assert.deepEqual(joinWorkspaceRecords(before), stored);
  const next = {...stored, state: wrap(setTaskDocuments(board, 'task-1', [google()])).data};
  const changes = changedWorkspaceRecords(before, splitWorkspaceRecords(next));
  assert.equal(changes.remove.length, 0); assert.equal(changes.put.length, 2);
  assert.ok(changes.put.some(record => record.key.includes('documentLinks')));
});

test('metadata 快取獨立，不改變同步雜湊或工作資料，世代切換清空舊顯示資訊', async () => {
  const board = setTaskDocuments(workspace(), 'task-0', [google()]), saved = wrap(board), hash = await syncHash(saved), cache = new DocumentMetadataCache();
  cache.set('one', google(), {name: '雲端新名稱', location: '/新位置', status: 'available', checkedAt: '2026-10-13T00:00:00.000Z', accessToken: 'not-retained'});
  assert.equal(cache.get('one', google()).accessToken, undefined);
  assert.equal(cache.get('one', google()).name, '雲端新名稱'); assert.equal(await syncHash(saved), hash);
  assert.equal(saved.data.workspaces[0].documentSources[0].name, '研究文件'); assert.equal(cache.get('two', google()), undefined);
});

test('含文件的自動同步使用新版分塊格式，手動 Drive 備份仍是完整 JSON', async () => {
  const board = setTaskDocuments(workspace(), 'task-0', [google()]), saved = wrap(board), service = cloud();
  for (const purpose of ['sync', 'manual']) {
    const document = await createDriveDocument(saved, crypto.randomUUID(), [], purpose), id = await service.api.generateId();
    assert.equal(document.cloud.formatVersion, 6); assert.equal((await readDriveDocument(document)).formatVersion, 6);
    const file = await service.api.save(document, id), loaded = await service.api.read(file);
    assert.equal(documentsForTask(loaded.data.workspaces[0], 'task-0').length, 1);
    assert.equal(service.files.get(id).data.application, purpose === 'sync' ? 'iih-orbit-chunked' : 'iih-orbit');
    assert.equal(readDriveFile({id, name: 'backup.json', mimeType: 'application/json', createdTime: document.exportedAt, appProperties: versionProperties(document)}).cloud.formatVersion, 6);
  }
  service.advance(100);
  assert.deepEqual(await service.api.cleanupBlocks(() => true, service.now()), {observed: 0, removed: 0, remaining: false});
});

test('Gmail 資訊連結按帳號與 message ID 去重，移除與跨分支整併保留原信及其他連結', async () => {
  const {mailInformationSource} = await import('../src/app/mail-information-data.ts'), {documentUrl} = await import('../src/app/document-data.ts');
  const mail = {id: 'mail', threadId: 'thread', subject: '研究討論', from: '作者 <author@example.test>', senderEmail: 'author@example.test', senderName: '作者', snippet: 'PRIVATE-PREVIEW', messageId: '<mail@example.test>', receivedAt: 1, labelIds: []}, source = mailInformationSource({...mail, body: 'PRIVATE-BODY', accessToken: 'PRIVATE-TOKEN'}, 'me@example.test', 'account-a');
  assert.equal(source.provider, 'gmail'); assert.equal(source.fileId, 'mail'); assert.equal(source.id, mailInformationSource({...mail, subject: '名稱更新'}, 'me@example.test', 'account-a').id);
  assert.notEqual(source.id, mailInformationSource(mail, 'other@example.test', 'account-b').id); assert.equal(JSON.stringify(source).includes('PRIVATE'), false);
  assert.ok(documentUrl(source.url, 'gmail')); const board = setTaskDocuments(workspace(), 'task-0', [google(), source]), saved = readBackup(JSON.parse(JSON.stringify(wrap(board)))).data.workspaces[0];
  assert.equal(documentsForTask(saved, 'task-0').length, 2); assert.equal(tasksForDocument([saved], source).length, 1);
  const removed = setTaskDocuments(saved, 'task-0', [google()]); assert.equal(documentsForTask(removed, 'task-0').length, 1);
  const merged = mergeDriveBackups(wrap(board), [wrap(removed), wrap(board)], undefined, true).backup; assert.equal(documentsForTask(merged.data.workspaces[0], 'task-0').some(item => item.provider === 'gmail'), false);
  const url = new URL(source.url); url.searchParams.set('continue', 'https://evil.example/mail/'); assert.equal(documentUrl(url.href, 'gmail'), null);
  url.searchParams.set('continue', 'https://mail.google.com/mail/?access_token=PRIVATE'); assert.equal(documentUrl(url.href, 'gmail'), null);
  assert.equal(documentUrl('https://accounts.google.com/AccountChooser?continue=https://accounts.google.com/AccountChooser', 'gmail'), null);
  assert.equal(documentUrl('https://mail.google.com.evil.example/mail/', 'gmail'), null);
});
