import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ReminderHistory, readReminderHistory, REMINDER_HISTORY_KEY, REMINDER_HISTORY_AGE, MAX_REMINDER_HISTORY} from '../src/app/reminder-history.ts';
const now = Date.UTC(2026, 9, 17, 12);
const entry = (key = 'notice', patch = {}) => ({key, generation: 'generation', workspaceId: 'space', workspaceIds: ['space'], workspaceName: '研究工作', itemId: 'orbit:task', taskId: 'task', title: '當時的任務名稱', source: 'orbit', sourceId: '', sourceName: '', stage: 'today', startDate: '2026-10-17', startTime: '13:00', dueDate: '', dueTime: '', at: now, ...patch});
function repository() {
  const values = new Map(); let failed = false, chain = Promise.resolve();
  const storage = {getItem: key => values.get(key) ?? null, setItem(key, value) {if (failed) throw new Error('quota'); values.set(key, value);}};
  const lock = operation => {const result = chain.then(operation); chain = result.catch(() => {}); return result;};
  return {values, first: new ReminderHistory(storage, lock), second: new ReminderHistory(storage, lock), fail: () => {failed = true;}};
}
test('提醒歷史跨分頁聯集，保留首次快照並合併查看、提示及關閉狀態', async () => {
  const f = repository();
  await Promise.all([f.first.save([entry()], [], {}, now), f.second.save([entry('other')], [], {}, now)]);
  await Promise.all([f.first.save([entry('notice', {title: '後來改名', workspaceName: '新空間名', at: now + 100})], ['notice'], {readAt: now + 100}, now + 100), f.second.save([], ['notice'], {popupAt: now + 10, dismissedAt: now + 50}, now + 100)]);
  const saved = f.first.read(now + 100); assert.equal(saved.length, 2);
  assert.deepEqual(saved.find(item => item.key === 'notice'), entry('notice', {readAt: now + 100, popupAt: now + 10, dismissedAt: now + 50}));
  assert.equal(JSON.stringify(saved).includes('後來改名'), false);
});
test('歷史只保留近三十天及五百筆，驗證欄位並捨棄描述、憑證及損壞資料', () => {
  const input = [entry('expired', {at: now - REMINDER_HISTORY_AGE - 1}), ...Array.from({length: MAX_REMINDER_HISTORY + 20}, (_, index) => entry(String(index), {at: now - 10000 + index, description: 'private-description', token: 'secret-token'})), entry('invalid-date', {startDate: '2026-02-30'}), entry('invalid-state', {readAt: 'yesterday'}), entry('invalid-membership', {workspaceIds: ['elsewhere']})];
  const result = readReminderHistory({version: 1, entries: input}, now);
  assert.equal(result.length, MAX_REMINDER_HISTORY); assert.equal(result[0].key, '20'); assert.equal(result.at(-1).key, '519');
  assert.equal(JSON.stringify(result).includes('secret-token'), false); assert.equal(JSON.stringify(result).includes('private-description'), false);
  assert.deepEqual(readReminderHistory({version: 2, entries: [entry()]}, now), []);
  assert.equal(readReminderHistory({version: 1, entries: [entry('boundary', {at: now - REMINDER_HISTORY_AGE})]}, now).length, 1);
});
test('歷史保存失敗保留原資料，重置世代後延遲寫入不復活舊紀錄', async () => {
  const f = repository(); await f.first.save([entry()], [], {}, now); const original = f.values.get(REMINDER_HISTORY_KEY);
  f.fail(); await assert.rejects(f.second.save([entry('new')], [], {}, now), /quota/); assert.equal(f.values.get(REMINDER_HISTORY_KEY), original);
  const clean = repository(); let current = true;
  const pending = clean.first.save([entry()], [], {}, now, () => current); current = false;
  assert.deepEqual(await pending, []); assert.equal(clean.values.has(REMINDER_HISTORY_KEY), false);
  clean.values.set(REMINDER_HISTORY_KEY, 'bad JSON'); assert.deepEqual(clean.first.read(now), []);
  const unavailable = new ReminderHistory({getItem() {throw new Error('read denied');}, setItem() {throw new Error('must not overwrite');}}, async operation => operation());
  await assert.rejects(unavailable.save([entry()], [], {}, now), /read denied/);
});
