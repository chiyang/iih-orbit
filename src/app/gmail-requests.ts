import { GoogleHttpError } from './google-api.ts';

export type GmailRequest = (path: string, parameters?: Record<string, string>, signal?: AbortSignal) => Promise<unknown>;
const cancelledMail = (signal?: AbortSignal): Error => signal?.reason instanceof Error ? signal.reason : new DOMException('Gmail 讀取已取消。', 'AbortError');
export function assertMailActive(signal?: AbortSignal, current: () => boolean = () => true): void {
  if (signal?.aborted) throw cancelledMail(signal);
  if (!current()) throw new DOMException('Gmail 讀取已取消。', 'AbortError');
}
function pauseMail(milliseconds: number, signal?: AbortSignal): Promise<void> {
  assertMailActive(signal);
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', cancel); resolve(); };
    const cancel = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(cancelledMail(signal)); };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener('abort', cancel, {once: true});
  });
}
/** One limit for list, nested label pages, threads and full-body reads together. GETs only. */
export class GmailReadQueue {
  private running = 0;
  private readonly waiting = new Set<() => void>();
  private cooldownUntil = 0;
  constructor(private readonly request: GmailRequest) {}
  async read(path: string, parameters?: Record<string, string>, signal?: AbortSignal, current: () => boolean = () => true): Promise<unknown> {
    while (this.running >= 4) {
      assertMailActive(signal, current);
      await new Promise<void>((resolve, reject) => {
        const wake = () => { this.waiting.delete(wake); signal?.removeEventListener('abort', cancel); resolve(); };
        const cancel = () => { this.waiting.delete(wake); signal?.removeEventListener('abort', cancel); reject(cancelledMail(signal)); };
        this.waiting.add(wake); signal?.addEventListener('abort', cancel, {once: true});
      });
    }
    assertMailActive(signal, current); this.running++;
    try {
      for (let attempt = 0;; attempt++) {
        // A limit seen by one worker pauses the others before their next request, too.
        while (this.cooldownUntil > Date.now()) { await pauseMail(this.cooldownUntil - Date.now(), signal); assertMailActive(signal, current); }
        assertMailActive(signal, current);
        try {
          const result = await this.request(path, parameters, signal);
          assertMailActive(signal, current); return result;
        } catch (error) {
          // Expired credentials intentionally change the connection version in GoogleAuth.
          if (error instanceof GoogleHttpError && error.status === 401 && !signal?.aborted) throw error;
          assertMailActive(signal, current);
          if (!(error instanceof GoogleHttpError) || !error.retryable || attempt >= 2 || error.retryAfterMs > 10000) throw error;
          // Respect a short server retry hint; longer limits need a later manual refresh.
          const delay = Math.max(1000 * 2 ** attempt + Math.random() * 250, error.retryAfterMs);
          this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + delay);
        }
      }
    } finally { this.running--; for (const wake of [...this.waiting]) wake(); }
  }
}
