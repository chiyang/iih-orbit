import type { GmailRequest } from './gmail-api';
import { GoogleHttpError } from './google-api.ts';

interface Arrival {id: string; threadId: string}
export interface GmailArrivalState {version: 1; context: string; historyId: string; checkedAt: number; pending: Arrival[]; viewed: string[]}
interface MailReference {id?: string; threadId?: string; labelIds?: string[]}
interface HistoryPage {historyId?: string; nextPageToken?: string; history?: Record<string, {message?: MailReference}[]>[]}
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const validHistory = (value: unknown): value is string => typeof value === 'string' && /^\d{1,100}$/.test(value);
const isMissing = (error: unknown) => error instanceof GoogleHttpError && error.status === 404;

export function readGmailArrivalState(value: unknown, context: string): GmailArrivalState | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const state = value as GmailArrivalState;
  if (state.version !== 1 || state.context !== context || !validHistory(state.historyId) || !Number.isSafeInteger(state.checkedAt) || state.checkedAt < 0
    || !Array.isArray(state.pending) || state.pending.length > 5000 || !state.pending.every(mail => mail && validId(mail.id) && validId(mail.threadId))
    || !Array.isArray(state.viewed) || state.viewed.length > 5000 || !state.viewed.every(validId)) return undefined;
  const viewed = [...new Set(state.viewed)], seen = new Set(viewed);
  return {...state, pending: [...new Map(state.pending.filter(mail => !seen.has(mail.id)).map(mail => [mail.id, {id: mail.id, threadId: mail.threadId}])).values()], viewed};
}

