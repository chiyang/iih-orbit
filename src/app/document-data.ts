import type { BoardState, DocumentLink, DocumentProvider, DocumentSource, Task, Workspace } from './models.ts';

export const DOCUMENT_PROVIDERS: {id: DocumentProvider; label: string}[] = [
  {id: 'google-drive', label: 'Google Drive'},
  {id: 'gmail', label: 'Gmail'},
  {id: 'pcloud', label: 'pCloud'},
  {id: 'microsoft-365', label: 'Microsoft 365'}
];
export const DOCUMENT_DRAG_TYPE = 'application/x-orbit-document';
const text = (value: unknown, limit = 1000): value is string => typeof value === 'string' && !!value.trim() && value.length <= limit;
const identity = (source: Pick<DocumentSource, 'provider' | 'sourceScope' | 'fileId' | 'locator'>): string | undefined =>
  source.fileId ? JSON.stringify([source.provider, source.sourceScope, 'id', source.fileId])
    : source.locator ? JSON.stringify([source.provider, source.sourceScope, 'path', source.locator]) : undefined;
export const documentIdentity = (source: DocumentSource): string => identity(source) ?? source.id;
export const documentProviderLabel = (provider: DocumentProvider): string => DOCUMENT_PROVIDERS.find(item => item.id === provider)?.label ?? provider;

const safeUrl = (url: URL): boolean => {
  const sensitive = ['access_token', 'refresh_token', 'id_token', 'client_secret', 'authorization'];
  const parameters = [...url.searchParams.keys(), ...new URLSearchParams(url.hash.slice(1)).keys()];
  return url.protocol === 'https:' && !url.username && !url.password && !url.port && !parameters.some(key => sensitive.includes(key.toLowerCase()));
};
function gmailUrl(url: URL): boolean {
  if (url.hostname === 'mail.google.com' && url.pathname.startsWith('/mail/')) return true;
  if (url.hostname !== 'accounts.google.com' || url.pathname !== '/AccountChooser') return false;
  try {const target = new URL(url.searchParams.get('continue') ?? ''); return safeUrl(target) && target.hostname === 'mail.google.com' && target.pathname.startsWith('/mail/');}
  catch {return false;}
}
export function documentUrl(value: unknown, provider: DocumentProvider): string | null {
  if (!text(value, 4096)) return null;
  try {
    const url = new URL(value.trim()), host = url.hostname.toLowerCase();
    const allowed = provider === 'google-drive' ? ['drive.google.com', 'docs.google.com'].includes(host)
      : provider === 'gmail' ? gmailUrl(url)
        : provider === 'pcloud' ? ['my.pcloud.com', 'u.pcloud.link', 'e.pcloud.link', 'www.pcloud.com'].includes(host)
          : ['onedrive.live.com', '1drv.ms', 'www.office.com', 'office.com'].includes(host) || host.endsWith('.sharepoint.com');
    return allowed && safeUrl(url) ? url.href : null;
  } catch {return null;}
}

export function readDocumentSource(value: unknown): DocumentSource | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as DocumentSource;
  if (!text(source.id, 3000) || !DOCUMENT_PROVIDERS.some(item => item.id === source.provider) || typeof source.sourceScope !== 'string'
    || source.sourceScope.length > 500 || !text(source.name, 300) || !documentUrl(source.url, source.provider)
    || source.fileId !== undefined && (!text(source.fileId, 500) || !source.sourceScope)
    || source.locator !== undefined && (!text(source.locator, 1500) || !source.sourceScope || source.fileId !== undefined)
    || source.location !== undefined && !text(source.location, 1500)
    || source.mimeType !== undefined && !text(source.mimeType, 200)) return null;
  const key = identity(source);
  if (key && source.id !== 'document:' + key) return null;
  return {id: source.id, provider: source.provider, sourceScope: source.sourceScope, url: source.url, name: source.name.trim(),
    ...(source.fileId === undefined ? {} : {fileId: source.fileId}), ...(source.locator === undefined ? {} : {locator: source.locator}),
    ...(source.location === undefined ? {} : {location: source.location}), ...(source.mimeType === undefined ? {} : {mimeType: source.mimeType})};
}

