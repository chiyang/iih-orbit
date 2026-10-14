import { sourceDragEvent, type SourceDragPointer } from './source-drag-events.ts';

export function sourceScrollSpeed(position: number, start: number, end: number): number {
  if (end <= start || position < start - 8 || position > end + 8) return 0;
  const edge = Math.min(48, (end - start) / 3);
  if (position < start + edge) return -320 * Math.min(1, (start + edge - position) / edge);
  if (position > end - edge) return 320 * Math.min(1, (position - end + edge) / edge);
  return 0;
}

/** Scroll the innermost available view first, then the page; refresh drop geometry after scrolling. */
export function sourceDragScroll(document: Document): () => void {
  const window = document.defaultView;
  if (!window?.requestAnimationFrame || !window.cancelAnimationFrame) return () => {};
  let pointer: SourceDragPointer | undefined, frame = 0, previous = 0, stopped = false;
  let lastTarget: Element | null = null;
  const scroll = (now: number) => {
    if (stopped) return;
    const elapsed = Math.min(40, previous ? now - previous : 16) / 1000; previous = now;
    if (pointer) {
      const {clientX: x, clientY: y} = pointer, hit = document.elementFromPoint?.(x, y), main = document.querySelector('main');
      const targets = new Set<HTMLElement>();
      for (let element = hit as HTMLElement | null; element && element !== document.body; element = element.parentElement) if (main?.contains(element)) targets.add(element);
      for (const element of main?.querySelectorAll<HTMLElement>('.kanban-scroll, .list-scroll, .calendar-scroll, .week-scroll') ?? []) targets.add(element);
      let moved = false, movedX = false, movedY = false;
      for (const element of targets) {
        const bounds = element.getBoundingClientRect();
        const left = bounds.left <= 48 ? 0 : bounds.left, right = bounds.right >= window.innerWidth - 48 ? window.innerWidth : bounds.right;
        const top = Math.max(0, bounds.top), bottom = Math.min(window.innerHeight, bounds.bottom);
        if (right <= left || bottom <= top || x < left - 8 || x > right + 8 || y < top - 8 || y > bottom + 8) continue;
        const style = window.getComputedStyle(element);
        const dx = !movedX && /auto|scroll/.test(style.overflowX) && element.scrollWidth > element.clientWidth ? sourceScrollSpeed(x, left, right) * elapsed : 0;
        const sticky = element.querySelector<HTMLElement>('.week-sticky-head')?.getBoundingClientRect().height ?? 0;
        const dy = !movedY && /auto|scroll/.test(style.overflowY) && element.scrollHeight > element.clientHeight ? sourceScrollSpeed(y, Math.min(bottom, top + sticky), bottom) * elapsed : 0;
        const oldX = element.scrollLeft, oldY = element.scrollTop;
        if (dx) element.scrollLeft = Math.max(0, Math.min(element.scrollWidth - element.clientWidth, oldX + dx));
        if (dy) element.scrollTop = Math.max(0, Math.min(element.scrollHeight - element.clientHeight, oldY + dy));
        movedX ||= element.scrollLeft !== oldX; movedY ||= element.scrollTop !== oldY; moved ||= element.scrollLeft !== oldX || element.scrollTop !== oldY;
      }
      const page = document.scrollingElement;
      const mainBounds = main?.getBoundingClientRect();
      if (page && mainBounds && x >= mainBounds.left && x <= mainBounds.right) {
        const oldX = page.scrollLeft, oldY = page.scrollTop;
        if (!movedX) page.scrollLeft = Math.max(0, Math.min(Math.max(0, page.scrollWidth - window.innerWidth), oldX + sourceScrollSpeed(x, 0, window.innerWidth) * elapsed));
        if (!movedY) page.scrollTop = Math.max(0, Math.min(Math.max(0, page.scrollHeight - window.innerHeight), oldY + sourceScrollSpeed(y, 0, window.innerHeight) * elapsed));
        moved ||= page.scrollLeft !== oldX || page.scrollTop !== oldY;
      }
      if (moved) {
        const target = document.elementFromPoint?.(x, y) ?? null;
        if (target !== lastTarget) {
          lastTarget?.dispatchEvent(sourceDragEvent(document, 'dragleave', pointer, target));
          target?.dispatchEvent(sourceDragEvent(document, 'dragenter', pointer, lastTarget));
          lastTarget = target;
        }
        target?.dispatchEvent(sourceDragEvent(document, 'dragover', pointer));
      }
    }
    if (!stopped) frame = window.requestAnimationFrame(scroll);
  };
  const over = (event: DragEvent) => {
    if (!event.dataTransfer || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
    pointer = {clientX: event.clientX, clientY: event.clientY, dataTransfer: event.dataTransfer};
    lastTarget = (event.target as Element | null)?.nodeType === 1 ? event.target as Element : null;
    if (!frame) frame = window.requestAnimationFrame(scroll);
  };
  const leave = (event: DragEvent) => {if (!event.relatedTarget && (event.clientX <= 0 || event.clientY <= 0 || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight)) pointer = undefined;};
  const stop = () => {if (stopped) return; stopped = true; window.cancelAnimationFrame(frame); document.removeEventListener('dragover', over, true); document.removeEventListener('dragleave', leave, true); document.removeEventListener('dragend', stop, true); document.removeEventListener('drop', stop); window.removeEventListener('pagehide', stop);};
  document.addEventListener('dragover', over, true); document.addEventListener('dragleave', leave, true); document.addEventListener('dragend', stop, true); document.addEventListener('drop', stop); window.addEventListener('pagehide', stop);
  return stop;
}
