import { decodeMailHeader } from './gmail-data';
import type { GmailRequest } from './gmail-api';

export interface MailAttachment {name: string; mimeType: string; size: number}
export interface MailContent {html: string; plain: string; to: string; cc: string; attachments: MailAttachment[]; warning: string}
interface Part {mimeType?: unknown; filename?: unknown; headers?: {name?: unknown; value?: unknown}[]; body?: {data?: unknown; attachmentId?: unknown; size?: unknown}; parts?: Part[]}
const MAX_BODY = 512 * 1024;
const header = (part: Part, name: string) => Array.isArray(part.headers) ? String(part.headers.find(item => String(item?.name).toLowerCase() === name)?.value ?? '').slice(0, 4000) : '';
export async function fetchMailContent(request: GmailRequest, id: string, isCurrent: () => boolean): Promise<MailContent> {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new Error('郵件識別碼不正確。');
  if (!isCurrent()) throw new Error('Gmail 帳號已變更，請重新選擇郵件。');
  const value = await request('messages/' + id, {format: 'full', fields: 'id,payload'});
  if (!isCurrent()) throw new Error('Gmail 帳號已變更，請重新選擇郵件。');
  if ((value as {id?: unknown})?.id !== id) throw new Error('郵件內文與選擇的郵件不符。');
  return readMailContent(value, attachment => {
    if (!isCurrent()) throw new Error('Gmail 帳號已變更，請重新選擇郵件。');
    return request('messages/' + id + '/attachments/' + attachment, {fields: 'data,size'});
  });
}
export async function readMailContent(value: unknown, readBody: (id: string) => Promise<unknown>): Promise<MailContent> {
  const payload = (value as {payload?: Part})?.payload;
  if (!payload || typeof payload !== 'object') throw new Error('郵件內文資料不完整，請在 Gmail 查看或重試。');
  const htmlParts: Part[] = [], plainParts: Part[] = [], attachments: MailAttachment[] = [];
  let count = 0, limited = false;
  const visit = (part: Part, depth: number): void => {
    if (!part || typeof part !== 'object') return;
    if (++count > 200 || depth > 12) { limited = true; return; }
    const filename = typeof part.filename === 'string' ? decodeMailHeader(part.filename).slice(0, 260) : '';
    const mime = String(part.mimeType ?? '').toLowerCase();
    if (filename || /^attachment\b/i.test(header(part, 'content-disposition'))) {
      if (attachments.length < 50) attachments.push({name: filename || '未命名附件', mimeType: mime, size: Number.isSafeInteger(part.body?.size) && Number(part.body?.size) >= 0 ? Number(part.body!.size) : 0});
      else limited = true;
      return;
    }
    if (mime === 'text/html') htmlParts.push(part);
    else if (mime === 'text/plain') plainParts.push(part);
    // Forwarded mail attachments are not the selected mail's inline body.
    if (mime !== 'message/rfc822' && Array.isArray(part.parts)) { if (part.parts.length > 200) limited = true; for (const child of part.parts.slice(0, 200)) visit(child, depth + 1); }
  };
  visit(payload, 0);
  const decode = async (parts: Part[]): Promise<string> => {
    let remaining = MAX_BODY;
    const decoded: string[] = [];
    for (const part of parts) {
      const size = Number(part.body?.size);
      if (Number.isFinite(size) && size > remaining) { limited = true; continue; }
      let data = part.body?.data;
      const id = part.body?.attachmentId;
      if (!data && typeof id === 'string' && /^[A-Za-z0-9_-]{1,1000}$/.test(id)) data = (await readBody(id) as {data?: unknown})?.data;
      if (typeof data !== 'string' || !data) continue;
      if (data.length > Math.ceil(remaining * 4 / 3) + 4) { limited = true; continue; }
      try {
        const bytes = Uint8Array.from(atob(data.replaceAll('-', '+').replaceAll('_', '/')), character => character.charCodeAt(0));
        if (bytes.length > remaining) { limited = true; continue; }
        const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(header(part, 'content-type'))?.[1] ?? 'utf-8';
        let text: string;
        try { text = new TextDecoder(charset).decode(bytes); } catch { text = new TextDecoder().decode(bytes); }
        decoded.push(text.replaceAll('\u0000', '')); remaining -= bytes.length;
      } catch { limited = true; }
    }
    return decoded.join('\n');
  };
  const html = await decode(htmlParts);
  const plain = html.trim() ? '' : await decode(plainParts);
  return {html, plain, to: decodeMailHeader(header(payload, 'to')), cc: decodeMailHeader(header(payload, 'cc')), attachments,
    warning: limited ? '部分內文較大或格式無法預覽，請在 Gmail 查看完整內容。' : ''};
}
