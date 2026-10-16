import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadBrowseState, readBrowseState, saveBrowseState } from '../src/app/browse-state.ts';

test('甘特視圖的定位日期與尺度獨立保存在各工作空間，舊版偏好可直接使用', () => {
  const values = new Map(); globalThis.localStorage = {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value)};
  try {
    const state = readBrowseState({view: 'gantt', ganttDate: '2028-02-29', ganttScale: 'month', ganttZoom: 175, ganttCompletion: 'pending', ganttOrder: 'end', ganttRange: {start: '2028-02-20', end: '2028-03-15'}, calendarDate: '2026-10-16'});
    saveBrowseState('generation', 'first', state); saveBrowseState('generation', 'second', readBrowseState({ganttScale: 'week'}));
    assert.equal(loadBrowseState('generation', 'first').view, 'gantt'); assert.equal(loadBrowseState('generation', 'first').ganttDate, '2028-02-29');
    assert.equal(loadBrowseState('generation', 'first').ganttScale, 'month'); assert.equal(loadBrowseState('generation', 'first').calendarDate, '2026-10-16');
    assert.equal(loadBrowseState('generation', 'second').ganttScale, 'week'); assert.equal(loadBrowseState('new-generation', 'first').view, 'board');
    const restored = loadBrowseState('generation', 'first');
    assert.equal(restored.ganttZoom, 175); assert.equal(restored.ganttCompletion, 'pending'); assert.equal(restored.ganttOrder, 'end'); assert.deepEqual(restored.ganttRange, {start: '2028-02-20', end: '2028-03-15'});
    assert.equal(loadBrowseState('generation', 'second').ganttZoom, 100); assert.equal(loadBrowseState('new-generation', 'first').ganttRange, null);
    const invalid = readBrowseState({ganttZoom: Infinity, ganttCompletion: 'archived', ganttOrder: 'unknown', ganttRange: {start: '2026-10-20', end: '2026-10-01'}, ganttColorBy: 'status'});
    assert.equal(invalid.ganttZoom, 100); assert.equal(invalid.ganttCompletion, 'all'); assert.equal(invalid.ganttOrder, 'start'); assert.equal(invalid.ganttRange, null); assert.equal('ganttColorBy' in invalid, false);
    assert.equal(readBrowseState({}).ganttScale, 'day'); assert.equal(readBrowseState({ganttScale: 'year'}).ganttScale, 'day');
    assert.notEqual(readBrowseState({ganttDate: '2026-02-30'}).ganttDate, '2026-02-30');
    assert.equal(readBrowseState({ganttDate: '2026-10-16', ganttRange: {start: '2027-01-01', end: '2027-01-07'}}).ganttDate, '2027-01-01');
    assert.equal(readBrowseState({view: 'week'}).view, 'week');
  } finally {delete globalThis.localStorage;}
});

