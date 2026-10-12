import '@angular/compiler';
import {DOCUMENT} from '@angular/common';
import {createEnvironmentInjector, ElementRef, runInInjectionContext, signal, ɵChangeDetectionScheduler, ɵEffectScheduler} from '@angular/core';
import assert from 'node:assert/strict';
import {after, test} from 'node:test';
import {createRequire} from 'node:module';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {JSDOM} from 'jsdom';

const require = createRequire(import.meta.url), {build} = createRequire(require.resolve('@angular/build/package.json'))('esbuild');
await mkdir('.angular', {recursive: true});
const directory = await mkdtemp(resolve('.angular/toolbar-interaction-test-')), output = resolve(directory, 'toolbar.mjs');
await build({stdin: {contents: "export {Tooltip} from './src/app/tooltip.ts'; export {CloudLogoutConfirm} from './src/app/cloud-logout-confirm.ts'; export {GoogleConnections} from './src/app/google-connections.ts';", resolveDir: process.cwd()}, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: output, tsconfig: 'tsconfig.json'});
const {Tooltip, CloudLogoutConfirm, GoogleConnections} = await import(pathToFileURL(output).href);
after(() => rm(directory, {recursive: true, force: true}));

function environment(providers = []) {
  const effects = new Set(), scheduler = {add(effect) {effects.add(effect);}, schedule() {}, remove(effect) {effects.delete(effect);}};
  const injector = createEnvironmentInjector([...providers, {provide: ɵEffectScheduler, useValue: scheduler}, {provide: ɵChangeDetectionScheduler, useValue: {notify() {}}}]);
  return {injector, flush() {for (let round = 0; round < 30 && [...effects].some(effect => effect.dirty); round++) for (const effect of effects) if (effect.dirty) effect.run();}, close() {injector.destroy();}};
}

function logoutDialog() {
  const connections = {store: {generation: signal('generation'), google: signal({clientId: 'client'}), drive: signal({accountId: 'account'}), cloudResume: signal(undefined)}, drive: {online: signal(true), auth: {connected: signal(true)}, runtime: signal({link: {datasetId: 'dataset'}})}, busy: signal(false), loggingOut: signal(false), error: signal(''), cleanupError: signal(''), message: signal('登出完成')};
  let calls = 0;
  connections.logout = async () => {calls++; connections.store.cloudResume.set({datasetId: 'dataset'});};
  const f = environment([{provide: GoogleConnections, useValue: connections}]);
  const serverMode = globalThis.ngServerMode; globalThis.ngServerMode = true;
  let dialog;
  try {dialog = runInInjectionContext(f.injector, () => new CloudLogoutConfirm());}
  finally {if (serverMode === undefined) delete globalThis.ngServerMode; else globalThis.ngServerMode = serverMode;}
  const busy = [], results = []; let closed = 0;
  dialog.busyChange.subscribe(value => busy.push(value)); dialog.result.subscribe(value => results.push(value)); dialog.close.subscribe(() => {closed++;});
  return {...f, connections, dialog, busy, results, calls: () => calls, closed: () => closed};
}

test('登出確認視窗開啟或取消不開始備份；只有確認後成功才關閉', async () => {
  const f = logoutDialog();
  try {
    assert.equal(f.calls(), 0); assert.equal(f.dialog.canConfirm(), true);
    f.dialog.close.emit(); assert.equal(f.calls(), 0); assert.equal(f.connections.store.cloudResume(), undefined);
    await f.dialog.confirm(); assert.equal(f.calls(), 1); assert.equal(f.closed(), 2);
    assert.deepEqual(f.results, ['登出完成']); assert.equal(f.busy[0], true); assert.equal(f.busy.at(-1), false);
  } finally {f.close();}
});

test('登出確認阻止重複點擊；處理期間保持忙碌，失敗留在視窗且可重試', async () => {
  const f = logoutDialog(); let finish, calls = 0;
  try {
    f.connections.logout = async () => {calls++; await new Promise(resolve => {finish = resolve;}); f.connections.error.set('上傳失敗，本機資料保留');};
    const saving = f.dialog.confirm(); assert.equal(f.dialog.busy(), true); assert.equal(f.dialog.canConfirm(), false);
    await f.dialog.confirm(); assert.equal(calls, 1); finish(); await saving;
    assert.equal(f.closed(), 0); assert.equal(f.connections.store.cloudResume(), undefined); assert.match(f.dialog.error(), /本機資料保留/);
    assert.equal(f.dialog.busy(), false); assert.equal(f.dialog.canConfirm(), true);
    f.connections.error.set(''); f.connections.logout = async () => {throw new Error('連線中斷');};
    await f.dialog.confirm(); assert.equal(f.closed(), 0); assert.match(f.dialog.error(), /連線中斷/);
  } finally {f.close();}
});

test('確認前離線、失去授權或切換集合會停用；開啟舊視窗不操作新集合', async () => {
  const f = logoutDialog();
  try {
    f.connections.drive.online.set(false); await f.dialog.confirm(); assert.equal(f.calls(), 0);
    f.connections.drive.online.set(true); f.connections.drive.auth.connected.set(false); await f.dialog.confirm(); assert.equal(f.calls(), 0);
    f.connections.drive.auth.connected.set(true); f.connections.drive.runtime.set({link: {datasetId: 'another'}});
    assert.equal(f.dialog.stale(), true); await f.dialog.confirm(); assert.equal(f.calls(), 0);
  } finally {f.close();}
});

test('tooltip 支援鍵盤及動態狀態、保留既有說明關聯，以純文字顯示且不超出視窗', () => {
  const dom = new JSDOM('<button aria-describedby="existing">同步</button>'), document = dom.window.document, button = document.querySelector('button');
  const f = environment([{provide: DOCUMENT, useValue: document}, {provide: ElementRef, useValue: new ElementRef(button)}]);
  const tooltip = runInInjectionContext(f.injector, () => new Tooltip()); tooltip.text = signal('立即同步 <img src=x>'); f.flush();
  try {
    button.getBoundingClientRect = () => ({left: 1010, top: 740, bottom: 770, width: 24});
    tooltip.focus(); const tip = document.querySelector('[role="tooltip"]');
    assert.equal(tip.textContent, '立即同步 <img src=x>'); assert.equal(tip.querySelector('img'), null);
    tip.getBoundingClientRect = () => ({width: 240, height: 60}); tooltip.text.set('同步完成'); f.flush();
    assert.equal(tip.textContent, '同步完成'); assert.equal(tip.querySelector('img'), null);
    assert.equal(button.getAttribute('aria-describedby'), 'existing ' + tip.id);
    assert.ok(parseFloat(tip.style.left) + 240 <= dom.window.innerWidth - 8); assert.equal(tip.style.top, '672px');
    tooltip.escape(); assert.equal(document.querySelector('[role="tooltip"]'), null); assert.equal(button.getAttribute('aria-describedby'), 'existing');
    tooltip.focus(); tooltip.text.set(''); f.flush(); assert.equal(document.querySelector('[role="tooltip"]'), null);
    tooltip.text.set('新的提醒'); tooltip.focus(); document.dispatchEvent(new dom.window.Event('scroll')); assert.equal(document.querySelector('[role="tooltip"]'), null);
    tooltip.focus(); tooltip.ngOnDestroy(); assert.equal(document.querySelector('[role="tooltip"]'), null); assert.equal(button.getAttribute('aria-describedby'), 'existing');
  } finally {tooltip.ngOnDestroy(); f.close(); dom.window.close();}
});
