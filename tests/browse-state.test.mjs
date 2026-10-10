import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadBrowseState, readBrowseState, saveBrowseState } from '../src/app/browse-state.ts';

test('瀏覽狀態驗證日期與選項，隔離工作空間及重置，儲存失敗仍可使用預設畫面', () => {
  const values = new Map();
  globalThis.localStorage = {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value)};
  const state = readBrowseState({view: 'week', calendarDate: '2026-10-18', calendarScrollHour: 13.5, query: '會議', panel: 'gmail'});
  saveBrowseState('generation', 'first', state);
  saveBrowseState('generation', 'second', readBrowseState({view: 'list'}));
  assert.deepEqual(loadBrowseState('generation', 'first'), state); assert.equal(loadBrowseState('generation', 'second').view, 'list');
  assert.equal(loadBrowseState('other-generation', 'first').view, 'board');
  const invalid = readBrowseState({view: 'unknown', scope: 'unknown', calendarDate: '2026-02-30', calendarScrollHour: Infinity, deadlineDays: 50, sort: 'unknown', query: 'x'.repeat(1001)});
  assert.equal(invalid.view, 'board'); assert.equal(invalid.scope, 'all'); assert.notEqual(invalid.calendarDate, '2026-02-30');
  assert.equal(invalid.calendarScrollHour, 7.75); assert.equal(invalid.deadlineDays, null); assert.equal(invalid.sort, null); assert.equal(invalid.query, '');
  globalThis.localStorage = {getItem() {throw Error('blocked');}, setItem() {throw Error('blocked');}};
  assert.equal(loadBrowseState('generation', 'first').view, 'board'); assert.doesNotThrow(() => saveBrowseState('generation', 'first', state));
  delete globalThis.localStorage;
});
