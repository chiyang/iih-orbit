import { Component, computed, effect, ElementRef, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { GmailService } from './gmail-service';
import { gmailMessageLink, type MailPreview as Mail } from './gmail-data';
import type { MailContent } from './gmail-content';
import { RichContent } from './rich-content';
import { MailReader } from './mail-reader';

@Component({selector: 'app-mail-preview', imports: [RichContent], templateUrl: './mail-preview.html', styleUrl: './mail-preview.css'})
export class MailPreview {
  readonly gmail = inject(GmailService);
  readonly reader = inject(MailReader);
  readonly mail = input.required<Mail>();
  readonly identity = input.required<string>();
  readonly email = input.required<string>();
  readonly createTask = output<Mail>();
  readonly selected = signal<Mail | null>(null);
  readonly shown = computed(() => this.selected() ?? this.mail());
  readonly messages = signal<Mail[]>([]);
  readonly threadBusy = signal(false);
  readonly threadError = signal('');
  readonly threadOpen = signal(false);
  readonly content = signal<MailContent | null>(null);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly expired = computed(() => this.identity() !== this.gmail.previewIdentity());
  readonly link = computed(() => gmailMessageLink(this.shown(), this.email()));
  readonly readingPane = viewChild<ElementRef<HTMLElement>>('readingPane');
  private sequence = 0;
  private threadSequence = 0;
  private threadLoaded = false;
  private destroyed = false;
  constructor() {
    effect(() => {
      const mail = this.mail(), identity = this.identity(), expired = this.expired();
      untracked(() => {
        this.sequence++; this.threadSequence++; this.threadLoaded = false; this.selected.set(mail); this.messages.set([mail]); this.threadOpen.set(!expired); this.threadBusy.set(false); this.threadError.set(''); this.content.set(null); this.error.set(''); this.busy.set(false);
        if (!expired) { void this.load(mail, identity); void this.openThread(); }
      });
    });
  }
  messageDate(mail: Mail): string { return new Date(mail.receivedAt).toLocaleString('zh-TW', {hour12: false}); }
  date(): string { return new Date(this.shown().receivedAt).toLocaleString('zh-TW', {hour12: false}); }
  async load(mail = this.shown(), identity = this.identity()): Promise<void> {
    if (this.busy() || this.expired()) return;
    const sequence = ++this.sequence; this.busy.set(true); this.error.set('');
    try {
      const content = await this.reader.read(mail, identity);
      if (!this.destroyed && sequence === this.sequence && !this.expired()) this.content.set(content);
    } catch (error) { if (!this.destroyed && sequence === this.sequence && !this.expired()) this.error.set(error instanceof Error ? error.message : '無法讀取郵件內文，請在 Gmail 查看。'); }
    finally { if (!this.destroyed && sequence === this.sequence) this.busy.set(false); }
  }
  selectMessage(mail: Mail): void {
    if (this.expired() || this.shown().id === mail.id || !this.messages().some(item => item.id === mail.id)) return;
    this.sequence++; this.busy.set(false); this.selected.set(mail); this.content.set(null); void this.load();
    this.readingPane()?.nativeElement.scrollTo({top: 0});
  }
  toggleThread(): void {
    if (this.threadBusy() || this.expired()) return;
    if (this.threadOpen()) this.threadOpen.set(false);
    else if (this.threadLoaded) this.threadOpen.set(true);
    else void this.openThread();
  }
  async openThread(force = false): Promise<void> {
    if (this.threadBusy() || this.expired()) return;
    this.threadBusy.set(true); this.threadError.set('');
    const identity = this.identity(), threadId = this.mail().threadId, sequence = ++this.threadSequence;
    try {
      const messages = await this.reader.thread(this.mail(), identity, force);
      if (!this.destroyed && sequence === this.threadSequence && identity === this.gmail.previewIdentity() && this.mail().threadId === threadId) {
        this.threadLoaded = true; this.messages.set(messages); this.threadOpen.set(true);
        const selected = messages.find(mail => mail.id === this.shown().id);
        if (selected) this.selected.set(selected); else this.selectMessage(messages[0]);
      }
    } catch (error) { if (!this.destroyed && sequence === this.threadSequence && !this.expired()) this.threadError.set(error instanceof Error ? error.message : '無法讀取討論串。'); }
    finally { if (!this.destroyed && sequence === this.threadSequence) this.threadBusy.set(false); }
  }
  ngOnDestroy(): void { this.destroyed = true; this.sequence++; this.threadSequence++; this.content.set(null); }
}
