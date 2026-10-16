import assert from 'node:assert/strict';
import {test} from 'node:test';
import {descriptionsForTask, documentFromUrl, documentsForTask, setTaskDocuments} from '../src/app/document-data.ts';
import {readBoardState} from '../src/app/board-data.ts';
import {copyWorkspaces, createBackup, readBackup} from '../src/app/backup-data.ts';
import {createDriveDocument, readDriveDocument, readDriveFile, syncHash, versionProperties} from '../src/app/drive-data.ts';
import {mergeDriveBackups} from '../src/app/drive-merge.ts';
import {splitWorkspaceRecords, joinWorkspaceRecords, changedWorkspaceRecords} from '../src/app/workspace-records.ts';
import {mailInformationSource} from '../src/app/mail-information-data.ts';
import {backup, cloud} from './helpers/backup-cloud.mjs';

const first = documentFromUrl('google-drive', 'https://docs.google.com/document/d/first/edit', '研究文件');
const second = documentFromUrl('google-drive', 'https://drive.google.com/drive/folders/second', '資料夾');
const mail = mailInformationSource({id: 'mail', subject: '討論信件', from: 'sender@example.test', senderEmail: 'sender@example.test'}, 'me@example.test', 'account');
const workspace = () => backup(2).data.workspaces[0];
const wrap = board => createBackup({version: 1, activeWorkspaceId: board.id, workspaces: [board]}, 'full');
const edit = (board, sources, notes = {}, task = 'task-0') => setTaskDocuments(board, task, sources, undefined, sources.map(source => ({documentId: source.id, description: notes[source.id] ?? descriptionsForTask(board, task).find(item => item.documentId === source.id)?.description ?? ''})));
const note = (board, source = first, task = 'task-0') => descriptionsForTask(board, task).find(item => item.documentId === source.id)?.description;
const ids = board => documentsForTask(board, 'task-0').map(source => source.id);

test('用途說明屬於任務／來源，檔案、資料夾與信件共用手動順序，重複事件只顯示一次', () => {
  let board = edit(workspace(), [first, second, mail], {[first.id]: '閱讀第 2 節\n<純文字>'});
  board = edit(board, [mail, first, second]);
  board = edit(board, [first], {[first.id]: '另一個任務的用途'}, 'task-1');
  board.documentLinks.push({...board.documentLinks.find(link => link.documentId === first.id), id: 'concurrent-add'});
  assert.deepEqual(ids(board), [mail.id, first.id, second.id]);
  assert.equal(note(board), '閱讀第 2 節\n<純文字>'); assert.equal(note(board, first, 'task-1'), '另一個任務的用途');
  assert.equal(board.documentSources.find(source => source.id === first.id).description, undefined);
  assert.ok(readBoardState(board));
  const observed = edit(board, [mail, first, second]);
  assert.deepEqual(edit(observed, [mail, first, second]), observed);
});

test('移除後重新加入使用空白說明與清單末端，不復用已移除事件的說明', () => {
  const original = edit(workspace(), [first, second], {[first.id]: '舊用途'});
  const removed = edit(original, [second]), readded = edit(removed, [second, first]);
  assert.equal(note(readded), ''); assert.deepEqual(ids(readded), [second.id, first.id]);
  assert.notEqual(readded.documentDetails.find(item => item.documentId === first.id).linkIds[0], original.documentLinks[0].id);
  assert.equal(original.documentLinks[0].removed, undefined); assert.equal(note(original), '舊用途');
});

