import type { BoardState, Task } from './models';
import { COLUMNS } from './models.ts';

function relativeDate(offset: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function createInitialState(): BoardState {
  const seeds: Omit<Task, 'startDate' | 'startTime' | 'dueTime'>[] = [
    {id: 't1', title: '整理使用者訪談與需求', description: '讓每個設計決定，都從使用者的真實需求開始。', categoryId: 'research', status: 'todo', priority: 'high', dueDate: relativeDate(2), subtasks: [{id: 's1', title: '彙整訪談筆記', done: true}, {id: 's2', title: '歸納痛點', done: false}, {id: 's3', title: '確認需求優先順序', done: false}]},
    {id: 't2', title: '規劃網站資訊架構', description: '梳理頁面層級，打造直覺且清楚的瀏覽動線。', categoryId: 'design', status: 'todo', priority: 'medium', dueDate: relativeDate(4), subtasks: []},
    {id: 't3', title: '撰寫品牌故事文案', description: '用簡單、真誠的文字，說出我們的品牌價值。', categoryId: 'content', status: 'todo', priority: 'low', dueDate: relativeDate(6), subtasks: []},
    {id: 't4', title: '首頁視覺設計', description: '探索新的視覺方向，讓第一眼就留下好印象。', categoryId: 'design', status: 'progress', priority: 'high', dueDate: relativeDate(1), subtasks: [{id: 's4', title: '製作情緒板', done: true}, {id: 's5', title: '桌面版設計', done: true}, {id: 's6', title: '行動版設計', done: false}, {id: 's7', title: '整理交付檔案', done: false}]},
    {id: 't5', title: '建立共用元件與設計系統', description: '統一按鈕、表單與卡片，保持一致的使用體驗。', categoryId: 'development', status: 'progress', priority: 'medium', dueDate: relativeDate(3), subtasks: []},
    {id: 't6', title: '整理產品圖片素材', description: '挑選、裁切與壓縮圖片，準備好上線素材。', categoryId: 'content', status: 'progress', priority: 'low', dueDate: relativeDate(5), subtasks: []},
    {id: 't7', title: '確認品牌色彩與字體', description: '檢查色彩對比與閱讀體驗，完成視覺規範。', categoryId: 'design', status: 'review', priority: 'medium', dueDate: relativeDate(0), subtasks: []},
    {id: 't8', title: '審核關於我們頁面', description: '確認內容正確、語氣一致，準備交付開發。', categoryId: 'content', status: 'review', priority: 'high', dueDate: relativeDate(1), subtasks: []},
    {id: 't9', title: '專案啟動與時程規劃', description: '目標、分工與里程碑，都已準備就緒。', categoryId: 'research', status: 'done', priority: 'medium', dueDate: relativeDate(-3), subtasks: []},
    {id: 't10', title: '完成競品分析', description: '找到值得學習的體驗，也找到我們的不同。', categoryId: 'research', status: 'done', priority: 'low', dueDate: relativeDate(-2), subtasks: []},
    {id: 't11', title: '建置開發環境', description: '開發工具與專案架構已經設定完成。', categoryId: 'development', status: 'done', priority: 'high', dueDate: relativeDate(-1), subtasks: []}
  ];

  const tasks: Task[] = seeds.map(task => ({...task, startDate: relativeDate(task.status === 'done' ? -5 : task.status === 'todo' ? 1 : -1), startTime: '', dueTime: ''}));

  return {
    version: 3,
    projectName: '品牌網站改版',
    statuses: COLUMNS.map(status => ({...status})),
    categories: [
      {id: 'design', name: '介面設計', color: 'violet'},
      {id: 'development', name: '程式開發', color: 'blue'},
      {id: 'content', name: '內容企劃', color: 'orange'},
      {id: 'research', name: '研究規劃', color: 'green'}
    ],
    tasks
  };
}
