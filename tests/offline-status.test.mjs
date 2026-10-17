import '@angular/compiler';
import {createEnvironmentInjector, runInInjectionContext, signal} from '@angular/core';
import assert from 'node:assert/strict';
import {after, test} from 'node:test';
import {createRequire} from 'node:module';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const require = createRequire(import.meta.url), {build} = createRequire(require.resolve('@angular/build/package.json'))('esbuild');
await mkdir('.angular', {recursive: true});
const directory = await mkdtemp(resolve('.angular/offline-status-test-')), output = resolve(directory, 'status.mjs');
await build({stdin: {contents: "export {OfflineStatus} from './src/app/offline-status.ts'; export {BoardStore} from './src/app/board-store.ts';", resolveDir: process.cwd()}, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: output, tsconfig: 'tsconfig.json'});
const {OfflineStatus, BoardStore} = await import(pathToFileURL(output).href);
after(() => rm(directory, {recursive: true, force: true}));

test('offline readiness waits for activation and local save failures remain distinct', async () => {
  const originals = new Map(['window', 'navigator', 'document'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const window = Object.assign(new EventTarget(), {isSecureContext: true, setInterval: () => 0});
  const worker = Object.assign(new EventTarget(), {state: 'activating'});
  const registration = Object.assign(new EventTarget(), {active: worker, installing: null, waiting: null});
  const store = {storageLoading: signal(false), pendingWrites: signal(0), hasUnsavedChanges: signal(false), storageWarning: signal('')};
  let injector;
  try {
    Object.defineProperty(globalThis, 'window', {configurable: true, value: window});
    Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {onLine: true, serviceWorker: {register: async () => registration}}});
    Object.defineProperty(globalThis, 'document', {configurable: true, value: {baseURI: 'https://example.test/iih-orbit/'}});
    injector = createEnvironmentInjector([{provide: BoardStore, useValue: store}]);
    const status = runInInjectionContext(injector, () => new OfflineStatus());
    await status.retry();
    assert.equal(status.ready(), false);
    worker.state = 'activated'; worker.dispatchEvent(new Event('statechange'));
    assert.equal(status.ready(), true);
    store.pendingWrites.set(1); assert.match(status.localStatus(), /正在保存/);
    store.pendingWrites.set(0); store.hasUnsavedChanges.set(true); assert.match(status.localStatus(), /保存未完成/);
    store.hasUnsavedChanges.set(false); assert.equal(status.localStatus(), '任務已存於此裝置');
    navigator.onLine = false; window.dispatchEvent(new Event('offline'));
    assert.equal(status.online(), false); assert.equal(status.ready(), true);
    const next = Object.assign(new EventTarget(), {state: 'installing'});
    registration.installing = next; registration.dispatchEvent(new Event('updatefound'));
    registration.waiting = next; next.state = 'installed'; next.dispatchEvent(new Event('statechange'));
    assert.equal(status.updateAvailable(), true); assert.equal(status.ready(), true);
    assert.equal(worker.state, 'activated');
  } finally {
    injector?.destroy();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
});