test('不同連結的說明與排序可合併，同一來源在不同任務修改也互不覆蓋', () => {
  const board = edit(workspace(), [first, second, mail]), base = wrap(board);
  const a = wrap(edit(board, [first, second, mail], {[first.id]: '文件用途'}));
  const b = wrap(edit(board, [mail, first, second], {[second.id]: '資料夾用途'}));
  const result = mergeDriveBackups(base, [a, b], undefined, true);
  assert.deepEqual(result.conflicts, []); assert.deepEqual(ids(result.backup.data.workspaces[0]), [mail.id, first.id, second.id]);
  assert.equal(note(result.backup.data.workspaces[0]), '文件用途'); assert.equal(note(result.backup.data.workspaces[0], second), '資料夾用途');
  const other = wrap(edit(board, [first], {[first.id]: '另一任務'}, 'task-1'));
  const combined = mergeDriveBackups(base, [a, other], undefined, true);
  assert.deepEqual(combined.conflicts, []); assert.equal(note(combined.backup.data.workspaces[0], first, 'task-1'), '另一任務');
});

test('相同說明或順序的衝突保留各分支供選擇，明確選擇仍保留其他連結的獨立修改', () => {
  const board = edit(workspace(), [first, second, mail]), base = wrap(board);
  const a = wrap(edit(board, [second, first, mail], {[first.id]: 'A 的說明', [second.id]: '獨立修改'}));
  const b = wrap(edit(board, [first, mail, second], {[first.id]: 'B 的說明'}));
  const result = mergeDriveBackups(base, [a, b], undefined, true);
  assert.ok(result.conflicts.some(path => path.includes('description'))); assert.ok(result.conflicts.some(path => path.endsWith('.order')));
  const chosen = mergeDriveBackups(base, [a, b], 1, true).backup.data.workspaces[0];
  assert.equal(note(chosen), 'B 的說明'); assert.equal(note(chosen, second), '獨立修改'); assert.deepEqual(ids(chosen), [first.id, mail.id, second.id]);
  assert.equal(note(a.data.workspaces[0]), 'A 的說明'); assert.equal(note(b.data.workspaces[0]), 'B 的說明');
});

test('第一次並行加入可合併不同連結，相同來源的不同用途需要選擇，仍只呈現一筆', () => {
  const original = workspace(), base = wrap(original);
  const a = wrap(edit(original, [first], {[first.id]: 'A'})), b = wrap(edit(original, [second], {[second.id]: 'B'}));
  const different = mergeDriveBackups(base, [a, b], undefined, true);
  assert.deepEqual(different.conflicts, []); assert.equal(ids(different.backup.data.workspaces[0]).length, 2);
  const same = wrap(edit(original, [first], {[first.id]: 'B'}));
  const collision = mergeDriveBackups(base, [a, same], undefined, true);
  assert.ok(collision.conflicts.some(path => path.includes('description'))); assert.equal(ids(collision.backup.data.workspaces[0]).length, 1);
  assert.equal(collision.backup.data.workspaces[0].documentLinks.filter(link => !link.removed).length, 2);
});

test('舊裝置修改已移除事件，不會把用途復活到重新加入的新關聯', () => {
  const board = edit(workspace(), [first]), base = wrap(board);
  const stale = wrap(edit(board, [first], {[first.id]: '舊裝置後來填寫'}));
  const readded = wrap(edit(edit(board, []), [first]));
  const result = mergeDriveBackups(base, [stale, readded], undefined, true);
  assert.deepEqual(result.conflicts, []); assert.equal(note(result.backup.data.workspaces[0]), '');
  assert.equal(result.backup.data.workspaces[0].documentLinks.filter(link => !link.removed).length, 1);
});

test('舊文件格式升級時，以原始顯示順序作為整併基準，補說明不干擾另一裝置重排', () => {
  const board = setTaskDocuments(workspace(), 'task-0', [first, second, mail]), base = wrap(board);
  const a = wrap(edit(board, [first, second, mail], {[first.id]: '用途'})), b = wrap(edit(board, [mail, first, second]));
  const result = mergeDriveBackups(base, [a, b], undefined, true);
  assert.deepEqual(result.conflicts, []); assert.equal(note(result.backup.data.workspaces[0]), '用途');
  assert.deepEqual(ids(result.backup.data.workspaces[0]), [mail.id, first.id, second.id]);
});

