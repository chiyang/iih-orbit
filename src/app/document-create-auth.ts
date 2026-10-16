import {Injectable} from '@angular/core';
import {GoogleAuth} from './google-auth';
import {DOCUMENT_CREATE_SCOPE, DOCUMENT_FOLDER_CREATE_SCOPE, DOCUMENT_CREATE_FIELDS, COLAB_MIME_TYPE, EMPTY_COLAB_NOTEBOOK, readDocumentCreateMetadata, type DocumentCreateMetadata, type DocumentCreationTransport} from './document-create-data';
import type {SessionOptions} from './google-session';
import {validBrowserId} from './drive-browser-data';

@Injectable()
export class DocumentCreateAuth extends GoogleAuth implements DocumentCreationTransport {
  createNotebook(metadata: DocumentCreateMetadata, resourceKeys?: string): Promise<unknown> {
    const body = readDocumentCreateMetadata(metadata, true);
    if (!this.hasScope(DOCUMENT_CREATE_SCOPE) && !this.hasScope(DOCUMENT_FOLDER_CREATE_SCOPE)) throw new Error('請先取得文件建立授權。');
    if (resourceKeys && (resourceKeys.split('/').length !== 2 || resourceKeys.split('/')[0] !== body.parents?.[0] || !resourceKeys.split('/').every(validBrowserId))) throw new Error('筆記本保存資料夾資訊不合法。');
    const boundary = 'orbit-notebook-' + crypto.randomUUID();
    const content = '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(body)
      + '\r\n--' + boundary + '\r\nContent-Type: ' + COLAB_MIME_TYPE + '\r\n\r\n' + EMPTY_COLAB_NOTEBOOK + '\r\n--' + boundary + '--\r\n';
    return this.fetchJson('https://www.googleapis.com/upload/drive/v3/files?' + new URLSearchParams({uploadType: 'multipart', fields: DOCUMENT_CREATE_FIELDS, supportsAllDrives: 'true'}), {method: 'POST', headers: {'Content-Type': 'multipart/related; boundary=' + boundary, ...(resourceKeys ? {'X-Goog-Drive-Resource-Keys': resourceKeys} : {})}, body: content});
  }
  protected override get sessionOptions(): SessionOptions {return this.sessionConfiguration!.options;}
  protected override get sessionChannel(): string {return this.sessionConfiguration!.channel;}
  protected override get sessionPersistence(): 'memory' {return 'memory';}
  protected override get permissionMessage(): string {return this.sessionOptions.scope === DOCUMENT_FOLDER_CREATE_SCOPE ? '請允許 Google Drive 存取權限，才能在選定的既有資料夾建立文件。取消時不會建立文件。' : '請允許建立及管理由此應用程式建立或選用的 Drive 文件。';}
  protected override get networkMessage(): string {return '建立或查核中斷，請先查核結果，避免重複建立。';}
  protected override get resourceName(): string {return '新文件';}
  protected override get maxResponseBytes(): number {return 1024 * 1024;}
  api(path: string, parameters: Record<string, string>, options: RequestInit = {}): Promise<unknown> {
    if (path !== 'files' && (!path.startsWith('files/') || !validBrowserId(path.slice(6))) || !['GET', 'POST'].includes(options.method ?? 'GET') || options.method === 'POST' && path !== 'files'
      || !this.hasScope(DOCUMENT_CREATE_SCOPE) && !this.hasScope(DOCUMENT_FOLDER_CREATE_SCOPE) || parameters['alt'] || parameters['fields']?.includes('*')) throw new Error('文件建立僅允許新增支援的文件與查核資訊。');
    const list = path === 'files' && options.method !== 'POST';
    if (parameters['fields'] !== (list ? 'nextPageToken,incompleteSearch,files(' + DOCUMENT_CREATE_FIELDS + ')' : DOCUMENT_CREATE_FIELDS)
      || Object.keys(parameters).some(key => !['fields', 'supportsAllDrives', 'includeItemsFromAllDrives', 'q', 'spaces', 'corpora', 'driveId', 'pageSize', 'orderBy'].includes(key))) throw new Error('文件建立要求包含不支援的欄位。');
    if (options.method === 'POST') {
      readDocumentCreateMetadata(JSON.parse(String(options.body)));
    } else if (options.body) throw new Error('查核要求不可包含檔案內容。');
    return this.fetchJson('https://www.googleapis.com/drive/v3/' + path + '?' + new URLSearchParams(parameters), options);
  }
}
