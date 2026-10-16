import {DatePipe} from '@angular/common';
import {Component, computed, inject, input} from '@angular/core';
import type {DocumentSource} from './models';
import {DocumentMetadataService} from './document-metadata-service';
import {DocumentMetadataVisible} from './document-metadata-visible';

@Component({
  selector: 'app-document-link-status', imports: [DatePipe, DocumentMetadataVisible],
  styles: [`:host{display:block;margin-top:var(--sp6)}.metadata-status{display:grid;gap:var(--sp4);font-size:var(--font-9);line-height:1.6;color:var(--text-soft);overflow-wrap:anywhere}.metadata-warning{color:var(--warning-text)}.metadata-line{display:flex;flex-wrap:wrap;gap:var(--sp6)}button{justify-self:start;cursor:pointer;border:1px solid var(--border);border-radius:5px;background:var(--surface);color:var(--text-muted);padding:var(--sp4) var(--sp7);font:inherit}button:focus-visible{outline:2px solid var(--accent-text);outline-offset:2px}button:disabled{opacity:.5}`],
  template: `@let state = status();<div class="metadata-status" [class.metadata-warning]="state.status === 'trashed' || state.status === 'unavailable'" [appDocumentMetadata]="source()" [metadataSource]="preferred()">
    <div class="metadata-line"><span>{{ state.checking ? '正在查驗…' : state.label }}@if (state.connectionLabel && state.status !== 'unsupported') { · {{ state.connectionLabel }}}</span>@if (state.checkedAt) {<time [attr.datetime]="state.checkedAt | date:'yyyy-MM-ddTHH:mm:ssZZZZZ'" [title]="'上次查驗：' + (state.checkedAt | date:'yyyy/MM/dd HH:mm:ss')">{{ state.checkedAt | date:'MM/dd HH:mm' }}</time>}</div>
    @if (state.partialLocation) {<span>無法確認完整路徑</span>}
    @if (state.pathNote) {<span>{{ state.pathNote }}</span>}
    @if (state.alternate) {<span>{{ state.alternate }}</span>}
    @if (state.status === 'authorization') {<button type="button" (click)="metadata.reconnect(state.connectionId || preferred() || 'default')">連線／重新授權此來源</button>}
    @else if (state.status === 'error' || state.status === 'unavailable' || state.status === 'limited' || state.stale) {<button type="button" [disabled]="state.checking || metadata.manualBusy() || !metadata.online()" (click)="metadata.refresh([source()], preferred())">重新查驗</button>}
  </div>`
})
export class DocumentLinkStatus {
  readonly metadata = inject(DocumentMetadataService);
  readonly source = input.required<DocumentSource>();
  readonly preferred = input('');
  readonly status = computed(() => this.metadata.view(this.source(), this.preferred()));
}
