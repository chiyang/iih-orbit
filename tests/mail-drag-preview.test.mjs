import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {createMailDragPreview} from '../src/app/mail-drag-preview.ts';

const css = readFileSync(new URL('../src/mail-drag-preview.css', import.meta.url), 'utf8');
const mail = {senderName: '王小明 <img src=x onerror=alert(1)>', senderEmail: 'sender@example.test', subject: '會議邀請 <script>alert(1)</script>'};
const page = () => new JSDOM(`<style>${css}</style><article id="source" style="font-size:12px">郵件</article>`);
const drag = (document, dataTransfer = {}) => ({currentTarget: document.querySelector('#source'), clientX: 100, clientY: 120, dataTransfer});

test('原生拖曳影像失效時仍顯示真正的半透明郵件卡片；游標移動、邊界與離開視窗可處理', () => {
  const dom = page(), {document} = dom.window;
  let nativeCalls = 0;
  const cleanup = createMailDragPreview(drag(document, {setDragImage(image) {nativeCalls++; assert.equal(image.isConnected, true); throw new Error('native preview unavailable');}}), mail);
  try {
    const preview = document.querySelector('.mail-drag-preview'), style = dom.window.getComputedStyle(preview);
    assert.equal(nativeCalls, 1); assert.equal(preview.isConnected, true);
    assert.equal(style.position, 'fixed'); assert.equal(style.pointerEvents, 'none'); assert.equal(Number(style.opacity), .8); assert.equal(style.width, '300px');
    assert.equal(preview.querySelector('strong').textContent, mail.senderName);
    assert.equal(preview.querySelector('.mail-drag-email').textContent, mail.senderEmail);
    assert.equal(preview.querySelector('.mail-drag-subject').textContent, mail.subject);
    assert.equal(preview.querySelector('img, script'), null); assert.equal(preview.style.fontSize, '14px');
    assert.equal(preview.style.transform, 'translate3d(120px, 140px, 0)');
    const over = new dom.window.MouseEvent('dragover', {clientX: 400, clientY: 300, bubbles: true, cancelable: true});
    document.body.dispatchEvent(over);
    assert.equal(over.defaultPrevented, false); assert.equal(preview.style.transform, 'translate3d(420px, 320px, 0)');
    document.body.dispatchEvent(new dom.window.MouseEvent('dragover', {clientX: 1000, clientY: 760, bubbles: true}));
    assert.equal(preview.style.transform, 'translate3d(680px, 622px, 0)');
    document.body.dispatchEvent(new dom.window.MouseEvent('dragleave', {clientX: 0, clientY: 0, bubbles: true}));
    assert.equal(preview.style.visibility, 'hidden');
    document.body.dispatchEvent(over); assert.equal(preview.style.visibility, 'visible');
    document.body.dispatchEvent(new dom.window.Event('drop', {bubbles: true}));
    assert.equal(document.querySelector('.mail-drag-preview, .mail-drag-native-image'), null);
    const lastPosition = preview.style.transform; document.body.dispatchEvent(new dom.window.MouseEvent('dragover', {clientX: 200, clientY: 200, bubbles: true}));
    assert.equal(preview.style.transform, lastPosition);
  } finally {cleanup(); dom.window.close();}
});

test('取消拖曳、頁面離開與重複清理移除卡片；未支援 setDragImage 時仍可顯示', () => {
  const dom = page(), {document} = dom.window;
  try {
    for (const finish of ['dragend', 'pagehide', 'manual']) {
      const cleanup = createMailDragPreview(drag(document), mail);
      assert.equal(document.querySelectorAll('.mail-drag-preview').length, 1);
      if (finish === 'pagehide') dom.window.dispatchEvent(new dom.window.Event(finish));
      else if (finish === 'dragend') document.body.dispatchEvent(new dom.window.Event(finish, {bubbles: true}));
      else cleanup();
      cleanup(); assert.equal(document.querySelector('.mail-drag-preview, .mail-drag-native-image'), null);
    }
  } finally {dom.window.close();}
});
