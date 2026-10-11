import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createBackup, readBackup} from '../src/app/backup-data.ts';
import {emptyWorkspace} from '../src/app/workspace-data.ts';
import {commonDriveAncestor, mergeDriveBackups} from '../src/app/drive-merge.ts';
import {createDriveDocument, readDriveFile, versionProperties, syncHash} from '../src/app/drive-data.ts';

const task = (id = 'task') => ({id, title: '原始', description: '', projectId: '', categoryId: '', status: 'todo', priority: 'medium', startDate: '', startTime: '', dueDate: '', dueTime: '', subtasks: []});
function versions() {
  const workspace = {...emptyWorkspace('workspace', '工作'), tasks: [task()]};
  const base = createBackup({version: 1, activeWorkspaceId: 'workspace', workspaces: [workspace]}, 'full');
  return {base, a: structuredClone(base), b: structuredClone(base)};
}
const tasks = backup => backup.data.workspaces[0].tasks;
const file = document => readDriveFile({id: 'drive_' + document.cloud.versionId, name: 'Orbit.json', mimeType: 'application/json', createdTime: document.exportedAt, appProperties: versionProperties(document)});

test('裝置來源只是紀錄，安全欄位自動整併；各份描述原文與來源時間獨立保留', () => {
  const {base, a, b} = versions();
  tasks(a)[0] = {...tasks(a)[0], title: '工作版', editSource: {id: 'A', name: '工作電腦'}, updatedAt: '2026-10-11T01:00:00.000Z'};
  tasks(b)[0] = {...tasks(b)[0], priority: 'high', editSource: {id: 'B', name: '手機'}, updatedAt: '2026-10-11T02:00:00.000Z'};
  const safe = mergeDriveBackups(base, [a, b], undefined, true);
  assert.deepEqual(safe.conflicts, []); assert.equal(safe.backup.data.workspaces[0].taskConflicts, undefined);
  assert.equal(tasks(safe.backup)[0].title, '工作版'); assert.equal(tasks(safe.backup)[0].priority, 'high');
  tasks(a)[0].description = '段落一\n\n工作電腦完整描述'; tasks(b)[0].description = '段落一\n\n手機完整描述';
  const conflict = mergeDriveBackups(base, [a, b], undefined, true).backup;
  const entries = conflict.data.workspaces[0].taskConflicts[0].versions;
  assert.equal(entries.length, 2);
  for (const input of [a, b]) {
    const original = tasks(input)[0], version = entries.find(version => version.source.id === original.editSource.id);
    assert.equal(version.task.description, original.description);
    assert.deepEqual(version.source, {...original.editSource, updatedAt: original.updatedAt});
  }
  const repeated = mergeDriveBackups(base, [conflict, a, b], undefined, true).backup;
  assert.deepEqual(repeated.data.workspaces[0].taskConflicts[0].versions.map(version => version.source), entries.map(version => version.source));
});

test('修改並採用版本後，晚到的舊版本不覆蓋新草稿；兩端新草稿衝突仍保留', () => {
  const {base, a, b} = versions(); tasks(a)[0].description = 'A 內容'; tasks(b)[0].description = 'B 內容';
  const pending = mergeDriveBackups(base, [a, b], undefined, true).backup, resolved = structuredClone(pending);
  const record = resolved.data.workspaces[0].taskConflicts[0]; record.resolved = record.versions[0].key;
  resolved.data.workspaces[0].tasks[0] = {...record.versions[0].task, title: '人工調整', description: '使用者手動保留兩邊的重要內容'};
  const late = mergeDriveBackups(pending, [resolved, b], undefined, true);
  assert.deepEqual(late.conflicts, []); assert.equal(tasks(late.backup)[0].description, tasks(resolved)[0].description);
  assert.ok(late.backup.data.workspaces[0].taskConflicts[0].resolved);
  assert.deepEqual(late.backup.data.workspaces[0].taskConflicts[0].versions, pending.data.workspaces[0].taskConflicts[0].versions);
  const second = structuredClone(resolved); tasks(second)[0].description = '另一台裝置手動調整';
  const again = mergeDriveBackups(pending, [resolved, second], undefined, true);
  assert.deepEqual(again.conflicts, []); assert.equal(again.backup.data.workspaces[0].taskConflicts[0].resolved, undefined);
  assert.ok(again.backup.data.workspaces[0].taskConflicts[0].versions.some(version => version.task.description === tasks(resolved)[0].description));
  assert.ok(again.backup.data.workspaces[0].taskConflicts[0].versions.some(version => version.task.description === tasks(second)[0].description));
});

