import type { CategoryColor, Priority, Workspace } from './models';
import { emptyWorkspace } from './workspace-data.ts';
import { dateKey, weekDates } from './task-schedule.ts';

export type WorkspaceTemplateId = 'blank' | 'administration' | 'students' | 'courses' | 'research' | 'software' | 'learning';
export interface WorkspaceCreationOptions {
  templateId?: WorkspaceTemplateId;
  includeExamples?: boolean;
  now?: Date;
}
interface ExampleTask {
  title: string;
  category: number;
  project: number;
  day: number;
  endDay?: number;
  startTime?: string;
  dueTime?: string;
  status?: string;
  priority?: Priority;
  steps?: string[];
}
export interface WorkspaceTemplate {
  id: Exclude<WorkspaceTemplateId, 'blank'>;
  name: string;
  description: string;
  icon: string;
  categories: {name: string; color: CategoryColor}[];
  projects: string[];
  examples: ExampleTask[];
}

/** Catalog and example payload load only when the workspace dialog is opened. */
export const WORKSPACE_TEMPLATES: readonly WorkspaceTemplate[] = [
  {
    id: 'administration', name: '學程行政', icon: 'board', description: '整理行政待辦、會議與評鑑資料。',
    categories: [{name: '行政作業', color: 'blue'}, {name: '文件整理', color: 'green'}, {name: '會議協調', color: 'violet'}, {name: '品質改善', color: 'orange'}],
    projects: ['學程評鑑準備'],
    examples: [
      {title: '彙整本週行政待辦', category: 0, project: 0, day: 1, endDay: 2, steps: ['整理待回覆事項', '確認處理順序']},
      {title: '整理學程會議資料', category: 1, project: 0, day: 2, startTime: '09:00', dueTime: '10:00', status: 'progress'},
      {title: '學程行政協調會議', category: 2, project: 0, day: 3, startTime: '14:00', dueTime: '15:00', priority: 'high'},
      {title: '彙整評鑑佐證文件', category: 3, project: 1, day: 4, endDay: 5, steps: ['建立文件索引', '檢查缺漏資料']},
      {title: '歸檔上週公文', category: 1, project: 0, day: 1, startTime: '09:00', dueTime: '09:30', status: 'done'}
    ]
  },
  {
    id: 'students', name: '學生事務', icon: 'user', description: '追蹤學生服務、活動與資源安排。',
    categories: [{name: '學生服務', color: 'blue'}, {name: '活動規劃', color: 'orange'}, {name: '資源媒合', color: 'green'}, {name: '追蹤關懷', color: 'pink'}],
    projects: ['迎新活動'],
    examples: [
      {title: '整理學生常見問題', category: 0, project: 0, day: 1, endDay: 2, status: 'progress'},
      {title: '確認迎新流程與分工', category: 1, project: 1, day: 2, startTime: '10:00', dueTime: '11:00', steps: ['確認場地', '整理工作分工']},
      {title: '彙整學習資源清單', category: 2, project: 0, day: 3, endDay: 4},
      {title: '安排導師交流時段', category: 3, project: 0, day: 4, startTime: '15:00', dueTime: '16:00'},
      {title: '完成服務窗口資訊整理', category: 0, project: 0, day: 1, status: 'done'}
    ]
  },
  {
    id: 'courses', name: '課程安排', icon: 'calendar', description: '安排授課、教材、評量與課程檢討。',
    categories: [{name: '授課安排', color: 'blue'}, {name: '教材準備', color: 'violet'}, {name: '學習評量', color: 'orange'}, {name: '課程檢討', color: 'green'}],
    projects: ['智慧醫療概論'],
    examples: [
      {title: '確認本週課程與教室', category: 0, project: 0, day: 1, status: 'done'},
      {title: '準備示範課程教材', category: 1, project: 1, day: 1, endDay: 3, status: 'progress', steps: ['整理講義', '準備課堂練習']},
      {title: '智慧醫療概論授課', category: 0, project: 1, day: 3, startTime: '10:00', dueTime: '12:00'},
      {title: '整理課堂作業回饋', category: 2, project: 1, day: 4, startTime: '14:00', dueTime: '15:00'},
      {title: '彙整本週課程調整建議', category: 3, project: 0, day: 5, status: 'review'}
    ]
  },
  {
    id: 'research', name: '研究計劃', icon: 'search', description: '整理文獻、實驗、資料分析與研究產出。',
    categories: [{name: '文獻閱讀', color: 'violet'}, {name: '實驗設計', color: 'blue'}, {name: '資料分析', color: 'green'}, {name: '論文寫作', color: 'orange'}],
    projects: ['先導研究'],
    examples: [
      {title: '整理研究問題與文獻', category: 0, project: 0, day: 1, endDay: 2, status: 'progress'},
      {title: '討論先導研究設計', category: 1, project: 1, day: 2, startTime: '14:00', dueTime: '15:00', priority: 'high'},
      {title: '規劃示範資料分析流程', category: 2, project: 1, day: 3, endDay: 4, steps: ['定義分析指標', '整理資料欄位']},
      {title: '撰寫研究摘要初稿', category: 3, project: 0, day: 5, startTime: '09:00', dueTime: '11:00'},
      {title: '建立研究資料夾結構', category: 2, project: 0, day: 1, status: 'done'}
    ]
  },
  {
    id: 'software', name: '軟體開發', icon: 'grid', description: '共用看板追蹤需求、設計、開發與測試。',
    categories: [{name: '需求規劃', color: 'orange'}, {name: '介面設計', color: 'violet'}, {name: '程式開發', color: 'blue'}, {name: '測試驗證', color: 'green'}],
    projects: ['網站改版', '工具優化'],
    examples: [
      {title: '整理本週功能需求', category: 0, project: 0, day: 1, status: 'done'},
      {title: '規劃網站首頁介面', category: 1, project: 1, day: 1, endDay: 2, status: 'progress'},
      {title: '實作搜尋與篩選功能', category: 2, project: 0, day: 3, endDay: 4, steps: ['完成搜尋', '加入分類篩選']},
      {title: '檢查工具操作流程', category: 3, project: 2, day: 4, startTime: '10:00', dueTime: '11:30', status: 'review'},
      {title: '本週版本檢討', category: 0, project: 0, day: 5, startTime: '15:00', dueTime: '16:00'}
    ]
  },
  {
    id: 'learning', name: '學習進度', icon: 'spark', description: '安排閱讀、練習、複習與學習成果。',
    categories: [{name: '閱讀筆記', color: 'violet'}, {name: '實作練習', color: 'blue'}, {name: '複習整理', color: 'green'}, {name: '成果輸出', color: 'orange'}],
    projects: ['程式設計練習'],
    examples: [
      {title: '訂定本週學習目標', category: 2, project: 0, day: 1, status: 'done'},
      {title: '閱讀入門章節並做筆記', category: 0, project: 0, day: 1, endDay: 2, status: 'progress'},
      {title: '完成程式設計練習', category: 1, project: 1, day: 3, startTime: '19:00', dueTime: '20:30', steps: ['完成範例', '嘗試修改參數']},
      {title: '整理本週重點與疑問', category: 2, project: 0, day: 5, startTime: '19:00', dueTime: '20:00'},
      {title: '製作學習成果摘要', category: 3, project: 0, day: 6, status: 'review'}
    ]
  }
];

