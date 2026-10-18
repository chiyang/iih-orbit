import { computed, effect, inject, Injectable, InjectionToken, OnDestroy, signal, untracked } from '@angular/core';
import { BoardStore } from './board-store';
import { DriveBrowserConnection } from './drive-browser-connection';
import { DriveBrowserApi, isDriveFolder, sourceFromDriveEntry, type DriveBrowserEntry, type DriveBrowserFolder, type DriveBrowserPage } from './drive-browser-data';
import { DocumentMetadataService } from './document-metadata-service';
import type { DocumentSource } from './models';
import {DEFAULT_DRIVE_SOURCE} from './drive-source-data';
import {documentLocationSnapshot} from './document-data';

const ROOT: DriveBrowserFolder = {id: 'root', name: '我的雲端硬碟'};
export const DRIVE_FOLDERS_ONLY = new InjectionToken<boolean>('Drive folders only');
interface CachedFolder extends DriveBrowserPage {updatedAt: number; tokens: string[]}
interface NavigationState {path: DriveBrowserFolder[]; query: string; files: DriveBrowserEntry[]; nextPageToken: string; cache: Map<string, CachedFolder>}

@Injectable({providedIn: 'root'})
export class DriveBrowser implements OnDestroy {
  readonly store = inject(BoardStore);
  readonly connection = inject(DriveBrowserConnection);
  private readonly foldersOnly = inject(DRIVE_FOLDERS_ONLY, {optional: true}) ?? false;
  readonly sourceId = signal(DEFAULT_DRIVE_SOURCE);
  readonly selectedConnection = computed(() => this.connection.source(this.sourceId()));
  readonly sourceContext = computed(() => JSON.stringify([this.selectedConnection().id, this.selectedConnection().context()]));
  get auth() {return this.selectedConnection().auth;}
  readonly busy = signal(false);
  readonly refreshing = signal(false);
  readonly error = signal('');
  readonly notice = signal('');
  readonly path = signal<DriveBrowserFolder[]>([{...ROOT}]);
  readonly query = signal('');
  readonly files = signal<DriveBrowserEntry[]>([]);
  readonly nextPageToken = signal('');
  readonly metadata = inject(DocumentMetadataService);
  readonly visibleFiles = computed(() => this.files().filter(file => this.metadata.visibleIn(this.selectedConnection().id, file.id, this.path().at(-1)!)));
  private cache = new Map<string, CachedFolder>();
  private readonly navigation = new Map<string, NavigationState>();
  private context = '';
  private request = 0;
  private epoch = 0;
  private controller?: AbortController;
  private pendingConnection = 0;
  private destroyed = false;
  private readonly unregisterCaches = this.metadata.registerListCaches({stats: () => {
    const caches = this.caches(); return {lists: caches.reduce((sum, cache) => sum + cache.size, 0), expired: caches.reduce((sum, cache) => sum + [...cache.values()].filter(value => Date.now() - value.updatedAt >= 5 * 60000).length, 0)};
  }, clear: expiredOnly => {
    if (!expiredOnly) {this.epoch++; this.cancel();}
    let removed = 0;
    for (const cache of this.caches()) for (const [key, value] of cache) if (!expiredOnly || Date.now() - value.updatedAt >= 5 * 60000) {cache.delete(key); removed++;}
    return removed;
  }});
  constructor() {
    effect(() => {const context = this.sourceContext(); untracked(() => this.useSource(context));});
    effect(() => {const contexts = new Set(this.connection.sources().map(source => JSON.stringify([source.id, source.context()]))); untracked(() => {for (const key of this.navigation.keys()) if (!contexts.has(key)) this.navigation.delete(key); this.metadata.touchCaches();});});
    effect(() => {const version = this.auth.connectionVersion(), connected = this.auth.connected(); untracked(() => {if (this.controller && version !== this.pendingConnection) this.cancel(); if (version && !connected) this.notice.set(this.auth.message());});});
  }
  private caches(): Map<string, CachedFolder>[] {return [...new Set([this.cache, ...[...this.navigation.values()].map(value => value.cache)])];}
  private useSource(context: string): void {
    if (context === this.context) return;
    if (this.context) this.navigation.set(this.context, {path: this.path(), query: this.query(), files: this.files(), nextPageToken: this.nextPageToken(), cache: this.cache});
    const valid = new Set(this.connection.sources().map(source => JSON.stringify([source.id, source.context()])));
    for (const key of this.navigation.keys()) if (!valid.has(key)) this.navigation.delete(key);
    this.context = context; this.epoch++; this.cancel();
    const saved = this.navigation.get(context);
    this.cache = saved?.cache ?? new Map(); this.files.set(saved?.files ?? []); this.path.set(saved?.path ?? [{...ROOT}]);
    this.query.set(saved?.query ?? ''); this.nextPageToken.set(saved?.nextPageToken ?? ''); this.error.set(''); this.notice.set('');
  }
  async selectSource(id: string): Promise<void> {
    if (!this.connection.sources().some(source => source.id === id)) return;
    this.sourceId.set(id); this.useSource(this.sourceContext()); await this.activate();
  }
  identity(): string {return JSON.stringify([this.sourceContext(), this.auth.connectionVersion(), this.epoch]);}
  async prepare(): Promise<void> {
    if (!this.selectedConnection().clientId()) return;
    try {await this.selectedConnection().prepare();} catch (error) {this.error.set(this.message(error));}
  }
  disconnect(): void {
    this.cancel(); this.selectedConnection().disconnect(); this.epoch++; this.cache.clear(); this.navigation.delete(this.context); this.files.set([]); this.path.set([{...ROOT}]); this.query.set(''); this.nextPageToken.set('');
    this.notice.set('檔案瀏覽已解除連線，任務中的資訊連結保留。');
  }
  async activate(): Promise<void> {this.useSource(this.sourceContext()); if (this.refreshing()) return; if (this.auth.connected() && !this.selectedConnection().connecting()) await this.load(); else void this.prepare();}
  async root(shared = false): Promise<void> {await this.load([shared ? {id: 'shared', name: '與我共用', shared: true} : {...ROOT}], '');}
  async open(file: DriveBrowserEntry): Promise<void> {
    if (!this.isListed(file)) return;
    const shown = this.displayEntry(file); if (!isDriveFolder(shown)) return;
    const target = shown.shortcut;
    const folder: DriveBrowserFolder = {id: target?.id ?? shown.id, name: shown.name, ...(!target && shown.driveId ? {driveId: shown.driveId} : {}), ...(target?.resourceKey || shown.resourceKey ? {resourceKey: target?.resourceKey ?? shown.resourceKey} : {})};
    await this.load([...this.path(), folder], '');
  }
  async back(index = this.path().length - 2): Promise<void> {if (index >= 0 && index < this.path().length) await this.load(this.path().slice(0, index + 1), '');}
  async search(query: string): Promise<void> {await this.load(this.path(), query.trim());}
  async refresh(): Promise<void> {
    const source = this.selectedConnection();
    if (this.destroyed || this.refreshing() || this.busy() || source.connecting() || source.auth.authorizing()) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {this.error.set('目前離線，原有檔案列表已保留。'); return;}
    const context = this.sourceContext(), epoch = this.epoch, path = this.path(), query = this.query();
    const current = () => !this.destroyed && context === this.sourceContext() && epoch === this.epoch && path === this.path() && query === this.query();
    this.refreshing.set(true);
    try {
      const renewal = source.auth.renewForAction({generation: this.store.generation(), clientId: source.clientId(), accountId: source.account().id});
      if (renewal) await renewal;
      if (current()) {this.notice.set(''); await this.load(path, query, false, true);}
    } catch (error) {if (current()) this.error.set(this.message(error));}
    finally {this.refreshing.set(false);}
  }
  async more(): Promise<void> {if (this.nextPageToken() && !this.busy()) await this.load(this.path(), this.query(), true);}
  isListed(file: DriveBrowserEntry): boolean {return this.auth.connected() && !this.selectedConnection().connecting() && this.visibleFiles().some(item => item.id === file.id && item.url === file.url);}
  sourceLabel(): string {const source = this.selectedConnection(); return source.id === DEFAULT_DRIVE_SOURCE ? 'Google Drive' : source.name();}
  pathLabel(index: number): string {return index === 0 ? this.sourceLabel() + (this.path()[0].shared ? ' · 與我共用' : '') : this.metadata.entry(this.selectedConnection().id, this.path()[index].id)?.name ?? this.path()[index].name;}
  displayEntry(file: DriveBrowserEntry): DriveBrowserEntry {return this.metadata.entry(this.selectedConnection().id, file.id) ?? file;}
  source(file: DriveBrowserEntry): DocumentSource {
    if (!this.isListed(file)) throw new Error('檔案列表或連線已更新，請重新選擇。');
    return sourceFromDriveEntry(this.displayEntry(file), documentLocationSnapshot(this.sourceLabel(), this.path().map((folder, index) => index ? this.pathLabel(index) : folder.name).join(' / ')));
  }
  display(source: DocumentSource): {name: string; location?: string} {
    return this.metadata.display(source, this.selectedConnection().id);
  }
  private async load(path = this.path(), query = this.query(), append = false, force = false): Promise<void> {
    if (this.destroyed || !this.auth.connected() || this.selectedConnection().connecting()) return;
    this.cancel(); const request = ++this.request, identity = this.identity(), controller = new AbortController(); this.controller = controller; this.pendingConnection = this.auth.connectionVersion();
    const current = () => !this.destroyed && request === this.request && identity === this.identity() && !controller.signal.aborted;
    const folder = path[path.length - 1], key = JSON.stringify([folder, query]), previous = this.cache.get(key), token = append ? this.nextPageToken() : '';
    this.busy.set(true); this.error.set('');
    try {
      let page: DriveBrowserPage;
      if (!append && !force && previous && Date.now() - previous.updatedAt < 5 * 60000) page = previous;
      else page = await new DriveBrowserApi(this.auth).list(folder, query, token, controller.signal, this.foldersOnly);
      if (!current()) return;
      const tokens = append ? [...previous?.tokens ?? [], token] : page === previous ? [...previous.tokens] : [];
      if (page.nextPageToken && (page.nextPageToken === token || tokens.includes(page.nextPageToken))) throw new Error('Drive 分頁重複，請重新整理目前資料夾。');
      const files = [...new Map([...(append ? this.files() : []), ...page.files].map(file => [file.id, file])).values()];
      if (files.length > 1000) throw new Error('此資料夾項目較多，請用檔名搜尋縮小範圍。');
      files.sort((a, b) => Number(isDriveFolder(b)) - Number(isDriveFolder(a)) || a.name.localeCompare(b.name, 'zh-Hant', {numeric: true}));
      this.path.set(structuredClone(path)); this.query.set(query); this.files.set(files); this.nextPageToken.set(page.nextPageToken);
      this.cache.delete(key); this.cache.set(key, {files, nextPageToken: page.nextPageToken, tokens, updatedAt: page === previous ? previous.updatedAt : Date.now()});
      while (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!);
      this.metadata.observeList(this.selectedConnection().id, page.files, folder, page === previous ? previous.updatedAt : Date.now(), page === previous); this.metadata.touchCaches();
    } catch (error) {if (current()) this.error.set(this.message(error));}
    finally {if (request === this.request) {this.busy.set(false); this.controller = undefined;}}
  }
  private cancel(): void {this.request++; this.controller?.abort(); this.controller = undefined; this.busy.set(false);}
  private message(error: unknown): string {return error instanceof Error ? error.message : '無法讀取 Drive 檔案列表，請稍後重試。';}
  ngOnDestroy(): void {this.destroyed = true; this.cancel(); this.unregisterCaches();}
}
