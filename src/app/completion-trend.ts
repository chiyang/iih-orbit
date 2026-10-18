import {Component, computed, input, linkedSignal, output} from '@angular/core';
import {FormsModule} from '@angular/forms';
import type {Workspace} from './models';
import {completionTrend, type CompletionBucket} from './completion-trend-data';

@Component({selector: 'app-completion-trend', imports: [FormsModule], templateUrl: './completion-trend.html', styleUrl: './completion-trend.css'})
export class CompletionTrend {
  readonly workspace = input.required<Workspace>();
  readonly now = input.required<Date>();
  readonly project = input('all');
  readonly selectRange = output<string>();
  readonly days = linkedSignal<string, 7 | 30 | 90>({source: () => this.workspace().id, computation: (id, previous) => previous?.source === id ? previous.value : 30});
  readonly weekly = linkedSignal<string, boolean>({source: () => this.workspace().id, computation: (id, previous) => previous?.source === id ? previous.value : false});
  readonly data = computed(() => completionTrend(this.workspace(), this.now(), this.project(), this.days(), this.weekly()));
  readonly chartMaximum = computed(() => Math.max(2, Math.ceil(this.data().maximum / 2) * 2));
  readonly linePoints = computed(() => this.data().buckets.map((bucket, index, buckets) => `${(index + 0.5) / buckets.length * 1000},${this.pointY(bucket)}`).join(' '));
  readonly labelStep = computed(() => Math.max(1, Math.ceil(this.data().buckets.length / 10)));
  changeDays(value: number): void {if ([7, 30, 90].includes(value)) {this.days.set(value as 7 | 30 | 90); this.weekly.set(value === 90);}}
  pointY(bucket: CompletionBucket): number {return (1 - bucket.count / this.chartMaximum()) * 100;}
  show(bucket: CompletionBucket): void {if (bucket.count) this.selectRange.emit(bucket.start + '/' + bucket.end);}
  label(bucket: CompletionBucket): string {return `${bucket.start}${bucket.end === bucket.start ? '' : ' 至 ' + bucket.end}，完成 ${bucket.count} ${this.weekly() ? '次' : '項'}，查看任務`;}
}