test('用途與順序使用新版格式，拒絕降級、過長內容、重複資料及錯誤生命週期參照', () => {
  const board = edit(workspace(), [first, second], {[first.id]: '用途'});
  assert.equal(board.version, 6); assert.equal(wrap(board).formatVersion, 7);
  for (const version of [4, 5]) assert.equal(readBoardState({...board, version}), null);
  for (const formatVersion of [5, 6]) assert.throws(() => readBackup({...wrap(board), formatVersion}), /新版/);
  assert.throws(() => edit(board, [first], {[first.id]: '字'.repeat(1001)}), /1000/);
  for (const corrupt of [
    {...board, documentDetails: [{...board.documentDetails[0], description: '字'.repeat(1001)}]},
    {...board, documentDetails: [{...board.documentDetails[0], linkIds: ['missing']}]},
    {...board, documentDetails: [{...board.documentDetails[0], linkIds: [board.documentLinks[1].id]}]},
    {...board, documentDetails: [...board.documentDetails, board.documentDetails[0]]},
    {...board, documentOrders: [{id: 'task-0', documentIds: [first.id, first.id]}]},
    {...board, documentOrders: undefined}
  ]) assert.equal(readBoardState(corrupt), null);
});

test('JSON、副本與本機紀錄保留用途及順序，副本重新建立任務與生命週期 ID', async () => {
  const board = edit(workspace(), [mail, second, first], {[first.id]: '重要用途'}), saved = wrap(board);
  const restored = readBackup(JSON.parse(JSON.stringify(saved))).data.workspaces[0];
  assert.deepEqual(ids(restored), ids(board)); assert.equal(note(restored), '重要用途');
  const [copy] = copyWorkspaces([board]); assert.ok(readBoardState(copy));
  assert.notEqual(copy.tasks[0].id, board.tasks[0].id);
  assert.equal(note(copy, first, copy.tasks[0].id), '重要用途');
  assert.equal(copy.documentDetails[0].linkIds.some(id => board.documentLinks.some(link => link.id === id)), false);
  const data = {formatVersion: 2, generation: 'test', revision: 'one', updatedAt: '2026-10-15T00:00:00.000Z', state: saved.data};
  const records = splitWorkspaceRecords(data); assert.deepEqual(joinWorkspaceRecords(records).state, data.state);
  const changed = {...data, state: wrap(edit(board, [mail, second, first], {[first.id]: '更新用途'})).data};
  const delta = changedWorkspaceRecords(records, splitWorkspaceRecords(changed));
  assert.equal(delta.put.length, 1); assert.match(delta.put[0].key, /documentDetails/);
  assert.notEqual(await syncHash(saved), await syncHash(wrap(edit(board, [first, second, mail]))));
});

test('新版 Drive 手動 JSON 與自動分塊備份皆能還原用途、順序與 v7 版本標記', async () => {
  const board = edit(workspace(), [second, first], {[first.id]: '讀這份文件'}), service = cloud();
  for (const purpose of ['manual', 'sync']) {
    const document = await createDriveDocument(wrap(board), crypto.randomUUID(), [], purpose), id = await service.api.generateId();
    assert.equal(document.cloud.formatVersion, 7); assert.ok(await readDriveDocument(document));
    const file = await service.api.save(document, id), restored = await service.api.read(file);
    assert.deepEqual(ids(restored.data.workspaces[0]), [second.id, first.id]); assert.equal(note(restored.data.workspaces[0]), '讀這份文件');
    assert.equal(readDriveFile({id, name: 'backup.json', mimeType: 'application/json', createdTime: document.exportedAt, appProperties: versionProperties(document)}).cloud.formatVersion, 7);
    await assert.rejects(readDriveDocument({...document, cloud: {...document.cloud, formatVersion: 6}}), /新版/);
  }
});
