import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { Icon } from './icon';
import { ThemeColor } from './theme-color';
import { dateKey, weekDates } from './task-schedule';
import { WORKSPACE_TEMPLATES, WorkspaceTemplateId } from './workspace-templates';

@Component({
  selector: 'app-workspace-template-picker', imports: [Icon, ThemeColor],
  templateUrl: './workspace-template-picker.html', styleUrl: './workspace-template-picker.css', changeDetection: ChangeDetectionStrategy.OnPush
})
export class WorkspaceTemplatePicker {
  readonly selected = input<WorkspaceTemplateId>('blank');
  readonly workspaceName = input('');
  readonly disabled = input(false);
  readonly emptyStart = input(false);
  readonly choose = output<{id: WorkspaceTemplateId; name: string}>();
  readonly templates = WORKSPACE_TEMPLATES;
  readonly template = computed(() => this.templates.find(item => item.id === this.selected()));
  readonly week = weekDates(new Date()).map(date => dateKey(date).replaceAll('-', '/'));
}
