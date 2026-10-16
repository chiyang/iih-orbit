import {DOCUMENT} from '@angular/common';
import {computed, effect, inject, Injectable, Injector, OnDestroy, signal, untracked} from '@angular/core';
import {BoardStore, type TaskEditContext} from './board-store';
import {DriveBrowserConnection} from './drive-browser-connection';
import {GOOGLE_AUTH_SESSION} from './google-auth';
import {DocumentCreateAuth} from './document-create-auth';
import {DOCUMENT_CREATE_SCOPE, DOCUMENT_FOLDER_CREATE_SCOPE, DOCUMENT_OPERATIONS_KEY, DocumentCreationApi, DocumentCreationCoordinator, DocumentOperationJournal, documentCreationName, pendingDocumentOperation, type DocumentCreationRequest, type DocumentDestination, type DocumentOperation} from './document-create-data';
import {withStorageLock} from './storage-coordinator';
import {validBrowserId} from './drive-browser-data';

const DESTINATIONS_KEY = 'iih-orbit-document-destinations-v1';
type CreationIdentity = Pick<DocumentCreationRequest, 'generation' | 'workspaceId' | 'profileId' | 'context' | 'clientId' | 'accountId'>;

@Injectable({providedIn: 'root'})
export class DocumentCreateService implements OnDestroy {
  readonly store = inject(BoardStore);
  readonly connections = inject(DriveBrowserConnection);
  private readonly document = inject(DOCUMENT);
  private readonly injector = inject(Injector);
  readonly busy = signal(false);
  readonly message = signal('');
  readonly operations = signal<DocumentOperation[]>([]);
  readonly pending = computed(() => this.operations().filter(pendingDocumentOperation));
  readonly result = signal<DocumentOperation | null>(null);
  private readonly credentialsRevision = signal(0);
  private readonly writers = new Map<string, {context: string; scope: string; auth: DocumentCreateAuth; injector: ReturnType<typeof Injector.create>}>();
  private readonly journal = new DocumentOperationJournal({getItem: key => {
    const storage = this.document.defaultView?.localStorage; if (!storage) throw new Error('瀏覽器無法保存建立紀錄，尚未建立文件。'); return storage.getItem(key);
  }, setItem: (key, value) => {
    const storage = this.document.defaultView?.localStorage; if (!storage) throw new Error('瀏覽器無法保存建立紀錄，尚未建立文件。'); storage.setItem(key, value);
  }}, withStorageLock, () => this.reload());
  private readonly coordinator = new DocumentCreationCoordinator(this.journal);
  private readonly stopProtection = this.store.protectDocumentSources(() => {
    this.operations();
    try {return new Set(this.journal.read().filter(pendingDocumentOperation).flatMap(operation => [operation.result, ...operation.matches ?? []].filter(Boolean).map(source => source!.id)));}
    catch {return new Set(this.store.workspaces().flatMap(workspace => workspace.documentSources?.map(source => source.id) ?? []));}
  });
  private readonly storageChanged = (event: StorageEvent) => {if (!event.key || event.key === DOCUMENT_OPERATIONS_KEY) this.reload();};
  constructor() {
    this.reload(); this.document.defaultView?.addEventListener('storage', this.storageChanged);
    effect(() => {
      const sources = this.connections.sources(), generation = this.store.generation();
      const valid = new Map(sources.filter(source => source.auth.connected() && !source.connecting()).map(source => [source.id, JSON.stringify([generation, source.context()])]));
      untracked(() => {for (const [id, writer] of this.writers) if (writer.context !== valid.get(id)) {writer.auth.disconnect(); writer.injector.destroy(); this.writers.delete(id); this.credentialsRevision.update(value => value + 1);}});
    });
  }
  reload(): void {try {this.operations.set(this.journal.read());} catch (error) {this.message.set(error instanceof Error ? error.message : '建立紀錄無法讀取。');}}
  authorization(id: string): DocumentCreateAuth | undefined {this.credentialsRevision(); return this.writers.get(id)?.auth;}
  writer(id: string, folderAccess = false): DocumentCreateAuth | undefined {
    const source = this.connections.sources().find(item => item.id === id);
    if (!source?.auth.connected() || source.connecting() || !source.account().id) return undefined;
    const context = JSON.stringify([this.store.generation(), source.context()]);
    const scope = folderAccess ? DOCUMENT_FOLDER_CREATE_SCOPE : DOCUMENT_CREATE_SCOPE;
    const saved = this.writers.get(id); if (saved?.context === context && (saved.scope === scope || saved.scope === DOCUMENT_FOLDER_CREATE_SCOPE && saved.auth.connected())) return saved.auth;
    if (saved) {saved.auth.disconnect(); saved.injector.destroy();}
    const prefix = 'iih-orbit-document-create-' + id + (folderAccess ? '-folder' : '');
    const injector = Injector.create({parent: this.injector, providers: [DocumentCreateAuth, {provide: GOOGLE_AUTH_SESSION, useValue: {options: {scope, storageKey: prefix + '-session-v1', controlPrefix: prefix + '-control-v1:'}, channel: prefix + '-' + crypto.randomUUID()}}]});
    const auth = injector.get(DocumentCreateAuth); auth.useSession({generation: this.store.generation(), clientId: source.clientId(), accountId: source.account().id});
    this.writers.set(id, {context, scope, auth, injector}); this.credentialsRevision.update(value => value + 1); void auth.prepare().catch(() => {}); return auth;
  }
  async prepare(id: string, folderAccess = false): Promise<void> {
    try {const source = this.connections.sources().find(item => item.id === id); if (!source) return; await (this.writer(id, folderAccess)?.prepare() ?? source.prepare());}
    catch (error) {this.message.set(error instanceof Error ? error.message : '授權元件尚未準備完成。');}
  }
  async connectSource(id: string): Promise<void> {
    const source = this.connections.sources().find(item => item.id === id);
    if (!source?.clientId()) {this.message.set('請先在「設定 → Google Drive」設定此來源的 Client ID。'); return;}
    if (!source.auth.ready()) {this.message.set('來源授權元件尚未準備完成，請按重新準備來源連線。'); return;}
    if (source.connecting() || source.auth.authorizing()) return;
    if (!await source.connect()) {this.message.set(source.error() || source.auth.message() || '來源連線尚未完成，請重試。'); return;}
    await this.prepare(id);
  }
  private destinations(): {profileId: string; context: string; folder: DocumentDestination}[] {
    try {
      const values = JSON.parse(this.document.defaultView?.localStorage.getItem(DESTINATIONS_KEY) ?? '[]') as {profileId: string; context: string; folder: DocumentDestination}[];
      return Array.isArray(values) && values.length <= 100 ? values.filter(item => typeof item?.profileId === 'string' && typeof item.context === 'string' && validBrowserId(item.folder?.id) && typeof item.folder.name === 'string' && item.folder.name.length <= 300
        && (!item.folder.resourceKey || validBrowserId(item.folder.resourceKey)) && (!item.folder.driveId || validBrowserId(item.folder.driveId))) : [];
    } catch {return [];}
  }
  lastFolder(id: string): DocumentDestination {
    const source = this.connections.sources().find(item => item.id === id), context = source?.context();
    return structuredClone(this.destinations().find(item => item.profileId === id && item.context === context)?.folder ?? this.operations().filter(operation => operation.profileId === id && operation.context === context && operation.result).sort((a, b) => a.createdAt - b.createdAt).at(-1)?.folder ?? {id: 'root', name: '我的雲端硬碟'});
  }
  private rememberDestination(operation: DocumentOperation): void {
    if (!operation.result || !this.valid(operation)) return;
    try {const values = this.destinations().filter(item => item.profileId !== operation.profileId || item.context !== operation.context); this.document.defaultView?.localStorage.setItem(DESTINATIONS_KEY, JSON.stringify([...values.slice(-99), {profileId: operation.profileId, context: operation.context, folder: operation.folder}]));}
    catch { /* A display preference failure must not hide a created file or invalidate its relation. */ }
  }
  async validateFolder(id: string, folder: DocumentDestination, signal?: AbortSignal): Promise<DocumentDestination> {
    const source = this.connections.sources().find(item => item.id === id);
    if (!source?.auth.connected() || source.connecting()) throw new Error('來源尚未連線，請重新連線後選擇。');
    const identity: CreationIdentity = {generation: this.store.generation(), workspaceId: this.store.currentWorkspace().id, profileId: id, context: source.context(), clientId: source.clientId(), accountId: source.account().id};
    const version = source.auth.connectionVersion();
    const api = new DocumentCreationApi({api: (path, parameters, options) => {
      if (!path.startsWith('files/') || options?.method && options.method !== 'GET' || options?.body) throw new Error('選擇資料夾僅讀取資訊。');
      const keys = new Headers(options?.headers).get('X-Goog-Drive-Resource-Keys') ?? undefined;
      return source.auth.api(path, parameters, options?.signal ?? undefined, keys);
    }});
    const destination = await api.destination(folder, signal);
    signal?.throwIfAborted();
    if (!this.valid(identity) || source.auth.connectionVersion() !== version) throw new Error('來源或工作空間已變更，請重新選擇。');
    return destination;
  }
  private valid(request: CreationIdentity): boolean {
    const source = this.connections.sources().find(item => item.id === request.profileId);
    return this.store.generation() === request.generation && this.store.currentWorkspace().id === request.workspaceId && !!source?.auth.connected() && !source.connecting()
      && source.context() === request.context && source.clientId() === request.clientId && source.account().id === request.accountId;
  }
  private async authorize(request: CreationIdentity, folderAccess = false): Promise<DocumentCreationApi> {
    const auth = this.writer(request.profileId, folderAccess);
    if (!auth?.ready() || !this.valid(request)) throw new Error('來源或授權元件尚未準備完成，請確認連線後再試。');
    if (!auth.connected()) await auth.authorize(request.clientId, {expectedAccountId: request.accountId, loginHint: request.accountId});
    if (!this.valid(request) || auth.account()?.id !== request.accountId) throw new Error('來源帳號已變更，未接續建立或查核。');
    return new DocumentCreationApi(auth);
  }
  private link(context: TaskEditContext, request: DocumentCreationRequest) {
    return async (source: NonNullable<DocumentOperation['result']>) => {
      const result = await this.store.linkDocument(request.taskId, source, context, {requirePersistence: true, verify: () => {
        if (!this.valid(request) || !this.journal.read().some(operation => operation.generation === request.generation && operation.workspaceId === request.workspaceId && operation.taskId === request.taskId && operation.result?.id === source.id && operation.phase !== 'closed')) throw new Error('來源、工作空間、資料或建立紀錄已變更，未加入原任務。');
      }});
      if (!result.ok || !result.persisted) throw new Error(result.ok ? '任務連結尚未保存。' : result.message);
    };
  }
  async create(context: TaskEditContext, profileId: string, name: string, mimeType: string, folder: DocumentDestination): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true); this.message.set(''); this.result.set(null);
    try {
      const source = this.connections.sources().find(item => item.id === profileId);
      if (!context.original || !source || context.generation !== this.store.generation() || this.store.hasUnsavedChanges()) throw new Error('請先成功儲存任務，再建立雲端文件。');
      const request: DocumentCreationRequest = {generation: context.generation, workspaceId: context.workspaceId, taskId: context.original.id, taskTitle: context.original.title.slice(0, 300),
        profileId, context: source.context(), clientId: source.clientId(), accountId: source.account().id, sourceName: profileId === 'default' ? 'Google Drive' : source.name(), name: documentCreationName(name, mimeType), mimeType, folder};
      const api = await this.authorize(request, folder.id !== 'root');
      const current = () => this.valid(request) && JSON.stringify(this.store.workspaces().find(workspace => workspace.id === request.workspaceId)?.tasks.find(task => task.id === request.taskId)) === JSON.stringify(context.original);
      const operation = await this.coordinator.create(request, api, current, this.link(context, request)); this.rememberDestination(operation); this.result.set(operation); this.message.set(operation.message);
    } catch (error) {this.message.set(error instanceof Error ? error.message : '文件尚未建立，請確認後重試。');}
    finally {this.busy.set(false); this.reload();}
  }
  async recover(operation: DocumentOperation): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true); this.message.set('');
    try {
      const latest = this.journal.read().find(item => item.id === operation.id);
      if (!latest || !pendingDocumentOperation(latest)) throw new Error('建立紀錄已更新，請重新查看。');
      const context = this.store.taskContext(latest.taskId);
      if (!context.original || !this.valid(latest)) throw new Error('請回到原工作空間、任務與來源帳號後接續。文件連結仍可開啟。');
      const api = await this.authorize(latest, latest.folder.id !== 'root');
      const result = await this.coordinator.reconcile(latest, api, () => this.valid(latest), this.link(context, latest)); this.rememberDestination(result); this.result.set(result); this.message.set(result.message);
    } catch (error) {this.message.set(error instanceof Error ? error.message : '查核未完成，請稍後重試。');}
    finally {this.busy.set(false); this.reload();}
  }
  async closeRecord(operation: DocumentOperation): Promise<void> {
    if (this.busy()) return;
    try {const latest = this.journal.read().find(item => item.id === operation.id); if (latest) await this.journal.update({...latest, phase: 'closed', message: '已由使用者確認並結束接續，雲端文件保留。'}); this.message.set('已結束這次接續。雲端文件與已保存的任務連結保留。');}
    catch {this.message.set('紀錄未能保存，仍保留待接續狀態。');}
  }
  ngOnDestroy(): void {for (const writer of this.writers.values()) {writer.auth.disconnect(); writer.injector.destroy();} this.writers.clear(); this.stopProtection(); this.document.defaultView?.removeEventListener('storage', this.storageChanged);}
}
