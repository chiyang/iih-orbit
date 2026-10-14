import type { MailPreview } from './gmail-data';
import { sourceDragScroll } from './source-drag-scroll.ts';

// Render the card in the page; native drag-image snapshots vary between browsers.
export function createMailDragPreview(event: DragEvent, mail: MailPreview, onEnd?: () => void): () => void {
  const source = (event.currentTarget || event.target) as HTMLElement | null;
  const document = source?.ownerDocument, window = document?.defaultView;
  if (!document?.body || !window) return () => {};
  const preview = document.createElement('div'), mask = document.createElement('canvas');
  preview.className = 'mail-drag-preview'; preview.setAttribute('aria-hidden', 'true');
  mask.className = 'mail-drag-native-image'; mask.width = 1; mask.height = 1; mask.setAttribute('aria-hidden', 'true');
  const style = window.getComputedStyle(source!);
  preview.style.fontFamily = style.fontFamily;
  preview.style.fontSize = `${Math.min(16, Math.max(14, parseFloat(style.fontSize) || 14))}px`;
  const heading = document.createElement('div'), sender = document.createElement('strong');
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  heading.className = 'mail-drag-heading'; sender.textContent = mail.senderName || mail.senderEmail || '寄件人';
  icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('fill', 'none'); icon.setAttribute('stroke', 'currentColor'); icon.setAttribute('stroke-width', '1.65');
  path.setAttribute('d', 'M3 5h18v14H3zM3 5l9 7 9-7'); icon.append(path); heading.append(icon, sender);
  const address = document.createElement('div'), subject = document.createElement('div');
  address.className = 'mail-drag-email'; address.textContent = mail.senderEmail || mail.from || '未提供寄件人地址';
  subject.className = 'mail-drag-subject'; subject.textContent = mail.subject.trim() || '未命名郵件';
  preview.append(heading, address, subject);
  const move = (event: DragEvent) => {
    if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
    const width = preview.offsetWidth || Math.min(300, window.innerWidth - 16), height = preview.offsetHeight || 118;
    const left = event.clientX + width + 28 <= window.innerWidth ? event.clientX + 20 : event.clientX - width - 20;
    const top = event.clientY + height + 28 <= window.innerHeight ? event.clientY + 20 : event.clientY - height - 20;
    const x = Math.max(8, Math.min(left, window.innerWidth - width - 8)), y = Math.max(8, Math.min(top, window.innerHeight - height - 8));
    preview.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`; preview.style.visibility = 'visible';
  };
  const leave = (event: DragEvent) => {
    if (!event.relatedTarget && (event.clientX <= 0 || event.clientY <= 0 || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight)) preview.style.visibility = 'hidden';
  };
  let cleaned = false;
  const stopScrolling = sourceDragScroll(document);
  const cleanup = () => {
    if (cleaned) return; cleaned = true;
    stopScrolling();
    document.removeEventListener('dragover', move, true); document.removeEventListener('dragleave', leave, true);
    document.removeEventListener('drop', cleanup); document.removeEventListener('dragend', finish, true); window.removeEventListener('pagehide', finish);
    preview.remove(); mask.remove();
  };
  const finish = () => { cleanup(); onEnd?.(); };
  document.body.append(mask, preview); move(event);
  document.addEventListener('dragover', move, true); document.addEventListener('dragleave', leave, true);
  // Let the drop target read its payload before removing the native drag-image element.
  document.addEventListener('drop', cleanup); document.addEventListener('dragend', finish, true); window.addEventListener('pagehide', finish);
  try { event.dataTransfer?.setDragImage(mask, 0, 0); } catch { /* The visible card works even when a native preview cannot be set. */ }
  return cleanup;
}
