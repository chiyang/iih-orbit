import { DatePipe } from '@angular/common';
import { Component, inject } from '@angular/core';
import { GoogleConnections } from './google-connections';

@Component({
  selector: 'app-cloud-resume-notice', imports: [DatePipe],
  template: `@if (connections.store.cloudResume()) {
    @if (connections.cleanupError()) {
      <section role="alert"><p>{{ connections.cleanupError() }}</p><button [disabled]="connections.cleaning()" (click)="connections.cleanupLogout()">重試清理本機資料</button></section>
    }
    @if (connections.resumeChoices().length) {
      <section aria-label="選擇雲端內容"><strong>原本的雲端資料有多份不同內容，請選擇要使用的版本。</strong>
      @if (connections.error()) {<p role="alert">{{ connections.error() }}</p>}
      <div class="choices">@for (file of connections.resumeChoices(); track file.id) {
        <button [disabled]="connections.busy() || !connections.drive.online() || !connections.drive.auth.connected()" (click)="connections.resumeCloud(file)"><strong>{{ file.createdTime | date:'yyyy/MM/dd HH:mm:ss' }}</strong><span>{{ file.summary?.workspaces ?? '?' }} 個工作空間 · {{ file.summary?.tasks ?? '?' }} 個任務</span><span>使用這份雲端內容</span></button>
      }</div></section>
    }
  }`,
  styles: `:host {display: block;} section {margin: 16px 24px; padding: 16px; border: 1px solid var(--warning-border); border-radius: 8px; background: var(--warning-bg); color: var(--text); font-size: var(--font-14);} p {line-height: 1.7;} button {border: 1px solid var(--accent-border); border-radius: 7px; padding: 10px; color: var(--accent-text); background: var(--accent-soft); font: inherit; cursor: pointer;} button:disabled {cursor: wait; opacity: .55;} .choices {display: flex; flex-wrap: wrap; gap: 12px; margin-top: 12px;} .choices button {display: grid; gap: 6px; text-align: left;} .choices span {font-size: var(--font-13);}`
})
export class CloudResumeNotice {
  readonly connections = inject(GoogleConnections);
}
