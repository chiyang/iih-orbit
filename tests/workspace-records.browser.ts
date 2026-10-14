import '@angular/compiler';
import {BoardStore} from '../src/app/board-store';
import {WorkspaceRecordRepository} from '../src/app/workspace-records';
import {createBackup} from '../src/app/backup-data';
import {emptyWorkspace} from '../src/app/workspace-data';
import {WORKSPACE_STORAGE_KEY} from '../src/app/stored-data';
import {documentFromUrl} from '../src/app/document-data';

/** Run only on an isolated test origin. These records are synthetic and contain no credentials. */
export async function runRecordBrowserTests(): Promise<string[]> {
  const results: string[] = [], check = (condition: boolean, label: string) => {if (!condition) throw new Error(label); results.push(label);};
  const workspace = {...emptyWorkspace('test-workspace', '儲存測試'), tasks: Array.from({length: 1000}, (_, i) => ({id: 'task-' + i, title: '任務 ' + i, description: '測試內容', projectId: '', categoryId: '', status: 'todo', priority: 'medium' as const, startDate: '', startTime: '', dueDate: '', dueTime: '', subtasks: []}))};
  const legacy = {formatVersion: 2, generation: 'test-generation', revision: 'legacy-revision', updatedAt: '2026-10-13T00:00:00.000Z', state: {version: 1 as const, activeWorkspaceId: workspace.id, workspaces: [workspace, emptyWorkspace('second-workspace', '第二個空間')]}};
  localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(legacy));
  sessionStorage.setItem('orbit-active-workspace-v1', 'second-workspace');
  const first = new BoardStore();
  try {
    await first.snapshotForExport();
    check(first.state().id === 'second-workspace', '升級後保留分頁工作空間選擇');
    first.switchWorkspace(workspace.id);
    check(first.tasks().length === 1000, 'localStorage 升級至原生 IndexedDB 保留一千個任務');
    const marker = JSON.parse(localStorage.getItem(WORKSPACE_STORAGE_KEY)!);
    check(marker.storage === 'indexeddb' && !marker.state, 'localStorage 只保存小型修訂通知，不重寫完整工作資料');
    const repository = new WorkspaceRecordRepository();
    const before = await repository.read();
    check(before?.generation === legacy.generation, '升級保留資料世代，沒有假重置');
    const originalPut = IDBObjectStore.prototype.put, writes: string[] = [];
    IDBObjectStore.prototype.put = function(value, ...args) {if (this.name === 'records') writes.push(value.key); return originalPut.call(this, value, ...args);};
    try {
      const task = {...first.tasks()[100], title: '單筆修改'};
      check((await first.saveTask(task)).ok, '原生交易可保存單筆修改');
    } finally {IDBObjectStore.prototype.put = originalPut;}
    check(writes.length === 2 && writes.includes('root'), '單筆修改只寫入一個任務及修訂索引');
    const second = new BoardStore();
    try {
      await second.snapshotForExport(); second.switchWorkspace(workspace.id);
      const a = first.tasks()[101], b = second.tasks()[102], stale = second.taskContext('task-100');
      const saved = await Promise.all([first.saveTask({...a, title: '分頁 A'}), second.saveTask({...b, title: '分頁 B'})]);
      check(saved.every(result => result.ok), '兩個分頁並行修改不同任務都成功');
      const merged = await repository.read();
      check(merged?.state.workspaces[0].tasks[101].title === '分頁 A' && merged.state.workspaces[0].tasks[102].title === '分頁 B', '交易重讀最新資料，兩份修改都保留');
      await first.saveTask({...first.tasks()[100], title: '較新內容'});
      check(!(await second.saveTask({...stale.original!, title: '過期草稿'}, stale)).ok, '過期草稿無法蓋掉另一分頁新內容');
      const prior = await repository.read();
      try {await repository.update(() => {throw new Error('模擬驗證失敗');});} catch { /* Expected atomic abort. */ }
      check(JSON.stringify(await repository.read()) === JSON.stringify(prior), '交易中斷不部分寫入或刪除原有紀錄');
      const exported = await first.backupForExport('full');
      check(exported.formatVersion === 5 && exported.data.workspaces[0].tasks.length === 1000, '手動 JSON 備份保持完整及既有格式');
      const document = documentFromUrl('google-drive', 'https://docs.google.com/document/d/native-test-file/edit', '原生文件測試');
      await second.snapshotForExport();
      const linked = await Promise.all([first.linkDocument('task-0', document), second.linkDocument('task-1', document)]);
      check(linked.every(result => result.ok), '兩個分頁可並行把同一文件加入不同任務');
      const documentState = await repository.read();
      check(documentState!.state.workspaces[0].documentSources!.length === 1 && documentState!.state.workspaces[0].documentLinks!.length === 2, '原生交易保存共用來源和兩份獨立關聯');
      await first.snapshotForExport();
      const withDocuments = await first.backupForExport('full');
      check(withDocuments.formatVersion === 6 && withDocuments.data.workspaces[0].documentSources!.length === 1, '新版 JSON 包含來源與關聯，可獨立還原');
      const documentWrites: string[] = [];
      IDBObjectStore.prototype.put = function(value, ...args) {if (this.name === 'records') documentWrites.push(value.key); return originalPut.call(this, value, ...args);};
      try {check((await first.saveTask(first.tasks()[0], first.taskContext('task-0'), undefined, [])).ok, '文件移除以交易保存刪除記錄');}
      finally {IDBObjectStore.prototype.put = originalPut;}
      check(documentWrites.some(key => key.includes('documentLinks')) && !documentWrites.some(key => key.includes('task-2')), '關聯移除不重寫其他任務');
      const beforeDocumentFailure = await repository.read();
      IDBObjectStore.prototype.put = function(value, ...args) {if (value.key.includes('documentLinks')) throw new DOMException('測試文件寫入失敗', 'QuotaExceededError'); return originalPut.call(this, value, ...args);};
      try {const result = await first.linkDocument('task-2', document); check(result.ok && !result.persisted && first.hasUnsavedChanges(), '文件寫入失敗顯示未保存，完整內容暫存分頁');}
      finally {IDBObjectStore.prototype.put = originalPut;}
      check(JSON.stringify(await repository.read()) === JSON.stringify(beforeDocumentFailure), '文件交易失敗不留下來源、任務或關聯的部分變更');
      check((await first.linkDocument('task-2', document)).ok && !first.hasUnsavedChanges(), '儲存恢復後可重試完整文件變更');
      check((await first.importBackup(withDocuments, first.revision())).ok && first.tasksForDocument(document).length === 2, '原生 IndexedDB 還原保留雙向關聯');
      const count = (await repository.read())!.state.workspaces[0].tasks.length;
      IDBObjectStore.prototype.put = function() {throw new DOMException('測試容量不足', 'QuotaExceededError');};
      try {
        const result = await first.importBackup(createBackup(exported.data, 'full'), first.revision());
        check(!result.ok, '容量不足時整份還原被拒絕');
      } finally {IDBObjectStore.prototype.put = originalPut;}
      check((await repository.read())!.state.workspaces[0].tasks.length === count, '還原保存失敗時 IndexedDB 原資料保留');
      const oldContext = second.taskContext('task-101'), smaller = structuredClone(exported.data);
      smaller.workspaces[0].tasks = smaller.workspaces[0].tasks.slice(0, 2);
      const generation = first.generation();
      check((await first.importBackup(createBackup(smaller, 'full'), first.revision())).ok, '完整還原以一個交易取代工作資料');
      check(first.generation() !== generation && (await repository.read())!.state.workspaces[0].tasks.length === 2, '還原建立新世代並移除舊任務紀錄');
      check(!(await second.saveTask({...oldContext.original!, title: '舊分頁回寫'}, oldContext)).ok, '舊世代分頁不能把還原前任務寫回');
      await first.updateGoogle({clientId: '123-example.apps.googleusercontent.com'});
      const dataset = crypto.randomUUID();
      check((await first.logoutToCloud(first.google().clientId, dataset, first.revision(), first.generation())).ok, '已驗證備份後的登出重置可保存至 IndexedDB');
      const reloaded = new BoardStore();
      try {
        await reloaded.snapshotForExport();
        check(reloaded.tasks().length === 0 && reloaded.cloudResume()?.datasetId === dataset, '重開後維持空白資料及雲端登入目的地');
      } finally {reloaded.ngOnDestroy();}
    } finally {second.ngOnDestroy();}
  } finally {first.ngOnDestroy();}
  return results;
}
