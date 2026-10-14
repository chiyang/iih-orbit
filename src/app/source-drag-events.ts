export interface SourceDragPointer {clientX: number; clientY: number; dataTransfer: DataTransfer}

export function sourceDataTransfer(document: Document): DataTransfer {
  const window = document.defaultView as (Window & typeof globalThis) | null;
  try {if (window?.DataTransfer) return new window.DataTransfer();} catch { /* Use the same private payload contract on browsers without a constructor. */ }
  const values = new Map<string, string>();
  return {
    dropEffect: 'none', effectAllowed: 'copy',
    get types() {return [...values.keys()];},
    setData: (type: string, value: string) => {values.set(type, value);},
    getData: (type: string) => values.get(type) ?? '',
    clearData: (type?: string) => {if (type) values.delete(type); else values.clear();},
    setDragImage: () => {}
  } as unknown as DataTransfer;
}

export function sourceDragEvent(document: Document, type: string, pointer: SourceDragPointer, relatedTarget: EventTarget | null = null): DragEvent {
  const window = document.defaultView as (Window & typeof globalThis) | null;
  const options = {bubbles: true, cancelable: true, clientX: pointer.clientX, clientY: pointer.clientY, dataTransfer: pointer.dataTransfer, relatedTarget};
  try {if (window?.DragEvent) return new window.DragEvent(type, options);} catch { /* Some mobile engines do not accept a constructed DataTransfer. */ }
  const event = new window!.MouseEvent(type, options);
  Object.defineProperty(event, 'dataTransfer', {value: pointer.dataTransfer});
  return event as DragEvent;
}
