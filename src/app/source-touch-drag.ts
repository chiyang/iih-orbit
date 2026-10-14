import { Directive, ElementRef, inject, input, OnDestroy } from '@angular/core';
import { sourceDataTransfer, sourceDragEvent, type SourceDragPointer } from './source-drag-events';

/** A short tap and ordinary scrolling stay native; holding a source starts the existing drop contract. */
export function touchSourceDrag(element: HTMLElement, enabled: () => boolean): () => void {
  const document = element.ownerDocument, window = document.defaultView;
  if (!window?.requestAnimationFrame || !window.cancelAnimationFrame) return () => {};
  let touchId: number | undefined, origin = {x: 0, y: 0}, pointer: SourceDragPointer | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined, frame = 0, active = false, previousDraggable: string | null = null, ignoreClickUntil = 0;
  let lastTarget: Element | null = null, moved = false;
  const hover = () => {
    if (!active || !pointer) return false;
    const target = document.elementFromPoint?.(pointer.clientX, pointer.clientY);
    if (target !== lastTarget) {
      lastTarget?.dispatchEvent(sourceDragEvent(document, 'dragleave', pointer, target));
      target?.dispatchEvent(sourceDragEvent(document, 'dragenter', pointer, lastTarget));
      lastTarget = target;
    }
    if (!target) return false;
    const event = sourceDragEvent(document, 'dragover', pointer);
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const reset = () => {
    clearTimeout(timer); timer = undefined; window.cancelAnimationFrame(frame); frame = 0;
    document.removeEventListener('touchmove', move, true); document.removeEventListener('touchend', end, true); document.removeEventListener('touchcancel', cancel, true);
    document.removeEventListener('keydown', keydown); window.removeEventListener('pagehide', cancel);
    if (touchId !== undefined) {if (previousDraggable === null) element.removeAttribute('draggable'); else element.setAttribute('draggable', previousDraggable);}
    element.classList.remove('source-touch-active'); touchId = undefined; lastTarget = null;
  };
  const finish = (drop: boolean) => {
    const started = active, payload = pointer;
    const accepted = drop && moved && hover(), target = accepted && payload ? document.elementFromPoint?.(payload.clientX, payload.clientY) : null;
    active = false; pointer = undefined; reset();
    if (started && payload) {
      ignoreClickUntil = Date.now() + 400;
      if (target) target.dispatchEvent(sourceDragEvent(document, 'drop', payload));
      (element.isConnected ? element : document).dispatchEvent(sourceDragEvent(document, 'dragend', payload));
    }
  };
  const move = (event: TouchEvent) => {
    if (touchId === undefined) return;
    if (event.touches.length !== 1 || !enabled()) {finish(false); return;}
    const touch = Array.from(event.touches).find(touch => touch.identifier === touchId);
    if (!touch) {finish(false); return;}
    if (!active) {if (Math.hypot(touch.clientX - origin.x, touch.clientY - origin.y) > 8) finish(false); return;}
    event.preventDefault();
    moved ||= Math.hypot(touch.clientX - origin.x, touch.clientY - origin.y) > 8;
    pointer = {...pointer!, clientX: touch.clientX, clientY: touch.clientY}; hover();
  };
  const end = (event: TouchEvent) => {
    if (touchId === undefined || !Array.from(event.changedTouches).some(touch => touch.identifier === touchId)) return;
    if (active && !enabled()) {event.preventDefault(); finish(false); return;}
    if (active) {
      event.preventDefault(); const touch = Array.from(event.changedTouches).find(touch => touch.identifier === touchId)!;
      moved ||= Math.hypot(touch.clientX - origin.x, touch.clientY - origin.y) > 8;
      pointer = {...pointer!, clientX: touch.clientX, clientY: touch.clientY};
    }
    finish(true);
  };
  const cancel = () => finish(false);
  const keydown = (event: KeyboardEvent) => {if (event.key === 'Escape' && active) {event.preventDefault(); event.stopPropagation(); finish(false);}};
  const click = (event: MouseEvent) => {if (event.detail && Date.now() < ignoreClickUntil) {event.preventDefault(); event.stopImmediatePropagation();}};
  const contextmenu = (event: Event) => {if (touchId !== undefined) event.preventDefault();};
  const start = (event: TouchEvent) => {
    if (touchId !== undefined || event.touches.length !== 1 || !enabled()) return;
    const target = event.target as Element | null, control = target?.closest('button, a, input, textarea, select, summary, [contenteditable]');
    if (control && !control.hasAttribute('data-source-drag-handle')) return;
    const touch = event.touches[0]; touchId = touch.identifier; origin = {x: touch.clientX, y: touch.clientY}; moved = false;
    previousDraggable = element.getAttribute('draggable'); element.setAttribute('draggable', 'false');
    document.addEventListener('touchmove', move, {capture: true, passive: false}); document.addEventListener('touchend', end, {capture: true, passive: false});
    document.addEventListener('touchcancel', cancel, true); document.addEventListener('keydown', keydown); window.addEventListener('pagehide', cancel);
    timer = setTimeout(() => {
      if (!enabled() || !element.isConnected) {finish(false); return;}
      pointer = {clientX: origin.x, clientY: origin.y, dataTransfer: sourceDataTransfer(document)};
      const event = sourceDragEvent(document, 'dragstart', pointer);
      element.dispatchEvent(event);
      if (event.defaultPrevented || !pointer.dataTransfer.types.length) {finish(false); return;}
      active = true; element.classList.add('source-touch-active'); frame = window.requestAnimationFrame(() => {frame = 0; hover();});
    }, 420);
  };
  element.classList.add('source-touch-ready'); element.addEventListener('touchstart', start, {passive: false});
  element.addEventListener('click', click, true); element.addEventListener('contextmenu', contextmenu);
  return () => {finish(false); element.classList.remove('source-touch-ready'); element.removeEventListener('touchstart', start); element.removeEventListener('click', click, true); element.removeEventListener('contextmenu', contextmenu);};
}

@Directive({selector: '[appSourceTouchDrag]'})
export class SourceTouchDrag implements OnDestroy {
  readonly appSourceTouchDrag = input(true);
  private readonly stop = touchSourceDrag(inject<ElementRef<HTMLElement>>(ElementRef).nativeElement, () => this.appSourceTouchDrag());
  ngOnDestroy(): void {this.stop();}
}