test('舊裝置未記錄來源時不借用另一版本的來源或時間', () => {
  const {base, a, b} = versions(); tasks(a)[0].description = '舊版描述';
  tasks(b)[0] = {...tasks(b)[0], description: '手機描述', editSource: {id: 'B', name: '手機'}, updatedAt: '2026-10-11T02:00:00.000Z'};
  const variants = mergeDriveBackups(base, [a, b], undefined, true).backup.data.workspaces[0].taskConflicts[0].versions;
  assert.deepEqual(variants.find(version => version.task.description === '舊版描述').source, {});
  tasks(a)[0].updatedAt = '2026-10-10T01:00:00.000Z';
  const timed = mergeDriveBackups(base, [a, b], undefined, true).backup.data.workspaces[0].taskConflicts[0].versions;
  assert.deepEqual(timed.find(version => version.task.description === '舊版描述').source, {updatedAt: tasks(a)[0].updatedAt});
});

test('同一任務不同欄位及子任務各自修改自動整併，不依裝置時間覆寫內容', () => {
  const {base, a, b} = versions();
  tasks(base)[0].subtasks = [{id: 'sub', title: '子任務', done: false}];
  tasks(a)[0] = {...tasks(base)[0], title: '本機標題', updatedAt: '2026-10-11T01:00:00.000Z', subtasks: [{id: 'sub', title: '新的子任務名稱', done: false}]};
  tasks(b)[0] = {...tasks(base)[0], description: '雲端描述', updatedAt: '2026-10-10T01:00:00.000Z', subtasks: [{id: 'sub', title: '子任務', done: true}]};
  const result = mergeDriveBackups(base, [a, b]);
  assert.deepEqual(result.conflicts, []);
  assert.equal(tasks(result.backup)[0].title, '本機標題'); assert.equal(tasks(result.backup)[0].description, '雲端描述');
  assert.deepEqual(tasks(result.backup)[0].subtasks, [{id: 'sub', title: '新的子任務名稱', done: true}]);
  assert.equal(tasks(result.backup)[0].updatedAt, '2026-10-11T01:00:00.000Z');
  assert.equal(tasks(base)[0].title, '原始'); assert.equal(tasks(a)[0].description, '');
});

test('三份內容同欄位衝突只採用選定欄位，其餘不同欄位仍整併', () => {
  const {base, a, b} = versions(), c = structuredClone(base);
  tasks(a)[0].title = 'A'; tasks(a)[0].description = 'A 的描述';
  tasks(b)[0].title = 'B'; tasks(b)[0].pinned = true;
  tasks(c)[0].priority = 'high';
  assert.ok(mergeDriveBackups(base, [a, b, c]).conflicts.some(path => path.endsWith('.title')));
  const selected = mergeDriveBackups(base, [a, b, c], 1).backup;
  assert.equal(tasks(selected)[0].title, 'B'); assert.equal(tasks(selected)[0].description, 'A 的描述');
  assert.equal(tasks(selected)[0].pinned, true); assert.equal(tasks(selected)[0].priority, 'high');
  assert.equal(tasks(mergeDriveBackups(base, [a, b, c], 2).backup)[0].title, '原始');
});

test('垃圾桶刪除對編輯以及永久刪除對編輯保留衝突，正常刪除不復活任務', () => {
  for (const hardDelete of [false, true]) {
    const {base, a, b} = versions();
    if (hardDelete) tasks(a).splice(0, 1); else tasks(a)[0].deletedAt = '2026-10-11T01:00:00.000Z';
    assert.deepEqual(mergeDriveBackups(base, [a, b]).conflicts, []);
    const deleted = tasks(mergeDriveBackups(base, [a, b]).backup);
    assert.equal(hardDelete ? deleted.length : !!deleted[0].deletedAt, hardDelete ? 0 : true);
    tasks(b)[0].description = '刪除期間的編輯';
    assert.ok(mergeDriveBackups(base, [a, b]).conflicts.length);
    assert.equal(tasks(mergeDriveBackups(base, [a, b], 1).backup)[0].description, '刪除期間的編輯');
    const chosenDelete = tasks(mergeDriveBackups(base, [a, b], 0).backup);
    assert.equal(hardDelete ? chosenDelete.length : !!chosenDelete[0].deletedAt, hardDelete ? 0 : true);
  }
});