export function workspaceFromTemplate(id: string, name: string, options: WorkspaceCreationOptions = {}, newId: () => string = () => crypto.randomUUID()): Workspace {
  const workspace = emptyWorkspace(id, name, newId);
  if (!options.templateId || options.templateId === 'blank') return workspace;
  const template = WORKSPACE_TEMPLATES.find(item => item.id === options.templateId);
  if (!template) throw new Error('未知的工作空間樣板');
  workspace.projects.push(...template.projects.map(project => ({id: newId(), name: project === workspace.name ? `${project}（專案）` : project})));
  workspace.categories = template.categories.map(category => ({...category, id: newId()}));
  if (options.includeExamples === false) return workspace;
  const days = weekDates(options.now ?? new Date()).map(dateKey);
  workspace.tasks = template.examples.map(example => ({
    id: newId(), title: example.title, description: '【樣板示範】這是虛構的本週任務，可依實際安排編輯或刪除。',
    categoryId: workspace.categories[example.category].id, projectId: workspace.projects[example.project].id,
    status: example.status ?? 'todo', priority: example.priority ?? 'medium',
    startDate: days[example.day], startTime: example.startTime ?? '', dueDate: days[example.endDay ?? example.day], dueTime: example.dueTime ?? '',
    subtasks: (example.steps ?? []).map(title => ({id: newId(), title, done: false}))
  }));
  return workspace;
}
