import { Component, computed, input, ViewEncapsulation } from '@angular/core';
import { renderMarkdown, sanitizeMailHtml } from './rich-content-data';

@Component({
  selector: 'app-rich-content',
  template: `@if (plain()) {<span>{{ plainText() }}</span>} @else {<div class="orbit-rich-content" [class.mail-rich-content]="format() === 'html'" [innerHTML]="html()"></div>}`,
  styleUrls: ['./rich-content.css', './document-dialog.css'],
  encapsulation: ViewEncapsulation.None
})
export class RichContent {
  readonly value = input('');
  readonly format = input<'markdown' | 'html'>('markdown');
  readonly plain = input(false);
  readonly html = computed(() => this.format() === 'html' ? sanitizeMailHtml(this.value()) : renderMarkdown(this.value()));
  readonly plainText = computed(() => { const template = document.createElement('template'); template.innerHTML = this.html(); return template.content.textContent ?? ''; });
}
