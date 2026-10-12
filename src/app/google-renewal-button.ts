import { Component, inject, output } from '@angular/core';
import { GoogleConnections } from './google-connections';

@Component({
  selector: 'app-google-renewal-button',
  template: `@if (connections.renewalNeeded() || connections.connectingAll()) {
    <button type="button" aria-label="重新授權 Google 全部服務" [title]="connections.connectingAll() ? '等待 Google 授權…' : connections.drive.runtime().pending ? 'Google 授權已到期；Drive 尚有待上傳資料，請由設定單獨連線 Drive' : 'Google 授權已到期，按一下重新授權全部服務'" [disabled]="!connections.canConnect()" [attr.aria-busy]="connections.connectingAll()" (click)="renew()"><span aria-hidden="true">G</span></button>
  }`,
  styles: `:host {display: contents;} button {display: inline-flex; align-items: center; justify-content: center; width: max(28px, calc(36px * var(--font-scale))); height: max(28px, calc(36px * var(--font-scale))); padding: 0; flex-shrink: 0; box-sizing: border-box; border: 1px solid var(--accent-border); border-radius: 7px; color: var(--accent-text); background: var(--accent-soft); font-weight: 700; font-size: var(--font-15); cursor: pointer;} button:hover {background: var(--control-bg);} button:focus-visible {outline: 2px solid var(--accent-strong); outline-offset: 3px;} button:disabled {cursor: wait; opacity: .55;}`
})
export class GoogleRenewalButton {
  readonly connections = inject(GoogleConnections);
  readonly result = output<string>();
  async renew(): Promise<void> {
    if (!this.connections.renewalNeeded() || !this.connections.canConnect()) return;
    await this.connections.connectAll();
    const message = this.connections.error() || this.connections.message();
    if (message) this.result.emit(message);
  }
}
