import { Component, DestroyRef, inject, output } from '@angular/core';
import { GoogleConnections } from './google-connections';
import { Tooltip } from './tooltip';

@Component({
  selector: 'app-google-renewal-button', imports: [Tooltip],
  template: `@if (connections.renewalVisible()) {
    <button type="button" [attr.aria-label]="connections.store.cloudResume() ? '登入 Google 並同步原本的雲端資料' : '重新授權 Google 全部服務'" [appTooltip]="connections.cleaning() ? '正在清理本機資料…' : connections.resuming() ? '正在取回雲端資料…' : connections.connectingAll() ? '等待 Google 授權…' : connections.store.cloudResume() ? '登入 Google，接回原本的雲端資料' : connections.drive.runtime().pending ? 'Google 授權已到期；Drive 尚有待上傳資料，請由設定單獨連線 Drive' : 'Google 授權已到期，按一下重新授權全部服務'" [disabled]="!connections.canConnect()" [attr.aria-busy]="connections.busy()" (click)="renew()"><span aria-hidden="true">G</span></button>
  }`,
  styles: `:host {display: contents;} button {display: inline-flex; align-items: center; justify-content: center; width: max(28px, calc(36px * var(--font-scale))); height: max(28px, calc(36px * var(--font-scale))); padding: 0; flex-shrink: 0; box-sizing: border-box; border: 1px solid var(--accent-border); border-radius: 7px; color: var(--accent-text); background: var(--accent-soft); font-weight: 700; font-size: var(--font-15); cursor: pointer;} button:hover {background: var(--control-bg);} button:focus-visible {outline: 2px solid var(--accent-strong); outline-offset: 3px;} button:disabled {cursor: wait; opacity: .55;}`
})
export class GoogleRenewalButton {
  readonly connections = inject(GoogleConnections);
  private readonly destroyRef = inject(DestroyRef);
  readonly result = output<string>();
  async renew(): Promise<void> {
    if (!this.connections.authorizationNeeded() || !this.connections.canConnect()) return;
    await this.connections.connectAll(true);
    const message = this.connections.error() || this.connections.message();
    if (message && !this.destroyRef.destroyed) this.result.emit(message);
  }
}
