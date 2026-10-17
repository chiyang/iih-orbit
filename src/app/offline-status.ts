import {computed, DestroyRef, inject, Injectable, isDevMode, signal} from '@angular/core';
import {BoardStore} from './board-store';

@Injectable({providedIn: 'root'})
export class OfflineStatus {
  private readonly store = inject(BoardStore);
  readonly enabled = !isDevMode();
  readonly online = signal(navigator.onLine !== false);
  readonly ready = signal(false);
  readonly updateAvailable = signal(false);
  readonly error = signal('');
  readonly localStatus = computed(() => this.store.storageLoading() ? '正在讀取本機任務…'
    : this.store.hasUnsavedChanges() || this.store.storageWarning() ? '本機保存未完成，請保留此頁並匯出備份。'
    : this.store.pendingWrites() ? '正在保存至此裝置…' : '任務已存於此裝置');
  private registration?: ServiceWorkerRegistration;

  constructor() {
    const refresh = () => {this.online.set(navigator.onLine !== false); if (this.online()) void this.check();};
    window.addEventListener('online', refresh);
    window.addEventListener('offline', refresh);
    const timer = window.setInterval(() => {if (this.online()) void this.check();}, 60 * 60 * 1000);
    inject(DestroyRef).onDestroy(() => {
      window.removeEventListener('online', refresh); window.removeEventListener('offline', refresh); clearInterval(timer);
    });
    if (this.enabled) void this.register();
  }

  async retry(): Promise<void> {await this.register();}

  private async check(): Promise<void> {
    try {await this.registration?.update();} catch { /* Existing offline release remains available. */ }
  }

  private async register(): Promise<void> {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) {
      this.error.set('此瀏覽環境無法準備離線啟動，請使用 HTTPS 與支援的瀏覽器。'); return;
    }
    this.error.set('');
    try {
      const registration = this.registration = await navigator.serviceWorker.register(new URL('sw.js', document.baseURI), {scope: new URL('.', document.baseURI).pathname, updateViaCache: 'none'});
      const inspect = () => {
        this.ready.set(registration.active?.state === 'activated');
        this.updateAvailable.set(!!registration.waiting);
      };
      const watch = () => {
        const worker = registration.installing ?? registration.waiting ?? registration.active;
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          inspect();
          if (worker.state === 'redundant') this.error.set('離線版本準備失敗，請在網路穩定時重試。');
        });
      };
      registration.addEventListener('updatefound', watch);
      inspect(); watch();
    } catch {this.error.set('離線啟動尚未準備完成，請在網路穩定時重試。');}
  }
}
