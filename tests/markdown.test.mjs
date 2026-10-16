import '@angular/compiler';
import {createEnvironmentInjector, runInInjectionContext, signal} from '@angular/core';
import assert from 'node:assert/strict';
import {after, test} from 'node:test';
import {createRequire} from 'node:module';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {JSDOM} from 'jsdom';

const require = createRequire(import.meta.url), {build} = createRequire(require.resolve('@angular/build/package.json'))('esbuild');
await mkdir('.angular', {recursive: true});
const directory = await mkdtemp(resolve('.angular/markdown-test-')), output = resolve(directory, 'markdown.mjs');
await build({stdin: {contents: "export * from './src/app/rich-content-data.ts'; export {MarkdownEditor} from './src/app/markdown-editor.ts'; export {mailTask, readMailPreview, gmailMessageLink} from './src/app/gmail-data.ts';", resolveDir: process.cwd()}, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: output, tsconfig: 'tsconfig.json'});
const {renderMarkdown, sanitizeRichHtml, sanitizeMailHtml, MarkdownEditor, mailTask, readMailPreview, gmailMessageLink} = await import(pathToFileURL(output).href);
after(() => rm(directory, {recursive: true, force: true}));
const dom = new JSDOM('<!doctype html><html><body></body></html>'); after(() => dom.window.close());
const rendered = html => JSDOM.fragment(html);

test('Markdown 預覽支援標題、清單、勾選、表格與可點擊的連結，舊純文字換行及網址仍可閱讀', () => {
  const html = rendered(renderMarkdown('## 活動準備\n\n- [x] 完成報名\n- [ ] 整理資料\n\n|日期|時段|\n|---|---|\n|10/15|14:00|\n\n[在 Gmail 開啟](https://mail.google.com/)\n\n原有描述第一行\n第二行 https://example.test/notes', dom.window));
  assert.equal(html.querySelector('h2').textContent, '活動準備'); assert.equal(html.querySelectorAll('li').length, 2); assert.match(html.textContent, /☑ 完成報名/); assert.match(html.textContent, /☐ 整理資料/); assert.equal(html.querySelector('td').textContent, '10/15');
  assert.deepEqual([...html.querySelectorAll('a')].map(a => a.href), ['https://mail.google.com/', 'https://example.test/notes']); assert.equal(html.querySelector('a').target, '_blank'); assert.equal(html.querySelector('a').rel, 'noopener noreferrer'); assert.ok(html.querySelector('br'));
});
test('不執行描述或郵件的腳本、表單、危險網址與 CSS，也不自動載入圖片或其他資源', () => {
  const attack = '<style>body{background:url(https://tracker.test/x)}</style><script>alert(1)</script><form action="https://evil.test"><input name="password"></form><iframe src="https://evil.test"></iframe><img src="https://tracker.test/pixel" onerror="alert(1)"><svg><a href="javascript:alert(1)">SVG</a></svg><table background="https://tracker.test"><tr><td style="position:fixed" onclick="alert(1)">活動資訊</td></tr></table><a id="location" href="javascript:alert(1)">危險</a><a href="https://example.test" target="_top" ping="https://tracker.test">正常</a>';
  const mail = rendered(sanitizeRichHtml(attack, dom.window));
  assert.equal(mail.querySelectorAll('script,style,form,input,iframe,img,svg,math,object,embed,link').length, 0); assert.equal(mail.querySelectorAll('[style],[onclick],[onerror],[src],[background],[ping],[id],[name]').length, 0);
  assert.equal(mail.querySelector('a').hasAttribute('href'), false); assert.equal(mail.querySelector('a[href]').target, '_blank'); assert.equal(mail.querySelector('a[href]').rel, 'noopener noreferrer'); assert.match(mail.textContent, /活動資訊/);
  const markdown = rendered(renderMarkdown('[危險](javascript:alert%281%29)\n\n![圖片](https://tracker.test/pixel)\n\n' + attack, dom.window));
  assert.equal(markdown.querySelectorAll('script,img,iframe,style,svg').length, 0); assert.equal(markdown.querySelector('a').hasAttribute('href'), false); assert.match(markdown.textContent, /圖片/);
});
test('郵件副本的寄件地址與原信連結可讀、可點；不將寄件內容誤解成 Markdown 或任意 HTML', () => {
  const mail = readMailPreview({id: 'mail', threadId: 'thread', internalDate: '1000', labelIds: [], snippet: '[假連結](https://evil.test) <img src="https://tracker.test">', payload: {headers: [{name: 'From', value: '"**客服**" <sender@example.test>'}, {name: 'Subject', value: '**活動**'}, {name: 'Message-ID', value: '<mail@example.test>'}]}});
  const task = mailTask(mail, 'me@example.test', {id: 'new', title: '', description: '', categoryId: '', projectId: '', status: 'todo', priority: 'medium', startDate: '', startTime: '', dueDate: '', dueTime: '', subtasks: []});
  const html = rendered(renderMarkdown(task.description, dom.window));
  assert.match(html.textContent, /\*\*客服\*\* <sender@example.test>/); assert.match(html.textContent, /\[假連結\]/); assert.equal([...html.querySelectorAll('a')].some(link => link.textContent === '假連結'), false); assert.equal([...html.querySelectorAll('a')].find(link => link.textContent === '在 Gmail 開啟原信 ↗').href, gmailMessageLink(mail, 'me@example.test'));  assert.equal(html.querySelector('img'), null); assert.ok(task.description.length <= 2000);
});
test('Markdown 編輯／預覽／放大共用原始草稿；格式工具只改選取文字，不提交表單或丟失內容', () => {
  const injector = createEnvironmentInjector([]);
  const serverMode = globalThis.ngServerMode; globalThis.ngServerMode = true;
  try {
    const editor = runInInjectionContext(injector, () => new MarkdownEditor()); editor.value = signal('任務描述與原信連結'); editor.initialMode = signal('preview');
    let changes = 0, prevented = 0;
    editor.valueChange.subscribe(value => {changes++; editor.value.set(value);}); assert.equal(editor.mode(), 'preview');
    const link = rendered('<a href="https://example.test"><span>連結</span></a>').querySelector('span');
    editor.editPreview({target: link, preventDefault() {prevented++;}}); assert.equal(editor.mode(), 'preview'); assert.equal(prevented, 0);
    editor.editPreview({target: dom.window.document.createElement('p'), preventDefault() {prevented++;}});
    assert.equal(editor.mode(), 'edit'); assert.equal(prevented, 1); assert.equal(editor.expanded(), false); assert.equal(changes, 0);
    const textarea = dom.window.document.createElement('textarea'); dom.window.document.body.append(textarea); textarea.value = editor.value(); textarea.setSelectionRange(0, 4); editor.textarea = () => ({nativeElement: textarea});
    editor.insert('bold'); assert.equal(editor.value(), '**任務描述**與原信連結'); assert.equal(textarea.value.slice(textarea.selectionStart, textarea.selectionEnd), '任務描述');
    editor.mode.set('preview'); editor.expanded = signal(false); editor.expandedChange.subscribe(value => editor.expanded.set(value));
    editor.setExpanded(true); assert.equal(editor.mode(), 'edit'); assert.equal(editor.expanded(), true); assert.equal(dom.window.document.activeElement, textarea);
    const focusControl = dom.window.document.createElement('button'); dom.window.document.body.append(focusControl); editor.focusControl = () => ({nativeElement: focusControl});
    editor.setExpanded(false); assert.equal(editor.expanded(), false); assert.equal(dom.window.document.activeElement, focusControl);
    assert.equal(editor.value(), '**任務描述**與原信連結'); assert.equal(editor.value(), textarea.value); assert.equal(changes, 1);
    textarea.remove(); focusControl.remove();
  } finally {injector.destroy(); if (serverMode === undefined) delete globalThis.ngServerMode; else globalThis.ngServerMode = serverMode;}
});

