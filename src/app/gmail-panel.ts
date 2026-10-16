import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, effect, inject, input, linkedSignal, output, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { GmailService } from './gmail-service';
import { GmailNotifications } from './gmail-notifications';
import { MailTasks } from './mail-tasks';
import { gmailMessageLink, mailLabelName, MailLabel, MailPreview } from './gmail-data';
import { Icon } from './icon';
import { mapMailRequests } from './gmail-api';
import { SourceTouchDrag } from './source-touch-drag';
import {mailInformationSource} from './mail-information-data';
import type {Task} from './models';

interface ThreadView {messages: MailPreview[]; busy: boolean; error: string}
@Component({selector: 'app-gmail-panel', imports: [FormsModule, Icon, NgTemplateOutlet, SourceTouchDrag], templateUrl: './gmail-panel.html', styleUrl: './gmail-panel.css'})
export class GmailPanel {
  readonly gmail = inject(GmailService);
  readonly notifications = inject(GmailNotifications);
  readonly mailTasks = inject(MailTasks);
  readonly active = input(true);
  readonly visible = input(true);
  readonly visit = input(0);
  readonly createTask = output<MailPreview>();
  readonly previewMail = output<MailPreview>();
  readonly configure = output<void>();
  readonly openTask = output<{workspaceId: string; task: Task}>();
  readonly searchDraft = linkedSignal(() => this.gmail.query());
  readonly labelDraft = linkedSignal(() => {
    this.gmail.store.generation(); this.gmail.clientId(); this.gmail.preferences().accountId;
    return [...this.gmail.selected()];
  });
  readonly labelsChanged = computed(() => JSON.stringify([...this.labelDraft()].sort()) !== JSON.stringify([...this.gmail.selected()].sort()));
  readonly draftLabelNames = computed(() => this.labelDraft().map(id => {const label = this.gmail.labelIndex().get(id); return label ? mailLabelName(label) : id === 'INBOX' ? '收件匣' : '暫不可用的標籤';}));
  readonly userLabels = computed(() => this.gmail.labels().filter(label => label.type === 'user'));
  readonly systemLabels = computed(() => this.gmail.labels().filter(label => label.type === 'system'));
  readonly labelName = mailLabelName;
  readonly expanded = signal(new Set<string>());
  readonly threadViews = signal(new Map<string, ThreadView>());
  readonly refreshing = signal(false);
  private readonly viewedNewThreadIds = linkedSignal(() => {this.gmail.previewIdentity(); return new Set<string>();});
  readonly newThreadIds = computed(() => new Set([...this.gmail.newThreadIds(), ...this.viewedNewThreadIds()]));
  private readonly context = computed(() => JSON.stringify([this.gmail.previewIdentity(), [...this.gmail.selected()].sort(), this.gmail.query()]));
  private previousContext = '';
  private viewedVisit = '';
  private refreshedVisit = '';
  private readonly foreground = signal(this.isForeground());
  private readonly visibilityChanged = () => this.foreground.set(this.isForeground());
  private destroyed = false;
  constructor() {
    effect(() => { const active = this.active(); untracked(() => this.gmail.active.set(active)); });
    effect(() => {
      const active = this.active(), visible = this.visible(), foreground = this.foreground(), visit = this.visit();
      const identity = this.gmail.previewIdentity(), context = JSON.stringify([this.gmail.store.generation(), this.gmail.clientId(), this.gmail.preferences().accountId, visit]);
      const loaded = !this.gmail.busy() && !this.gmail.error() && !this.gmail.showingPrevious() && (this.gmail.updatedAt() > 0 || this.gmail.messages().length > 0);
      untracked(() => {
        if (!active) {this.viewedVisit = ''; this.refreshedVisit = ''; this.viewedNewThreadIds.set(new Set()); return;}
        if (!visible || !foreground) return;
        if (visit > 0 && this.refreshedVisit !== context) {this.refreshedVisit = context; void this.gmail.load();}
        if (!loaded || this.gmail.busy() || this.gmail.error() || this.viewedVisit === context) return;
        // A visit acknowledges one batch. Later arrivals remain new while this panel stays open.
        const newThreadIds = new Set(this.gmail.newThreadIds());
        if (this.notifications.acknowledgeCurrent(identity)) {this.viewedVisit = context; this.viewedNewThreadIds.set(newThreadIds);}
      });
    });
    document.addEventListener('visibilitychange', this.visibilityChanged);
    window.addEventListener('focus', this.visibilityChanged); window.addEventListener('blur', this.visibilityChanged);
    effect(() => {
      const context = this.context(), ids = new Set(this.gmail.threads().filter(thread => thread.count > 1).map(thread => thread.mail.threadId));
      untracked(() => {
        if (context !== this.previousContext) { this.previousContext = context; this.expanded.set(new Set()); this.threadViews.set(new Map()); }
        else { this.expanded.set(new Set([...this.expanded()].filter(id => ids.has(id)))); this.threadViews.set(new Map([...this.threadViews()].filter(([id]) => ids.has(id)))); }
        this.syncExpanded();
      });
    });
  }
  private isForeground(): boolean {return document.visibilityState === 'visible' && (document.hasFocus?.() ?? true);}
  toggleLabel(id: string): void {
    if (!this.gmail.labelIndex().has(id)) return;
    this.labelDraft.update(ids => ids.includes(id) ? ids.filter(label => label !== id) : [...ids, id]);
  }
  resetLabels(): void { this.labelDraft.set([...this.gmail.selected()]); }
  applyLabels(selector?: HTMLDetailsElement): void {
    if (!this.labelsChanged() || !this.gmail.preferences().accountId) return;
    this.gmail.applyLabels(this.labelDraft());
    if (selector) {selector.open = false; selector.querySelector('summary')?.focus();}
  }
  async refresh(): Promise<void> {
    if (this.refreshing() || this.gmail.busy() || !this.gmail.auth.connected() || !this.gmail.online()) return;
    const context = this.context(); this.refreshing.set(true);
    try {
      await this.gmail.load(true);
      if (this.destroyed || context !== this.context() || this.gmail.error()) return;
      await mapMailRequests(this.gmail.threads().filter(thread => this.expanded().has(thread.mail.threadId)), thread => this.loadThread(thread.mail, true));
    } finally { if (!this.destroyed) this.refreshing.set(false); }
  }
  replies(mail: MailPreview): MailPreview[] { return this.threadViews().get(mail.threadId)?.messages.filter(item => item.id !== mail.id) ?? []; }
  private syncExpanded(): void { this.gmail.expandedMessages.set([...this.expanded()].flatMap(id => this.threadViews().get(id)?.messages ?? [])); }
  async toggleThread(mail: MailPreview): Promise<void> {
    const id = mail.threadId;
    if (this.expanded().has(id)) { this.expanded.update(ids => new Set([...ids].filter(value => value !== id))); this.syncExpanded(); return; }
    if (this.destroyed || !this.gmail.isListed(mail)) return;
    this.expanded.update(ids => new Set([...ids, id]));
    await this.loadThread(mail);
  }
  async loadThread(mail: MailPreview, force = false): Promise<void> {
    const id = mail.threadId, context = this.context(), previous = this.threadViews().get(id);
    if (previous?.busy || this.destroyed) return;
    this.threadViews.update(views => new Map(views).set(id, {messages: previous?.messages ?? [], busy: true, error: ''})); this.syncExpanded();
    const current = () => !this.destroyed && context === this.context() && this.gmail.threads().some(thread => thread.mail.threadId === id);
    try {
      const messages = await this.gmail.readThread(mail, this.gmail.previewIdentity(), force);
      if (current()) this.threadViews.update(views => new Map(views).set(id, {messages, busy: false, error: ''}));
    } catch (error) {
      if (current()) this.threadViews.update(views => new Map(views).set(id, {messages: previous?.messages ?? [], busy: false, error: error instanceof Error ? error.message : '無法讀取討論串。'}));
    } finally { if (current()) this.syncExpanded(); }
  }
  link(mail: MailPreview): string { return gmailMessageLink(mail, this.gmail.preferences().email); }
  related(mail: MailPreview) {
    const {email, accountId} = this.gmail.preferences();
    if (!accountId) return [];
    try {return this.gmail.store.tasksForDocument(mailInformationSource(mail, email, accountId));}
    catch {return [];}
  }
  labels(mail: MailPreview): MailLabel[] { return mail.labelIds.filter(id => id !== 'UNREAD').map(id => this.gmail.labelIndex().get(id)).filter((label): label is MailLabel => !!label); }
  date(mail: MailPreview): string { return new Date(mail.receivedAt).toLocaleString('zh-TW', {month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false}); }
  labelMenuKeydown(event: KeyboardEvent): void {
    const details = (event.currentTarget as HTMLElement).closest('details');
    if (event.key === 'Escape' && details?.open) { event.preventDefault(); event.stopPropagation(); details.open = false; details.querySelector('summary')?.focus(); }
  }
  ngOnDestroy(): void {
    this.destroyed = true; this.gmail.active.set(false); this.gmail.expandedMessages.set([]); this.mailTasks.end();
    document.removeEventListener('visibilitychange', this.visibilityChanged);
    window.removeEventListener('focus', this.visibilityChanged); window.removeEventListener('blur', this.visibilityChanged);
  }
}
