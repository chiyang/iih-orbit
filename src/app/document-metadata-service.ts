import {DOCUMENT} from '@angular/common';
import {computed, effect, inject, Injectable, OnDestroy, signal, untracked} from '@angular/core';
import {BoardStore} from './board-store';
import {DriveBrowserConnection} from './drive-browser-connection';
import {DRIVE_BROWSER_SCOPE, DriveBrowserApi, type DriveBrowserEntry, type DriveBrowserFolder} from './drive-browser-data';
import {DEFAULT_DRIVE_SOURCE} from './drive-source-data';
import {DocumentMetadataManager} from './document-metadata-manager';
import type {DocumentSource} from './models';

interface ListCaches {stats(): {lists: number; expired: number}; clear(expiredOnly: boolean): number}
interface VisibleReference {element: Element; source: DocumentSource; preferred: string; visible: boolean}

@Injectable({providedIn: 'root'})
export class DocumentMetadataService implements OnDestroy {
  readonly connections = inject(DriveBrowserConnection);
  private readonly store = inject(BoardStore);
  private readonly document = inject(DOCUMENT);
  readonly revision = signal(0);
  readonly contextRevision = signal(0);
  readonly notice = signal('');
  readonly manualBusy = signal(false);
  readonly online = signal(this.document.defaultView?.navigator.onLine !== false);
  readonly manager = new DocumentMetadataManager(() => this.revision.update(value => value + 1));
  private readonly listCaches = new Set<ListCaches>();
  private readonly references = new Set<VisibleReference>();
  private readonly observed = new Map<Element, Set<VisibleReference>>();
  private observer?: IntersectionObserver;
  private queued = false;
  private destroyed = false;
  private readonly wake = () => {
    this.online.set(this.document.defaultView?.navigator.onLine !== false);
    this.manager.setEnvironment(this.online(), this.document.visibilityState !== 'hidden');
    this.requestVisible();
  };
  private readonly timer = setInterval(() => {this.revision.update(value => value + 1); this.wake();}, 60000);
  readonly stats = computed(() => {
    this.revision(); const metadata = this.manager.stats(), lists = [...this.listCaches].map(cache => cache.stats());
    return {...metadata, lists: lists.reduce((sum, cache) => sum + cache.lists, 0), expired: metadata.expired + lists.reduce((sum, cache) => sum + cache.expired, 0)};
  });
  constructor() {
    effect(() => {
      const generation = this.store.generation();
      const connections = this.connections.sources().map(source => ({id: source.id, key: JSON.stringify([generation, source.id, source.context(), DRIVE_BROWSER_SCOPE]),
        label: source.id === DEFAULT_DRIVE_SOURCE ? 'Google Drive' : source.name(), available: source.auth.connected() && !source.connecting() && !source.auth.authorizing(),
        version: source.auth.connectionVersion(), api: new DriveBrowserApi(source.auth)}));
      untracked(() => {this.manager.setConnections(connections); this.contextRevision.update(value => value + 1); this.requestVisible();});
    });
    this.document.addEventListener('visibilitychange', this.wake);
    this.document.defaultView?.addEventListener('online', this.wake);
    this.document.defaultView?.addEventListener('offline', this.wake);
    this.wake();
  }
  view(source: DocumentSource, preferred = '') {this.revision(); return this.manager.view(source, preferred);}
  display(source: DocumentSource, preferred = ''): DocumentSource {return this.view(source, preferred).source;}
  entry(connectionId: string, id: string) {this.revision(); return this.manager.entry(connectionId, id);}
  visibleIn(connectionId: string, id: string, folder: DriveBrowserFolder): boolean {this.revision(); return this.manager.visibleIn(connectionId, id, folder);}
  observeList(connectionId: string, files: readonly DriveBrowserEntry[], folder: DriveBrowserFolder, at: number, cached = false): void {this.manager.observeList(connectionId, files, folder, at, cached); this.requestVisible();}
  watch(element: Element, source: DocumentSource, preferred: string): {visible(value: boolean): void; stop(): void} {
    const entry = {element, source, preferred, visible: false}; this.references.add(entry);
    if (!this.observed.has(element)) this.observed.set(element, new Set()); this.observed.get(element)!.add(entry);
    const Observer = this.document.defaultView?.IntersectionObserver as typeof IntersectionObserver | undefined;
    if (Observer) {
      this.observer ??= new Observer(entries => {
        for (const state of entries) for (const reference of this.observed.get(state.target) ?? []) reference.visible = state.isIntersecting;
        this.requestVisible();
      });
      this.observer.observe(element);
    } else {const bounds = element.getBoundingClientRect(); entry.visible = bounds.height > 0 && bounds.bottom > 0 && bounds.top < (this.document.defaultView?.innerHeight ?? 0); if (entry.visible) this.requestVisible();}
    return {visible: value => {entry.visible = value; if (value) this.requestVisible();}, stop: () => {
      this.references.delete(entry); const observed = this.observed.get(element); observed?.delete(entry);
      if (!observed?.size) {this.observer?.unobserve(element); this.observed.delete(element);}
    }};
  }
  private requestVisible(): void {
    if (this.destroyed || this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false; if (this.destroyed) return;
      const groups = new Map<string, DocumentSource[]>();
      for (const entry of this.references) if (entry.visible) {if (!groups.has(entry.preferred)) groups.set(entry.preferred, []); groups.get(entry.preferred)!.push(entry.source);}
      for (const [preferred, sources] of groups) void this.manager.refresh(sources, preferred);
    });
  }
  async refreshVisible(element: Element, preferred = ''): Promise<void> {
    const sources = [...this.references].filter(entry => entry.visible && element.contains(entry.element)).map(entry => entry.source);
    if (!sources.some(source => source.provider === 'google-drive' && source.fileId)) {this.notice.set('目前沒有可查驗的可見 Drive 連結。捲動到連結後可再更新。'); return;}
    await this.refresh(sources, preferred);
  }
  async refresh(sources: readonly DocumentSource[], preferred = ''): Promise<void> {
    if (this.manualBusy()) return;
    if (!this.online()) {this.notice.set('目前離線，連線後可再更新連結資訊。'); return;}
    if (preferred && !this.connections.sources().some(source => source.id === preferred && source.auth.connected() && !source.connecting())) {this.notice.set('所選查驗來源尚未連線，請先連線／重新授權，或改選其他來源。'); return;}
    if (!this.connections.sources().some(source => source.auth.connected() && !source.connecting())) {this.notice.set('請先連線一個 Google Drive 檔案來源，再更新連結資訊。'); return;}
    this.manualBusy.set(true); this.notice.set('正在更新可見連結的名稱、位置與存取狀態…');
    try {
      await this.manager.refresh(sources, preferred, true);
      const states = sources.filter(source => source.provider === 'google-drive' && source.fileId).map(source => this.manager.view(source, preferred));
      const available = states.filter(state => state.status === 'available').length, limited = states.filter(state => state.status === 'limited').length;
      const alternate = states.filter(state => state.alternate).length;
      this.notice.set(`查驗已結束：${available} 項可存取，${states.length - available} 項請查看狀態。${alternate ? `${alternate} 項所選來源查驗未完成，保留其他來源資訊。` : ''}${limited ? '配額限制尚未解除，請稍後再試。' : ''}`);
    }
    finally {this.manualBusy.set(false);}
  }
  async reconnect(id: string): Promise<void> {
    const source = this.connections.sources().find(source => source.id === id);
    if (!source || !source.clientId()) {this.notice.set('請先在「設定 → Google Drive」完成來源連線。'); return;}
    if (source.connecting() || source.auth.authorizing()) return;
    try {if (!source.auth.ready()) await source.prepare(); if (await source.connect()) this.requestVisible(); else this.notice.set(source.error() || '來源授權尚未完成，請再試一次。');}
    catch {this.notice.set('來源連線未完成，請到 Google Drive 設定重試。');}
  }
  registerListCaches(cache: ListCaches): () => void {this.listCaches.add(cache); this.touchCaches(); return () => {this.listCaches.delete(cache); this.touchCaches();};}
  touchCaches(): void {this.revision.update(value => value + 1);}
  clear(expiredOnly = false): void {
    const removed = this.manager.clear(expiredOnly) + [...this.listCaches].reduce((sum, cache) => sum + cache.clear(expiredOnly), 0);
    this.notice.set(`已清除 ${removed} 筆${expiredOnly ? '過期' : '可重建'}快取。任務內容與來源連線保留。`); this.touchCaches();
  }
  ngOnDestroy(): void {
    this.destroyed = true; clearInterval(this.timer); this.manager.destroy(); this.observer?.disconnect(); this.references.clear(); this.observed.clear(); this.listCaches.clear();
    this.document.removeEventListener('visibilitychange', this.wake); this.document.defaultView?.removeEventListener('online', this.wake); this.document.defaultView?.removeEventListener('offline', this.wake);
  }
}
