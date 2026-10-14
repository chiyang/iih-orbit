import { effect, inject, Injectable, OnDestroy, signal, untracked } from '@angular/core';
import { BoardStore } from './board-store';
import { DriveBrowserConnection } from './drive-browser-connection';
import { DriveBrowserApi, isDriveFolder, sourceFromDriveEntry, type DriveBrowserEntry, type DriveBrowserFolder, type DriveBrowserPage } from './drive-browser-data';
import { DocumentMetadataCache } from './document-metadata';
import type { DocumentSource } from './models';

const ROOT: DriveBrowserFolder = {id: 'root', name: '我的雲端硬碟'};
interface CachedFolder extends DriveBrowserPage {updatedAt: number; tokens: string[]}

@Injectable({providedIn: 'root'})
export class DriveBrowser implements OnDestroy {
  readonly store = inject(BoardStore);
  readonly connection = inject(DriveBrowserConnection);
  readonly auth = this.connection.auth;
  private readonly api = new DriveBrowserApi(this.auth);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly notice = signal('');
  readonly path = signal<DriveBrowserFolder[]>([{...ROOT}]);
  readonly query = signal('');
  readonly files = signal<DriveBrowserEntry[]>([]);
  readonly nextPageToken = signal('');
  readonly metadataRevision = signal(0);
  private readonly metadata = new DocumentMetadataCache();
  private readonly cache = new Map<string, CachedFolder>();
  private context = '';
  private request = 0;
  private epoch = 0;
  private controller?: AbortController;
  private pendingConnection = 0;
  private destroyed = false;
  constructor() {
    effect(() => {const context = this.connection.context(); untracked(() => {
      if (context === this.context) return;
      this.context = context; this.epoch++; this.cancel(); this.cache.clear(); this.files.set([]); this.path.set([{...ROOT}]); this.query.set(''); this.nextPageToken.set(''); this.error.set(''); this.notice.set('');
    });});
    effect(() => {const version = this.auth.connectionVersion(), connected = this.auth.connected(); untracked(() => {if (this.controller && version !== this.pendingConnection) this.cancel(); if (version && !connected) this.notice.set(this.auth.message());});});
  }
  identity(): string {return JSON.stringify([this.context, this.auth.connectionVersion(), this.epoch]);}
  async prepare(): Promise<void> {
    if (!this.store.google().clientId) return;
    try {await this.connection.prepare();} catch (error) {this.error.set(this.message(error));}
  }
  disconnect(): void {
    this.cancel(); this.connection.disconnect(); this.epoch++; this.cache.clear(); this.files.set([]); this.path.set([{...ROOT}]); this.query.set(''); this.nextPageToken.set('');
    this.notice.set('檔案瀏覽已解除連線，任務中的資訊連結保留。');
  }
  async activate(): Promise<void> {if (this.auth.connected()) await this.load(); else void this.prepare();}
  async root(shared = false): Promise<void> {await this.load([shared ? {id: 'shared', name: '與我共用', shared: true} : {...ROOT}], '');}
  async open(file: DriveBrowserEntry): Promise<void> {
    if (!this.isListed(file) || !isDriveFolder(file)) return;
    const target = file.shortcut;
    const folder: DriveBrowserFolder = {id: target?.id ?? file.id, name: file.name, ...(!target && file.driveId ? {driveId: file.driveId} : {}), ...(target?.resourceKey || file.resourceKey ? {resourceKey: target?.resourceKey ?? file.resourceKey} : {})};
    await this.load([...this.path(), folder], '');
  }
  async back(index = this.path().length - 2): Promise<void> {if (index >= 0 && index < this.path().length) await this.load(this.path().slice(0, index + 1), '');}
  async search(query: string): Promise<void> {await this.load(this.path(), query.trim());}
  async refresh(): Promise<void> {await this.load(this.path(), this.query(), false, true);}
  async more(): Promise<void> {if (this.nextPageToken() && !this.busy()) await this.load(this.path(), this.query(), true);}
  isListed(file: DriveBrowserEntry): boolean {return this.auth.connected() && this.files().some(item => item.id === file.id && item.url === file.url);}
  source(file: DriveBrowserEntry): DocumentSource {
    if (!this.isListed(file)) throw new Error('檔案列表或連線已更新，請重新選擇。');
    return sourceFromDriveEntry(file, this.path().map(folder => folder.name).join(' / ').slice(0, 1500));
  }
  display(source: DocumentSource): {name: string; location?: string} {
    this.metadataRevision();
    return this.metadata.get(JSON.stringify([this.store.generation(), this.context]), source) ?? source;
  }
  private async load(path = this.path(), query = this.query(), append = false, force = false): Promise<void> {
    if (this.destroyed || !this.auth.connected()) return;
    this.cancel(); const request = ++this.request, identity = this.identity(), controller = new AbortController(); this.controller = controller; this.pendingConnection = this.auth.connectionVersion();
    const current = () => !this.destroyed && request === this.request && identity === this.identity() && !controller.signal.aborted;
    const folder = path[path.length - 1], key = JSON.stringify([folder, query]), previous = this.cache.get(key), token = append ? this.nextPageToken() : '';
    this.busy.set(true); this.error.set('');
    try {
      let page: DriveBrowserPage;
      if (!append && !force && previous && Date.now() - previous.updatedAt < 5 * 60000) page = previous;
      else page = await this.api.list(folder, query, token, controller.signal);
      if (!current()) return;
      const tokens = append ? [...previous?.tokens ?? [], token] : page === previous ? [...previous.tokens] : [];
      if (page.nextPageToken && (page.nextPageToken === token || tokens.includes(page.nextPageToken))) throw new Error('Drive 分頁重複，請重新整理目前資料夾。');
      const files = [...new Map([...(append ? this.files() : []), ...page.files].map(file => [file.id, file])).values()];
      if (files.length > 1000) throw new Error('此資料夾項目較多，請用檔名搜尋縮小範圍。');
      files.sort((a, b) => Number(isDriveFolder(b)) - Number(isDriveFolder(a)) || a.name.localeCompare(b.name, 'zh-Hant', {numeric: true}));
      this.path.set(structuredClone(path)); this.query.set(query); this.files.set(files); this.nextPageToken.set(page.nextPageToken);
      this.cache.delete(key); this.cache.set(key, {files, nextPageToken: page.nextPageToken, tokens, updatedAt: page === previous ? previous.updatedAt : Date.now()});
      while (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!);
      for (const file of files) {const source = this.source(file); this.metadata.set(JSON.stringify([this.store.generation(), this.context]), source, {name: file.name, location: source.location, status: 'available', checkedAt: new Date().toISOString()});}
      this.metadataRevision.update(version => version + 1);
    } catch (error) {if (current()) this.error.set(this.message(error));}
    finally {if (request === this.request) {this.busy.set(false); this.controller = undefined;}}
  }
  private cancel(): void {this.request++; this.controller?.abort(); this.controller = undefined; this.busy.set(false);}
  private message(error: unknown): string {return error instanceof Error ? error.message : '無法讀取 Drive 檔案列表，請稍後重試。';}
  ngOnDestroy(): void {this.destroyed = true; this.cancel(); }
}
