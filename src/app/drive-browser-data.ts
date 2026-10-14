import { createDocumentSource, documentUrl } from './document-data.ts';
import type { DocumentSource, Task } from './models.ts';
import type { CalendarPosition } from './calendar-move.ts';
import { snapCalendarMinute } from './calendar-move.ts';
import { dateKey, parseDate, validDate } from './task-schedule.ts';
import { minuteLabel } from './week-layout.ts';
import {sourceFileLabel} from './source-file-type.ts';

export const DRIVE_BROWSER_SCOPE = 'https://www.googleapis.com/auth/drive.metadata.readonly';
export const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';
export const DRIVE_SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';
export const DRIVE_BROWSER_PAGE_SIZE = 100;
export const DRIVE_BROWSER_FIELDS = 'id,name,mimeType,webViewLink,modifiedTime,size,parents,driveId,resourceKey,appProperties,shortcutDetails(targetId,targetMimeType,targetResourceKey)';
const ORBIT_BACKUP_FILTER = `not (mimeType = '${DRIVE_FOLDER_MIME}' and ((appProperties has { key='orbit' and value='v1' } and appProperties has { key='type' and value='folder' }) or name = 'IIH Orbit'))`;
export const validBrowserId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(id);
export interface DriveBrowserEntry {
  id: string;
  name: string;
  mimeType: string;
  url: string;
  modifiedTime?: string;
  size?: string;
  driveId?: string;
  resourceKey?: string;
  shortcut?: {id: string; mimeType: string; resourceKey?: string};
}
export interface DriveBrowserFolder {id: string; name: string; driveId?: string; resourceKey?: string; shared?: true}
export interface DriveBrowserPage {files: DriveBrowserEntry[]; nextPageToken: string}
export interface DriveBrowserTransport {api(path: string, parameters: Record<string, string>, signal?: AbortSignal, resourceKeys?: string): Promise<unknown>}

export const isDriveFolder = (file: DriveBrowserEntry): boolean => file.mimeType === DRIVE_FOLDER_MIME || file.shortcut?.mimeType === DRIVE_FOLDER_MIME;
export function driveFileLabel(file: DriveBrowserEntry): string {
  return sourceFileLabel(file);
}
export function readDriveBrowserEntry(value: unknown): DriveBrowserEntry {
  const file = value as {id: string; name: string; mimeType: string; webViewLink?: string; modifiedTime?: string; size?: string; driveId?: string; resourceKey?: string; shortcutDetails?: {targetId: string; targetMimeType: string; targetResourceKey?: string}};
  if (!file || !validBrowserId(file.id) || typeof file.name !== 'string' || !file.name.trim() || file.name.length > 300
    || typeof file.mimeType !== 'string' || !file.mimeType || file.mimeType.length > 200
    || file.modifiedTime !== undefined && !Number.isFinite(Date.parse(file.modifiedTime))
    || file.size !== undefined && (typeof file.size !== 'string' || !/^\d{1,20}$/.test(file.size))
    || file.driveId !== undefined && !validBrowserId(file.driveId) || file.resourceKey !== undefined && !validBrowserId(file.resourceKey)) throw new Error('Drive 檔案資訊不完整，原列表保留。');
  const target = file.shortcutDetails;
  if (target && (!validBrowserId(target.targetId) || typeof target.targetMimeType !== 'string' || !target.targetMimeType || target.targetMimeType.length > 200
    || target.targetResourceKey !== undefined && !validBrowserId(target.targetResourceKey))) throw new Error('Drive 捷徑資訊不完整。');
  const generated = file.mimeType === DRIVE_FOLDER_MIME ? 'https://drive.google.com/drive/folders/' + file.id : 'https://drive.google.com/file/d/' + file.id + '/view';
  // An editor-specific or malformed optional link must not block the folder's list.
  // The validated ID and resource key provide a safe Drive URL without retaining that link.
  const url = documentUrl(file.webViewLink, 'google-drive') ?? generated + (file.resourceKey ? '?resourcekey=' + file.resourceKey : '');
  return {id: file.id, name: file.name, mimeType: file.mimeType, url,
    ...(file.modifiedTime === undefined ? {} : {modifiedTime: file.modifiedTime}), ...(file.size === undefined ? {} : {size: file.size}),
    ...(file.driveId === undefined ? {} : {driveId: file.driveId}), ...(file.resourceKey === undefined ? {} : {resourceKey: file.resourceKey}),
    ...(target ? {shortcut: {id: target.targetId, mimeType: target.targetMimeType, ...(target.targetResourceKey ? {resourceKey: target.targetResourceKey} : {})}} : {})};
}
export function sourceFromDriveEntry(file: DriveBrowserEntry, location = ''): DocumentSource {
  return createDocumentSource({provider: 'google-drive', sourceScope: 'drive', fileId: file.id, name: file.name, url: file.url, mimeType: file.mimeType, ...(location ? {location} : {})});
}

