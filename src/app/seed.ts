import type { BoardState, WorkspaceState } from './models';
import { COLUMNS } from './models.ts';

/** Fresh installs contain no projects, categories or example tasks. */
export function createInitialState(): BoardState {
  return {version: 4, projects: [], categories: [], statuses: COLUMNS.map(status => ({...status})), tasks: []};
}

export function isInitialWorkspace(state: WorkspaceState): boolean {
  const workspace = state.workspaces[0];
  return state.workspaces.length === 1 && workspace.id === 'workspace-default' && workspace.name === '空白工作空間'
    && !workspace.projects.length && !workspace.categories.length && !workspace.tasks.length && !workspace.calendarTransfers?.length
    && JSON.stringify(workspace.statuses) === JSON.stringify(COLUMNS);
}
