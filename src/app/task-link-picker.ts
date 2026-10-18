import {Component, computed, effect, inject, signal, untracked} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {DIALOG_DATA, DialogRef} from '@angular/cdk/dialog';
import {BoardStore} from './board-store';

export interface TaskLinkPickerData {taskId: string; workspaceId: string; generation: string; excluded: string[]}

@Component({selector: 'app-task-link-picker', imports: [FormsModule], styleUrl: './task-link-picker.css', template: `
<section class="task-link-picker" (keydown.escape)="escape($event)"><header><div><h2>建立任務連結</h2><p>{{ store.currentWorkspace().name }} · 可選擇同空間的其他專案任務</p></div><button type="button" class="picker-cancel" (click)="cancel()">取消</button></header>
<div class="picker-body"><label class="search-label">搜尋任務或專案<input class="task-link-search" type="search" aria-label="搜尋要連結的任務" placeholder="輸入任務名稱或專案" maxlength="1000" [ngModel]="query()" (ngModelChange)="query.set($event)"></label>
<div class="picker-results" role="group" aria-label="可連結的任務">@for (task of candidates(); track task.id) {<label class="candidate"><input type="checkbox" [checked]="selected().includes(task.id)" (change)="toggle(task.id)"><span><strong>{{ task.title }}</strong><small>{{ projectName(task.projectId) }} · {{ statusName(task.status) }}</small></span></label>} @empty {<p>沒有可連結的任務，請調整搜尋或先建立其他任務。</p>} @if (matchingCount() > candidates().length) {<p>顯示前 50 個任務，請輸入更完整的名稱縮小範圍。</p>}</div>
@if (error()) {<p class="error" role="alert">{{ error() }}</p>}<p>確認後加入目前草稿，儲存任務後建立雙向連結。</p></div>
<footer><span role="status">已選 {{ selected().length }} 個任務</span><button type="button" [disabled]="!selected().length || store.pendingWrites() > 0 || !valid()" (click)="confirm()">加入任務連結</button></footer></section>`})
export class TaskLinkPicker {
  readonly store = inject(BoardStore);
  private readonly ref = inject<DialogRef<string[]>>(DialogRef);
  private readonly data = inject<TaskLinkPickerData>(DIALOG_DATA);
  readonly query = signal('');
  readonly selected = signal<string[]>([]);
  readonly error = signal('');
  readonly valid = computed(() => this.store.generation() === this.data.generation && this.store.currentWorkspace().id === this.data.workspaceId);
  private readonly available = computed(() => {
    const excluded = new Set([this.data.taskId, ...this.data.excluded, ...this.store.taskConflicts().filter(entry => entry.workspace.id === this.data.workspaceId).map(entry => entry.conflict.id)]);
    return this.store.tasks().filter(task => !excluded.has(task.id));
  });
  private readonly matches = computed(() => {const query = this.query().trim().normalize('NFKC').toLocaleLowerCase(); return this.available().filter(task => !query || (task.title + ' ' + this.projectName(task.projectId)).normalize('NFKC').toLocaleLowerCase().includes(query));});
  readonly candidates = computed(() => this.matches().slice(0, 50));
  readonly matchingCount = computed(() => this.matches().length);
  constructor() {effect(() => {if (!this.valid()) untracked(() => this.cancel());});}
  projectName(id: string): string {return this.store.projects().find(project => project.id === id)?.name ?? '未指定專案';}
  statusName(id: string): string {return this.store.statuses().find(status => status.id === id)?.label ?? '未指定狀態';}
  toggle(id: string): void {if (this.valid() && this.available().some(task => task.id === id)) {this.selected.update(ids => ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id]); this.error.set('');}}
  confirm(): void {
    if (!this.valid()) {this.cancel(); return;}
    if (this.store.pendingWrites() || !this.selected().length) return;
    const available = new Set(this.available().map(task => task.id));
    if (this.selected().some(id => !available.has(id))) {this.selected.update(ids => ids.filter(id => available.has(id))); this.error.set('部分任務已移除或有同步衝突，請確認選擇後重試。'); return;}
    this.ref.close([...this.selected()]);
  }
  cancel(): void {this.ref.close();}
  escape(event: Event): void {event.preventDefault(); event.stopPropagation(); this.cancel();}
}
