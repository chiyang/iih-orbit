import '@angular/compiler';
import {createEnvironmentInjector, runInInjectionContext, signal, ɵEffectScheduler, ɵChangeDetectionScheduler} from '@angular/core';
import {DIALOG_DATA, Dialog, DialogRef} from '@angular/cdk/dialog';
import {Subject} from 'rxjs';
import assert from 'node:assert/strict';
import {after, test} from 'node:test';
import {createRequire} from 'node:module';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {documentFromUrl} from '../src/app/document-data.ts';
import {mailInformationSource} from '../src/app/mail-information-data.ts';

const require = createRequire(import.meta.url), {build} = createRequire(require.resolve('@angular/build/package.json'))('esbuild');
await mkdir('.angular', {recursive: true});
const directory = await mkdtemp(resolve('.angular/information-picker-test-')), output = resolve(directory, 'picker.mjs');
await build({stdin: {contents: "export {DocumentMetadataService} from './src/app/document-metadata-service.ts'; export {DriveFilePicker} from './src/app/drive-file-picker.ts'; export {DocumentLinksEditor} from './src/app/document-links-editor.ts'; export {DriveBrowser} from './src/app/drive-browser.ts';", resolveDir: process.cwd()}, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: output, tsconfig: 'tsconfig.json'});
const {DocumentMetadataService, DriveFilePicker, DocumentLinksEditor, DriveBrowser} = await import(pathToFileURL(output).href);
after(() => rm(directory, {recursive: true, force: true}));
const first = documentFromUrl('google-drive', 'https://docs.google.com/document/d/first/edit', '第一份'), second = documentFromUrl('google-drive', 'https://drive.google.com/drive/folders/second', '第二份'), mail = mailInformationSource({id: 'mail', subject: '郵件', from: 'sender@example.test', senderEmail: 'sender@example.test', messageId: '<mail@example.test>'}, 'me@example.test', 'account');
function fixture() {
  const effects = new Set(), context = signal('context'), primary = {id: 'default', context, connecting: signal(false)}, browser = {connection: {context, connecting: primary.connecting, sources: signal([primary])}, selectedConnection: () => primary, busy: signal(false)}, closures = [], opens = [];
  const ref = {closed: new Subject(), backdropClick: new Subject(), close(value) {closures.push(value); this.closed.next(value); this.closed.complete();}};
  const dialog = {open(component, config) {opens.push({component, config}); return ref;}};
  const injector = createEnvironmentInjector([{provide: DocumentMetadataService, useValue: {display: source => source}}, {provide: DriveBrowser, useValue: browser}, {provide: DialogRef, useValue: ref}, {provide: Dialog, useValue: dialog}, {provide: DIALOG_DATA, useValue: {value: [first, mail]}}, {provide: ɵEffectScheduler, useValue: {add: e => effects.add(e), schedule() {}, remove: e => effects.delete(e)}}, {provide: ɵChangeDetectionScheduler, useValue: {notify() {}}}]);
  globalThis.ngServerMode = true;
  let picker, editor;
  try {runInInjectionContext(injector, () => {picker = new DriveFilePicker(); editor = new DocumentLinksEditor();});} finally {delete globalThis.ngServerMode;}
  editor.value = signal([first, mail]); editor.known = signal([first, second, mail]); editor.descriptions = signal([]);
  const flush = () => {for (const effect of effects) if (effect.dirty) effect.run();}; flush();
  return {picker, editor, browser, ref, opens, closures, flush, close: () => injector.destroy()};
}
test('獨立選檔可新增、取消選取與取消整個視窗，取消不變更任務草稿', async () => {
  const f = fixture(), changes = [];
  try {
    f.editor.valueChange.subscribe(value => changes.push(value)); await f.editor.openPicker(); assert.equal(f.editor.pickerOpen(), true);
    f.picker.toggle(second); f.picker.toggle(first); assert.deepEqual(f.picker.selected().map(source => source.id), [second.id]);
    f.picker.cancel(); assert.equal(f.editor.pickerOpen(), false); assert.deepEqual(changes, []); assert.deepEqual(f.editor.value(), [first, mail]); assert.match(f.editor.notice(), /取消/);
  } finally {f.close();}
});
test('確認才加入草稿，保留 Gmail 資訊連結，結果與選取清單沒有共用可變陣列', async () => {
  const f = fixture(), changes = [];
  try {
    f.editor.valueChange.subscribe(value => changes.push(value)); await f.editor.openPicker(); f.picker.toggle(second); f.picker.confirm();
    assert.equal(changes.length, 1); assert.deepEqual(changes[0].map(source => source.id), [first.id, mail.id, second.id]); assert.equal(f.editor.pickerOpen(), false);
    changes[0][0].name = '修改草稿'; assert.equal(f.picker.selected()[0].name, first.name);
    assert.equal(f.opens[0].config.disableClose, true); assert.equal(f.opens[0].config.ariaModal, true);
  } finally {f.close();}
});

