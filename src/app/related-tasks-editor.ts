import {Component, computed, inject, input, output} from '@angular/core';
import {BoardStore} from './board-store';
import {Icon} from './icon';

/** Internal task entries share the information section; edits stay in the parent draft. */
@Component({selector: 'app-related-tasks-editor', imports: [Icon], template: `
@for (row of rows(); track row.id) {<article class="relation-row"><app-icon name="board" /><button type="button" class="relation-open" [disabled]="!row.task || !!row.task.deletedAt" [attr.aria-label]="'開啟連結任務：' + (row.task?.title || '待確認的任務')" (click)="openTask.emit(row.id)"><strong>{{ row.task?.title || '待確認的任務' }}</strong><small>任務 · {{ row.task?.deletedAt ? '在垃圾桶' : row.task ? projectName(row.task.projectId) + ' · ' + statusName(row.task.status) : '原任務無法開啟' }}</small></button><button type="button" class="remove" [attr.aria-label]="'移除任務連結：' + (row.task?.title || '待確認的任務')" (click)="remove(row.id)">移除</button></article>}`, styles: `
:host{display:grid;gap:var(--sp8)}:host:empty{display:none}.relation-row{display:flex;align-items:start;gap:var(--sp6);min-width:0;padding:var(--sp10);border:1px solid var(--border);border-radius:6px;background:var(--surface)}app-icon{width:20px;height:20px;flex-shrink:0;margin-top:2px;color:var(--text-muted)}button{color:var(--text-muted);font:inherit;background:transparent}.relation-open{min-width:0;flex:1;text-align:left;padding:0;display:grid;gap:var(--sp4)}.relation-open strong{font-size:var(--font-11);font-weight:500;overflow-wrap:anywhere}.relation-open small{font-size:var(--font-9);color:var(--text-muted);overflow-wrap:anywhere}.relation-open:disabled{opacity:.65;cursor:default}.relation-open:not(:disabled):hover{color:var(--accent-text)}.remove{flex-shrink:0;border:1px solid var(--border);border-radius:6px;padding:var(--sp7) var(--sp10);font-size:var(--font-10)}button:focus-visible{outline:2px solid var(--accent-text);outline-offset:2px}`})
export class RelatedTasksEditor {
  readonly store = inject(BoardStore);
  readonly taskId = input.required<string>();
  readonly value = input<string[]>([]);
  readonly valueChange = output<string[]>();
  readonly openTask = output<string>();
  readonly rows = computed(() => {const tasks = new Map(this.store.state().tasks.map(task => [task.id, task])); return this.value().map(id => ({id, task: tasks.get(id)}));});
  projectName(id: string): string {return this.store.projects().find(project => project.id === id)?.name ?? '未指定專案';}
  statusName(id: string): string {return this.store.statuses().find(status => status.id === id)?.label ?? '未指定狀態';}
  remove(id: string): void {this.valueChange.emit(this.value().filter(value => value !== id));}
}
