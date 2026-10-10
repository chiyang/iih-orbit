import { Component, ElementRef, input, linkedSignal, output, viewChild } from '@angular/core';
import { RichContent } from './rich-content';

@Component({
  selector: 'app-markdown-editor', imports: [RichContent],
  templateUrl: './markdown-editor.html', styleUrl: './markdown-editor.css'
})
export class MarkdownEditor {
  readonly value = input('');
  readonly initialMode = input<'edit' | 'preview'>('edit');
  readonly expanded = input(false);
  readonly valueChange = output<string>();
  readonly expandedChange = output<boolean>();
  readonly mode = linkedSignal(() => this.initialMode());
  readonly textarea = viewChild<ElementRef<HTMLTextAreaElement>>('source');
  readonly focusControl = viewChild<ElementRef<HTMLButtonElement>>('focusControl');
  readonly limit = 20000;
  change(event: Event): void { this.valueChange.emit((event.target as HTMLTextAreaElement).value); }
  setExpanded(value: boolean): void { this.expandedChange.emit(value); if (!value) this.focusControl()?.nativeElement.focus(); }
  insert(kind: 'bold' | 'heading' | 'list' | 'link'): void {
    const field = this.textarea()?.nativeElement; if (!field) return;
    const start = field.selectionStart, end = field.selectionEnd, chosen = field.value.slice(start, end);
    const templates = {bold: ['**', chosen || '重點文字', '**'], heading: ['## ', chosen || '段落標題', ''], list: ['- ', chosen || '清單項目', ''], link: ['[', chosen || '連結文字', '](https://example.com)']};
    const [before, text, after] = templates[kind], prefix = kind === 'heading' || kind === 'list' ? start > 0 && field.value[start - 1] !== '\n' ? '\n' : '' : '';
    const addition = prefix + before + text + after, next = field.value.slice(0, start) + addition + field.value.slice(end);
    if (next.length > this.limit) return;
    field.setRangeText(addition, start, end, 'end'); this.valueChange.emit(next);
    field.focus(); field.setSelectionRange(start + prefix.length + before.length, start + prefix.length + before.length + text.length);
  }
}
