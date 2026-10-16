import {afterRenderEffect, ChangeDetectionStrategy, Component, computed, ElementRef, inject, input, linkedSignal, output, untracked, viewChild} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {BoardStore} from './board-store';
import {DocumentMetadataService} from './document-metadata-service';
import {Icon} from './icon';
import {donutSegments} from './overview-charts';
import {ThemeColor} from './theme-color';
import type {Task, TaskConflict, Workspace} from './models';
import {OVERVIEW_LABELS, overviewTasks, workspaceOverview, type OverviewKind, type OverviewSelection} from './workspace-overview-data';

@Component({
  selector: 'app-workspace-overview', imports: [FormsModule, Icon, ThemeColor],
  host: {'[class.details-only]': 'detailsOnly()'},
  templateUrl: './workspace-overview.html', styleUrl: './workspace-overview.css', changeDetection: ChangeDetectionStrategy.OnPush
})
export class WorkspaceOverview {
  readonly store = inject(BoardStore);
  private readonly metadata = inject(DocumentMetadataService);
  readonly now = input.required<Date>();
  readonly project = input('all');
  readonly includeArchived = input(false);
  readonly selection = input<OverviewSelection | null>(null);
  readonly detailsOnly = input(false);
  readonly initialPage = input(0);
  readonly scrollPosition = input(0);
  readonly pageChange = output<number>();
  readonly scrollChange = output<number>();
  readonly projectChange = output<string>();
  readonly includeArchivedChange = output<boolean>();
  readonly selectionChange = output<OverviewSelection | null>();
  readonly openTask = output<Task>();
  readonly openConflict = output<{workspace: Workspace; conflict: TaskConflict}>();
  readonly addTask = output<void>();
  readonly projects = computed(() => this.store.projects().filter(project => this.includeArchived() || !project.archived));
  readonly selectedProject = computed(() => this.project() === '' || this.projects().some(project => project.id === this.project()) ? this.project() : 'all');
  readonly data = computed(() => workspaceOverview(this.store.currentWorkspace(), this.now(), {project: this.selectedProject(), includeArchived: this.includeArchived(), dueSoonDays: this.store.reminders().dueSoonDays}, source => this.metadata.view(source)));
  readonly labels = OVERVIEW_LABELS;
  readonly metrics: OverviewKind[] = ['total', 'pending', 'done', 'overdue', 'unscheduled', 'linked'];
  readonly schedules: OverviewKind[] = ['today-start', 'week-start', 'due-soon', 'overdue'];
  readonly completionRows = computed(() => {
    const rows: {kind: OverviewKind; label: string; color: string; count: number}[] = [
      {kind: 'done', label: '已完成', color: 'green', count: this.count('done')},
      {kind: 'pending', label: '待完成', color: 'blue', count: this.count('pending')}
    ];
    if (this.includeArchived()) rows.push({kind: 'archived', label: '封存任務', color: 'gray', count: this.count('archived')});
    return rows;
  });
  readonly completionSlices = computed(() => donutSegments(this.completionRows()));
  readonly statusSlices = computed(() => donutSegments(this.data().statuses));
  readonly categorySlices = computed(() => donutSegments(this.data().categories));
  readonly scheduleMax = computed(() => Math.max(1, ...this.schedules.map(kind => this.count(kind))));
  readonly increaseProjectLimit = (value: number) => value + 12;
  private readonly overviewTitle = viewChild<ElementRef<HTMLElement>>('overviewTitle');
  private readonly detailTitle = viewChild<ElementRef<HTMLElement>>('detailTitle');
  private readonly detailPane = viewChild<ElementRef<HTMLElement>>('detailPane');
  private readonly workspaceId = computed(() => this.store.currentWorkspace().id);
  constructor() {
    afterRenderEffect(() => {
      this.workspaceId();
      if (this.detailsOnly()) {
        this.detailTitle()?.nativeElement.focus({preventScroll: true});
        const pane = this.detailPane()?.nativeElement;
        if (pane) pane.scrollTop = untracked(this.scrollPosition);
      } else this.overviewTitle()?.nativeElement.focus({preventScroll: true});
    });
  }
  readonly page = linkedSignal(() => {this.selection(); this.project(); this.includeArchived(); this.store.currentWorkspace().id; return this.initialPage();});
  readonly projectLimit = linkedSignal(() => {this.project(); this.includeArchived(); this.store.currentWorkspace().id; return 12;});
  readonly categoryLimit = linkedSignal(() => {this.project(); this.includeArchived(); this.store.currentWorkspace().id; return 12;});
  readonly selectedTasks = computed(() => {const selection = this.selection(); return selection ? overviewTasks(this.data(), selection) : [];});
  readonly pageCount = computed(() => Math.max(1, Math.ceil((this.selection()?.kind === 'conflicts' ? this.data().conflicts.length : this.selectedTasks().length) / 30)));
  readonly currentPage = computed(() => Math.min(this.page(), this.pageCount() - 1));
  readonly taskRows = computed(() => this.selectedTasks().slice(this.currentPage() * 30, (this.currentPage() + 1) * 30));
  readonly conflictRows = computed(() => this.data().conflicts.slice(this.currentPage() * 30, (this.currentPage() + 1) * 30));
  readonly selectionLabel = computed(() => {
    const selection = this.selection(); if (!selection) return '';
    return selection.kind === 'status' ? this.store.statuses().find(status => status.id === selection.value)?.label ?? '已移除的狀態'
      : selection.kind === 'category' ? selection.value === '' ? '未分類' : this.store.currentWorkspace().categories.find(category => category.id === selection.value)?.name ?? '已移除的分類'
      : selection.kind === 'project' ? this.projectName(selection.value ?? '') : this.labels[selection.kind];
  });
  readonly projectNameMap = computed(() => new Map(this.store.projects().map(project => [project.id, project.name])));
  readonly statusMap = computed(() => new Map(this.store.statuses().map(status => [status.id, status])));
  projectName(id: string): string {return id ? this.projectNameMap().get(id) ?? '已移除的專案' : '未指定專案';}
  focusTitle(): void {this.overviewTitle()?.nativeElement.focus({preventScroll: true});}
  count(kind: OverviewKind): number {return this.data().groups.get(kind)?.length ?? 0;}
  percentLabel(percent: number): string {return percent > 0 && percent < .1 ? '<0.1%' : (Math.round(percent * 10) / 10) + '%';}
  goPage(page: number): void {
    this.page.set(page); this.pageChange.emit(page); this.scrollChange.emit(0);
    const pane = this.detailPane()?.nativeElement; if (pane) pane.scrollTop = 0;
  }
  show(kind: OverviewKind, value?: string): void {this.selectionChange.emit(value === undefined ? {kind} : {kind, value});}
  conflictTitle(conflict: TaskConflict): string {return conflict.versions.find(version => version.task)?.task?.title ?? '已刪除的任務';}
  changeArchived(value: boolean): void {
    if (!value && this.store.projects().some(project => project.id === this.project() && project.archived)) this.projectChange.emit('all');
    this.includeArchivedChange.emit(value);
  }
}