test('瀏覽狀態驗證日期與選項，隔離工作空間及重置，儲存失敗仍可使用預設畫面', () => {
  const values = new Map();
  globalThis.localStorage = {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value)};
  const state = readBrowseState({view: 'week', calendarDate: '2026-10-18', calendarScrollHour: 13.5, query: '會議', panel: 'tasks', headerCompact: true, trashOpen: true, pinnedOnly: true, recentOnly: true, deadline: 'this-week', reminderTab: 'this-week'});
  assert.equal(state.deadline, 'this-week'); assert.equal(state.reminderTab, 'this-week');
  assert.equal(state.panelTab, 'tasks'); assert.equal(state.headerCompact, true); assert.equal(state.trashOpen, true);
  assert.equal(readBrowseState({headerCompact: 'true', trashOpen: 1}).headerCompact, false); assert.equal(readBrowseState({}).trashOpen, false);
  assert.equal(readBrowseState({panel: 'gmail'}).panelTab, 'gmail');
  assert.equal(readBrowseState({panel: 'reminders'}).panelTab, 'reminders');
  assert.equal(readBrowseState({panel: 'closed', panelTab: 'gmail'}).panelTab, 'gmail');
  assert.equal(readBrowseState({panelTab: 'unknown'}).panelTab, 'tasks');
  saveBrowseState('generation', 'first', state);
  saveBrowseState('generation', 'second', readBrowseState({view: 'list', deadline: 'unset'}));
  assert.deepEqual(loadBrowseState('generation', 'first'), state); assert.equal(loadBrowseState('generation', 'second').view, 'list');
  assert.equal(loadBrowseState('generation', 'first').panel, 'tasks'); assert.equal(loadBrowseState('generation', 'first').pinnedOnly, true);
  assert.equal(loadBrowseState('generation', 'second').pinnedOnly, false); assert.equal(readBrowseState({pinnedOnly: 'true', recentOnly: 1}).recentOnly, false);
  assert.equal(loadBrowseState('generation', 'second').deadline, 'unset');
  assert.equal(loadBrowseState('other-generation', 'first').view, 'board');
  const invalid = readBrowseState({view: 'unknown', scope: 'unknown', calendarDate: '2026-02-30', calendarScrollHour: Infinity, deadlineDays: 50, sort: 'unknown', query: 'x'.repeat(1001)});
  assert.equal(invalid.view, 'board'); assert.equal(invalid.scope, 'all'); assert.notEqual(invalid.calendarDate, '2026-02-30');
  assert.equal(invalid.calendarScrollHour, 7.75); assert.equal(invalid.deadlineDays, null); assert.equal(invalid.sort, null); assert.equal(invalid.query, '');
  globalThis.localStorage = {getItem() {throw Error('blocked');}, setItem() {throw Error('blocked');}};
  assert.equal(loadBrowseState('generation', 'first').view, 'board'); assert.doesNotThrow(() => saveBrowseState('generation', 'first', state));
  delete globalThis.localStorage;
});

test('甘特圖例複選保存在本機空間，舊偏好為全部，移除重複與不合法類型', () => {
  const values = new Map(); globalThis.localStorage = {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value)};
  try {
    const state = readBrowseState({ganttStatuses: ['todo', null, 'done', 'todo', 1], ganttCategories: ['design', '', 'design', {}]});
    assert.deepEqual(state.ganttStatuses, ['todo', 'done']); assert.deepEqual(state.ganttCategories, ['design', '']);
    saveBrowseState('g', 'first', state); saveBrowseState('g', 'second', readBrowseState({}));
    assert.deepEqual(loadBrowseState('g', 'first').ganttStatuses, ['todo', 'done']); assert.deepEqual(loadBrowseState('g', 'first').ganttCategories, ['design', '']);
    assert.deepEqual(loadBrowseState('g', 'second').ganttStatuses, []); assert.deepEqual(loadBrowseState('other', 'first').ganttCategories, []);
    assert.deepEqual(readBrowseState({ganttStatuses: 'todo', ganttCategories: null}).ganttStatuses, []);
  } finally {delete globalThis.localStorage;}
});

test('總覽選項只存在瀏覽偏好，舊偏好預設回到任務，不恢復錯誤的下鑽條件', () => {
  const values = new Map(); globalThis.localStorage = {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value)};
  try {
    const state = readBrowseState({overviewOpen: true, overviewProject: '', overviewArchived: true, overviewSelection: {kind: 'status', value: 'custom-done'}});
    saveBrowseState('generation', 'first', state); const restored = loadBrowseState('generation', 'first');
    assert.equal(restored.overviewOpen, true); assert.equal(restored.overviewProject, ''); assert.equal(restored.overviewArchived, true); assert.deepEqual(restored.overviewSelection, {kind: 'status', value: 'custom-done'});
    assert.equal(readBrowseState({}).overviewOpen, false); assert.equal(readBrowseState({overviewSelection: {kind: 'unknown'}}).overviewSelection, null);
    assert.equal(loadBrowseState('other-generation', 'first').overviewOpen, false);
  } finally {delete globalThis.localStorage;}
});
