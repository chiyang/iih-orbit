import {Component, computed, effect, inject, OnDestroy, output, signal, untracked} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {DriveBrowserConnection} from './drive-browser-connection';
import {DriveSourceConnection} from './drive-source-connection';
import {GoogleConnections} from './google-connections';
import {DocumentMetadataService} from './document-metadata-service';
import {DocumentCreateService} from './document-create-service';
import {DocumentCreateRecovery} from './document-create-recovery';

@Component({
  selector: 'app-drive-browser-settings', imports: [FormsModule, DocumentCreateRecovery], templateUrl: './drive-browser-settings.html',
  styleUrls: ['./google-settings.css', './google-connection.css', './drive-browser-settings.css']
})
export class DriveBrowserSettings implements OnDestroy {
  readonly connections = inject(GoogleConnections);
  readonly files = this.connections.files;
  readonly metadata = inject(DocumentMetadataService);
  readonly creation = inject(DocumentCreateService);
  readonly cleanupNotice = signal('');
  readonly cleanupPreview = this.creation.store.documentCleanupPreview;
  readonly cleanable = computed(() => this.cleanupPreview().filter(item => !item.reasons.length).length);
  readonly configure = output<void>();
  readonly saving = signal(false);
  readonly busy = computed(() => this.connections.busy() || this.saving() || this.creation.busy());
  readonly editId = signal<string | null>(null);
  readonly draftName = signal('');
  readonly draftClient = signal('');
  readonly removing = signal('');
  private readonly started = new Set<DriveBrowserConnection | DriveSourceConnection>();
  constructor() {
    effect(() => {const sources = this.files.sources(); sources.forEach(source => source.clientId()); untracked(() => {for (const source of sources) if (source.clientId()) void this.prepare(source);});});
  }
  async prepare(source: DriveBrowserConnection | DriveSourceConnection): Promise<void> {
    try {await source.prepare();}
    catch (error) {source.error.set(error instanceof Error ? error.message : '無法準備 Google Drive 連線。');}
  }
  async connect(source: DriveBrowserConnection | DriveSourceConnection, selectAccount = false): Promise<void> {
    if (this.busy()) return;
    this.started.add(source);
    try {if (source instanceof DriveSourceConnection) await source.connect(selectAccount); else await source.connect(undefined, undefined, selectAccount);}
    finally {this.started.delete(source);}
  }
  edit(source?: DriveBrowserConnection | DriveSourceConnection): void {
    this.editId.set(source?.id ?? ''); this.draftName.set(source?.name() ?? ''); this.draftClient.set(source?.clientId() ?? this.files.clientId());
    this.files.sourceError.set(''); this.files.sourceNotice.set('');
  }
  async save(): Promise<void> {
    const id = this.editId();
    if (id === null || this.busy()) return;
    this.saving.set(true);
    try {
      const saved = id ? await this.files.saveSource(id, this.draftName(), this.draftClient().trim()) : await this.files.addSource(this.draftName(), this.draftClient().trim());
      if (saved) {this.editId.set(null); this.files.sourceNotice.set(id ? '來源設定已保存。' : '來源已新增，請按「連線」選擇 Google 帳號。');}
    } finally {this.saving.set(false);}
  }
  async remove(): Promise<void> {
    const id = this.removing();
    if (!id || this.busy()) return;
    this.saving.set(true);
    try {if (await this.files.removeSource(id)) this.removing.set('');}
    finally {this.saving.set(false);}
  }
  async cleanDocuments(): Promise<void> {
    if (this.busy()) return;
    this.saving.set(true); this.cleanupNotice.set('正在重新核對來源引用…');
    try {const result = await this.creation.store.cleanUnusedDocumentSources(); this.cleanupNotice.set(result.ok ? `已整理 ${result.removed} 筆無使用來源。任務、歷史與雲端原檔保留。` : result.message);}
    finally {this.saving.set(false);}
  }
  ngOnDestroy(): void {for (const source of this.started) source.cancelAuthorization();}
}
