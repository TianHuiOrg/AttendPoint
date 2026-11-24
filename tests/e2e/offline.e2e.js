// 雲端版離線操作（dist/gas-sim.html）：山上網路差時先存在手機，網路好時再上傳
const test = require('node:test');
const assert = require('node:assert/strict');
const { SKIP, launch, idle, dialog, toast, tab, card, login } = require('./helpers.js');

const OWNER_PIN = '246810'; // scripts/gas-sim.js 的模擬擁有者 PIN

test('雲端版離線操作', { skip: SKIP }, async (t) => {
  const env = await launch();
  t.after(() => env.close());
  const page = await env.open('gas-sim.html');
  const context = page.context();
  page.on('dialog', (d) => d.accept()); // 重新整理時的「尚未上傳」提醒

  await page.evaluate((pin) => {
    const tok = apiLogin('U-owner', pin).token;
    const cls = apiApply(tok, {
      type: 'class.create', name: '兒童讀經班', idPrefix: 'K', teams: ['孝順隊'],
      addRules: [{ label: '準時報到', points: 10, isCheckin: true }]
    }).result;
    ['王小明', '李小華', '陳大同'].forEach((name) => apiApply(tok, { type: 'student.create', classId: cls.id, teamId: null, name }));
    apiApply(tok, { type: 'staff.create', name: '林輔導', role: '護持壇務', classIds: [cls.id] });
    apiApply(tok, { type: 'gift.create', name: '鉛筆', cost: 5 });
  }, OWNER_PIN);
  await login(page, OWNER_PIN);
  await page.waitForFunction(() => App.s.data.students.length === 3);

  // 後台（模擬試算表）的資料、手機上的未上傳佇列
  const server = () => page.evaluate(() => {
    const st = readState_();
    return { logs: st.logs.map((l) => l.reason), duty: st.sessions.reduce((n, s) => n + s.dutyStaffIds.length, 0) };
  });
  const outbox = () => page.evaluate(() => JSON.parse(localStorage.getItem('attendpoint_outbox') || '[]').map((x) => x.label));
  const netBar = () => page.locator('#netBar').innerText();
  // 記錄送到後台的呼叫（重新整理後要重新安裝）
  const watchCalls = () => page.evaluate(() => {
    window.__calls = [];
    ['apiApply', 'apiApplyBatch', 'apiGetState'].forEach((name) => {
      const orig = window[name];
      window[name] = function () {
        const res = orig.apply(null, arguments);
        window.__calls.push({ name, n: name === 'apiApplyBatch' ? arguments[1].length : 1 });
        return res;
      };
    });
  });
  const calls = () => page.evaluate(() => window.__calls.splice(0));
  const award = (name, points, reason) => page.evaluate(({ name, points, reason }) => {
    const s = App.s.data.students.find((x) => x.name === name);
    return App.run({ type: 'points.award', studentId: s.id, date: App.s.date, points, reason }).accepted;
  }, { name, points, reason });

  await t.test('網頁檔案存在手機：Service Worker 安裝完成', async () => {
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    const keys = await page.evaluate(() => caches.keys());
    assert.ok(keys.some((k) => /^attendpoint-[0-9a-f]{12}$/.test(k)), JSON.stringify(keys));
  });

  await t.test('斷線：點名、加分、服務人員點名、兌換先存在手機，畫面顯示離線中與筆數', async () => {
    const before = await server();
    await context.setOffline(true);
    await page.locator('#netBar', { hasText: '📴 離線中' }).waitFor();
    await card(page, '王小明').locator('[data-action="checkin"]').click();
    await toast(page, '王小明 報到成功');
    await card(page, '王小明').locator('button', { hasText: '已報到' }).waitFor();
    await page.locator('[data-staff-duty] [data-action="staff-duty"]', { hasText: '林輔導' }).click();
    assert.equal(await award('王小明', 5, '離線加分'), true);
    // 兌換：點數用剛剛離線加的分
    await tab(page, 'gifts');
    await page.click('#view [data-action="redeem-pick"]');
    const m = await dialog(page);
    await m.locator('.list-item', { hasText: '王小明' }).locator('[data-action="redeem"]').click();
    await page.locator('.modal-backdrop').last().locator('[data-yes]').click();
    await toast(page, '兌換「鉛筆」成功');
    await page.locator('.modal-backdrop [data-close]').first().click();
    await tab(page, 'checkin');
    await idle(page);
    assert.equal(await netBar(), '📴 離線中，有 4 筆尚未上傳');
    const d = await page.evaluate(() => '（' + App.s.date.slice(5).replace('-', '/') + '）');
    assert.deepEqual(await outbox(), ['報到：王小明' + d, '服務人員到：林輔導' + d, '加分 +5「離線加分」：王小明' + d, '兌換「鉛筆」：王小明' + d]);
    assert.deepEqual(await server(), before, '後台還沒有收到');
    assert.equal((await page.locator('#syncStatus').innerText()).trim(), '', '沒有卡在「同步中」');
  });

  await t.test('離線時需要後台編號的功能停用，按下去提示需要網路', async () => {
    await tab(page, 'roster');
    const add = page.locator('#view [data-action="edit-student"]').first();
    assert.equal(await add.evaluate((el) => el.classList.contains('needs-net')), true);
    await add.click();
    await toast(page, '需要網路');
    assert.equal(await page.locator('.modal-backdrop').count(), 0);
    // 直接呼叫也一樣被擋下
    const accepted = await page.evaluate(() => App.run({ type: 'gift.create', name: '離線禮品', cost: 1 }).accepted);
    assert.equal(accepted, false);
    await tab(page, 'checkin');
    assert.equal(await page.locator('#view [data-action="checkin"]').first().evaluate((el) => el.classList.contains('needs-net')), false);
  });

  await t.test('離線重新整理：網頁、名冊、分數、已報到與未上傳操作都還在', async () => {
    await page.reload();
    await page.waitForFunction(() => window.App && App.s.backend && document.querySelector('#tabBar').children.length > 0);
    await page.locator('#netBar', { hasText: '有 4 筆尚未上傳' }).waitFor();
    assert.deepEqual((await page.locator('#studentGrid .name').allTextContents()).sort(), ['李小華', '王小明', '陳大同']);
    await card(page, '王小明').locator('button', { hasText: '已報到' }).waitFor();
    assert.equal(await page.locator('#userBtn').innerText().then((s) => s.includes('模擬堂主')), true, '保持登入');
    const totals = await page.evaluate(() => App.studentTotals(App.s.data.students.find((x) => x.name === '王小明').id));
    assert.equal(totals.balance, 10 + 5 - 5);
    assert.equal(await page.locator('[data-staff-duty] [data-action="staff-duty"]', { hasText: '林輔導' }).getAttribute('aria-pressed'), 'true');
    // 離線時再多做幾筆（共 35 筆，上傳時每 30 筆合併送出）
    for (let i = 1; i <= 31; i++) assert.equal(await award('陳大同', 1, '離線連續' + i), true);
    await page.locator('#netBar', { hasText: '有 35 筆尚未上傳' }).waitFor();
  });

  await t.test('恢復連線：自動上傳，每 30 筆合併送出', async () => {
    await watchCalls();
    await context.setOffline(false);
    await page.waitForFunction(() => App.pendingCount() === 0, null, { timeout: 15000 });
    await idle(page);
    const sent = (await calls()).filter((c) => c.name !== 'apiGetState');
    assert.deepEqual(sent, [{ name: 'apiApplyBatch', n: 30 }, { name: 'apiApplyBatch', n: 5 }]);
    const s = await server();
    assert.ok(s.logs.includes('離線加分') && s.logs.includes('離線連續31'));
    assert.equal(s.logs.filter((r) => r.indexOf('離線連續') === 0).length, 31);
    assert.equal(s.duty, 1);
    assert.deepEqual(await outbox(), []);
    assert.equal(await netBar(), '');
    assert.equal(await page.evaluate(() => JSON.stringify(App.s.data) === JSON.stringify(readState_())), true);
  });

  await t.test('等太久就改成離線暫存；重送時後台不會重複記分', async () => {
    await page.evaluate(() => { App.SEND_TIMEOUT_MS = 800; window.__simDelay = 2000; });
    await calls();
    assert.equal(await award('李小華', 2, '慢慢送'), true);
    await page.locator('#netBar', { hasText: '📴 離線中，有 1 筆尚未上傳' }).waitFor();
    // 那次請求其實晚一點送到了後台
    await page.waitForFunction(() => readState_().logs.some((l) => l.reason === '慢慢送'));
    await page.evaluate(() => { window.__simDelay = 300; App.SEND_TIMEOUT_MS = 8000; window.dispatchEvent(new Event('online')); });
    await page.waitForFunction(() => App.pendingCount() === 0);
    await idle(page);
    assert.equal((await server()).logs.filter((r) => r === '慢慢送').length, 1);
    assert.equal(await netBar(), '');
  });

  await t.test('山上模式：不嘗試連線，直接暫存；關閉後上傳', async () => {
    await page.click('#mountainBtn');
    await page.locator('#netBar', { hasText: '⛰️ 山上模式' }).waitFor();
    await calls();
    await card(page, '李小華').locator('[data-action="checkin"]').click();
    await toast(page, '李小華 報到成功');
    await page.click('[data-action="refresh"]');
    await toast(page, '山上模式不連線');
    await page.waitForTimeout(500);
    assert.deepEqual(await calls(), [], '沒有連線');
    assert.match(await netBar(), /山上模式（不連線），有 1 筆尚未上傳/);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('attendpoint_prefs')).mountain), true, '重新開啟也保持山上模式');
    await page.click('#mountainBtn');
    await page.waitForFunction(() => App.pendingCount() === 0);
    await idle(page);
    assert.equal(await page.evaluate(() => readState_().logs.filter((l) => l.type === 'checkin').length), 2, '王小明、李小華都已報到');
  });

  await t.test('衝突：另一台已經點過名，上傳時列出被退回的明細', async () => {
    await page.click('#mountainBtn');
    await card(page, '陳大同').locator('[data-action="checkin"]').click();
    assert.equal(await award('陳大同', 3, '衝突時一起送'), true);
    // 另一台（有網路）先幫陳大同報到
    await page.evaluate((pin) => {
      const tok = apiLogin('U-owner', pin).token;
      const s = readState_().students.find((x) => x.name === '陳大同');
      apiApply(tok, { type: 'points.checkin', studentId: s.id, date: App.s.date });
    }, OWNER_PIN);
    await page.click('#mountainBtn');
    await toast(page, '有 1 筆上傳被後台退回');
    await page.waitForFunction(() => App.pendingCount() === 0);
    await idle(page);
    assert.ok((await server()).logs.includes('衝突時一起送'), '其他項目照常上傳');
    await page.locator('#netBar', { hasText: '有 1 筆上傳被後台退回' }).waitFor();
    await page.click('#netBar [data-action="show-conflicts"]');
    const m = await dialog(page);
    const text = await m.innerText();
    assert.match(text, /報到：陳大同/);
    assert.match(text, /已經報到/);
    // 重新整理後明細還在，確認後才清除
    await page.reload();
    await page.waitForFunction(() => window.App && App.s.backend && document.querySelector('#tabBar').children.length > 0);
    await page.locator('#netBar', { hasText: '有 1 筆上傳被後台退回' }).waitFor();
    await page.click('#netBar [data-action="show-conflicts"]');
    await (await dialog(page)).locator('[data-action="clear-conflicts"]').click();
    await page.waitForFunction(() => document.querySelector('#netBar').innerText.trim() === '');
    await idle(page);
  });

  await t.test('登入過期：保留未上傳資料，重新登入後再傳', async () => {
    await page.click('#mountainBtn');
    assert.equal(await award('王小明', 4, '過期前加分'), true);
    await page.evaluate(() => CacheService.getScriptCache().remove('tok:' + App.s.backend.token));
    await page.click('#mountainBtn');
    await toast(page, '登入已逾時');
    await page.waitForFunction(() => !App.s.user);
    await page.locator('#netBar', { hasText: '🔒 有 1 筆尚未上傳：請重新登入' }).waitFor();
    assert.deepEqual(await outbox(), [await page.evaluate(() => '加分 +4「過期前加分」：王小明（' + App.s.date.slice(5).replace('-', '/') + '）')]);
    assert.equal((await server()).logs.includes('過期前加分'), false);
    await page.click('#netBar [data-action="open-login"]');
    const m = await dialog(page);
    await m.locator('#loginPin').fill(OWNER_PIN);
    await m.locator('button[type=submit]').click();
    await page.waitForFunction(() => App.s.user && App.pendingCount() === 0);
    await idle(page);
    assert.ok((await server()).logs.includes('過期前加分'));
    assert.equal(await netBar(), '');
  });

  await t.test('尚未上傳時關閉網頁會先提醒', async () => {
    await page.click('#mountainBtn');
    assert.equal(await award('李小華', 1, '關閉前'), true);
    const warned = await page.evaluate(() => {
      const e = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    });
    assert.equal(warned, true);
    await page.click('#mountainBtn');
    await page.waitForFunction(() => App.pendingCount() === 0);
    await idle(page);
  });

  await t.test('沒有程式錯誤', () => {
    assert.deepEqual(page.errors, []);
  });
});
