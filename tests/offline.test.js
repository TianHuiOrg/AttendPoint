// 離線操作的規則（src/ui/offline.js）：本機儲存、說明文字、狀態列
const test = require('node:test');
const assert = require('node:assert/strict');
const Off = require('../src/ui/offline.js');
const Store = require('../src/store.js');

function memoryStorage() {
  const data = {};
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; }
  };
}

function sample() {
  let st = Store.emptyState();
  let r = Store.apply(st, {
    type: 'class.create', name: '兒童讀經班', idPrefix: 'K',
    addRules: [{ label: '背誦', points: 5 }], deductRules: [{ label: '遲到', points: 2 }]
  }, {});
  st = r.state;
  const cls = st.classes[0];
  r = Store.apply(st, { type: 'student.create', classId: cls.id, teamId: null, name: '王小明' }, {});
  st = r.state;
  const sid = r.result.id;
  st = Store.apply(st, { type: 'gift.create', name: '鉛筆', cost: 3 }, {}).state;
  st = Store.apply(st, { type: 'staff.create', name: '林輔導', role: '護持壇務', classIds: [cls.id] }, {}).state;
  return { st, cls, sid };
}

test('只有加減分類操作可以離線暫存', () => {
  assert.deepEqual(Off.OPTIMISTIC, ['points.checkin', 'points.award', 'points.batch', 'points.redeem', 'session.duty']);
  assert.equal(Off.isOptimistic({ type: 'points.award' }), true);
  for (const type of ['student.create', 'class.create', 'meta.update', 'log.reverse', 'session.create']) {
    assert.equal(Off.isOptimistic({ type }), false, type);
  }
  assert.equal(Off.isOptimistic(null), false);
});

test('離線時可以用的按鈕：點名加分、切換畫面；新增、設定、撤銷、下載備份需要網路', () => {
  for (const a of ['checkin', 'award-rule', 'award-custom', 'staff-duty', 'redeem', 'open-batch', 'switch-class', 'flush-outbox', 'export-roster']) {
    assert.equal(Off.allowedOffline(a), true, a);
  }
  for (const a of ['new-class', 'edit-student', 'new-user', 'save-meta', 'undo', 'download-backup', 'import-students', 'edit-session', 'change-my-pin']) {
    assert.equal(Off.allowedOffline(a), false, a);
  }
});

test('網路錯誤與其他錯誤分開處理', () => {
  for (const code of ['NETWORK', 'TIMEOUT', 'OFFLINE']) assert.equal(Off.isNetworkError({ code }), true);
  for (const code of ['SERVER_ERROR', 'SESSION_EXPIRED', 'ALREADY_CHECKED_IN', 'BAD_RESPONSE']) assert.equal(Off.isNetworkError({ code }), false);
  assert.equal(Off.isNetworkError(null), false);
});

test('操作編號符合後台格式且不重複', () => {
  const ids = new Set();
  for (let i = 0; i < 500; i++) {
    const id = Off.newClientId();
    assert.match(id, /^[A-Za-z0-9_-]{6,40}$/);
    ids.add(id);
  }
  assert.equal(ids.size, 500);
});

test('等太久就失敗（TIMEOUT），及時回來就照常', async () => {
  const err = () => ({ code: 'TIMEOUT' });
  assert.equal(await Off.withTimeout(Promise.resolve(7), 50, err), 7);
  await assert.rejects(Off.withTimeout(new Promise(() => {}), 20, err), (e) => e.code === 'TIMEOUT');
  await assert.rejects(Off.withTimeout(Promise.reject({ code: 'NETWORK' }), 50, err), (e) => e.code === 'NETWORK');
});

test('未上傳佇列存在本機：重新開啟後還在，只保留可重送的欄位', () => {
  const storage = memoryStorage();
  const op = { type: 'points.checkin', studentId: 'K01', date: '2026-11-24' };
  assert.equal(Off.saveOutbox(storage, [{ clientId: 'cAAAAAA1', op, label: '報到：王小明', at: '2026-11-24T09:00:00', userId: 'U-1', userName: '壇務甲', resolve() {} }]), true);
  const back = Off.loadOutbox(storage);
  assert.deepEqual(back, [{ clientId: 'cAAAAAA1', op, label: '報到：王小明', at: '2026-11-24T09:00:00', userId: 'U-1', userName: '壇務甲' }]);
  // 清空時移除；壞掉的資料、不能離線的操作不載入
  Off.saveOutbox(storage, []);
  assert.equal(storage.getItem(Off.KEYS.outbox), null);
  storage.setItem(Off.KEYS.outbox, '{壞掉');
  assert.deepEqual(Off.loadOutbox(storage), []);
  storage.setItem(Off.KEYS.outbox, JSON.stringify([{ clientId: 'cB', op: { type: 'student.delete' } }, { op }, null]));
  assert.deepEqual(Off.loadOutbox(storage), []);
});

