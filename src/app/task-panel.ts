import { DatePipe, NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, output } from '@angular/core';
import { BoardStore } from './board-store';
import { Icon } from './icon';
import { Task, TaskConflict, Workspace } from './models';
import { recentTasks, RECENT_TASK_LIMIT } from './task-activity-data';

@Component({
  selector: 'app-task-panel',
  imports: [DatePipe, NgTemplateOutlet, Icon],
  templateUrl: './task-panel.html',
  styleUrl: './task-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class TaskPanel {
  readonly store = inject(BoardStore);
  readonly openTask = output<Task>();
  readonly pinTask = output<Task>();
  readonly openConflict = output<{workspace: Workspace; conflict: TaskConflict}>();
  readonly pinned = computed(() => this.store.tasks().filter(task => task.pinned));
  readonly recent = computed(() => recentTasks(this.store.tasks()));
  readonly recentLimit = RECENT_TASK_LIMIT;
  readonly conflicts = this.store.taskConflicts;
  conflictTitle(conflict: TaskConflict): string {return conflict.versions.find(version => version.task)?.task?.title ?? '已刪除的任務';}
  projectName(task: Task): string { return this.store.projects().find(project => project.id === task.projectId)?.name ?? '未指定專案'; }
  statusLabel(task: Task): string { return this.store.statuses().find(status => status.id === task.status)?.label ?? ''; }
}
