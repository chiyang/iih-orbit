import { A11yModule } from '@angular/cdk/a11y';
import { afterRenderEffect, Component, computed, DestroyRef, ElementRef, inject, output, signal, viewChild } from '@angular/core';
import { GoogleConnections } from './google-connections';

@Component({
  selector: 'app-cloud-logout-confirm', imports: [A11yModule],
  template: `<div class="modal-body"><p>是否要同步備份並登出？</p><p>會先把全部工作空間備份到雲端，確認成功後清除這台瀏覽器的工作資料、設定與 Google 連線，回到空白工作介面。</p><p>保留 Client ID 與雲端集合識別，下次可按頁首 G 授權並接回原資料。</p>
    @if (stale()) {<p class="form-error" role="alert">連線或雲端集合已變更，請關閉後重新確認。</p>}
    @if (error()) {<p class="form-error" role="alert">{{ error() }}</p>}
    @if (connections.loggingOut()) {<p role="status">正在同步備份與清理資料，請等候完成…</p>}
  </div><div class="modal-footer"><span class="form-note">同步或備份失敗時會保留本機資料。</span><div><button #cancel class="button secondary" cdkFocusInitial [disabled]="busy()" (click)="close.emit()">取消</button><button class="button primary" [disabled]="!canConfirm()" (click)="confirm()">{{ busy() ? '同步並登出中…' : '確認同步並登出' }}</button></div></div>`,
  styleUrl: './cloud-logout-confirm.css'
})
export class CloudLogoutConfirm {
  readonly connections = inject(GoogleConnections);
  private readonly destroyRef = inject(DestroyRef);
  readonly close = output<void>();
  readonly result = output<string>();
  readonly busyChange = output<boolean>();
  readonly busy = signal(false);
  readonly error = signal('');
  private readonly cancel = viewChild<ElementRef<HTMLButtonElement>>('cancel');
  private readonly context = this.configuration();
  readonly stale = computed(() => !this.busy() && this.context !== this.configuration());
  readonly canConfirm = computed(() => !this.busy() && !this.stale() && !this.connections.busy() && this.connections.drive.online() && this.connections.drive.auth.connected() && !!this.connections.drive.runtime().link && !this.connections.store.cloudResume());
  constructor() {let focused = false; afterRenderEffect(() => {const cancel = this.cancel(); if (cancel && !focused) {focused = true; cancel.nativeElement.focus();}});}
  private configuration(): string {return JSON.stringify([this.connections.store.generation(), this.connections.store.google().clientId, this.connections.store.drive().accountId, this.connections.drive.runtime().link?.datasetId]);}
  async confirm(): Promise<void> {
    if (!this.canConfirm()) return;
    this.busy.set(true); this.busyChange.emit(true); this.error.set('');
    try {
      await this.connections.logout();
      if (this.destroyRef.destroyed) return;
      const error = this.connections.error() || this.connections.cleanupError();
      if (error) {this.error.set(error); return;}
      if (this.connections.store.cloudResume()) {this.busy.set(false); this.busyChange.emit(false); this.result.emit(this.connections.message()); this.close.emit();}
      else this.error.set('登出尚未完成，請稍後再試。');
    } catch (error) {if (!this.destroyRef.destroyed) this.error.set(error instanceof Error ? error.message : '登出未完成，請稍後再試。');}
    finally {this.busy.set(false); if (!this.destroyRef.destroyed) this.busyChange.emit(false);}
  }
}