/** URL-only references remain unresolved identities unless the service's stable ID is known. */
export function documentFromUrl(provider: DocumentProvider, value: string, name: string, existing: readonly DocumentSource[] = []): DocumentSource {
  const url = documentUrl(value, provider);
  if (!url || !name.trim() || name.trim().length > 300) throw new Error('請填寫文件名稱與所選服務的 HTTPS 文件連結。');
  const parsed = new URL(url);
  const fileId = provider === 'google-drive' ? /\/(?:document|spreadsheets|presentation|file)\/d\/([a-zA-Z0-9_-]+)(?:\/|$)/.exec(parsed.pathname)?.[1]
    ?? (parsed.hostname === 'drive.google.com' ? /\/drive\/(?:u\/\d+\/)?folders\/([a-zA-Z0-9_-]+)(?:\/|$)/.exec(parsed.pathname)?.[1] : undefined)
    ?? (parsed.hostname === 'drive.google.com' && parsed.pathname === '/open' ? parsed.searchParams.get('id') ?? undefined : undefined) : undefined;
  const known = existing.find(item => item.provider === provider && item.url === url);
  if (!fileId && known) return {...known, name: name.trim()};
  const source: DocumentSource = {id: '', provider, sourceScope: fileId ? 'drive' : '', ...(fileId ? {fileId} : {}), url, name: name.trim()};
  source.id = identity(source) ? 'document:' + identity(source) : existing.find(item => item.provider === provider && item.url === url)?.id ?? crypto.randomUUID();
  const valid = readDocumentSource(source);
  if (!valid) throw new Error('文件來源資訊不完整，請確認連結。');
  return valid;
}

/** Used by service adapters once stable identity or an unambiguous full locator is available. */
export function createDocumentSource(input: Omit<DocumentSource, 'id'>): DocumentSource {
  const source = {...input, id: identity(input) ? 'document:' + identity(input) : crypto.randomUUID()};
  const valid = readDocumentSource(source);
  if (!valid) throw new Error('文件來源資訊不合法。');
  return valid;
}

export function readDocumentData(board: BoardState, taskIds: Set<string>): {documentSources: DocumentSource[]; documentLinks: DocumentLink[]} | null {
  if (!Array.isArray(board.documentSources) || !Array.isArray(board.documentLinks) || board.documentSources.length > 100000 || board.documentLinks.length > 200000) return null;
  const sources = board.documentSources.map(readDocumentSource);
  if (sources.some(source => !source) || new Set(sources.map(source => source!.id)).size !== sources.length
    || new Set(sources.map(source => documentIdentity(source!))).size !== sources.length) return null;
  const ids = new Set(sources.map(source => source!.id)), links: DocumentLink[] = [];
  for (const link of board.documentLinks) {
    if (!link || !text(link.id, 200) || !text(link.taskId, 1000) || !ids.has(link.documentId)
      || link.removed !== undefined && link.removed !== true || !link.removed && !taskIds.has(link.taskId)) return null;
    links.push({id: link.id, taskId: link.taskId, documentId: link.documentId, ...(link.removed ? {removed: true} : {})});
  }
  if (new Set(links.map(link => link.id)).size !== links.length) return null;
  return {documentSources: sources as DocumentSource[], documentLinks: links};
}

