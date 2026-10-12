import { WORKSPACE_STORAGE_KEY } from './stored-data';

/** Clear Orbit's records only; other applications on the same origin are untouched. */
export function clearLogoutStorage(storage: Storage, keepWorkspace = false): void {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key && (key.startsWith('orbit-') || key.startsWith('iih-orbit-')) && (!keepWorkspace || key !== WORKSPACE_STORAGE_KEY)) keys.push(key);
  }
  for (const key of keys) storage.removeItem(key);
}
