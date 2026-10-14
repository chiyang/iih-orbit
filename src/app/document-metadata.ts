import type { DocumentSource } from './models.ts';
import { documentIdentity } from './document-data.ts';

export interface DocumentMetadata {
  name: string;
  location?: string;
  status: 'available' | 'offline' | 'unavailable';
  checkedAt: string;
}
/** Rebuildable display cache. It never writes workspace records or creates backup versions. */
export class DocumentMetadataCache {
  private generation = '';
  private readonly values = new Map<string, DocumentMetadata>();
  private context(generation: string): void {
    if (this.generation === generation) return;
    this.values.clear(); this.generation = generation;
  }
  get(generation: string, source: DocumentSource): DocumentMetadata | undefined {
    this.context(generation);
    const value = this.values.get(documentIdentity(source));
    return value ? {...value} : undefined;
  }
  set(generation: string, source: DocumentSource, value: DocumentMetadata): void {
    this.context(generation);
    if (!value.name.trim() || value.name.length > 300 || value.location !== undefined && value.location.length > 1500
      || !['available', 'offline', 'unavailable'].includes(value.status) || !Number.isFinite(Date.parse(value.checkedAt))) throw new Error('文件顯示資訊不完整。');
    this.values.set(documentIdentity(source), {name: value.name, ...(value.location === undefined ? {} : {location: value.location}), status: value.status, checkedAt: value.checkedAt});
    while (this.values.size > 1000) this.values.delete(this.values.keys().next().value!);
  }
}
