import {Component, computed, input, output, signal} from '@angular/core';
import {FormsModule} from '@angular/forms';

@Component({selector: 'app-schedule-time', imports: [FormsModule], template: `
  <button type="button" class="time-trigger" [disabled]="disabled()" [attr.aria-label]="label() + '：' + (value() || '選擇時間')" [attr.aria-expanded]="opened()" (click)="opened.set(!opened())">{{ value() || '選擇時間' }} <span aria-hidden="true">◷</span></button>
  @if (opened() && !disabled()) {<div class="time-options" (keydown.escape)="$event.stopPropagation(); opened.set(false)"><label>小時<select [ngModel]="hour()" (ngModelChange)="change($event, minute())" [ngModelOptions]="{standalone: true}">@for (hour of hours; track hour) {<option [value]="hour">{{ hour }}</option>}</select></label><label>分鐘<select [ngModel]="minute()" (ngModelChange)="change(hour(), $event)" [ngModelOptions]="{standalone: true}">@for (minute of minutes(); track minute) {<option [value]="minute">{{ minute }}</option>}</select></label><button type="button" (click)="finish()">完成</button></div>}
  `, styles: `:host {display: block; min-width: 0; margin-top: var(--sp6);} button, select {font: inherit; color: var(--text); border: 1px solid var(--border); background: var(--surface); border-radius: 6px; padding: var(--sp9);} .time-trigger {display: flex; justify-content: space-between; width: 100%; font-size: var(--font-11);} .time-trigger:disabled {opacity: .6;} .time-options {display: flex; flex-wrap: wrap; align-items: end; gap: var(--sp6); margin-top: var(--sp8); padding: var(--sp8); border: 1px solid var(--border); border-radius: 7px; background: var(--surface-soft);} .time-options label {display: grid; gap: var(--sp5); flex: 1; font-size: var(--font-9);} .time-options select {min-width: 64px; width: 100%;} .time-options button {font-size: var(--font-10);}`})
export class ScheduleTime {
  readonly value = input('');
  readonly label = input('時間');
  readonly disabled = input(false);
  readonly valueChange = output<string>();
  readonly opened = signal(false);
  readonly hours = Array.from({length: 24}, (_, hour) => String(hour).padStart(2, '0'));
  readonly hour = computed(() => this.value().slice(0, 2) || '09');
  readonly minute = computed(() => this.value().slice(3, 5) || '00');
  // Existing 15-minute calendar drops retain their exact time until the user changes it.
  readonly minutes = computed(() => [...new Set(['00', '10', '20', '30', '40', '50', this.minute()])].sort());
  finish(): void { if (!this.value()) this.change(this.hour(), this.minute()); this.opened.set(false); }
  change(hour: string, minute: string): void { this.valueChange.emit(hour + ':' + minute); }
}
