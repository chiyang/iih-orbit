import type {DocumentSource} from './models.ts';
import {createSourceDragPreview} from './source-drag-preview.ts';

export function createDocumentDragPreview(event: DragEvent, source: DocumentSource, onEnd: () => void): () => void {
  return createSourceDragPreview(event, source.name, onEnd);
}
