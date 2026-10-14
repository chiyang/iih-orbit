import {Component, computed, input} from '@angular/core';
import {Icon} from './icon';
import {sourceFileKind, sourceFileLabel, type SourceFileInfo} from './source-file-type';

@Component({
  selector: 'app-source-icon', imports: [Icon], host: {'aria-hidden': 'true', '[attr.data-file-type]': 'kind()', '[attr.title]': 'label()'},
  template: `@if (pageColor()) {
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 1h9l6 6v16H5z" [attr.fill]="pageColor()" /><path d="M14 1v6h6" fill="#fff" opacity=".45" />
      @switch (kind()) {
        @case ('document') {<path d="M8 11h9M8 14h9M8 17h7" fill="none" stroke="#fff" stroke-width="1.4" />}
        @case ('sheet') {<path d="M8 11h9v7H8zM8 14.5h9M12.5 11v7" fill="none" stroke="#fff" stroke-width="1.2" />}
        @case ('presentation') {<rect x="8" y="10" width="9" height="8" rx=".6" fill="#fff" /><path d="M10 16v-4h5v4z" [attr.fill]="pageColor()" />}
      }
    </svg>
  } @else if (kind() === 'notebook') {
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 7a6 6 0 1 0 0 10" fill="none" stroke="#f57c00" stroke-width="3.5" /><path d="M11 8a6 6 0 1 1 0 8" fill="none" stroke="#f9ab00" stroke-width="3.5" /></svg>
  } @else if (kind() === 'ecmx') {
    <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="9" r="8" fill="#808080" /><path d="M11.5 10.5V22l3.5-2.6 2 3.1 2.5-1.6-2-3.1 4.2-.9z" fill="#fff" stroke="#808080" stroke-width="1.25" stroke-linejoin="miter" /></svg>
  } @else {<app-icon [name]="kind() === 'pdf' ? 'filePdf' : kind() === 'image' ? 'fileImage' : kind() === 'mail' ? 'mail' : kind() === 'folder' ? 'folder' : 'file'" />}`,
  styles: ':host {display:inline-flex;width:24px;height:24px;flex-shrink:0;vertical-align:middle;color:var(--accent-text)} svg,app-icon {display:block;width:100%;height:100%}:host([data-file-type=folder]) {color:#b58947}:host([data-file-type=pdf]) {color:#cf4545}'
})
export class SourceIcon {
  readonly file = input.required<SourceFileInfo>();
  readonly kind = computed(() => sourceFileKind(this.file()));
  readonly label = computed(() => sourceFileLabel(this.file()));
  readonly pageColor = computed(() => ({document: '#4285f4', sheet: '#0f9d58', presentation: '#f4b400'} as Record<string, string>)[this.kind()] ?? '');
}