test('用途說明和拖曳／箭頭排序只改草稿，新選取附加末端，取消選檔保留混合順序與說明', async () => {
  const f = fixture();
  try {
    f.editor.valueChange.subscribe(value => f.editor.value.set(value));
    f.editor.descriptionsChange.subscribe(value => f.editor.descriptions.set(value));
    f.editor.describe(first.id, '閱讀第 2 節'); f.editor.move(0, 1);
    assert.deepEqual(f.editor.value().map(source => source.id), [mail.id, first.id]);
    assert.equal(f.editor.description(first.id), '閱讀第 2 節');
    f.editor.move(0, -1); f.editor.move(1, 2); assert.deepEqual(f.editor.value().map(source => source.id), [mail.id, first.id]);
    await f.editor.openPicker(); f.picker.toggle(second); f.picker.cancel();
    assert.deepEqual(f.editor.value().map(source => source.id), [mail.id, first.id]); assert.equal(f.editor.description(first.id), '閱讀第 2 節');
    f.editor.select(second); assert.equal(f.editor.value()[2].id, second.id); assert.equal(f.editor.description(second.id), '');
    f.editor.drop({previousIndex: 2, currentIndex: 0}); assert.deepEqual(f.editor.value().map(source => source.id), [second.id, mail.id, first.id]);
    f.editor.remove(first.id); f.editor.select(first); assert.equal(f.editor.description(first.id), '');
    assert.equal(first.name, '第一份'); assert.equal(mail.name, '郵件');
  } finally {f.close();}
});
test('Escape 只取消內層選檔，帳號更換丟棄尚未確認的新選取', async () => {
  const f = fixture(); let prevented = false, stopped = false;
  try {
    await f.editor.openPicker(); f.picker.toggle(second); f.browser.connection.context.set('another-account'); f.flush(); assert.deepEqual(f.picker.selected(), [first]); assert.match(f.picker.notice(), /帳號已更新/);
    f.picker.escape({preventDefault() {prevented = true;}, stopPropagation() {stopped = true;}}); assert.equal(prevented, true); assert.equal(stopped, true); assert.equal(f.editor.pickerOpen(), false); assert.deepEqual(f.editor.value(), [first, mail]);
  } finally {f.close();}
});
test('選檔切換不同來源保留已選項目，確認前來源帳號變更仍拒絕過期的新選取', () => {
  const f = fixture(), extra = {id: 'extra', context: signal('extra-account'), connecting: signal(false)};
  try {
    f.picker.toggle(second); f.browser.connection.sources.update(sources => [...sources, extra]); f.flush();
    f.browser.selectedConnection = () => extra;
    assert.deepEqual(f.picker.selected().map(source => source.id), [first.id, second.id]);
    extra.context.set('replacement-account'); f.picker.confirm();
    assert.deepEqual(f.closures, []); assert.deepEqual(f.picker.selected(), [first]); assert.match(f.picker.notice(), /帳號已更新/);
  } finally {f.close();}
});

test('選檔元件載入期間取消或離開任務，不會晚到開啟視窗', async () => {
  const f = fixture();
  const pending = f.editor.openPicker(); f.editor.cancelPicker(); await pending;
  assert.equal(f.editor.pickerOpen(), false); assert.equal(f.opens.length, 0);
  const reopening = f.editor.openPicker(); f.close(); await reopening; assert.equal(f.opens.length, 0);
});
