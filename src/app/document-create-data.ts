import {readDocumentSource, documentLocationSnapshot} from './document-data.ts';
import {DRIVE_FOLDER_MIME, DRIVE_FOLDER_FIELDS, readDriveBrowserEntry, sourceFromDriveEntry, validBrowserId, type DriveBrowserEntry} from './drive-browser-data.ts';
import {GoogleHttpError} from './google-api.ts';
import type {DocumentSource} from './models.ts';

export const DOCUMENT_CREATE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const DOCUMENT_FOLDER_CREATE_SCOPE = 'https://www.googleapis.com/auth/drive';
export const COLAB_MIME_TYPE = 'application/vnd.google.colaboratory';
export const EMPTY_COLAB_NOTEBOOK = JSON.stringify({nbformat: 4, nbformat_minor: 5, metadata: {colab: {provenance: []}, kernelspec: {name: 'python3', display_name: 'Python 3'}, language_info: {name: 'python'}}, cells: [{id: 'initial-cell', cell_type: 'code', metadata: {}, source: [], execution_count: null, outputs: []}]});
export const DOCUMENT_OPERATIONS_KEY = 'iih-orbit-document-operations-v1';
export const DOCUMENT_TYPES = [
  {mimeType: 'application/vnd.google-apps.document', label: 'Google 文件'},
  {mimeType: 'application/vnd.google-apps.spreadsheet', label: 'Google 試算表'},
  {mimeType: 'application/vnd.google-apps.presentation', label: 'Google 簡報'},
  {mimeType: COLAB_MIME_TYPE, label: 'Colab 筆記本（Python）'}
];
export const DOCUMENT_OPERATION_PROPERTY = 'iihOrbitDocumentOperation';
export const DOCUMENT_CREATE_FIELDS = DRIVE_FOLDER_FIELDS;
const fields = DOCUMENT_CREATE_FIELDS;
export interface DocumentDestination {id: string; name: string; resourceKey?: string; driveId?: string}
export interface DocumentCreationRequest {
  generation: string; workspaceId: string; taskId: string; taskTitle: string;
  profileId: string; context: string; clientId: string; accountId: string; sourceName: string;
  name: string; mimeType: string; folder: DocumentDestination;
}
export interface DocumentOperation extends DocumentCreationRequest {
  id: string; createdAt: number; phase: 'prepared' | 'uncertain' | 'created' | 'linked' | 'failed' | 'closed';
  result?: DocumentSource; matches?: DocumentSource[]; message: string;
}
export const pendingDocumentOperation = (operation: DocumentOperation): boolean => ['prepared', 'uncertain', 'created'].includes(operation.phase);
const text = (value: unknown, maximum: number) => typeof value === 'string' && !!value && value.length <= maximum;
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value);
export function documentCreationName(name: string, mimeType: string): string {
  const trimmed = name.trim(), value = trimmed && mimeType === COLAB_MIME_TYPE && !/\.ipynb$/i.test(trimmed) ? trimmed + '.ipynb' : trimmed;
  if (!value || value.length > 300) throw new Error('請填寫文件名稱；含 .ipynb 副檔名最多 300 字。');
  return value;
}
export interface DocumentCreateMetadata {name: string; mimeType: string; parents?: string[]; appProperties: Record<string, string>}
export function readDocumentCreateMetadata(value: unknown, notebook = false): DocumentCreateMetadata {
  const body = value as DocumentCreateMetadata;
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['name', 'mimeType', 'parents', 'appProperties'].includes(key))
    || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 300 || !DOCUMENT_TYPES.some(type => type.mimeType === body.mimeType)
    || notebook !== (body.mimeType === COLAB_MIME_TYPE) || notebook && !/\.ipynb$/i.test(body.name)
    || body.parents !== undefined && (!Array.isArray(body.parents) || body.parents.length !== 1 || !validBrowserId(body.parents[0]))
    || !body.appProperties || typeof body.appProperties !== 'object' || Array.isArray(body.appProperties) || Object.keys(body.appProperties).length !== 1 || !uuid(body.appProperties[DOCUMENT_OPERATION_PROPERTY])) throw new Error('只能建立支援的文件，且須有可查核的操作識別。');
  return {name: body.name, mimeType: body.mimeType, ...(body.parents ? {parents: [...body.parents]} : {}), appProperties: {[DOCUMENT_OPERATION_PROPERTY]: body.appProperties[DOCUMENT_OPERATION_PROPERTY]}};
}
export function readDocumentOperations(value: unknown): DocumentOperation[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('文件建立紀錄無法讀取，請保留資料並重試。');
  const operations = value.map((entry: DocumentOperation) => {
    if (!entry || !uuid(entry.id) || !['prepared', 'uncertain', 'created', 'linked', 'failed', 'closed'].includes(entry.phase)
      || !Number.isSafeInteger(entry.createdAt) || entry.createdAt < 0 || typeof entry.message !== 'string' || entry.message.length > 1500
      || !['generation', 'workspaceId', 'taskId', 'profileId', 'accountId'].every(key => text(entry[key as keyof DocumentOperation], 300))
      || !text(entry.context, 2000) || !text(entry.clientId, 300) || !text(entry.taskTitle, 300) || !text(entry.sourceName, 100)
      || !text(entry.name, 300) || !DOCUMENT_TYPES.some(type => type.mimeType === entry.mimeType)
      || !entry.folder || !validBrowserId(entry.folder.id) || !text(entry.folder.name, 300)
      || entry.folder.resourceKey !== undefined && !validBrowserId(entry.folder.resourceKey)
      || entry.folder.driveId !== undefined && !validBrowserId(entry.folder.driveId)) throw new Error('文件建立紀錄不完整，未發出建立要求。');
    const result = entry.result === undefined ? undefined : readDocumentSource(entry.result);
    const matches = entry.matches?.map(readDocumentSource);
    if (entry.result !== undefined && (!result || result.provider !== 'google-drive') || matches && (matches.length > 20 || matches.some(item => !item || item.provider !== 'google-drive'))
      || ['created', 'linked'].includes(entry.phase) && !result) throw new Error('文件建立結果不完整，請保留紀錄並重試查核。');
    return {id: entry.id, createdAt: entry.createdAt, phase: entry.phase, message: entry.message, generation: entry.generation, workspaceId: entry.workspaceId, taskId: entry.taskId, taskTitle: entry.taskTitle,
      profileId: entry.profileId, context: entry.context, clientId: entry.clientId, accountId: entry.accountId, sourceName: entry.sourceName, name: entry.name, mimeType: entry.mimeType,
      folder: {id: entry.folder.id, name: entry.folder.name, ...(entry.folder.resourceKey ? {resourceKey: entry.folder.resourceKey} : {}), ...(entry.folder.driveId ? {driveId: entry.folder.driveId} : {})},
      ...(result ? {result} : {}), ...(matches ? {matches: matches as DocumentSource[]} : {})};
  });
  if (new Set(operations.map(item => item.id)).size !== operations.length) throw new Error('文件建立紀錄含重複識別，請保留資料。');
  return operations;
}