test('兩端刪除時間不同不產生假衝突', () => {
  const {base, a, b} = versions();
  tasks(a)[0].deletedAt = '2026-10-11T01:00:00.000Z'; tasks(b)[0].deletedAt = '2026-10-11T02:00:00.000Z';
  const result = mergeDriveBackups(base, [a, b]); assert.deepEqual(result.conflicts, []);
  assert.equal(tasks(result.backup)[0].deletedAt, tasks(b)[0].deletedAt);
});

test('選用後連續修改同一欄位不被舊快照還原，晚到的已知版本不重開衝突', () => {
  const {base, a, b} = versions(); tasks(a)[0].title = 'A'; tasks(b)[0].title = 'B';
  const pending = mergeDriveBackups(base, [a, b], undefined, true).backup, resolved = structuredClone(pending);
  const record = resolved.data.workspaces[0].taskConflicts[0], chosen = record.versions.find(version => version.task.title === 'A');
  record.resolved = chosen.key; resolved.data.workspaces[0].tasks[0] = structuredClone(chosen.task);
  tasks(resolved)[0].title = '選用後再改為 C';
  const first = mergeDriveBackups(pending, [resolved, pending], undefined, true);
  assert.deepEqual(first.conflicts, []); assert.equal(tasks(first.backup)[0].title, '選用後再改為 C');
  assert.equal(first.backup.data.workspaces[0].taskConflicts[0].resolved, chosen.key);
  const later = structuredClone(first.backup), other = structuredClone(first.backup);
  tasks(later)[0].title = '接著改為 D'; other.reminders.leadMinutes = 60;
  const next = mergeDriveBackups(first.backup, [later, other], undefined, true);
  assert.deepEqual(next.conflicts, []); assert.equal(tasks(next.backup)[0].title, '接著改為 D');
  assert.equal(next.backup.reminders.leadMinutes, 60);
  const stale = mergeDriveBackups(base, [later, b], undefined, true);
  assert.deepEqual(stale.conflicts, []); assert.equal(tasks(stale.backup)[0].title, '接著改為 D');
  assert.equal(stale.backup.data.workspaces[0].taskConflicts[0].resolved, chosen.key);
  const unknown = structuredClone(b); tasks(unknown)[0].title = '未知的新修改';
  const conflict = mergeDriveBackups(base, [later, unknown], undefined, true);
  assert.equal(conflict.backup.data.workspaces[0].taskConflicts[0].resolved, undefined);
  const concurrent = structuredClone(later); tasks(concurrent)[0].title = '另一個選用後的修改';
  const newConflict = mergeDriveBackups(first.backup, [later, concurrent], undefined, true);
  assert.equal(newConflict.backup.data.workspaces[0].taskConflicts[0].resolved, undefined);
});

test('同時新增任務與子任務按穩定識別碼整併，交換裝置順序得到相同共享資料', async () => {
  const {base, a, b} = versions();
  tasks(a).unshift(task('a')); tasks(b).unshift(task('b'));
  tasks(a)[1].subtasks.push({id: 'sub-a', title: 'A', done: false}); tasks(b)[1].subtasks.push({id: 'sub-b', title: 'B', done: false});
  const ab = mergeDriveBackups(base, [a, b]), ba = mergeDriveBackups(base, [b, a]);
  // Empty base arrays merge distinct additions by identity.
  assert.deepEqual(ab.conflicts, []); assert.deepEqual(ba.conflicts, []);
  assert.deepEqual(tasks(ab.backup).map(task => task.id), ['a', 'b', 'task']);
  assert.deepEqual(tasks(ab.backup)[2].subtasks.map(task => task.id), ['sub-a', 'sub-b']);
  assert.equal(await syncHash(ab.backup), await syncHash(ba.backup));
});

