import { effect, inject, Injectable, untracked } from '@angular/core';
import { GmailService } from './gmail-service';
import { type MailPreview } from './gmail-data';
import { fetchMailContent, type MailContent } from './gmail-content';

/** Loaded with the mail dialog; full bodies never enter persisted Gmail previews. */
@Injectable({providedIn: 'root'})
export class MailReader {
  readonly gmail = inject(GmailService);
  private readonly cache = new Map<string, {identity: string; updatedAt: number; content: MailContent}>();
  private destroyed = false;
  private identity = '';
  constructor() { effect(() => { const identity = this.gmail.previewIdentity(); if (identity !== this.identity) untracked(() => { this.cache.clear(); this.identity = identity; }); }); }
  async read(mail: MailPreview, identity: string): Promise<MailContent> {
    const isCurrent = () => !this.destroyed && identity === this.gmail.previewIdentity();
    if (!isCurrent() || !this.gmail.preferences().accountId) throw new Error('Gmail 帳號已變更，請重新選擇郵件。');
    const cached = this.cache.get(mail.id);
    if (cached?.identity === identity && Date.now() - cached.updatedAt < 5 * 60000) return cached.content;
    if (!this.gmail.auth.connected()) throw new Error('請先重新連線 Gmail，才能讀取較完整的內文。');
    if (navigator.onLine === false) throw new Error('目前離線，仍可查看郵件預覽或稍後在 Gmail 開啟。');
    if (this.gmail.auth.account()?.id !== this.gmail.preferences().accountId) throw new Error('Gmail 帳號已變更，請重新選擇郵件。');
    const content = await fetchMailContent((path, params) => this.gmail.auth.api(path, params), mail.id, isCurrent);
    if (!isCurrent()) throw new Error('Gmail 帳號已變更，請重新選擇郵件。');
    this.cache.delete(mail.id); this.cache.set(mail.id, {identity, updatedAt: Date.now(), content});
    while (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!);
    return content;
  }
  async thread(mail: MailPreview, identity: string, force = false): Promise<MailPreview[]> {
    if (this.destroyed) throw new Error('郵件預覽已關閉。');
    const messages = await this.gmail.readThread(mail, identity, force);
    if (this.destroyed) throw new Error('郵件預覽已關閉。');
    return messages;
  }
  ngOnDestroy(): void { this.destroyed = true; this.cache.clear(); }
}
