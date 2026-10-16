/** Keep Tab as indentation, with an explicit Escape-then-Tab route out. */
export class DescriptionKeyboard {
  private leaveOnTab = false;
  reset(): void {this.leaveOnTab = false;}
  handle(event: KeyboardEvent, limit = 20000): string | undefined {
    const field = event.target as HTMLTextAreaElement;
    if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'Escape') {
      this.leaveOnTab = true;
      event.preventDefault(); event.stopPropagation(); return;
    }
    if (event.key !== 'Tab') {this.leaveOnTab = false; return;}
    if (this.leaveOnTab) {this.leaveOnTab = false; return;}
    event.preventDefault(); event.stopPropagation();
    const text = field.value, start = field.selectionStart, end = field.selectionEnd;
    if (!event.shiftKey && start === end) {
      if (text.length + 2 > limit) return;
      field.setRangeText('  ', start, end, 'end'); return field.value;
    }
    const lineStart = start === 0 ? 0 : text.lastIndexOf('\n', start - 1) + 1;
    const last = end > start && text[end - 1] === '\n' ? end - 1 : end;
    const newline = text.indexOf('\n', last), lineEnd = newline < 0 ? text.length : newline;
    const lines = text.slice(lineStart, lineEnd).split('\n');
    const changes = lines.map(line => event.shiftKey ? -(line.startsWith('\t') ? 1 : /^ {1,2}/.exec(line)?.[0].length ?? 0) : 2);
    const replacement = lines.map((line, index) => changes[index] < 0 ? line.slice(-changes[index]) : ' '.repeat(changes[index]) + line).join('\n');
    if (text.length + replacement.length - (lineEnd - lineStart) > limit) return;
    const delta = changes.reduce((total, value) => total + value, 0);
    field.setRangeText(replacement, lineStart, lineEnd, 'preserve');
    field.setSelectionRange(Math.max(lineStart, start + changes[0]), Math.max(lineStart, end + delta));
    return field.value;
  }
}