test('郵件排版表格去除空白欄與巢狀框線，保留內文順序、連結及真正的表格標頭', () => {
  const html = rendered(sanitizeMailHtml('<table><tr><td></td><td><table><tr><td>登入通知</td></tr><tr><td><a href="https://example.test/security">查看活動</a></td></tr></table></td><td><img src="https://tracker.test/pixel"></td></tr></table><table><tr><th>日期</th><th>時段</th></tr><tr><td>10/15</td><td>14:00</td></tr></table>', dom.window));
  assert.equal(html.querySelectorAll('table').length, 1); assert.equal(html.querySelector('th').textContent, '日期');
  assert.ok(html.textContent.indexOf('登入通知') < html.textContent.indexOf('查看活動')); assert.equal(html.querySelector('a').href, 'https://example.test/security');
  assert.equal(html.querySelector('img'), null); assert.equal(html.querySelectorAll('[style],[src]').length, 0);
});

test('描述 Tab 保留焦點並插入縮排，多行可縮排與反縮排；Escape 後 Tab 可離開', () => {
  const injector = createEnvironmentInjector([]), oldMode = globalThis.ngServerMode; globalThis.ngServerMode = true;
  try {
    const editor = runInInjectionContext(injector, () => new MarkdownEditor()); editor.value = signal('abc');
    const textarea = dom.window.document.createElement('textarea'); textarea.value = 'abc'; textarea.setSelectionRange(1, 1);
    editor.valueChange.subscribe(value => editor.value.set(value));
    const press = (key, shiftKey = false) => {const event = new dom.window.KeyboardEvent('keydown', {key, shiftKey, cancelable: true}); Object.defineProperty(event, 'target', {value: textarea}); editor.keydown(event); return event;};
    assert.equal(press('Tab').defaultPrevented, true); assert.equal(textarea.value, 'a  bc'); assert.equal(editor.value(), textarea.value); assert.equal(textarea.selectionStart, 3);
    textarea.value = '- a\n- b\nnext'; textarea.setSelectionRange(0, 8);
    press('Tab'); assert.equal(textarea.value, '  - a\n  - b\nnext'); assert.equal(textarea.value.slice(textarea.selectionStart, textarea.selectionEnd), '- a\n  - b\n');
    press('Tab', true); assert.equal(textarea.value, '- a\n- b\nnext');
    press('Escape'); assert.equal(press('Tab').defaultPrevented, false); assert.equal(press('Tab').defaultPrevented, true);
    textarea.value = 'x'.repeat(20000); textarea.setSelectionRange(10, 10); press('Tab'); assert.equal(textarea.value.length, 20000);
    textarea.value = '\nline'; textarea.setSelectionRange(0, 1); press('Tab'); assert.equal(textarea.value, '  \nline');
  } finally {injector.destroy(); if (oldMode === undefined) delete globalThis.ngServerMode; else globalThis.ngServerMode = oldMode;}
});
