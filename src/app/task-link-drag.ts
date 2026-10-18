export const TASK_LINK_DRAG_TYPE = 'application/x-iih-orbit-task-link';
export interface TaskLinkDragData {token: string; generation: string; workspaceId: string; taskId: string}
export const BOARD_TASK_DRAG_TYPE = 'application/x-iih-orbit-board-task';
export type BoardTaskDropPosition = {kind: 'move'; status: string; beforeId?: string} | {kind: 'link'; status: string; taskId: string};
export function readTaskLinkDrag(value: string): TaskLinkDragData | null {
  if (!value || value.length > 5000) return null;
  try {
    const data = JSON.parse(value);
    return data && ['token', 'generation', 'workspaceId', 'taskId'].every(key => typeof data[key] === 'string' && !!data[key] && data[key].length <= 1000)
      ? {token: data.token, generation: data.generation, workspaceId: data.workspaceId, taskId: data.taskId} : null;
  } catch {return null;}
}
