import {createRequire} from 'node:module';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

// A fixed, entirely fictional dataset for the README screenshots. No browser data is read.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url), {build} = createRequire(require.resolve('@angular/build/package.json'))('esbuild');
await mkdir(resolve(root, '.angular'), {recursive: true});
const temporary = await mkdtemp(resolve(root, '.angular/readme-demo-'));
try {
  const output = resolve(temporary, 'data.mjs');
  await build({stdin: {
    contents: "export {createBackup, readBackup} from './src/app/backup-data.ts'; export {COLUMNS} from './src/app/models.ts';",
    resolveDir: root
  }, bundle: true, platform: 'node', format: 'esm', outfile: output, tsconfig: resolve(root, 'tsconfig.json')});
  const {createBackup, readBackup, COLUMNS} = await import(pathToFileURL(output).href);
  const projects = [
    {id: 'demo-workshop', name: '秋日共創工作坊'},
    {id: 'demo-website', name: '課程網站改版'},
    {id: 'demo-research', name: '研究交流分享'}
  ];
  const categories = [
    {id: 'demo-planning', name: '企劃協作', color: 'violet'},
    {id: 'demo-design', name: '設計製作', color: 'blue'},
    {id: 'demo-content', name: '內容教材', color: 'orange'},
    {id: 'demo-research-category', name: '研究分析', color: 'green'}
  ];
  const task = (id, title, project, category, status, start, end, description, extra = {}) => ({
    id: 'demo-' + id, title, description, projectId: 'demo-' + project, categoryId: 'demo-' + category, status,
    priority: 'medium', startDate: start.slice(0, 10), startTime: start.slice(11), dueDate: end.slice(0, 10), dueTime: end.slice(11),
    subtasks: [], updatedAt: '2026-10-19T01:00:00.000Z', ...extra
  });
  const tasks = [
    task('venue', '確認場地與活動流程', 'workshop', 'planning', 'done', '2026-10-05', '2026-10-07', '完成空間配置、動線與活動時間表。', {pinned: true, subtasks: [{id: 'demo-venue-1', title: '確認場地配置', done: true}, {id: 'demo-venue-2', title: '完成活動流程表', done: true}]}),
    task('survey', '整理參與者需求', 'workshop', 'research-category', 'done', '2026-10-08', '2026-10-10', '彙整虛構問卷與訪談摘要，作為活動設計依據。'),
    task('poster', '共創工作坊主視覺', 'workshop', 'design', 'review', '2026-10-12', '2026-10-20', '確認海報、報名頁與現場指示的視覺一致性。', {priority: 'high', subtasks: [{id: 'demo-poster-1', title: '完成主視覺草稿', done: true}, {id: 'demo-poster-2', title: '校對日期與文案', done: false}]}),
    task('guide', '製作分組活動手冊', 'workshop', 'content', 'progress', '2026-10-15', '2026-10-23', '以小組任務與引導問題，串起半天的共創體驗。', {priority: 'high', pinned: true, subtasks: [{id: 'demo-guide-1', title: '規劃三個活動關卡', done: true}, {id: 'demo-guide-2', title: '完成工作單', done: true}, {id: 'demo-guide-3', title: '試跑活動流程', done: false}]}),
    task('briefing', '工作坊籌備會議', 'workshop', 'planning', 'progress', '2026-10-19T09:00', '2026-10-19T10:30', '核對分工、物料與當週進度。', {priority: 'high'}),
    task('rehearsal', '現場流程彩排', 'workshop', 'planning', 'todo', '2026-10-23T14:00', '2026-10-23T16:00', '從報到、分組到成果分享，完整走一次活動流程。'),
    task('launch', '秋日共創工作坊', 'workshop', 'planning', 'todo', '2026-10-28T09:00', '2026-10-28T16:00', '共創實驗室的虛構示範活動。', {priority: 'high', pinned: true}),
    task('sitemap', '完成網站架構盤點', 'website', 'planning', 'done', '2026-10-06', '2026-10-09', '整理首頁、課程介紹與學習資源的導覽層級。'),
    task('wireframe', '首頁版型與互動草稿', 'website', 'design', 'done', '2026-10-10', '2026-10-14', '完成桌面與手機版線框稿。'),
    task('components', '建立共用介面元件', 'website', 'design', 'progress', '2026-10-16', '2026-10-26', '統一按鈕、資訊卡片、表單與色彩規則。', {subtasks: [{id: 'demo-components-1', title: '按鈕與表單', done: true}, {id: 'demo-components-2', title: '課程卡片', done: false}]}),
    task('design-review', '網站視覺提案確認', 'website', 'design', 'review', '2026-10-20T10:00', '2026-10-20T11:30', '確認首頁視覺、字級與導覽體驗。'),
    task('copy', '課程介紹文案校對', 'website', 'content', 'review', '2026-10-21T09:30', '2026-10-21T11:00', '校對課程名稱、學習目標與閱讀順序。'),
    task('usability', '手機版易用性測試', 'website', 'research-category', 'todo', '2026-10-22T13:30', '2026-10-22T15:30', '檢查導覽、閱讀與表單填寫的操作體驗。', {priority: 'high'}),
    task('publish', '網站上線前檢查', 'website', 'planning', 'todo', '2026-10-29', '2026-10-30', '核對連結、頁面內容與備份。', {priority: 'low'}),
    task('reading', '彙整研究主題與文獻', 'research', 'research-category', 'done', '2026-10-07', '2026-10-13', '選定三個適合交流的研究問題。'),
    task('analysis', '整理示範分析結果', 'research', 'research-category', 'progress', '2026-10-14', '2026-10-22', '以合成資料整理圖表與觀察，沒有使用真實個人資料。'),
    task('discussion', '研究進度交流', 'research', 'research-category', 'progress', '2026-10-19T14:00', '2026-10-19T15:30', '討論分析方法、目前觀察與下一步驗證。'),
    task('slides', '分享簡報內容確認', 'research', 'content', 'review', '2026-10-21T14:00', '2026-10-21T16:00', '從研究問題到結果，調整故事線與圖表說明。', {subtasks: [{id: 'demo-slides-1', title: '完成簡報初稿', done: true}, {id: 'demo-slides-2', title: '檢查圖表與引用', done: false}]}),
    task('demo-check', '示範操作與設備確認', 'research', 'design', 'review', '2026-10-22T10:00', '2026-10-22T11:00', '確認投影、字級與示範操作流程。', {priority: 'low'}),
    task('sharing', '跨領域研究分享', 'research', 'content', 'todo', '2026-10-24T10:00', '2026-10-24T12:00', '用一個具體案例，交流方法、發現與後續方向。')
  ];
  const state = {
    version: 1, activeWorkspaceId: 'demo-lab', workspaces: [{
      version: 8, id: 'demo-lab', name: '共創實驗室', projects, categories, statuses: COLUMNS, tasks,
      documentSources: [], documentLinks: [], documentDetails: [], documentOrders: [],
      taskLinks: [{id: 'demo-link-1', taskIds: ['demo-guide', 'demo-rehearsal']}, {id: 'demo-link-2', taskIds: ['demo-analysis', 'demo-slides']}],
      completionEvents: tasks.filter(item => item.status === 'done').map(item => ({
        id: 'demo-completed-' + item.id, taskId: item.id, kind: 'completed', at: item.dueDate + 'T08:00:00.000Z',
        day: item.dueDate, title: item.title, projectId: item.projectId, projectName: projects.find(project => project.id === item.projectId).name
      }))
    }]
  };
  const backup = readBackup({...createBackup(state, 'workspaces', ['demo-lab']), exportedAt: '2026-10-19T01:00:00.000Z'});
  const directory = resolve(root, 'docs/demo');
  await mkdir(directory, {recursive: true});
  await writeFile(resolve(directory, 'orbit-demo.json'), JSON.stringify(backup, null, 2) + '\n');
  process.stdout.write(`Created fictional README demo: ${tasks.length} tasks, ${projects.length} projects, ${categories.length} categories.\n`);
} finally {await rm(temporary, {recursive: true, force: true});}