test('一端調整順序，另一端修改內容可以整併；兩端相反排序需要選擇', () => {
  const {base, a, b} = versions();
  base.data.workspaces[0].tasks = [task('a'), task('b'), task('c')];
  a.data.workspaces[0].tasks = [task('b'), task('a'), task('c')];
  b.data.workspaces[0].tasks = [task('a'), {...task('b'), description: 'B'}, task('c')];
  const result = mergeDriveBackups(base, [a, b]); assert.deepEqual(result.conflicts, []);
  assert.deepEqual(tasks(result.backup).map(task => task.id), ['b', 'a', 'c']); assert.equal(tasks(result.backup)[0].description, 'B');
  b.data.workspaces[0].tasks = [task('a'), task('c'), task('b')];
  assert.ok(mergeDriveBackups(base, [a, b]).conflicts.some(path => path.endsWith('.order')));
  assert.deepEqual(tasks(mergeDriveBackups(base, [a, b], 1).backup).map(task => task.id), ['a', 'c', 'b']);
});

test('合併後不合法的時間範圍需要選擇時段，選定後仍保留其他欄位修改', () => {
  const {base, a, b} = versions();
  tasks(base)[0].startDate = '2026-10-10'; tasks(base)[0].dueDate = '2026-10-20';
  tasks(a)[0] = {...tasks(base)[0], startDate: '2026-10-19', title: 'A'};
  tasks(b)[0] = {...tasks(base)[0], dueDate: '2026-10-11', description: 'B'};
  assert.ok(mergeDriveBackups(base, [a, b]).conflicts.some(path => path.endsWith('.schedule')));
  const result = mergeDriveBackups(base, [a, b], 1).backup;
  assert.equal(tasks(result)[0].startDate, '2026-10-10'); assert.equal(tasks(result)[0].dueDate, '2026-10-11');
  assert.equal(tasks(result)[0].title, 'A'); assert.equal(tasks(result)[0].description, 'B'); assert.doesNotThrow(() => readBackup(result));
});

test('專案與狀態交叉引用失效時不套用無效內容，仍保留其他工作空間修改', () => {
  const {base, a, b} = versions();
  for (const backup of [base, a, b]) backup.data.workspaces.push(emptyWorkspace('other', '另一空間', () => 'other-project'));
  const id = base.data.workspaces[0].projects[0].id;
  a.data.workspaces[0].projects = []; b.data.workspaces[0].tasks[0].projectId = id;
  a.data.workspaces[1].headerCompact = true;
  const result = mergeDriveBackups(base, [a, b], 1);
  assert.ok(result.conflicts.some(path => path.endsWith('.references')));
  assert.equal(result.backup.data.workspaces[1].headerCompact, true); assert.doesNotThrow(() => readBackup(result.backup));
});

test('外觀與提醒不同設定可整併，瀏覽視圖、字級與 Google 連線不參與衝突', () => {
  const {base, a, b} = versions();
  for (const backup of [base, a, b]) backup.data.workspaces.push(emptyWorkspace('other', '另一空間', () => 'other-project'));
  a.preferences.theme = 'dark'; a.preferences.textSize = 'large'; a.google.accountId = 'local'; a.data.activeWorkspaceId = 'other';
  b.preferences.accent = '#123456'; b.preferences.textSize = 'extra-small'; b.google.accountId = 'remote'; b.reminders.leadMinutes = 60;
  const result = mergeDriveBackups(base, [a, b]);
  assert.deepEqual(result.conflicts, []); assert.equal(result.backup.preferences.theme, 'dark'); assert.equal(result.backup.preferences.accent, '#123456');
  assert.equal(result.backup.preferences.textSize, undefined); assert.equal(result.backup.google.accountId, 'local'); assert.equal(result.backup.data.activeWorkspaceId, 'other');
  assert.equal(result.backup.reminders.leadMinutes, 60);
});

test('相同 Google 月曆不同本機識別碼，欄位修改與綁定新增可合併且無往返震盪', async () => {
  const {base, a, b} = versions();
  for (const backup of [base, a, b]) {
    backup.data.workspaces.push(emptyWorkspace('other', '另一空間', () => 'other-project'));
    backup.google.sources = [{id: 'base-source', accountId: 'account', calendarId: 'calendar', name: '原始月曆', color: '#31584b', visible: true, workspaceIds: ['workspace']}];
  }
  a.google.sources[0].id = 'a-source'; a.google.sources[0].name = '新的名稱';
  b.google.sources[0].id = 'b-source'; b.google.sources[0].color = '#123456'; b.google.sources[0].workspaceIds.push('other');
  const result = mergeDriveBackups(base, [a, b]); assert.deepEqual(result.conflicts, []);
  const source = result.backup.google.sources[0]; assert.equal(source.id, 'a-source'); assert.equal(source.name, '新的名稱'); assert.equal(source.color, '#123456'); assert.deepEqual(source.workspaceIds, ['other', 'workspace']);
  assert.equal(await syncHash(result.backup), await syncHash(mergeDriveBackups(base, [b, a]).backup));
});

