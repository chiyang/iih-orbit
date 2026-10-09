import { Component, input } from '@angular/core';
import { ExternalEvent } from './google-data';
import { ThemeColor } from './theme-color';

@Component({
  selector: 'app-external-event-details', imports: [ThemeColor],
  template: `<article><span class="source-badge" [orbitColor]="entry().source.color">Google・{{ entry().source.name }}・唯讀</span><h3>{{ entry().task.title }}</h3>
    <dl><dt>日期與時間</dt><dd>{{ schedule() }}<small>{{ entry().event.start?.date ? '全天活動' : '本機時區：' + timeZone }}</small></dd>
    @if (entry().event.location) {<dt>地點</dt><dd>{{ entry().event.location }}</dd>}
    @if (entry().event.recurringEventId) {<dt>重複活動</dt><dd>此活動是重複系列中的一個時段。</dd>}</dl>
    @if (entry().event.description) {<p class="description">{{ description() }}</p>}
    <p class="note">活動由 Google Calendar 管理，可在 Google 中修改後同步更新。</p>
    @if (entry().event.htmlLink) {<a [href]="entry().event.htmlLink" target="_blank" rel="noopener noreferrer">在 Google Calendar 開啟 ↗</a>}
    </article>`,
  styles: `article {padding: 25px 30px; overflow-wrap: anywhere;} h3 {font-size: var(--font-20); margin: 18px 0; line-height: 1.5;}
    .source-badge {display: inline-block; color: var(--category-text); background: var(--category-bg); border-radius: 6px; padding: 5px 9px; font-size: var(--font-10);}
    dl {display: grid; grid-template-columns: 100px minmax(0, 1fr); gap: 14px; font-size: var(--font-12);} dt {color: var(--text-muted);} dd {margin: 0;} dd small {display: block; color: var(--text-soft); margin-top: 6px; font-size: var(--font-10);}
    .description {white-space: pre-wrap; line-height: 1.8; font-size: var(--font-12); padding: 16px; background: var(--section-bg); border-radius: 8px;}
    .note {font-size: var(--font-11); color: var(--text-muted); line-height: 1.8;} a {color: var(--accent-text); font-size: var(--font-12);}
    @media (max-width: 700px) {article {padding: 20px;} dl {grid-template-columns: 1fr; gap: 6px;} dd {margin-bottom: 9px;}}`
})
export class ExternalEventDetails {
  readonly entry = input.required<ExternalEvent>();
  readonly timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  schedule(): string {
    const entry = this.entry();
    if (entry.event.start?.date) return entry.task.startDate === entry.task.dueDate ? entry.task.startDate : `${entry.task.startDate} — ${entry.task.dueDate}`;
    const format = (value: string) => new Date(value).toLocaleString('zh-TW', {year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false});
    return format(entry.event.start!.dateTime!) + ' — ' + format(entry.event.end!.dateTime!);
  }
  description(): string {
    return this.entry().event.description.replace(/<br\s*\/?\s*>|<\/(p|div)>/gi, '\n').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  }
}
