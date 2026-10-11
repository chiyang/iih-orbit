import { MailPreview, MailThreadSummary, readMailLabels, readMailPreview, readMailThread, readMailThreadIndex } from './gmail-data.ts';
import { assertMailActive, type GmailRequest } from './gmail-requests.ts';
import { MAIL_CACHE_TTL } from './gmail-cache';

export type { GmailRequest } from './gmail-requests.ts';
interface Stream {label: string; started: boolean; token: string; buffer: MailPreview[]}
export interface MailCursor {streams: Stream[]; seen: string[]; query?: string}
export const newMailCursor = (labels: string[], query = ''): MailCursor => ({query, streams: [...new Set(labels.length ? labels : [''])].map(label => ({label, started: false, token: '', buffer: []})), seen: []});
export const mailHasMore = (cursor: MailCursor) => cursor.streams.some(stream => !stream.started || !!stream.token || !!stream.buffer.length);
export async function mapMailRequests<T, R>(items: T[], work: (item: T, signal: AbortSignal) => Promise<R>, signal?: AbortSignal): Promise<R[]> {
  assertMailActive(signal);
  const controller = new AbortController(), cancel = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', cancel, {once: true});
  const results: R[] = new Array(items.length); let index = 0, failed = false, failure: unknown;
  try {
    await Promise.all(Array.from({length: Math.min(4, items.length)}, async () => {
      try {
        for (;;) {
          if (failed) return;
          assertMailActive(controller.signal);
          const next = index++; if (next >= items.length) return;
          results[next] = await work(items[next], controller.signal);
        }
      } catch (error) { if (!failed) {failed = true; failure = error; controller.abort(error);} }
    }));
  } finally { signal?.removeEventListener('abort', cancel); }
  if (failed) throw failure;
  assertMailActive(signal);
  return results;
}
/** Each label has its own ordered cursor. Merge heads, retaining older buffers for the next page. */
export class GmailApi {
  private readonly previews = new Map<string, {updatedAt: number; mail: MailPreview}>();
  private readonly summaries = new Map<string, {updatedAt: number; summary: MailThreadSummary}>();
  private cacheVersion = 0;
  constructor(private readonly request: GmailRequest) {}
  clearCache(): void { this.cacheVersion++; this.previews.clear(); this.summaries.clear(); }
  private async preview(id: string, signal?: AbortSignal, force = false): Promise<MailPreview> {
    assertMailActive(signal);
    const cached = this.previews.get(id), version = this.cacheVersion;
    if (!force && cached && Date.now() - cached.updatedAt < MAIL_CACHE_TTL) return structuredClone(cached.mail);
    const mail = readMailPreview(await this.request('messages/' + id, {format: 'full', fields: 'id,threadId,labelIds,snippet,internalDate,payload(headers(name,value))'}, signal));
    assertMailActive(signal);
    if (mail.id !== id) throw new Error('郵件來源不一致。');
    if (version === this.cacheVersion) {
      this.previews.delete(id); this.previews.set(id, {updatedAt: Date.now(), mail});
      while (this.previews.size > 200) this.previews.delete(this.previews.keys().next().value!);
    }
    return structuredClone(mail);
  }
  async labels(signal?: AbortSignal) { assertMailActive(signal); return readMailLabels(await this.request('labels', undefined, signal)); }
  async summary(id: string, known: MailPreview[], signal?: AbortSignal, force = false): Promise<MailThreadSummary> {
    assertMailActive(signal);
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new Error('討論串識別碼不正確。');
    const cached = this.summaries.get(id), version = this.cacheVersion;
    if (!force && cached && Date.now() - cached.updatedAt < MAIL_CACHE_TTL) return structuredClone(cached.summary);
    const index = readMailThreadIndex(await this.request('threads/' + id, {format: 'full', fields: 'id,messages(id,threadId,labelIds,internalDate)'}, signal), id);
    assertMailActive(signal);
    const mail = known.find(mail => mail.id === index.firstId && mail.threadId === id) ?? await this.preview(index.firstId, signal, force);
    assertMailActive(signal);
    if (mail.id !== index.firstId || mail.threadId !== id) throw new Error('討論串來源不一致。');
    const summary = {mail, count: index.count, unread: index.unread};
    if (version === this.cacheVersion) {
      this.summaries.delete(id); this.summaries.set(id, {updatedAt: Date.now(), summary});
      while (this.summaries.size > 200) this.summaries.delete(this.summaries.keys().next().value!);
    }
    return structuredClone(summary);
  }
  async thread(id: string): Promise<MailPreview[]> {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new Error('討論串識別碼不正確。');
    return readMailThread(await this.request('threads/' + id, {format: 'full', fields: 'id,messages(id,threadId,labelIds,snippet,internalDate,payload(headers(name,value)))'}), id);
  }
  async page(previous: MailCursor, size = 25, signal?: AbortSignal, force = false): Promise<{messages: MailPreview[]; cursor: MailCursor}> {
    assertMailActive(signal);
    const cursor = structuredClone(previous), seen = new Set(cursor.seen), details = new Map<string, Promise<MailPreview | null>>(), messages: MailPreview[] = [];
    const fill = async (stream: Stream, signal: AbortSignal) => {
      while (!stream.buffer.length && (!stream.started || stream.token)) {
        assertMailActive(signal);
        const parameters: Record<string, string> = {maxResults: '25', fields: 'messages(id),nextPageToken', includeSpamTrash: ['SPAM', 'TRASH'].includes(stream.label) ? 'true' : 'false'};
        if (stream.label) parameters['labelIds'] = stream.label;
        if (cursor.query) parameters['q'] = cursor.query;
        if (stream.token) parameters['pageToken'] = stream.token;
        const page = await this.request('messages', parameters, signal) as {messages?: {id: string}[]; nextPageToken?: string};
        assertMailActive(signal);
        if (!page || page.messages !== undefined && (!Array.isArray(page.messages) || page.messages.some(item => !item || typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(item.id))) || page.nextPageToken !== undefined && typeof page.nextPageToken !== 'string') throw new Error('Gmail 郵件清單不完整。');
        const token = page.nextPageToken ?? ''; if (token && token === stream.token) throw new Error('Gmail 分頁未前進，請重新載入。');
        stream.started = true; stream.token = token;
        stream.buffer = (await mapMailRequests((page.messages ?? []).filter(item => !seen.has(item.id)), async (item, signal) => {
          let detail = details.get(item.id);
          if (!detail) {
            detail = this.preview(item.id, signal, force).catch(error => { if ((error as {status?: number})?.status === 404) return null; throw error; });
            details.set(item.id, detail);
          }
          return detail;
        }, signal)).filter((mail): mail is MailPreview => !!mail).sort((a, b) => b.receivedAt - a.receivedAt || b.id.localeCompare(a.id));
      }
    };
    // Refill empty streams before choosing a head so label overlap never loses older mail.
    while (messages.length < size) {
      assertMailActive(signal);
      for (const stream of cursor.streams) stream.buffer = stream.buffer.filter(mail => !seen.has(mail.id));
      await mapMailRequests(cursor.streams.filter(stream => !stream.buffer.length), fill, signal);
      const next = cursor.streams.map(stream => stream.buffer[0]).filter(Boolean).sort((a, b) => b.receivedAt - a.receivedAt || b.id.localeCompare(a.id))[0];
      if (!next) break;
      seen.add(next.id); messages.push(next);
    }
    cursor.seen = [...seen]; for (const stream of cursor.streams) stream.buffer = stream.buffer.filter(mail => !seen.has(mail.id));
    return {messages, cursor};
  }
}
