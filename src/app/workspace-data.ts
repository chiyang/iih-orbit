import type { BoardState, BoardStatus, TaskScope, Workspace, WorkspaceState } from './models';
import { COLUMNS } from './models.ts';
import { readBoardState } from './board-data.ts';

export function createWorkspaceState(board: BoardState): WorkspaceState {
  return {version: 1, activeWorkspaceId: 'workspace-default', workspaces: [{...structuredClone(board), id: 'workspace-default', name: '我的工作空間'}]};
}

export function emptyWorkspace(id: string, name: string, newId: () => string = () => crypto.randomUUID()): Workspace {
  const label = name.trim();
  return {version: 4, id, name: label, projects: [{id: newId(), name: label}], categories: [], statuses: COLUMNS.map(status => ({...status})), tasks: []};
}

export function readWorkspaceState(value: unknown): WorkspaceState | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as WorkspaceState;
  if (source.version !== 1 || typeof source.activeWorkspaceId !== 'string' || !Array.isArray(source.workspaces) || !source.workspaces.length) return null;
  const workspaces: Workspace[] = [];
  for (const workspace of source.workspaces) {
    if (!workspace || typeof workspace.id !== 'string' || !workspace.id || typeof workspace.name !== 'string' || !workspace.name.trim()) return null;
    const board = readBoardState(workspace);
    if (!board) return null;
    if (workspace.headerCompact !== undefined && typeof workspace.headerCompact !== 'boolean') return null;
    workspaces.push({...board, id: workspace.id, name: workspace.name.trim(), ...(workspace.headerCompact === undefined ? {} : {headerCompact: workspace.headerCompact})});
  }
  if (new Set(workspaces.map(workspace => workspace.id)).size !== workspaces.length
    || !workspaces.some(workspace => workspace.id === source.activeWorkspaceId)) return null;
  return {version: 1, activeWorkspaceId: source.activeWorkspaceId, workspaces};
}

export function updateWorkspaceBoard(state: WorkspaceState, board: BoardState): WorkspaceState {
  return {...state, workspaces: state.workspaces.map(workspace => workspace.id === state.activeWorkspaceId ? {...workspace, ...structuredClone(board)} : workspace)};
}

/** Tasks always move to an existing destination before a status is removed. */
export function removeBoardStatus(board: BoardState, id: string, destination: string): BoardState | null {
  if (id === destination || !board.statuses.some(status => status.id === id) || !board.statuses.some(status => status.id === destination)) return null;
  return {...board, statuses: board.statuses.filter(status => status.id !== id), tasks: board.tasks.map(task => task.status === id ? {...task, status: destination} : task)};
}

export function statusKind(statuses: readonly BoardStatus[], id: string): BoardStatus['kind'] {
  return statuses.find(status => status.id === id)?.kind ?? 'active';
}

/** Explicit task views keep hidden statuses accessible without revealing other types. */
export function boardStatusesForScope(statuses: readonly BoardStatus[], scope: TaskScope): BoardStatus[] {
  return statuses.filter(status => scope === 'all' ? !(status.hidden ?? status.kind === 'archived') : status.kind === scope);
}
