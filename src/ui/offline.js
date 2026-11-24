/*
 * 離線操作（雲端版）：山上網路訊號差時，點名加分先存在手機，網路好時再上傳。
 *
 *   - 最後一次從後台讀到的資料存在本機（attendpoint_cache），離線開啟時照樣顯示名冊與分數
 *   - 加減分類操作（OPTIMISTIC）的佇列存在本機（attendpoint_outbox），關網頁、重開手機都不遺失；
 *     每筆帶 clientId，後台記住已執行的編號，重送時不會重複加分
 *   - 上傳時被後台擋下的項目記在 attendpoint_conflicts，畫面列出明細，不會默默消失
 *
 * 這個檔案只放不碰畫面的規則（Node 可以直接測試，見 tests/offline.test.js）；
 * 佇列的送出流程在 app.js。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AttendOffline = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** 可以先在畫面上生效、離線時暫存的操作（不需要後台給新編號） */
  const OPTIMISTIC = ['points.checkin', 'points.award', 'points.batch', 'points.redeem', 'session.duty'];
  const BATCH_MAX = 30; // 與後台 Code.js 相同
  const SEND_TIMEOUT_MS = 8000; // 等太久就改成離線暫存
  const CONFLICT_KEEP = 200;

  const KEYS = {
    cache: 'attendpoint_cache',
    outbox: 'attendpoint_outbox',
    conflicts: 'attendpoint_conflicts'
  };

  /**
   * 離線時仍可使用的按鈕（data-action）：切換畫面、點名加分、兌換、匯出 CSV。
   * 其他按鈕（新增學員、班別、改設定、撤銷、登入…）需要後台，離線時停用並提示「需要網路」。
   */
  const OFFLINE_ACTIONS = [
    'switch-class', 'switch-tab', 'team-filter', 'status-filter', 'toggle-sound', 'toggle-mountain', 'refresh',
    'open-login', 'logout', 'checkin', 'award-rule', 'award-custom', 'staff-duty', 'open-student', 'open-batch',
    'redeem-pick', 'redeem', 'manage-section', 'owner-section', 'export-roster', 'export-logs', 'export-staff',
    'download-template', 'flush-outbox', 'show-conflicts', 'clear-conflicts'
  ];

  function isOptimistic(op) {
    return !!op && OPTIMISTIC.indexOf(op.type) !== -1;
  }

  function allowedOffline(action) {
    return OFFLINE_ACTIONS.indexOf(action) !== -1;
  }

  /** 網路問題（送不出去、等太久、離線中）：操作留在手機，之後再傳 */
  function isNetworkError(err) {
    return !!err && (err.code === 'NETWORK' || err.code === 'TIMEOUT' || err.code === 'OFFLINE');
  }

  /** 操作編號：時間＋亂數，符合後台的 /^[A-Za-z0-9_-]{6,40}$/ */
  function newClientId(random) {
    const r = random || Math.random;
    let s = '';
    for (let i = 0; i < 8; i++) s += Math.floor(r() * 36).toString(36);
    return 'c' + Date.now().toString(36) + s;
  }

  /** promise 超過 ms 毫秒還沒結果就以 makeError() 失敗（原本的請求不會取消） */
  function withTimeout(promise, ms, makeError) {
    let timer = null;
    const timeout = new Promise(function (resolve, reject) {
      timer = setTimeout(function () { reject(makeError()); }, ms);
    });
    return Promise.race([promise, timeout]).then(function (v) {
      clearTimeout(timer);
      return v;
    }, function (e) {
      clearTimeout(timer);
      throw e;
    });
  }

  // ---------- 本機儲存 ----------

  function read(storage, key, fallback) {
    try {
      const raw = storage && storage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  /** 寫入失敗（例如手機空間不足）回傳 false，不丟錯 */
  function write(storage, key, value) {
    try {
      if (value === null || value === undefined) storage.removeItem(key);
      else storage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  }

  /** 佇列只存可以重送的欄位 */
  function outboxEntry(item) {
    return {
      clientId: item.clientId,
      op: item.op,
      label: item.label || '',
      at: item.at || '',
      userId: item.userId || null,
      userName: item.userName || null
    };
  }

  function loadOutbox(storage) {
    const list = read(storage, KEYS.outbox, []);
    return Array.isArray(list)
      ? list.filter(function (x) { return x && x.clientId && isOptimistic(x.op); }).map(outboxEntry)
      : [];
  }

  function saveOutbox(storage, items) {
    return write(storage, KEYS.outbox, items.length ? items.map(outboxEntry) : null);
  }

  /** 最後一次後台確認的資料：{ state, view, user, savedAt } */
  function loadCache(storage) {
    const c = read(storage, KEYS.cache, null);
    return c && c.state && c.state.meta && Array.isArray(c.state.logs) ? c : null;
  }

  function saveCache(storage, cache) {
    return write(storage, KEYS.cache, cache);
  }

  function loadConflicts(storage) {
    const list = read(storage, KEYS.conflicts, []);
    return Array.isArray(list) ? list : [];
  }

  function saveConflicts(storage, list) {
    return write(storage, KEYS.conflicts, list.length ? list.slice(-CONFLICT_KEEP) : null);
  }

  /** 被後台擋下的項目：{ label, message, code, at, rejectedAt } */
  function conflictOf(item, err, now) {
    return {
      label: item.label || (item.op && item.op.type) || '',
      message: (err && err.message) || '後台拒絕這筆操作',
      code: (err && err.code) || 'REJECTED',
      at: item.at || '',
      rejectedAt: now || ''
    };
  }

  // ---------- 說明文字 ----------

  function nameOf(list, id) {
    const x = (list || []).find(function (v) { return v.id === id; });
    return x ? x.name : id || '';
  }

  function signed(n) {
    return (n > 0 ? '+' : '') + n;
  }

  function shortDate(d) {
    return d ? String(d).slice(5).replace('-', '/') : '';
  }

  /** 尚未上傳／被退回時顯示的說明，例如「報到：王小明（11/24）」 */
  function describeOp(state, op) {
    state = state || {};
    const when = op.date ? '（' + shortDate(op.date) + '）' : '';
    const student = nameOf(state.students, op.studentId);
    switch (op.type) {
      case 'points.checkin':
        return '報到：' + student + when;
      case 'points.award': {
        if (op.ruleId) {
          const s = (state.students || []).find(function (x) { return x.id === op.studentId; });
          const cls = s && (state.classes || []).find(function (c) { return c.id === s.classId; });
          const add = cls && cls.addRules.find(function (r) { return r.id === op.ruleId; });
          const deduct = cls && cls.deductRules.find(function (r) { return r.id === op.ruleId; });
          if (add) return '加分 ' + signed(add.points) + '「' + add.label + '」：' + student + when;
          if (deduct) return '扣分 ' + signed(-deduct.points) + '「' + deduct.label + '」：' + student + when;
          return '加減分：' + student + when;
        }
        return (op.points > 0 ? '加分 ' : '扣分 ') + signed(op.points) + '「' + (op.reason || '') + '」：' + student + when;
      }
      case 'points.batch':
        return (op.points > 0 ? '團體加分 ' : '團體扣分 ') + signed(op.points) + '「' + (op.reason || '') + '」：' + nameOf(state.classes, op.classId) + when;
      case 'points.redeem':
        return '兌換「' + nameOf(state.gifts, op.giftId) + '」：' + student + when;
      case 'session.duty':
        return (op.on ? '服務人員到：' : '取消服務人員出席：') + nameOf(state.staff, op.staffId) + when;
      default:
        return op.type;
    }
  }

  /**
   * 畫面上方的網路狀態列：{ tone, text, button }，沒有要顯示的內容時回傳 null。
   * button：'flush' 立即上傳、'login' 重新登入
   */
  function statusBar(s) {
    const n = s.pending || 0;
    if (s.mountain) {
      return { tone: 'offline', text: '⛰️ 山上模式（不連線）' + (n ? '，有 ' + n + ' 筆尚未上傳' : '：點名加分會先存在手機'), button: null };
    }
    if (s.offline) {
      return { tone: 'offline', text: '📴 離線中' + (n ? '，有 ' + n + ' 筆尚未上傳' : '：點名加分會先存在手機，網路恢復後自動上傳'), button: null };
    }
    if (!n) return null;
    if (!s.loggedIn) return { tone: 'warn', text: '🔒 有 ' + n + ' 筆尚未上傳：請重新登入，登入後自動上傳', button: 'login' };
    if (s.sending) return { tone: 'sync', text: '⏳ 上傳中，還有 ' + n + ' 筆…', button: null };
    return { tone: 'sync', text: '📶 有 ' + n + ' 筆尚未上傳', button: 'flush' };
  }

  return {
    OPTIMISTIC: OPTIMISTIC,
    OFFLINE_ACTIONS: OFFLINE_ACTIONS,
    BATCH_MAX: BATCH_MAX,
    SEND_TIMEOUT_MS: SEND_TIMEOUT_MS,
    KEYS: KEYS,
    isOptimistic: isOptimistic,
    allowedOffline: allowedOffline,
    isNetworkError: isNetworkError,
    newClientId: newClientId,
    withTimeout: withTimeout,
    loadOutbox: loadOutbox,
    saveOutbox: saveOutbox,
    loadCache: loadCache,
    saveCache: saveCache,
    loadConflicts: loadConflicts,
    saveConflicts: saveConflicts,
    conflictOf: conflictOf,
    describeOp: describeOp,
    statusBar: statusBar
  };
});
