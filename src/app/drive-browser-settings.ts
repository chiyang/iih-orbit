import {Component, computed, effect, inject, OnDestroy, output, untracked} from '@angular/core';
import {DriveBrowser} from './drive-browser';
import {GoogleConnections} from './google-connections';

@Component({
  selector: 'app-drive-browser-settings', styleUrls: ['./google-settings.css', './google-connection.css'],
  template: `<h3>Google Drive</h3>
    <p>管理右側檔案側欄與任務資訊連結的檔案瀏覽。只讀取檔名、位置與連結。</p>
    <section class="google-service" aria-labelledby="drive-files-settings-title">
      <div class="service-heading"><h4 id="drive-files-settings-title">檔案瀏覽連線</h4><span [class.connected]="files.auth.connected()">{{ files.auth.connected() ? '已連線' : files.auth.expired() ? '授權已到期' : '尚未連線' }}</span></div>
      @if (files.account().email) {<p class="service-account">{{ files.account().email }}</p>}
      <p>檔案側欄與選檔視窗共用授權，各自保留瀏覽位置。</p>
      <div class="google-actions">
        @if (files.store.google().clientId) {
          <button type="button" class="google-primary" [disabled]="busy() || !files.auth.ready()" (click)="connect()">{{ files.connecting() ? '等待授權…' : files.auth.connected() ? '切換帳號／重新授權' : files.auth.expired() ? '重新連線檔案瀏覽' : '連線檔案瀏覽' }}</button>
          @if (!files.auth.ready()) {<button type="button" [disabled]="files.auth.preparing() || busy()" (click)="prepare()">{{ files.auth.preparing() ? '準備連線…' : '重新準備連線' }}</button>}
        }
        @if (files.auth.connected()) {<button type="button" [disabled]="busy()" (click)="browser.disconnect()">解除檔案瀏覽連線</button>}
        <button type="button" [disabled]="busy()" (click)="configure.emit()">Google 連線設定</button>
      </div>
      @if (!files.store.google().clientId) {<p class="google-note">請先到 Google 連線設定保存 Client ID，也可在該頁一次授權全部服務。</p>}
      @if (files.error()) {<p class="google-error" role="alert">{{ files.error() }}</p>}
      @if (files.warning() || files.auth.sessionWarning()) {<p class="google-note" role="status">{{ files.warning() || files.auth.sessionWarning() }}</p>}
      @if (!files.auth.connected() && files.auth.message()) {<p class="google-status" role="status">{{ files.auth.message() }}</p>}
    </section>
    <p class="google-note">瀏覽時會排除 Orbit 備份使用的「IIH Orbit」資料夾。</p>`
})
export class DriveBrowserSettings implements OnDestroy {
  readonly connections = inject(GoogleConnections);
  readonly files = this.connections.files;
  readonly browser = inject(DriveBrowser);
  readonly configure = output<void>();
  readonly busy = computed(() => this.connections.busy());
  private startedConsent = false;
  constructor() {
    effect(() => {const clientId = this.files.store.google().clientId; untracked(() => {if (clientId) void this.prepare();});});
  }
  async prepare(): Promise<void> {
    try {await this.files.prepare();}
    catch (error) {this.files.error.set(error instanceof Error ? error.message : '無法準備 Google Drive 連線。');}
  }
  async connect(): Promise<void> {
    if (this.busy()) return;
    this.startedConsent = true;
    try {await this.files.connect();}
    finally {this.startedConsent = false;}
  }
  ngOnDestroy(): void {if (this.startedConsent) this.files.cancelAuthorization();}
}
