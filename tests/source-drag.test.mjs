import '@angular/compiler';
import assert from 'node:assert/strict';
import {after, test} from 'node:test';
import {createRequire} from 'node:module';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {JSDOM} from 'jsdom';

const require = createRequire(import.meta.url), {build} = createRequire(require.resolve('@angular/build/package.json'))('esbuild');
await mkdir('.angular', {recursive: true});
const directory = await mkdtemp(resolve('.angular/source-drag-test-')), output = resolve(directory, 'drag.mjs');
await build({stdin: {contents: "export {touchSourceDrag} from './src/app/source-touch-drag.ts'; export {sourceDragScroll,sourceScrollSpeed} from './src/app/source-drag-scroll.ts'; export {sourceDataTransfer,sourceDragEvent} from './src/app/source-drag-events.ts';", resolveDir: process.cwd()}, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: output, tsconfig: 'tsconfig.json'});
const {touchSourceDrag, sourceDragScroll, sourceScrollSpeed, sourceDataTransfer, sourceDragEvent} = await import(pathToFileURL(output).href);
after(() => rm(directory, {recursive: true, force: true}));

function page() {
  const dom = new JSDOM('<body><aside><article draggable="true"><button data-source-drag-handle><span>來源</span></button><a href="#">開啟連結</a><button class="add">加入任務</button></article></aside><main><div class="kanban-scroll"><div class="target">目的地</div></div></main></body>', {pretendToBeVisual: true});
  const {document} = dom.window, frames = new Map(); let serial = 0;
  Object.defineProperties(dom.window, {innerWidth: {value: 360}, innerHeight: {value: 600}});
  dom.window.requestAnimationFrame = callback => {frames.set(++serial, callback); return serial;}; dom.window.cancelAnimationFrame = id => frames.delete(id);
  const source = document.querySelector('article'), target = document.querySelector('.target'), scroller = document.querySelector('.kanban-scroll');
  document.elementFromPoint = () => target;
  const frame = (now = 16) => {const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(now);};
  const touch = (type, x = 100, y = 200, count = 1, element = source) => {
    const points = Array.from({length: count}, (_, index) => ({identifier: index + 1, clientX: x, clientY: y}));
    const event = new dom.window.Event(type, {bubbles: true, cancelable: true});
    Object.defineProperties(event, {touches: {value: type === 'touchend' ? [] : points}, changedTouches: {value: points}});
    element.dispatchEvent(event); return event;
  };
  return {dom, document, source, target, scroller, frames, frame, touch, close: () => dom.window.close()};
}

test('長按來源使用既有私有拖放資料，更新指標後只在可接受的目標放下一次並抑制點擊', t => {
  t.mock.timers.enable({apis: ['setTimeout', 'Date'], now: 10000});
  const p = page(); let starts = 0, ends = 0, drops = 0, clicks = 0, lastX = 0, leaves = 0;
  p.source.addEventListener('dragstart', event => {starts++; event.dataTransfer.setData('application/x-orbit-document', 'private-token');});
  p.source.addEventListener('dragend', () => ends++); p.source.addEventListener('click', () => clicks++);
  p.target.addEventListener('dragover', event => {lastX = event.clientX; event.preventDefault();});
  p.target.addEventListener('dragleave', event => {leaves++; assert.equal(event.relatedTarget, p.document.body);});
  p.target.addEventListener('drop', event => {assert.equal(event.dataTransfer.getData('application/x-orbit-document'), 'private-token'); drops++;});
  const stop = touchSourceDrag(p.source, () => true);
  try {
    p.touch('touchstart', 100, 200, 1, p.source.querySelector('span')); assert.equal(p.source.draggable, false);
    t.mock.timers.tick(419); assert.equal(starts, 0); t.mock.timers.tick(1); assert.equal(starts, 1); p.frame();
    assert.equal(p.touch('touchmove', 240, 400).defaultPrevented, true); assert.equal(lastX, 240);
    p.document.elementFromPoint = () => p.document.body; p.touch('touchmove', 240, 50); assert.equal(leaves, 1);
    p.document.elementFromPoint = () => p.target;
    assert.equal(p.touch('touchend', 260, 420).defaultPrevented, true); assert.equal(drops, 1); assert.equal(ends, 1); assert.equal(p.source.draggable, true);
    p.source.dispatchEvent(new p.dom.window.MouseEvent('click', {bubbles: true, cancelable: true, detail: 1})); assert.equal(clicks, 0);
    t.mock.timers.tick(500); p.source.click(); assert.equal(clicks, 1);
    stop(); assert.equal(p.frames.size, 0);
  } finally {stop(); p.close();}
});

test('短按、一般滑動、操作按鈕及多指手勢不建立任務，停用／取消／銷毀清理拖曳', t => {
  t.mock.timers.enable({apis: ['setTimeout'], now: 10000});
  const p = page(); let starts = 0, ends = 0, drops = 0, enabled = true;
  p.source.addEventListener('dragstart', event => {starts++; event.dataTransfer.setData('source', 'token');}); p.source.addEventListener('dragend', () => ends++);
  p.target.addEventListener('drop', () => drops++);
  const stop = touchSourceDrag(p.source, () => enabled);
  try {
    p.touch('touchstart'); p.touch('touchend'); t.mock.timers.tick(500); assert.equal(starts, 0);
    p.touch('touchstart'); assert.equal(p.touch('touchmove', 100, 220).defaultPrevented, false); t.mock.timers.tick(500); assert.equal(starts, 0);
    p.touch('touchstart', 100, 200, 1, p.source.querySelector('a')); t.mock.timers.tick(500); assert.equal(starts, 0);
    p.touch('touchstart', 100, 200, 1, p.source.querySelector('.add')); t.mock.timers.tick(500); assert.equal(starts, 0);
    p.touch('touchstart'); t.mock.timers.tick(420); p.touch('touchmove', 110, 220, 2); assert.equal(ends, 1); assert.equal(drops, 0);
    p.touch('touchstart'); enabled = false; t.mock.timers.tick(420); assert.equal(starts, 1); enabled = true;
    p.touch('touchstart'); t.mock.timers.tick(420); p.touch('touchcancel'); assert.equal(ends, 2);
    p.touch('touchstart'); t.mock.timers.tick(420); stop(); assert.equal(ends, 3); assert.equal(drops, 0); assert.equal(p.frames.size, 0);
    assert.equal(p.source.draggable, true);
  } finally {stop(); p.close();}
});

