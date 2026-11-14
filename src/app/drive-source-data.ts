import {validClientId} from './google-data.ts';

export const DRIVE_SOURCE_KEY = 'iih-orbit-drive-sources-v1';
export const DEFAULT_DRIVE_SOURCE = 'default';
export interface DriveSourceConfiguration {id: string; provider: 'google-drive'; name: string; clientId: string}
export interface DriveSourceProfile extends DriveSourceConfiguration {accountId: string; email: string}
export interface DriveSourceSettings {version: 1; defaultName: string; sources: DriveSourceProfile[]}
export interface SharedDriveSources {version: 1; defaultName: string; sources: DriveSourceConfiguration[]}
export const defaultDriveSources = (): DriveSourceSettings => ({version: 1, defaultName: '主要來源', sources: []});
export const defaultSharedDriveSources = (): SharedDriveSources => ({version: 1, defaultName: '主要來源', sources: []});
export function readDriveSources(value: unknown, primaryClientId?: string): DriveSourceSettings | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const settings = value as DriveSourceSettings;
  if (settings.version !== 1 || typeof settings.defaultName !== 'string' || !settings.defaultName.trim() || settings.defaultName.length > 100
    || !Array.isArray(settings.sources) || settings.sources.length > 20) return undefined;
  const ids = new Set<string>();
  const sources: DriveSourceProfile[] = [];
  for (const source of settings.sources) {
    const legacy = source as DriveSourceProfile & {usePrimaryClientId?: boolean};
    if (!source || source.provider !== undefined && source.provider !== 'google-drive' || typeof source.id !== 'string' || !/^[a-f0-9-]{36}$/.test(source.id) || ids.has(source.id)
      || typeof source.name !== 'string' || !source.name.trim() || source.name.length > 100
      || legacy.usePrimaryClientId !== undefined && typeof legacy.usePrimaryClientId !== 'boolean'
      || typeof source.clientId !== 'string' || source.clientId.length > 300 || !validClientId(source.clientId)
      || typeof source.accountId !== 'string' || source.accountId.length > 300 || typeof source.email !== 'string' || source.email.length > 320) return undefined;
    ids.add(source.id);
    const clientId = legacy.usePrimaryClientId ? primaryClientId ?? source.clientId : source.clientId;
    sources.push({id: source.id, provider: 'google-drive', name: source.name.trim(), clientId, accountId: source.accountId, email: source.email});
  }
  return {version: 1, defaultName: settings.defaultName.trim(), sources};
}

/** Only public provider configuration crosses devices; accounts and credentials stay local. */
export function sharedDriveSources(settings: DriveSourceSettings | SharedDriveSources): SharedDriveSources {
  return {version: 1, defaultName: settings.defaultName, sources: settings.sources.map(({id, provider, name, clientId}) => ({id, provider, name, clientId}))};
}
export function readSharedDriveSources(value: unknown): SharedDriveSources | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const settings = value as SharedDriveSources;
  if (!Array.isArray(settings.sources)) return undefined;
  const local = readDriveSources({...settings, sources: settings.sources.map(source => source && {...source, accountId: '', email: ''})});
  return local ? sharedDriveSources(local) : undefined;
}