/** Only list direct children, one page at a time; never read file contents. */
export class DriveBrowserApi {
  private readonly transport: DriveBrowserTransport;
  constructor(transport: DriveBrowserTransport) {this.transport = transport;}
  async list(folder: DriveBrowserFolder, search = '', pageToken = '', signal?: AbortSignal): Promise<DriveBrowserPage> {
    if (!validBrowserId(folder.id) || folder.driveId !== undefined && !validBrowserId(folder.driveId) || folder.resourceKey !== undefined && !validBrowserId(folder.resourceKey)
      || search.length > 300 || pageToken.length > 4000) throw new Error('Drive 目錄或查詢資訊不合法。');
    const escape = (value: string) => value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
    const q = `${folder.shared ? 'sharedWithMe = true' : "'" + folder.id + "' in parents"} and trashed = false and ${ORBIT_BACKUP_FILTER}${search.trim() ? " and name contains '" + escape(search.trim()) + "'" : ''}`;
    const result = await this.transport.api('files', {q, spaces: 'drive', corpora: folder.driveId ? 'drive' : 'user', ...(folder.driveId ? {driveId: folder.driveId} : {}),
      supportsAllDrives: 'true', includeItemsFromAllDrives: 'true', pageSize: String(DRIVE_BROWSER_PAGE_SIZE), orderBy: 'folder,name_natural', fields: 'nextPageToken,incompleteSearch,files(' + DRIVE_BROWSER_FIELDS + ')', ...(pageToken ? {pageToken} : {})}, signal, folder.resourceKey ? folder.id + '/' + folder.resourceKey : undefined) as {files?: unknown[]; nextPageToken?: unknown; incompleteSearch?: unknown};
    if (!result || !Array.isArray(result.files) || result.files.length > DRIVE_BROWSER_PAGE_SIZE || result.incompleteSearch
      || result.nextPageToken !== undefined && (typeof result.nextPageToken !== 'string' || !result.nextPageToken || result.nextPageToken.length > 4000)) throw new Error('Drive 清單未完整讀取，請重新整理或縮小查詢範圍。');
    const files = result.files.map(readDriveBrowserEntry);
    if (new Set(files.map(file => file.id)).size !== files.length) throw new Error('Drive 清單含重複識別，原列表保留。');
    // Keep the page cursor even when all visible entries were filtered out.
    // App metadata also identifies a renamed backup folder; names cover legacy folders.
    const visible = files.filter((file, index) => {
      const properties = (result.files![index] as {appProperties?: Record<string, unknown>}).appProperties;
      return !isDriveFolder(file) || !(file.name.trim().toLowerCase() === 'iih orbit' || properties?.['orbit'] === 'v1' && properties?.['type'] === 'folder');
    });
    return {files: visible, nextPageToken: result.nextPageToken as string ?? ''};
  }
}

export interface DocumentCardBounds {id: string; top: number; bottom: number}
export type DocumentDropPosition = {kind: 'link'; taskId: string; status?: string} | {kind: 'create'; beforeId?: string; status?: string};
export function documentCardPosition(cards: readonly DocumentCardBounds[], y: number, status?: string): DocumentDropPosition {
  for (let index = 0; index < cards.length; index++) {
    const card = cards[index], edge = Math.min(32, Math.max(8, (card.bottom - card.top) * .22));
    if (y < card.top + edge) return {kind: 'create', beforeId: card.id, ...(status ? {status} : {})};
    if (y <= card.bottom - edge) return {kind: 'link', taskId: card.id, ...(status ? {status} : {})};
    if (y <= card.bottom) return {kind: 'create', ...(cards[index + 1] ? {beforeId: cards[index + 1].id} : {}), ...(status ? {status} : {})};
  }
  return {kind: 'create', ...(status ? {status} : {})};
}
export function scheduleDocumentTask(task: Task, source: DocumentSource, position?: CalendarPosition): Task {
  const result = {...structuredClone(task), title: source.name.slice(0, 100)};
  if (!position) return result;
  if (!position.day || !validDate(position.day)) throw new Error('請選擇有效的日期。');
  result.startDate = position.day; result.dueDate = position.day; result.startTime = ''; result.dueTime = '';
  if (position.kind === 'time') {
    if (!Number.isFinite(position.minute)) throw new Error('請選擇有效的時間。');
    const minute = snapCalendarMinute(position.minute!); result.startTime = minuteLabel(minute);
    const end = minute + 60, due = parseDate(position.day);
    if (end >= 1440) due.setDate(due.getDate() + 1);
    result.dueDate = dateKey(due); result.dueTime = minuteLabel(end % 1440);
  }
  return result;
}