export interface DocumentCreationTransport {api(path: string, parameters: Record<string, string>, options?: RequestInit): Promise<unknown>; createNotebook?(metadata: DocumentCreateMetadata, resourceKeys?: string): Promise<unknown>}
/** Narrow create/read API. Never modifies existing files, permissions or backup metadata. */
export class DocumentCreationApi {
  private readonly transport: DocumentCreationTransport;
  constructor(transport: DocumentCreationTransport) {this.transport = transport;}
  private headers(folder: DocumentDestination): Record<string, string> {return folder.resourceKey ? {'X-Goog-Drive-Resource-Keys': folder.id + '/' + folder.resourceKey} : {};}
  async destination(folder: DocumentDestination, signal?: AbortSignal): Promise<DocumentDestination> {
    if (!validBrowserId(folder.id) || folder.resourceKey && !validBrowserId(folder.resourceKey)) throw new Error('請選擇有效的保存資料夾。');
    if (folder.id === 'root') return {id: 'root', name: '我的雲端硬碟'};
    const raw = await this.transport.api('files/' + folder.id, {fields, supportsAllDrives: 'true'}, {headers: this.headers(folder), ...(signal ? {signal} : {})}) as {capabilities?: {canAddChildren?: boolean}; appProperties?: Record<string, string>};
    const file = readDriveBrowserEntry(raw);
    if (folder.id !== 'root' && file.id !== folder.id || file.mimeType !== DRIVE_FOLDER_MIME || file.trashed || !raw.capabilities?.canAddChildren
      || file.name.trim().toLowerCase() === 'iih orbit' || raw.appProperties?.['orbit'] === 'v1' && raw.appProperties?.['type'] === 'folder') throw new Error('此資料夾不可建立文件，或屬於 Orbit 備份位置，請重新選擇。');
    return {id: file.id, name: folder.id === 'root' ? '我的雲端硬碟' : file.name, ...(file.driveId ? {driveId: file.driveId} : {}), ...(file.resourceKey ? {resourceKey: file.resourceKey} : folder.resourceKey ? {resourceKey: folder.resourceKey} : {})};
  }
  async create(operation: DocumentOperation): Promise<DriveBrowserEntry> {
    if (!uuid(operation.id) || !DOCUMENT_TYPES.some(type => type.mimeType === operation.mimeType) || !text(operation.name.trim(), 300)) throw new Error('請填寫名稱與支援的 Google 文件類型。');
    const metadata: DocumentCreateMetadata = {name: documentCreationName(operation.name, operation.mimeType), mimeType: operation.mimeType, ...(operation.folder.id === 'root' ? {} : {parents: [operation.folder.id]}), appProperties: {[DOCUMENT_OPERATION_PROPERTY]: operation.id}};
    if (operation.mimeType === COLAB_MIME_TYPE && !this.transport.createNotebook) throw new Error('目前連線尚未支援建立 Colab 筆記本，請重新整理後再試。');
    const raw = operation.mimeType === COLAB_MIME_TYPE ? await this.transport.createNotebook!(metadata, this.headers(operation.folder)['X-Goog-Drive-Resource-Keys'])
      : await this.transport.api('files', {fields, supportsAllDrives: 'true'}, {method: 'POST', headers: {'Content-Type': 'application/json', ...this.headers(operation.folder)}, body: JSON.stringify(metadata)});
    return this.result(raw, operation);
  }
  private result(raw: unknown, operation: DocumentOperation): DriveBrowserEntry {
    const file = readDriveBrowserEntry(raw);
    if ((raw as {appProperties?: Record<string, string>})?.appProperties?.[DOCUMENT_OPERATION_PROPERTY] !== operation.id || file.mimeType !== operation.mimeType) throw new Error('Google 的建立結果尚未確認，請先查核。');
    return file;
  }
  async find(operation: DocumentOperation): Promise<DriveBrowserEntry[]> {
    if (!uuid(operation.id)) throw new Error('建立紀錄識別不合法。');
    const raw = await this.transport.api('files', {q: `appProperties has { key='${DOCUMENT_OPERATION_PROPERTY}' and value='${operation.id}' }`, spaces: 'drive', corpora: operation.folder.driveId ? 'drive' : 'user', ...(operation.folder.driveId ? {driveId: operation.folder.driveId} : {}), supportsAllDrives: 'true', includeItemsFromAllDrives: 'true', pageSize: '20', fields: 'nextPageToken,incompleteSearch,files(' + fields + ')'}) as {files?: unknown[]; nextPageToken?: unknown; incompleteSearch?: boolean};
    if (!Array.isArray(raw?.files) || raw.files.length > 20 || raw.nextPageToken || raw.incompleteSearch) throw new Error('查核結果不完整，請稍後再查，不要重複建立。');
    return raw.files.map(file => this.result(file, operation));
  }
}

