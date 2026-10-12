import { Component, computed, inject, output } from '@angular/core';
import { GoogleConnections } from './google-connections';
import { Icon } from './icon';
import { Tooltip } from './tooltip';

@Component({
  selector: 'app-cloud-logout-button', imports: [Icon, Tooltip], styleUrl: './toolbar-icon-button.css',
  template: `@if (visible()) {
    <button type="button" [disabled]="connections.busy() || !connections.drive.online() || !connections.drive.auth.connected()" [attr.aria-busy]="connections.loggingOut()" [appTooltip]="connections.loggingOut() ? '正在同步備份，完成後會清除本機資料…' : '同步並登出：先備份全部資料，再清除本機內容'" aria-label="同步並登出" (click)="request.emit()"><app-icon [name]="connections.loggingOut() ? 'sync' : 'logout'" [class.spinning]="connections.loggingOut()" /></button>
  }`
})
export class CloudLogoutButton {
  readonly connections = inject(GoogleConnections);
  readonly request = output<void>();
  readonly visible = computed(() => !this.connections.store.cloudResume() && !!this.connections.drive.runtime().link && !!this.connections.store.drive().accountId);
}
