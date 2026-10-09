import type { WorkspaceState } from './models';
import { readWorkspaceState } from './workspace-data.ts';
import type { AppearancePreferences } from './appearance-data.ts';
import { readAppearance } from './appearance-data.ts';

export const WORKSPACE_STORAGE_KEY = 'orbit-workspaces-v2';
export const WORKSPACE_SELECTION_KEY = 'orbit-active-workspace-v1';

export interface StoredWorkspaceData {
  formatVersion: 2;
  generation: string;
  revision: string;
  updatedAt: string;
  state: WorkspaceState;
  preferences?: AppearancePreferences;
}

export function readStoredData(value: unknown): StoredWorkspaceData | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as StoredWorkspaceData;
  const state = readWorkspaceState(source.state);
  if (source.formatVersion !== 2 || typeof source.generation !== 'string' || !source.generation
    || typeof source.revision !== 'string' || !source.revision || typeof source.updatedAt !== 'string'
    || !Number.isFinite(Date.parse(source.updatedAt)) || !state) return null;
  const preferences = source.preferences === undefined ? undefined : readAppearance(source.preferences);
  if (preferences === null) return null;
  return {formatVersion: 2, generation: source.generation, revision: source.revision, updatedAt: source.updatedAt, state, ...(preferences ? {preferences} : {})};
}
