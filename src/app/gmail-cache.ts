import { type MailLabel, type MailPreview, type MailThreadSummary, readMailLabels, readMailPreview } from './gmail-data';
import type { MailCursor } from './gmail-api';

const KEY = 'iih-orbit-gmail-cache-v1', MAX_AGE = 86400000, MAX_SCOPES = 6, MAX_BYTES = 1024 * 1024;
export const MAIL_CACHE_TTL = 5 * 60000;
export interface MailSnapshot {
  scope: string; labels: MailLabel[]; messages: MailPreview[]; summaries: MailThreadSummary[];
  updatedAt: number; hasMore: boolean; cursor?: MailCursor;
}
const preview = (mail: MailPreview) => readMailPreview({id: mail.id, threadId: mail.threadId, snippet: mail.snippet, internalDate: mail.receivedAt, labelIds: mail.labelIds, payload: {headers: [{name: 'From', value: mail.from}, {name: 'Subject', value: mail.subject}, {name: 'Message-ID', value: mail.messageId}]}});

/** Small, account-scoped preview snapshots. Cursors stay in memory; bodies never enter storage. */
export class GmailPreviewCache {
  private readonly entries = new Map<string, MailSnapshot>();
  constructor() {
    try {
      const content = localStorage.getItem(KEY) ?? 'null';
      if (new TextEncoder().encode(content).byteLength > MAX_BYTES) return;
      const saved = JSON.parse(content);
      const entries = saved?.version === 3 && Array.isArray(saved.entries) ? saved.entries.slice(-MAX_SCOPES) : saved?.version === 2 ? [saved] : [];
      for (const entry of entries) {
        try {
          const scope = JSON.parse(entry.scope);
          if (!Array.isArray(scope) || scope.length !== 5 || !scope.slice(0, 3).every(value => typeof value === 'string') || !Array.isArray(scope[3]) || !scope[3].every((value: unknown) => typeof value === 'string' && value.length <= 300) || typeof scope[4] !== 'string' || scope[4].length > 500) continue;
          if (!Number.isSafeInteger(entry.updatedAt) || entry.updatedAt <= 0 || entry.updatedAt > Date.now() || Date.now() - entry.updatedAt > MAX_AGE || !Array.isArray(entry.messages) || entry.messages.length > 75 || !Array.isArray(entry.summaries) || entry.summaries.length > 75) continue;
          const messages: MailPreview[] = entry.messages.map(preview);
          const summaries: MailThreadSummary[] = entry.summaries.map((summary: MailThreadSummary) => {
            if (!summary || !Number.isSafeInteger(summary.count) || summary.count < 1 || typeof summary.unread !== 'boolean') throw new Error('討論串快取不完整。');
            return {mail: preview(summary.mail), count: summary.count, unread: summary.unread};
          });
          if (messages.some(mail => !summaries.some(summary => summary.mail.threadId === mail.threadId))) continue;
          this.entries.set(entry.scope, {scope: entry.scope, labels: readMailLabels({labels: entry.labels}), messages, summaries, updatedAt: entry.updatedAt, hasMore: entry.hasMore === true || saved.version === 2 && messages.length >= 25});
        } catch { /* One invalid filter must not discard other usable snapshots. */ }
      }
    } catch { /* Missing, corrupt or unavailable storage can be rebuilt after a successful read. */ }
  }
  get(scope: string): MailSnapshot | undefined {
    const entry = this.entries.get(scope);
    if (!entry || Date.now() - entry.updatedAt > MAX_AGE) { this.entries.delete(scope); return; }
    this.entries.delete(scope); this.entries.set(scope, entry);
    return structuredClone(entry);
  }
  put(snapshot: MailSnapshot): void {
    const owner = JSON.stringify(JSON.parse(snapshot.scope).slice(0, 3));
    for (const [scope] of this.entries) if (JSON.stringify(JSON.parse(scope).slice(0, 3)) !== owner) this.entries.delete(scope);
    const messages = snapshot.messages.slice(0, 75).map(preview), ids = new Set(messages.map(mail => mail.threadId));
    const summaries = snapshot.summaries.filter(summary => ids.has(summary.mail.threadId)).map(summary => ({mail: preview(summary.mail), count: summary.count, unread: summary.unread}));
    const entry = {scope: snapshot.scope, labels: readMailLabels({labels: snapshot.labels}), messages, summaries, updatedAt: snapshot.updatedAt, hasMore: snapshot.hasMore || snapshot.messages.length > 75, cursor: snapshot.messages.length <= 75 ? snapshot.cursor : undefined};
    this.entries.delete(entry.scope); this.entries.set(entry.scope, structuredClone(entry));
    for (const [scope, saved] of this.entries) if (Date.now() - saved.updatedAt > MAX_AGE) this.entries.delete(scope);
    while (this.entries.size > MAX_SCOPES) this.entries.delete(this.entries.keys().next().value!);
    let content = this.serialize();
    while (new TextEncoder().encode(content).byteLength > MAX_BYTES && this.entries.size > 1) {this.entries.delete(this.entries.keys().next().value!); content = this.serialize();}
    if (new TextEncoder().encode(content).byteLength > MAX_BYTES) throw new Error('郵件預覽快取過大。');
    localStorage.setItem(KEY, content);
  }
  private serialize(): string {
    return JSON.stringify({version: 3, entries: [...this.entries.values()].map(({cursor: _cursor, ...snapshot}) => snapshot)});
  }
  clear(): void { this.entries.clear(); localStorage.removeItem(KEY); }
}
