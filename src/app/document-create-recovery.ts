import {sourceOpenUrl} from './source-file-type';
import {Component, computed, effect, inject, input, signal, untracked} from '@angular/core';
import {DocumentCreateService} from './document-create-service';

@Component({
  selector: 'app-document-create-recovery', styleUrl: './document-create.css',
  template: `@if (operations().length) {<section class="recovery" aria-label="待接續的文件建立"><h3>待接續的文件建立</h3><p>先查核 Google 的結果或重新加入已有文件，不會再次送出建立要求。紀錄只保存在此瀏覽器。</p>
    @for (operation of operations(); track operation.id) {<article><strong>{{ operation.name }}</strong><p>{{ operation.taskTitle }} · {{ operation.sourceName }} / {{ operation.folder.name }}</p><p>{{ operation.message }}</p>
      @if (operation.result; as source) {<a [href]="openUrl(source)" target="_blank" rel="noopener noreferrer">開啟 {{ source.name }} ↗</a>}
      @for (source of operation.matches || []; track source.id) {<a [href]="openUrl(source)" target="_blank" rel="noopener noreferrer">核對 {{ source.name }} ↗</a>}
      <div class="actions"><button type="button" [disabled]="creation.busy()" (click)="creation.recover(operation)">{{ operation.result ? '重新加入原任務' : '查核建立結果' }}</button><button type="button" [disabled]="creation.busy()" (click)="confirming.set(confirming() === operation.id ? '' : operation.id)">結束這次接續</button></div>
      @if (confirming() === operation.id) {<div class="confirmation"><p>請先到 Google Drive 確認結果。結束接續只關閉這次紀錄；原檔與已保存連結保留。若另建文件，可能產生重複檔案。</p><div class="actions"><button type="button" (click)="confirming.set('')">保留紀錄</button><button type="button" [disabled]="creation.busy()" (click)="creation.closeRecord(operation); confirming.set('')">已核對 Drive，結束接續</button></div></div>}
    </article>}
  </section>}`
})
export class DocumentCreateRecovery {
  readonly openUrl = sourceOpenUrl;
  readonly creation = inject(DocumentCreateService);
  readonly taskId = input('');
  readonly operations = computed(() => this.creation.pending().filter(operation => !this.taskId() || operation.taskId === this.taskId()));
  readonly confirming = signal('');
  constructor() {effect(() => {const operations = this.operations(); untracked(() => {for (const operation of operations) void this.creation.prepare(operation.profileId, operation.folder.id !== 'root');});});}
}
