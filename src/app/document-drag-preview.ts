import type { DocumentSource } from './models.ts';

export function createDocumentDragPreview(event: DragEvent, source: DocumentSource, onEnd: () => void): () => void {
  const element = (event.currentTarget || event.target) as HTMLElement | null, document = element?.ownerDocument, window = document?.defaultView;
  if (!document?.body || !window) return () => {};
  const preview = document.createElement('div'), mask = document.createElement('canvas');
  preview.className = 'document-drag-preview'; preview.setAttribute('aria-hidden', 'true'); preview.textContent = source.name;
  mask.width = mask.height = 1; mask.className = 'document-drag-mask'; document.body.append(mask, preview);
  const move = (pointer: DragEvent) => {
    if (!Number.isFinite(pointer.clientX) || !Number.isFinite(pointer.clientY)) return;
    const width = preview.offsetWidth || 240, height = preview.offsetHeight || 44;
    const left = pointer.clientX + width + 26 > window.innerWidth ? pointer.clientX - width - 18 : pointer.clientX + 18;
    const top = pointer.clientY + height + 28 > window.innerHeight ? pointer.clientY - height - 20 : pointer.clientY + 20;
    const x = Math.max(8, Math.min(left, window.innerWidth - width - 8)), y = Math.max(8, Math.min(top, window.innerHeight - height - 8));
    preview.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
  };
  let finished = false;
  const cleanup = () => {if (finished) return; finished = true; document.removeEventListener('dragover', move, true); document.removeEventListener('dragend', end, true); document.removeEventListener('drop', cleanup); window.removeEventListener('pagehide', end); preview.remove(); mask.remove();};
  const end = () => {cleanup(); onEnd();};
  document.addEventListener('dragover', move, true); document.addEventListener('dragend', end, true); document.addEventListener('drop', cleanup); window.addEventListener('pagehide', end); move(event);
  try {event.dataTransfer?.setDragImage(mask, 0, 0);} catch { /* The visible preview remains usable. */ }
  return cleanup;
}