export function documentsForTask(board: BoardState, taskId: string): DocumentSource[] {
  const ids = new Set(board.documentLinks?.filter(link => link.taskId === taskId && !link.removed).map(link => link.documentId));
  return (board.documentSources ?? []).filter(source => ids.has(source.id));
}
export function taskDocumentIds(board: BoardState): Map<string, string[]> {
  const ids = new Map<string, Set<string>>();
  for (const link of board.documentLinks ?? []) {
    if (link.removed) continue;
    if (!ids.has(link.taskId)) ids.set(link.taskId, new Set());
    ids.get(link.taskId)!.add(link.documentId);
  }
  return new Map([...ids].map(([task, documents]) => [task, [...documents].sort()]));
}
export interface DocumentTaskEntry {workspace: Workspace; task: Task}
export function indexDocumentTasks(workspaces: readonly Workspace[], includeTrash = false): Map<string, DocumentTaskEntry[]> {
  const index = new Map<string, DocumentTaskEntry[]>();
  for (const workspace of workspaces) {
    const sources = new Map(workspace.documentSources?.map(source => [source.id, documentIdentity(source)]));
    const tasks = new Map(workspace.tasks.filter(task => includeTrash || !task.deletedAt).map(task => [task.id, task]));
    const seen = new Set<string>();
    for (const link of workspace.documentLinks ?? []) {
      const key = sources.get(link.documentId), task = tasks.get(link.taskId), pair = JSON.stringify([key, link.taskId]);
      if (link.removed || !key || !task || seen.has(pair)) continue;
      seen.add(pair);
      if (!index.has(key)) index.set(key, []);
      index.get(key)!.push({workspace, task});
    }
  }
  return index;
}
export function tasksForDocument(workspaces: readonly Workspace[], document: DocumentSource, includeTrash = false): {workspace: Workspace; task: Workspace['tasks'][number]}[] {
  return indexDocumentTasks(workspaces, includeTrash).get(documentIdentity(document)) ?? [];
}

/** Removing an observed addition never erases its identity; re-adding creates a new addition. */
export function setTaskDocuments(board: BoardState, taskId: string, documents: readonly DocumentSource[], newId = () => crypto.randomUUID()): BoardState {
  if (!board.tasks.some(task => task.id === taskId && !task.deletedAt)) throw new Error('任務已刪除或不存在，文件關聯未變更。');
  const selected = new Map(documents.map(source => {const valid = readDocumentSource(source); if (!valid) throw new Error('文件來源不合法，原有資料保留。'); return [valid.id, valid] as const;}));
  if (!selected.size && !board.documentSources) return board;
  const sources = new Map((board.documentSources ?? []).map(source => [source.id, source]));
  selected.forEach((source, id) => {if (!sources.has(id)) sources.set(id, source);});
  const links: DocumentLink[] = (board.documentLinks ?? []).map(link => link.taskId === taskId && !link.removed && !selected.has(link.documentId) ? {...link, removed: true} : {...link});
  for (const source of selected.values()) if (!links.some(link => link.taskId === taskId && link.documentId === source.id && !link.removed)) links.push({id: newId(), taskId, documentId: source.id});
  return {...board, version: 5, documentSources: [...sources.values()], documentLinks: links};
}

export function reconcileDocumentTasks<T extends BoardState>(board: T): T {
  if (!board.documentLinks) return board;
  const ids = new Set([...board.tasks.map(task => task.id), ...board.taskConflicts?.map(conflict => conflict.id) ?? []]);
  return {...board, documentLinks: board.documentLinks.map(link => ids.has(link.taskId) || link.removed ? link : {...link, removed: true})};
}

/** Merge addition events without timestamps. An observed removal wins for that exact event. */
export function mergeDocumentLinks(collections: readonly (readonly DocumentLink[])[]): DocumentLink[] {
  const links = new Map<string, DocumentLink>();
  for (const collection of collections) for (const link of collection) {
    const previous = links.get(link.id);
    if (previous && (previous.taskId !== link.taskId || previous.documentId !== link.documentId)) throw new Error('文件關聯識別互相矛盾，原有資料保留。');
    links.set(link.id, {...link, ...(previous?.removed || link.removed ? {removed: true} : {})});
  }
  return [...links.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
export function mergeDocumentSources(collections: readonly (readonly DocumentSource[])[]): DocumentSource[] {
  const sources = new Map<string, DocumentSource>();
  for (const collection of collections) for (const source of collection) {
    const previous = sources.get(source.id);
    if (previous && documentIdentity(previous) !== documentIdentity(source)) throw new Error('文件來源識別互相矛盾，原有資料保留。');
    // Display snapshots do not decide task edits. Select deterministically when two snapshots differ.
    if (!previous || JSON.stringify(source) > JSON.stringify(previous)) sources.set(source.id, structuredClone(source));
  }
  return [...sources.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
