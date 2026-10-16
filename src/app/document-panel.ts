import {sourceOpenUrl} from './source-file-type';
import { Component, computed, effect, inject, input, linkedSignal, output, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { BoardStore } from './board-store';
import type { DocumentSource, Task } from './models';
import { Icon } from './icon';
import { DriveBrowser } from './drive-browser';
import { driveFileLabel, isDriveFolder, sourceFromDriveEntry, type DriveBrowserEntry } from './drive-browser-data';
import { DocumentTasks } from './document-tasks';
import {SourceIcon} from './source-icon';
import { SourceTouchDrag } from './source-touch-drag';
import {DocumentLinkStatus} from './document-link-status';

@Component({
  selector: 'app-document-panel', imports: [FormsModule, Icon, SourceIcon, SourceTouchDrag, DocumentLinkStatus], templateUrl: './document-panel.html', styleUrl: './document-panel.css'
})
export class DocumentPanel {
  readonly openUrl = sourceOpenUrl;
  readonly store = inject(BoardStore);
  readonly browser = inject(DriveBrowser);
  readonly documents = inject(DocumentTasks);
  readonly active = input(true);
  readonly selectionMode = input(false);
  readonly selectedIds = input<string[]>([]);
  readonly createTask = output<DocumentSource>();
  readonly selectSource = output<DocumentSource>();
  readonly configure = output<void>();
  readonly openTask = output<{workspaceId: string; task: Task}>();
  readonly searchDraft = linkedSignal(() => this.browser.query());
  readonly canUse = computed(() => this.browser.auth.connected() && !this.browser.selectedConnection().connecting() && !this.browser.busy() && !this.documents.busy());
  readonly folder = isDriveFolder;
  readonly label = driveFileLabel;
  private readonly references = computed(() => new Map(this.browser.visibleFiles().map(file => [file.id, sourceFromDriveEntry(file)])));
  reference(file: DriveBrowserEntry): DocumentSource {return this.references().get(file.id)!;}
  constructor() {
    effect(() => {const active = this.active(); this.browser.sourceContext(); this.browser.auth.connected(); this.browser.selectedConnection().connecting(); untracked(() => {if (active) void this.browser.activate();});});
    effect(() => {this.active(); this.browser.visibleFiles(); this.browser.auth.connectionVersion(); untracked(() => this.documents.validate());});
  }
  async reconnect(): Promise<void> {
    const source = this.browser.selectedConnection();
    if (source.connecting() || !source.auth.ready()) return;
    if (await source.connect()) await this.browser.activate();
  }
  source(file: DriveBrowserEntry): DocumentSource {return this.browser.source(file);}
  related(file: DriveBrowserEntry) {return this.store.tasksForDocument(sourceFromDriveEntry(file));}
  selected(file: DriveBrowserEntry): boolean {return this.selectedIds().includes(sourceFromDriveEntry(file).id);}
  choose(file: DriveBrowserEntry): void {
    try {const source = this.source(file); if (this.selectionMode()) this.selectSource.emit(source); else this.createTask.emit(source);}
    catch (error) {this.browser.error.set(error instanceof Error ? error.message : '請重新選擇檔案。');}
  }
  openFolder(event: MouseEvent, file: DriveBrowserEntry): void {
    const target = event.target as Element | null;
    if (!this.folder(file) || !this.canUse() || target?.closest('button, a, input, summary, .drive-open-link, .drive-related')) return;
    event.preventDefault();
    void this.browser.open(file);
  }
  drag(event: DragEvent, file: DriveBrowserEntry): void {
    if (this.selectionMode() || !this.canUse()) {event.preventDefault(); return;}
    try {const identity = this.browser.identity(); this.documents.start(event, this.source(file), () => this.active() && identity === this.browser.identity() && this.browser.isListed(file));}
    catch (error) {event.preventDefault(); this.browser.error.set(error instanceof Error ? error.message : '檔案列表已更新，請重新拖曳。');}
  }
  search(): void {void this.browser.search(this.searchDraft());}
}
