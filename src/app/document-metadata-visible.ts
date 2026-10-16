import {Directive, effect, ElementRef, inject, input} from '@angular/core';
import type {DocumentSource} from './models';
import {DocumentMetadataService} from './document-metadata-service';

/** Intersection is measured against all scroll ancestors, including the task modal. */
@Directive({selector: '[appDocumentMetadata]'})
export class DocumentMetadataVisible {
  readonly source = input.required<DocumentSource>({alias: 'appDocumentMetadata'});
  readonly preferred = input('', {alias: 'metadataSource'});
  private readonly element = inject(ElementRef<HTMLElement>);
  private readonly metadata = inject(DocumentMetadataService);
  constructor() {
    effect(onCleanup => {
      const source = this.source(), preferred = this.preferred(); this.metadata.contextRevision();
      if (source.provider !== 'google-drive' || source.sourceScope !== 'drive' || !source.fileId) return;
      const element = this.element.nativeElement, reference = this.metadata.watch(element, source, preferred);
      onCleanup(() => reference.stop());
    });
  }
}