test('手機空間不足時不丟錯，回傳 false', () => {
  const full = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); }, removeItem() {} };
  assert.equal(Off.saveOutbox(full, [{ clientId: 'cAAAAAA1', op: { type: 'points.checkin' } }]), false);
  assert.equal(Off.saveCache(full, { state: {} }), false);
  assert.deepEqual(Off.loadOutbox(null), []);
});

test('最後讀到的資料存在本機；格式不對時當成沒有', () => {
  const storage = memoryStorage();
  const { st } = sample();
  Off.saveCache(storage, { state: st, view: 'staff', user: { id: 'U-1', name: '壇務甲' }, savedAt: '2026-11-24T09:00:00' });
  const c = Off.loadCache(storage);
  assert.equal(c.state.students[0].name, '王小明');
  assert.equal(c.user.name, '壇務甲');
  storage.setItem(Off.KEYS.cache, JSON.stringify({ state: { meta: {} } }));
  assert.equal(Off.loadCache(storage), null);
  assert.equal(Off.loadCache(memoryStorage()), null);
});

test('被後台擋下的項目保留明細，最多 200 筆', () => {
  const storage = memoryStorage();
  const c = Off.conflictOf({ label: '報到：王小明（11/24）', at: '2026-11-24T09:00:00', op: {} }, { code: 'ALREADY_CHECKED_IN', message: '王小明 這堂課已經報到過了' }, '2026-11-24T12:00:00');
  assert.deepEqual(c, { label: '報到：王小明（11/24）', message: '王小明 這堂課已經報到過了', code: 'ALREADY_CHECKED_IN', at: '2026-11-24T09:00:00', rejectedAt: '2026-11-24T12:00:00' });
  Off.saveConflicts(storage, new Array(250).fill(c));
  assert.equal(Off.loadConflicts(storage).length, 200);
  Off.saveConflicts(storage, []);
  assert.deepEqual(Off.loadConflicts(storage), []);
  assert.equal(Off.conflictOf({ op: { type: 'points.award' } }, null).label, 'points.award');
});

test('未上傳項目的說明文字', () => {
  const { st, cls, sid } = sample();
  const date = '2026-11-24';
  const add = cls.addRules.find((r) => r.label === '背誦');
  const deduct = cls.deductRules[0];
  assert.equal(Off.describeOp(st, { type: 'points.checkin', studentId: sid, date }), '報到：王小明（11/24）');
  assert.equal(Off.describeOp(st, { type: 'points.award', studentId: sid, date, ruleId: add.id }), '加分 +5「背誦」：王小明（11/24）');
  assert.equal(Off.describeOp(st, { type: 'points.award', studentId: sid, date, ruleId: deduct.id }), '扣分 -2「遲到」：王小明（11/24）');
  assert.equal(Off.describeOp(st, { type: 'points.award', studentId: sid, date, points: 3, reason: '幫忙' }), '加分 +3「幫忙」：王小明（11/24）');
  assert.equal(Off.describeOp(st, { type: 'points.award', studentId: sid, date, points: -1, reason: '吵鬧' }), '扣分 -1「吵鬧」：王小明（11/24）');
  assert.equal(Off.describeOp(st, { type: 'points.batch', classId: cls.id, date, points: 10, reason: '秩序良好', target: { all: true } }), '團體加分 +10「秩序良好」：兒童讀經班（11/24）');
  assert.equal(Off.describeOp(st, { type: 'points.redeem', studentId: sid, giftId: st.gifts[0].id, date }), '兌換「鉛筆」：王小明（11/24）');
  assert.equal(Off.describeOp(st, { type: 'session.duty', classId: cls.id, staffId: st.staff[0].id, date, on: true }), '服務人員到：林輔導（11/24）');
  assert.equal(Off.describeOp(st, { type: 'session.duty', classId: cls.id, staffId: st.staff[0].id, date, on: false }), '取消服務人員出席：林輔導（11/24）');
  assert.equal(Off.describeOp(null, { type: 'points.checkin', studentId: 'K99' }), '報到：K99');
});

test('畫面上方的網路狀態列', () => {
  assert.equal(Off.statusBar({ pending: 0, loggedIn: true }), null);
  assert.deepEqual(Off.statusBar({ offline: true, pending: 3, loggedIn: true }), { tone: 'offline', text: '📴 離線中，有 3 筆尚未上傳', button: null });
  assert.match(Off.statusBar({ offline: true, pending: 0 }).text, /^📴 離線中：/);
  assert.match(Off.statusBar({ mountain: true, offline: true, pending: 2 }).text, /^⛰️ 山上模式（不連線），有 2 筆尚未上傳/);
  assert.deepEqual(Off.statusBar({ pending: 4, loggedIn: true }), { tone: 'sync', text: '📶 有 4 筆尚未上傳', button: 'flush' });
  assert.equal(Off.statusBar({ pending: 4, loggedIn: true, sending: true }).button, null);
  assert.deepEqual(Off.statusBar({ pending: 2, loggedIn: false }).button, 'login');
});