/** Persist the attempt before POST. Reloads and other tabs can only reconcile an uncertain attempt. */
export class DocumentOperationJournal {
  private readonly storage: Pick<Storage, 'getItem' | 'setItem'>;
  private readonly lock: <T>(write: () => T) => Promise<T>;
  private readonly changed: () => void;
  constructor(storage: Pick<Storage, 'getItem' | 'setItem'>, lock: <T>(write: () => T) => Promise<T>, changed = () => {}) {this.storage = storage; this.lock = lock; this.changed = changed;}
  read(): DocumentOperation[] {const raw = this.storage.getItem(DOCUMENT_OPERATIONS_KEY); return raw ? readDocumentOperations(JSON.parse(raw)) : [];}
  private save(operations: DocumentOperation[]): void {this.storage.setItem(DOCUMENT_OPERATIONS_KEY, JSON.stringify(readDocumentOperations(operations))); this.changed();}
  async begin(request: DocumentCreationRequest): Promise<{operation: DocumentOperation; fresh: boolean}> {
    return this.lock(() => {
      let operations = this.read();
      const previous = operations.find(item => item.generation === request.generation && item.workspaceId === request.workspaceId && item.taskId === request.taskId && pendingDocumentOperation(item));
      if (previous) return {operation: previous, fresh: false};
      const pending = operations.filter(pendingDocumentOperation);
      if (pending.length >= 100) throw new Error('待接續的文件建立已達上限，請先處理既有紀錄。');
      const completed = operations.filter(item => !pendingDocumentOperation(item) && Date.now() - item.createdAt < 30 * 86400000).slice(-(99 - pending.length));
      operations = [...pending, ...(pending.length === 99 ? [] : completed)];
      const operation: DocumentOperation = {...structuredClone(request), id: crypto.randomUUID(), createdAt: Date.now(), phase: 'prepared', message: '已保存建立紀錄，尚未送出。'};
      this.save([...operations, operation]); return {operation, fresh: true};
    });
  }
  async update(operation: DocumentOperation): Promise<DocumentOperation> {
    return this.lock(() => {
      const operations = this.read(), latest = operations.find(item => item.id === operation.id);
      if (!latest) throw new Error('本機建立紀錄已被清除，請保留目前文件連結。');
      const next = latest.phase === 'linked' || latest.phase === 'closed' ? {...latest, ...(operation.result && !latest.result ? {result: operation.result} : {})}
        : latest.result && !operation.result ? {...operation, phase: 'created' as const, result: latest.result} : operation;
      this.save(operations.map(item => item.id === operation.id ? next : item)); return next;
    });
  }
}