/** Read-only Gmail changes plus device-local acknowledgements, never Gmail read receipts. */
export class GmailArrivalTracker {
  private state: GmailArrivalState;
  constructor(private readonly context: string, private readonly request: GmailRequest, initial: GmailArrivalState | undefined, private readonly changed: (state: GmailArrivalState) => void) {
    this.state = initial ?? {version: 1, context, historyId: '', checkedAt: 0, pending: [], viewed: []};
  }
  adopt(incoming: GmailArrivalState): void {
    if (incoming.context !== this.context) return;
    const newer = BigInt(incoming.historyId) > BigInt(this.state.historyId || '0') || incoming.historyId === this.state.historyId && incoming.checkedAt >= this.state.checkedAt;
    const source = newer ? incoming : this.state;
    const viewed = [...new Set([...incoming.viewed, ...this.state.viewed])].sort().slice(-5000), seen = new Set(viewed);
    const next = {...source, viewed, pending: source.pending.filter(mail => !seen.has(mail.id)).sort((a, b) => a.id.localeCompare(b.id))};
    if (JSON.stringify(next) !== JSON.stringify(this.state)) {this.state = next; this.changed(structuredClone(next));}
  }
  acknowledge(ids: string[]): void {
    const viewed = [...new Set([...this.state.viewed, ...ids.filter(validId)])].slice(-5000), seen = new Set(viewed);
    this.state = {...this.state, pending: this.state.pending.filter(mail => !seen.has(mail.id)), viewed};
    this.changed(structuredClone(this.state));
  }
  private async baseline(): Promise<string> {
    const profile = await this.request('profile', {fields: 'historyId'}) as {historyId?: string};
    if (!profile || !validHistory(profile.historyId)) throw new Error('Gmail 新郵件檢查尚未完成。');
    return profile.historyId;
  }
  async check(current: () => boolean): Promise<void> {
    const previous = this.state, checkedAt = Date.now(), added = new Set<string>(), changed = new Set<string>(), deleted = new Set<string>();
    const assertCurrent = () => {if (!current()) throw new Error('Gmail 連線已變更。');};
    let historyId = previous.historyId;
    if (!historyId) {
      historyId = await this.baseline(); assertCurrent();
    } else {
      try {
        let token = ''; const tokens = new Set<string>();
        for (let page = 0; ; page++) {
          if (page >= 20) throw new Error('Gmail 郵件變更多，尚未完成新郵件檢查。');
          const response = await this.request('history', {startHistoryId: previous.historyId, maxResults: '500', fields: 'history(messagesAdded(message(id)),messagesDeleted(message(id)),labelsAdded(message(id)),labelsRemoved(message(id))),historyId,nextPageToken', ...(token ? {pageToken: token} : {})}) as HistoryPage;
          assertCurrent();
          if (!response || !validHistory(response.historyId) || response.history !== undefined && !Array.isArray(response.history)) throw new Error('Gmail 新郵件檢查回覆不完整。');
          for (const record of response.history ?? []) for (const [kind, target] of [['messagesAdded', added], ['messagesDeleted', deleted], ['labelsAdded', changed], ['labelsRemoved', changed]] as const) {
            const entries = record[kind];
            if (entries !== undefined && !Array.isArray(entries)) throw new Error('Gmail 新郵件變更回覆不完整。');
            for (const entry of entries ?? []) {
              if (!validId(entry?.message?.id)) throw new Error('Gmail 郵件識別碼不完整。');
              target.add(entry.message.id);
            }
          }
          historyId = response.historyId;
          if (response.nextPageToken !== undefined && typeof response.nextPageToken !== 'string') throw new Error('Gmail 新郵件分頁不完整。');
          token = response.nextPageToken ?? '';
          if (!token) break;
          if (tokens.has(token)) throw new Error('Gmail 新郵件分頁尚未前進。');
          tokens.add(token);
        }
      } catch (error) {
        if (!isMissing(error)) throw error;
        // An expired history cursor falls back to unread inbox arrivals since the last check.
        historyId = await this.baseline(); assertCurrent();
        added.clear(); changed.clear(); deleted.clear();
        this.state.pending.forEach(mail => changed.add(mail.id));
        let token = ''; const tokens = new Set<string>();
        for (let page = 0; ; page++) {
          if (page >= 20) throw new Error('Gmail 郵件變更多，尚未完成新郵件檢查。');
          const response = await this.request('messages', {labelIds: 'INBOX', q: 'is:unread after:' + Math.max(0, Math.floor(previous.checkedAt / 1000) - 1), maxResults: '100', fields: 'messages(id),nextPageToken', ...(token ? {pageToken: token} : {})}) as {messages?: MailReference[]; nextPageToken?: string};
          assertCurrent();
          if (!response || response.messages !== undefined && !Array.isArray(response.messages)) throw new Error('Gmail 收件匣檢查回覆不完整。');
          for (const mail of response.messages ?? []) {if (!validId(mail.id)) throw new Error('Gmail 郵件識別碼不完整。'); added.add(mail.id);}
          if (response.nextPageToken !== undefined && typeof response.nextPageToken !== 'string') throw new Error('Gmail 收件匣分頁不完整。');
          token = response.nextPageToken ?? ''; if (!token) break;
          if (tokens.has(token)) throw new Error('Gmail 收件匣分頁尚未前進。'); tokens.add(token);
        }
      }
    }
    const existing = new Set(this.state.pending.map(mail => mail.id)), details = new Map<string, Arrival | null>();
    const ids = [...new Set([...added, ...[...changed].filter(id => existing.has(id))])].filter(id => !deleted.has(id));
    if (ids.length > 5000) throw new Error('Gmail 郵件變更多，尚未完成新郵件檢查。');
    for (let index = 0; index < ids.length; index += 4) await Promise.all(ids.slice(index, index + 4).map(async id => {
      try {
        const mail = await this.request('messages/' + id, {format: 'minimal', fields: 'id,threadId,labelIds'}) as MailReference;
        assertCurrent();
        if (!mail || mail.id !== id || !validId(mail.threadId) || !Array.isArray(mail.labelIds) || !mail.labelIds.every(label => typeof label === 'string')) throw new Error('Gmail 新郵件資料不完整。');
        details.set(id, mail.labelIds.includes('INBOX') && mail.labelIds.includes('UNREAD') ? {id, threadId: mail.threadId} : null);
      } catch (error) {if (!isMissing(error)) throw error; details.set(id, null);}
    }));
    assertCurrent();
    if (BigInt(this.state.historyId || '0') > BigInt(historyId)) return;
    // A batch acknowledged while this check runs must not be resurrected by the late response.
    const viewed = new Set(this.state.viewed), pending = new Map(this.state.pending.map(mail => [mail.id, mail]));
    for (const id of deleted) pending.delete(id);
    for (const [id, mail] of details) {if (!mail || viewed.has(id)) pending.delete(id); else pending.set(id, mail);}
    if (pending.size > 5000) throw new Error('新郵件提示較多，請先開啟 Gmail 側欄查看這批通知後再更新。');
    this.state = {...this.state, historyId, checkedAt, pending: [...pending.values()]};
    this.changed(structuredClone(this.state));
  }
}