test('放在不可接受的目標或來源拒絕啟動時，不派送 drop', t => {
  t.mock.timers.enable({apis: ['setTimeout'], now: 10000});
  const p = page(); let drops = 0;
  p.source.addEventListener('dragstart', event => event.dataTransfer.setData('source', 'token')); p.target.addEventListener('drop', () => drops++);
  const stop = touchSourceDrag(p.source, () => true);
  try {p.touch('touchstart'); t.mock.timers.tick(420); p.touch('touchend'); assert.equal(drops, 0); stop();
    p.source.addEventListener('dragstart', event => event.preventDefault()); const stopRejected = touchSourceDrag(p.source, () => true);
    p.touch('touchstart'); t.mock.timers.tick(420); p.touch('touchend'); assert.equal(drops, 0); stopRejected();
  } finally {stop(); p.close();}
});

test('原地長按後直接放開只結束模式，不會意外建立或關聯底下的任務', t => {
  t.mock.timers.enable({apis: ['setTimeout'], now: 10000});
  const p = page(); let drops = 0, ends = 0;
  p.source.addEventListener('dragstart', event => event.dataTransfer.setData('source', 'token'));
  p.source.addEventListener('dragend', () => ends++); p.target.addEventListener('dragover', event => event.preventDefault()); p.target.addEventListener('drop', () => drops++);
  const stop = touchSourceDrag(p.source, () => true);
  try {p.touch('touchstart'); t.mock.timers.tick(420); p.frame(); p.touch('touchend', 103, 202); assert.equal(drops, 0); assert.equal(ends, 1);}
  finally {stop(); p.close();}
});

test('來源移除仍送出全頁結束訊號，放開前停用來源也不派送 drop', t => {
  t.mock.timers.enable({apis: ['setTimeout'], now: 10000});
  const p = page(); let documentEnds = 0, drops = 0, enabled = true;
  p.source.addEventListener('dragstart', event => event.dataTransfer.setData('source', 'token'));
  p.document.addEventListener('dragend', () => documentEnds++); p.target.addEventListener('dragover', event => event.preventDefault()); p.target.addEventListener('drop', () => drops++);
  const stop = touchSourceDrag(p.source, () => enabled);
  try {
    p.touch('touchstart'); t.mock.timers.tick(420); p.touch('touchmove', 240, 400); enabled = false; p.touch('touchend', 240, 400);
    assert.equal(documentEnds, 1); assert.equal(drops, 0); enabled = true;
    p.touch('touchstart'); t.mock.timers.tick(420); p.source.remove(); stop();
    assert.equal(documentEnds, 2); assert.equal(p.frames.size, 0); assert.equal(drops, 0);
  } finally {stop(); p.close();}
});

test('邊緣速度隨距離變化，中心、視圖外及零寬度不自動捲動', () => {
  assert.equal(sourceScrollSpeed(0, 0, 360), -320); assert.equal(sourceScrollSpeed(360, 0, 360), 320);
  assert.ok(sourceScrollSpeed(340, 0, 360) > sourceScrollSpeed(320, 0, 360));
  for (const point of [100, 180, 260, -50, 410]) assert.equal(sourceScrollSpeed(point, 0, 360), 0);
  assert.equal(sourceScrollSpeed(0, 0, 0), 0);
});

test('看板／月曆邊緣可持續水平捲動，週視圖可垂直捲動，捲動後更新放下位置且結束即停止', () => {
  const p = page(), scroller = p.scroller; let overs = 0;
  scroller.style.overflowX = 'auto'; scroller.style.overflowY = 'auto';
  scroller.getBoundingClientRect = () => ({left: 18, right: 342, top: 100, bottom: 550, width: 324, height: 450});
  Object.defineProperties(scroller, {clientWidth: {value: 324}, clientHeight: {value: 450}, scrollWidth: {value: 1000}, scrollHeight: {value: 1500}});
  const transfer = sourceDataTransfer(p.document); transfer.setData('source', 'private'); const stop = sourceDragScroll(p.document);
  p.target.addEventListener('dragover', () => overs++);
  try {
    p.target.dispatchEvent(sourceDragEvent(p.document, 'dragover', {clientX: 355, clientY: 540, dataTransfer: transfer}));
    p.frame(); const first = scroller.scrollLeft; assert.ok(first > 0); assert.ok(scroller.scrollTop > 0); assert.ok(overs > 1);
    p.frame(32); assert.ok(scroller.scrollLeft > first);
    scroller.scrollLeft = 999; p.frame(48); assert.equal(scroller.scrollLeft, 676);
    p.document.dispatchEvent(sourceDragEvent(p.document, 'dragend', {clientX: 355, clientY: 540, dataTransfer: transfer}));
    assert.equal(p.frames.size, 0); const after = scroller.scrollTop; p.frame(64); assert.equal(scroller.scrollTop, after);
  } finally {stop(); p.close();}
});
