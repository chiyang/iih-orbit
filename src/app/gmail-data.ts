import type { Task } from './models';
import { dateKey, parseDate, validDate, scheduleError } from './task-schedule.ts';
import { minuteLabel, timeMinutes } from './week-layout.ts';

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const GMAIL_MIME = 'application/x-iih-orbit-mail';
export interface MailLabel {id: string; name: string; type: 'system' | 'user'}
export interface MailPreview {id: string; threadId: string; from: string; senderName: string; senderEmail: string; subject: string; snippet: string; receivedAt: number; messageId: string; labelIds: string[]}
export interface MailSchedule {date?: string; time?: string}
export interface MailThreadSummary {mail: MailPreview; count: number; unread: boolean}
const systemNames: Record<string, string> = {INBOX: '收件匣', UNREAD: '未讀', STARRED: '已加星號', IMPORTANT: '重要', SENT: '寄件備份', DRAFT: '草稿', SPAM: '垃圾郵件', TRASH: '垃圾桶', CHAT: '聊天', CATEGORY_PERSONAL: '主要', CATEGORY_SOCIAL: '社交', CATEGORY_PROMOTIONS: '促銷', CATEGORY_UPDATES: '最新快訊', CATEGORY_FORUMS: '論壇'};
export const mailLabelName = (label: MailLabel) => label.type === 'system' ? systemNames[label.id] ?? label.name : label.name;
const text = (value: unknown, max: number) => typeof value === 'string' ? value.slice(0, max).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '') : '';
const cleanLine = (value: string) => value.replace(/[\r\n]+/g, ' ').trim();
const markdownText = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replace(/([\\`*_\[\]{}()#+!|])/g, '\\$1').replace(/(^|\n)(\s*)([-]|\d+\.) /g, '$1$2\\$3 ');
export function decodeMailHeader(value: string): string {
  return value.replace(/(\?=)\s+(?==\?)/g, '$1').replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (original, charset: string, encoding: string, encoded: string) => {
    try {
      const bytes = encoding.toLowerCase() === 'b' ? Uint8Array.from(atob(encoded), char => char.charCodeAt(0))
        : Uint8Array.from(encoded.replaceAll('_', ' ').replace(/=([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))), char => char.charCodeAt(0));
      return new TextDecoder(charset).decode(bytes);
    } catch { return original; }
  });
}
export function readMailLabels(value: unknown): MailLabel[] {
  const labels = (value as {labels?: unknown})?.labels;
  if (!Array.isArray(labels)) throw new Error('Gmail 標籤資料不完整，請重試。');
  const result = new Map<string, MailLabel>();
  for (const item of labels) {
    if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 300 || typeof item.name !== 'string' || item.name.length > 1000 || !['system', 'user'].includes(item.type)) throw new Error('Gmail 標籤格式不正確。');
    result.set(item.id, {id: item.id, name: item.name, type: item.type});
  }
  const order = ['INBOX', 'UNREAD', 'STARRED', 'IMPORTANT', 'SENT', 'DRAFT', 'CATEGORY_PERSONAL', 'CATEGORY_UPDATES', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS', 'CATEGORY_PROMOTIONS', 'SPAM', 'TRASH', 'CHAT'];
  const rank = (label: MailLabel) => order.includes(label.id) ? order.indexOf(label.id) : order.length;
  return [...result.values()].sort((a, b) => Number(a.type !== 'user') - Number(b.type !== 'user') || (a.type === 'system' ? rank(a) - rank(b) : 0) || mailLabelName(a).localeCompare(mailLabelName(b), 'zh-TW', {numeric: true}));
}
export function readMailPreview(value: unknown): MailPreview {
  const item = value as {id?: unknown; threadId?: unknown; snippet?: unknown; internalDate?: unknown; labelIds?: unknown; payload?: {headers?: {name?: unknown; value?: unknown}[]}};
  if (!item || typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(item.id) || typeof item.threadId !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(item.threadId) || !Array.isArray(item.payload?.headers) || !Number.isSafeInteger(Number(item.internalDate)) || Number(item.internalDate) < 0 || !Number.isFinite(new Date(Number(item.internalDate)).getTime()) || !Array.isArray(item.labelIds) || !item.labelIds.every(id => typeof id === 'string' && id.length <= 300)) throw new Error('Gmail 郵件資料不完整，請重新載入。');
  const rawHeader = (name: string) => cleanLine(text(item.payload!.headers!.find(header => String(header.name).toLowerCase() === name)?.value, 4000));
  const header = (name: string) => cleanLine(decodeMailHeader(rawHeader(name)));
  const rawFrom = rawHeader('from'), from = header('from');
  // Extract the mailbox before decoding the display name. Addresses inside names/comments are not senders.
  const mailboxText = rawFrom.replace(/"(?:\\.|[^"\\])*"|\([^()]*\)/g, match => ' '.repeat(match.length));
  const matches = [...mailboxText.matchAll(/<([^<>\s]+@[^<>\s]+)>/g)];
  const match = matches.at(-1) ?? /([^\s<>(),;]+@[^\s<>(),;]+)/.exec(mailboxText);
  const senderEmail = match?.[1] ?? '', senderName = match ? decodeMailHeader(rawFrom.slice(0, match.index).trim().replace(/^"(.*)"$/, '$1')) : from;
  return {id: item.id, threadId: item.threadId, from, senderEmail, senderName, subject: header('subject') || '（無主旨）', snippet: text(item.snippet, 1200), receivedAt: Number(item.internalDate), messageId: header('message-id'), labelIds: [...new Set(item.labelIds as string[])]};
}
export function readMailThread(value: unknown, id: string): MailPreview[] {
  const thread = value as {id?: string; messages?: unknown[]};
  if (!thread || thread.id !== id || !Array.isArray(thread.messages) || !thread.messages.length) throw new Error('討論串內容不完整，請在 Gmail 查看。');
  const messages = thread.messages.map(readMailPreview);
  if (messages.some(mail => mail.threadId !== id) || new Set(messages.map(mail => mail.id)).size !== messages.length) throw new Error('討論串來源不一致。');
  return messages.sort((a, b) => a.receivedAt - b.receivedAt || a.id.localeCompare(b.id));
}
export function readMailThreadIndex(value: unknown, id: string): {firstId: string; count: number; unread: boolean} {
  const thread = value as {id?: string; messages?: {id: string; threadId: string; internalDate: string; labelIds: string[]}[]};
  if (!thread || thread.id !== id || !Array.isArray(thread.messages) || !thread.messages.length) throw new Error('討論串內容不完整，請在 Gmail 查看。');
  const messages = thread.messages;
  if (messages.some(mail => !mail || typeof mail.id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(mail.id) || mail.threadId !== id || !Number.isSafeInteger(Number(mail.internalDate)) || Number(mail.internalDate) < 0 || !Number.isFinite(new Date(Number(mail.internalDate)).getTime()) || !Array.isArray(mail.labelIds) || mail.labelIds.some(label => typeof label !== 'string' || label.length > 300)) || new Set(messages.map(mail => mail.id)).size !== messages.length) throw new Error('討論串來源不一致。');
  const first = [...messages].sort((a, b) => Number(a.internalDate) - Number(b.internalDate) || a.id.localeCompare(b.id))[0];
  return {firstId: first.id, count: messages.length, unread: messages.some(mail => mail.labelIds.includes('UNREAD'))};
}
export function gmailMessageLink(mail: MailPreview, email: string): string {
  if (email.length > 320 || !/^[^@\s]+@[^@\s]+$/.test(email)) return '';
  const query = mail.messageId && mail.messageId.length <= 512 && /^[^\s<>]+@[^\s<>]+$/.test(mail.messageId.replace(/^<|>$/g, ''))
    ? 'in:anywhere rfc822msgid:' + mail.messageId.replace(/^<|>$/g, '')
    : 'in:anywhere subject:"' + mail.subject.slice(0, 100).replace(/["\\]/g, ' ') + '"' + (mail.senderEmail.length <= 320 && mail.senderEmail ? ' from:' + mail.senderEmail : '');
  const target = new URL('https://mail.google.com/mail/'); target.searchParams.set('authuser', email); target.hash = 'search/' + encodeURIComponent(query);
  const account = new URL('https://accounts.google.com/AccountChooser'); account.searchParams.set('Email', email); account.searchParams.set('continue', target.href);
  if (account.href.length > 1400) {
    target.hash = 'search/' + encodeURIComponent('in:anywhere subject:"' + mail.subject.slice(0, 20).replace(/["\\]/g, ' ') + '"');
    account.searchParams.set('continue', target.href);
  }
  return account.href;
}
export function mailTask(mail: MailPreview, email: string, base: Task, schedule: MailSchedule = {}): Task {
  const sender = (mail.senderName ? mail.senderName.slice(0, 120) + ' ' : '') + (mail.senderEmail ? '<' + mail.senderEmail + '>' : mail.from.slice(0, 320) || '未提供寄件人');
  const prefix = ['**寄件人：** ' + markdownText(sender), '**收信時間：** ' + new Date(mail.receivedAt).toLocaleString('zh-TW', {hour12: false}), '**主旨：** ' + markdownText(mail.subject.slice(0, 100)), '', '**郵件預覽：**'].join('\n') + '\n';
  const suffix = '\n\n[在 Gmail 開啟原信 ↗](<' + gmailMessageLink(mail, email) + '>)';
  const result = {...base, title: mail.subject.slice(0, 100), description: (prefix + markdownText(mail.snippet || '（沒有預覽文字）')).slice(0, Math.max(0, 2000 - suffix.length)) + suffix, startDate: '', startTime: '', dueDate: '', dueTime: ''};
  if (schedule.date) {
    if (!validDate(schedule.date)) throw new Error('日期不正確，未建立任務。');
    result.startDate = result.dueDate = schedule.date;
    if (schedule.time) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)) throw new Error('時間不正確，未建立任務。');
      const end = timeMinutes(schedule.time) + 60, date = parseDate(schedule.date);
      if (end >= 1440) date.setDate(date.getDate() + 1);
      result.startTime = schedule.time; result.dueDate = dateKey(date); result.dueTime = minuteLabel(end % 1440);
    }
  }
  const error = scheduleError(result); if (error) throw new Error(error);
  return result;
}