test('共同基準取最近祖先，保留垃圾桶版本血緣；無共同祖先與交叉整併不猜測基準', async () => {
  const {base} = versions(), root = await createDriveDocument(base), middle = await createDriveDocument(base, root.cloud.datasetId, [root.cloud.versionId]);
  const a = await createDriveDocument(base, root.cloud.datasetId, [middle.cloud.versionId]), b = await createDriveDocument(base, root.cloud.datasetId, [middle.cloud.versionId]);
  const files = [file(root), {...file(middle), trashed: true}, file(a), file(b)];
  assert.equal(commonDriveAncestor(files, [a.cloud.versionId, b.cloud.versionId]).cloud.versionId, middle.cloud.versionId);
  assert.equal(commonDriveAncestor(files, [crypto.randomUUID(), b.cloud.versionId]), undefined);
  const parents = [a.cloud.versionId, b.cloud.versionId];
  const c = await createDriveDocument(base, root.cloud.datasetId, parents), d = await createDriveDocument(base, root.cloud.datasetId, parents);
  assert.equal(commonDriveAncestor([...files, file(c), file(d)], [c.cloud.versionId, d.cloud.versionId]), undefined);
});

test('任務衝突納入整併資料並保留安全欄位，交換裝置順序產生同一份待選版本', async () => {
  const {base, a, b} = versions(); tasks(a)[0].title = 'A 標題'; tasks(a)[0].pinned = true;
  tasks(b)[0].title = 'B 標題'; tasks(b)[0].description = '安全描述';
  const ab = mergeDriveBackups(base, [a, b], undefined, true), ba = mergeDriveBackups(base, [b, a], undefined, true);
  assert.deepEqual(ab.conflicts, []); assert.equal(tasks(ab.backup)[0].title, '原始'); assert.equal(tasks(ab.backup)[0].description, '安全描述');
  const record = ab.backup.data.workspaces[0].taskConflicts[0]; assert.equal(record.versions.length, 2); assert.equal(record.resolved, undefined);
  assert.deepEqual(record.versions.map(version => version.task.title).sort(), ['A 標題', 'B 標題']);
  assert.ok(record.versions.every(version => version.task.description === '安全描述' && version.task.pinned));
  assert.equal(await syncHash(ab.backup), await syncHash(ba.backup)); assert.doesNotThrow(() => readBackup(ab.backup));
});

test('解決紀錄覆蓋舊的離線衝突；其他欄位的後續編輯仍整併，不重新建立已解決的版本', () => {
  const {base, a, b} = versions(); tasks(a)[0].title = 'A'; tasks(b)[0].title = 'B';
  const pending = mergeDriveBackups(base, [a, b], undefined, true).backup, resolved = structuredClone(pending);
  const record = resolved.data.workspaces[0].taskConflicts[0], chosen = record.versions.find(version => version.task.title === 'A');
  record.resolved = chosen.key; resolved.data.workspaces[0].tasks[0] = structuredClone(chosen.task);
  const stale = structuredClone(pending); stale.reminders.leadMinutes = 60;
  const result = mergeDriveBackups(base, [resolved, stale], undefined, true);
  assert.deepEqual(result.conflicts, []); assert.equal(tasks(result.backup)[0].title, 'A');
  assert.equal(result.backup.data.workspaces[0].taskConflicts[0].resolved, chosen.key); assert.equal(result.backup.reminders.leadMinutes, 60);
  const later = structuredClone(resolved); tasks(later)[0].description = '選擇後的新描述';
  // The late branch predates the decision, so the version graph still chooses the pending ancestor.
  const newResult = mergeDriveBackups(pending, [later, stale], undefined, true);
  assert.deepEqual(newResult.conflicts, []); assert.equal(tasks(newResult.backup)[0].description, '選擇後的新描述');
  assert.equal(newResult.backup.data.workspaces[0].taskConflicts[0].resolved, chosen.key);
});