export class DocumentCreationCoordinator {
  readonly journal: DocumentOperationJournal;
  constructor(journal: DocumentOperationJournal) {this.journal = journal;}
  private source(file: DriveBrowserEntry, operation: DocumentOperation): DocumentSource {return sourceFromDriveEntry(file, documentLocationSnapshot(operation.sourceName, operation.folder.name));}
  async create(request: DocumentCreationRequest, api: DocumentCreationApi, current: () => boolean, link: (source: DocumentSource) => Promise<void>): Promise<DocumentOperation> {
    if (!current()) throw new Error('任務或來源已變更，請重新開啟建立流程。');
    request = {...request, name: documentCreationName(request.name, request.mimeType)};
    const start = await this.journal.begin(request); let operation = start.operation;
    if (!start.fresh) return {...operation, message: '此任務已有待接續的建立紀錄，請先查核或重新加入，不會重複建立。'};
    let sent = false;
    try {
      operation.folder = await api.destination(request.folder);
      if (!current()) throw new Error('任務或來源已變更，未建立文件。');
      operation = await this.journal.update({...operation, phase: 'uncertain', message: '正在建立，尚待確認 Google 回覆。'});
      if (operation.phase === 'closed' || operation.phase === 'linked') return operation;
      if (!current()) throw new Error('任務或來源已變更，未送出建立要求。');
      sent = true; const file = await api.create(operation);
      operation = {...operation, phase: 'created', result: this.source(file, operation), message: '雲端文件已建立，正在保存任務連結。'};
      await this.journal.update(operation);
      return await this.attach(operation, current, link);
    } catch (error) {
      const rejected = !sent || error instanceof GoogleHttpError && [400, 401, 403, 404, 429].includes(error.status);
      operation = {...operation, phase: operation.result ? 'created' : rejected ? 'failed' : 'uncertain', message: operation.result ? '雲端文件已建立，任務連結尚未保存。請重新加入，勿重複建立。' : rejected ? (error instanceof Error ? error.message : '未完成建立，請重試。') : '尚無法確認 Google 是否完成建立。請先查核，不要重複建立。'};
      try {await this.journal.update(operation);} catch {operation.message += ' 本機紀錄未能更新，請保留此畫面與文件連結。';}
      return operation;
    }
  }
  async reconcile(operation: DocumentOperation, api: DocumentCreationApi, current: () => boolean, link: (source: DocumentSource) => Promise<void>): Promise<DocumentOperation> {
    if (!current()) throw new Error('請回到原資料世代、工作空間與來源帳號後查核。');
    let next = structuredClone(operation);
    if (!next.result) {
      const files = await api.find(next);
      if (files.length !== 1) {
        next = {...next, phase: 'uncertain', matches: files.map(file => this.source(file, next)), message: files.length ? '找到多份相符文件，請在 Drive 核對後選用連結，不會自動選擇或再次建立。' : '目前查無結果，Google 可能仍在處理。請稍後再查核，或到 Drive 確認。'};
        await this.journal.update(next); return next;
      }
      next = {...next, phase: 'created', result: this.source(files[0], next), message: '已找到建立結果，正在保存連結。'}; await this.journal.update(next);
      if (files[0].trashed) {next.message = '建立的文件已移至垃圾桶。請到 Drive 核對後還原，再重新加入任務。'; await this.journal.update(next); return next;}
    }
    return this.attach(next, current, link);
  }
  private async attach(operation: DocumentOperation, current: () => boolean, link: (source: DocumentSource) => Promise<void>): Promise<DocumentOperation> {
    const latest = this.journal.read().find(item => item.id === operation.id);
    if (latest?.phase === 'linked' || latest?.phase === 'closed') return latest;
    let next = operation;
    try {
      if (!current()) throw new Error('任務或來源已變更。');
      await link(operation.result!); next = {...operation, phase: 'linked', message: '文件已建立並加入任務，可開啟原文件編輯。'};
    } catch (error) {next = {...operation, phase: 'created', message: '文件已建立，任務連結尚未保存。' + (error instanceof Error ? error.message + ' ' : '') + '請保留連結，回到原任務後重新加入。'};}
    return this.journal.update(next);
  }
}
