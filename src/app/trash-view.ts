import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, output } from '@angular/core';
import { BoardStore } from './board-store';
import { Icon } from './icon';
import { Task } from './models';

@Component({
  selector: 'app-trash-view',
  imports: [DatePipe, Icon],
  templateUrl: './trash-view.html',
  styleUrl: './trash-view.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class TrashView {
  readonly store = inject(BoardStore);
  readonly restoreTask = output<Task>();
  readonly purgeTask = output<Task>();
  readonly emptyTrash = output<void>();
  readonly back = output<void>();
  readonly undo = output<void>();
  readonly redo = output<void>();
  readonly tasks = computed(() => [...this.store.trashedTasks()].sort((a, b) => b.deletedAt!.localeCompare(a.deletedAt!)));
  projectName(task: Task): string { return this.store.projects().find(project => project.id === task.projectId)?.name ?? '未指定專案'; }
  categoryName(task: Task): string { return this.store.categories().find(category => category.id === task.categoryId)?.name ?? '未分類'; }
  statusLabel(task: Task): string { return this.store.statuses().find(status => status.id === task.status)?.label ?? ''; }
}