test('兩端選擇不同版本重新保留兩份選擇，兩端選擇相同版本會收斂', () => {
  const {base, a, b} = versions(); tasks(a)[0].title = 'A'; tasks(b)[0].title = 'B';
  const pending = mergeDriveBackups(base, [a, b], undefined, true).backup;
  const choice = index => {const result = structuredClone(pending), record = result.data.workspaces[0].taskConflicts[0]; record.resolved = record.versions[index].key; result.data.workspaces[0].tasks[0] = structuredClone(record.versions[index].task); return result;};
  const conflict = mergeDriveBackups(pending, [choice(0), choice(1)], undefined, true);
  assert.deepEqual(conflict.conflicts, []); assert.equal(conflict.backup.data.workspaces[0].taskConflicts[0].resolved, undefined);
  const agreed = mergeDriveBackups(pending, [choice(0), choice(0)], undefined, true);
  assert.equal(agreed.backup.data.workspaces[0].taskConflicts[0].resolved, pending.data.workspaces[0].taskConflicts[0].versions[0].key);
});

test('復原版本選擇可與另一裝置修改整併，重做後再次傳送選擇', () => {
  const {base, a, b} = versions(); tasks(a)[0].title = 'A'; tasks(b)[0].title = 'B';
  const pending = mergeDriveBackups(base, [a, b], undefined, true).backup, resolved = structuredClone(pending);
  const record = resolved.data.workspaces[0].taskConflicts[0], selected = record.versions[0];
  record.resolved = selected.key; resolved.data.workspaces[0].tasks[0] = structuredClone(selected.task);
  const other = structuredClone(resolved); other.reminders.leadMinutes = 60;
  const undone = mergeDriveBackups(resolved, [pending, other], undefined, true);
  assert.deepEqual(undone.conflicts, []); assert.equal(undone.backup.data.workspaces[0].taskConflicts[0].resolved, undefined);
  assert.equal(tasks(undone.backup)[0].title, '原始'); assert.equal(undone.backup.reminders.leadMinutes, 60);
  const redone = mergeDriveBackups(undone.backup, [resolved, undone.backup], undefined, true);
  assert.deepEqual(redone.conflicts, []); assert.equal(redone.backup.data.workspaces[0].taskConflicts[0].resolved, selected.key);
  assert.equal(tasks(redone.backup)[0].title, selected.task.title);
});

test('共同基準沒有任務時，選用後永久刪除不被已知舊選項復活；未知編輯保留分歧', () => {
  const {base, a, b} = versions(); tasks(base).splice(0, 1); tasks(a)[0].title = 'A'; tasks(b)[0].title = 'B';
  const pending = mergeDriveBackups(base, [a, b], undefined, true).backup, deleted = structuredClone(pending);
  const record = deleted.data.workspaces[0].taskConflicts[0], chosen = record.versions.find(version => version.task.title === 'A');
  record.resolved = chosen.key; deleted.data.workspaces[0].tasks = [];
  const merged = mergeDriveBackups(base, [deleted, b], undefined, true);
  assert.deepEqual(merged.conflicts, []); assert.equal(tasks(merged.backup).length, 0);
  assert.equal(merged.backup.data.workspaces[0].taskConflicts[0].resolved, chosen.key);
  const unknown = structuredClone(b); tasks(unknown)[0].title = '尚未處理的新修改';
  const conflict = mergeDriveBackups(base, [deleted, unknown], undefined, true);
  assert.ok(conflict.conflicts.length); assert.equal(tasks(deleted).length, 0); assert.equal(tasks(unknown)[0].title, '尚未處理的新修改');
});

test('刪除與編輯的衝突保存刪除選項，任務衝突快照格式不完整時拒絕匯入', () => {
  const {base, a, b} = versions(); tasks(a).splice(0, 1); tasks(b)[0].description = '新的描述';
  const result = mergeDriveBackups(base, [a, b], undefined, true);
  assert.deepEqual(result.conflicts, []); assert.equal(result.backup.data.workspaces[0].taskConflicts[0].versions.some(version => version.task === null), true);
  for (const mutate of [record => record.versions[0].task = {...task('wrong')}, record => record.resolved = 'unknown', record => record.versions.push(structuredClone(record.versions[0]))]) {
    const invalid = structuredClone(result.backup); mutate(invalid.data.workspaces[0].taskConflicts[0]); assert.throws(() => readBackup(invalid), /資料不完整/);
  }
});
