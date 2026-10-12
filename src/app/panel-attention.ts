export interface PanelAttention {target: 'tasks' | 'reminders' | 'gmail' | 'toggle'; icon: string; count: number; label: string}
export function panelAttention(conflicts: number, reminders: number, arrivals: number): PanelAttention {
  if (conflicts > 0) return {target: 'tasks', icon: 'conflict', count: conflicts, label: conflicts + ' 個衝突任務，開啟任務側欄'};
  if (reminders > 0) return {target: 'reminders', icon: 'bell', count: reminders, label: reminders + ' 項新提醒尚未查看，開啟提醒側欄'};
  if (arrivals > 0) return {target: 'gmail', icon: 'mail', count: arrivals, label: arrivals + ' 封新郵件通知，開啟 Gmail 側欄'};
  return {target: 'toggle', icon: 'panelRight', count: 0, label: '右側欄'};
}
