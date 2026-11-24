/* 應用程式核心：狀態、操作佇列、外框（班別列、課次列、分頁）、登入 */
(function (App) {
  'use strict';

  App.views = {}; // 分頁：{ label, icon, minRole, order, render() }
  App.actions = {}; // data-action 對應的處理函式 (el, event)

  App.s = {
    backend: null,
    user: null,
    data: AttendStore.emptyState(),
    classId: null,
    tab: 'checkin',
    date: null,
    teamFilter: 'all',
    statusFilter: 'all',
    search: '',
    pending: 0,
    backendOutdated: false // 雲端版：後台程式版本與網頁不同
  };

  // ---------- 角色 ----------
  App.role = function () { return AttendAuth.roleOf(App.s.user); };
  App.isStaff = function () { return AttendAuth.atLeast(App.s.user, 'staff'); };
  App.isOwner = function () { return App.role() === 'owner'; };
  App.can = function (op) { return App.isStaff() && AttendAuth.can(App.s.data, op, App.s.user, App.today()); };

  // ---------- 查詢 ----------
  const memo = { data: null, totals: null };
  App.totals = function () {
    if (memo.data !== App.s.data) {
      memo.data = App.s.data;
      memo.totals = AttendStore.computeTotals(App.s.data);
    }
    return memo.totals;
  };
  App.studentTotals = function (id) { return App.totals()[id] || { honor: 0, balance: 0, sessionIds: [] }; };
  App.classes = function () { return AttendStore.active(App.s.data.classes); };
  App.cls = function () {
    return App.classes().find(function (c) { return c.id === App.s.classId; }) || null;
  };
  App.classById = function (id) { return App.s.data.classes.find(function (c) { return c.id === id; }) || null; };
  App.students = function (classId) {
    return AttendStore.active(App.s.data.students).filter(function (s) { return !classId || s.classId === classId; });
  };
  App.studentById = function (id) { return App.s.data.students.find(function (s) { return s.id === id; }) || null; };
  App.teamName = function (student) {
    const cls = App.classById(student.classId);
    const team = cls && cls.teams.find(function (t) { return t.id === student.teamId; });
    return team ? team.name : '';
  };
  App.session = function () {
    return App.s.classId && App.s.date ? AttendStore.findSession(App.s.data, App.s.classId, App.s.date) : null;
  };
  App.sessionById = function (id) { return App.s.data.sessions.find(function (s) { return s.id === id; }) || null; };
  App.gifts = function () { return AttendStore.active(App.s.data.gifts); };
  App.staffList = function () { return AttendStore.active(App.s.data.staff); };

  /** 榮譽稱號（沿用 v2） */
  App.rank = function (honor) {
    if (honor >= 300) return { title: '👑 智慧小狀元', cls: 'chip-gift' };
    if (honor >= 200) return { title: '🏅 讀經小舉人', cls: 'chip-ok' };
    if (honor >= 100) return { title: '📜 勤學小秀才', cls: 'chip-theme' };
    return { title: '🌱 初學小書僮', cls: '' };
  };

  // ---------- 操作佇列 ----------
  // 加減分類的操作先在畫面上立即生效（樂觀更新），再依序送到後端；
  // 後端回應後以後端資料為準，失敗時退回並提示。
  // 會建立新資料（需要後端給的 id）的操作則等後端回應後才更新畫面。
  // 雲端版每次讀寫試算表要好幾秒：送出時把排隊中的操作合併成一次送出（apiApplyBatch）。
  //
  // 離線（雲端版，見 offline.js）：加減分類操作同時存在手機（attendpoint_outbox）。
  // 送不出去、等太久或開啟山上模式時，操作留在手機（deferred），網路恢復後每 30 筆合併上傳；
  // 上傳時被後台擋下的項目記在「上傳被退回」明細，不會默默消失。
  const Off = window.AttendOffline;
  const queue = []; // { op, optimistic, clientId, label, at, userId, userName, deferred, local, resolve, reject }
  let confirmed = null; // 最後一次後端確認的資料
  let sending = false;
  let sendGen = 0; // 等太久而放棄的請求晚回來時不採用
  App.SEND_TIMEOUT_MS = Off.SEND_TIMEOUT_MS;
  App.s.offline = false; // 自動判斷：連不上後台
  App.s.conflicts = [];

  function cloud() { return !!App.s.backend && App.s.backend.mode === 'gas'; }
  function storage() { try { return window.localStorage; } catch (e) { return null; } }

  /** 雲端版：山上模式或連不上後台 */
  App.isOffline = function () { return cloud() && (!!App.prefs.mountain || App.s.offline); };
  App.pendingCount = function () { return queue.filter(function (i) { return i.optimistic; }).length; };

  function localApply(state, op) {
    AttendAuth.authorize(state, op, App.s.user, App.today());
    return AttendStore.apply(state, op, { operatorId: App.s.user && App.s.user.id, operatorName: App.s.user && App.s.user.name });
  }

  function persist() {
    if (!cloud()) return;
    const ok = Off.saveOutbox(storage(), queue.filter(function (i) { return i.optimistic; }));
    if (!ok) App.toast('⚠️ 手機儲存空間不足，尚未上傳的資料無法保存，請盡快連上網路上傳', 'warn');
  }

  /** 把最後一次後台確認的資料存在手機，離線開啟時使用 */
  function saveCache() {
    if (!cloud() || !confirmed) return;
    const b = App.s.backend;
    Off.saveCache(storage(), {
      state: confirmed,
      view: b.base === confirmed ? b.baseView : null,
      user: App.s.user,
      savedAt: AttendStore.localIso(new Date())
    });
  }

  function replayPending() {
    let state = confirmed || App.s.data;
    queue.forEach(function (item) {
      if (!item.optimistic) return;
      // 只是顯示用：登入逾時（訪客）時也照樣顯示尚未上傳的分數
      try { state = AttendStore.apply(state, item.op, { operatorId: item.userId, operatorName: item.userName }).state; } catch (e) { /* 已不適用的操作略過，後端會回報 */ }
    });
    App.s.data = state;
  }

  function refreshPending() {
    App.s.pending = queue.length;
    replayPending();
    App.render();
  }

  function addConflicts(list) {
    if (!list.length) return;
    App.s.conflicts = App.s.conflicts.concat(list);
    Off.saveConflicts(storage(), App.s.conflicts);
    App.toast('⚠️ 有 ' + list.length + ' 筆上傳被後台退回，請查看明細', 'warn');
  }

  /** 操作改成留在手機：呼叫端照常完成（用本機結果） */
  function defer(item) {
    if (item.deferred) return;
    item.deferred = true;
    item.resolve({ result: item.local, state: App.s.data, offline: true });
  }

  function remove(items) {
    items.forEach(function (item) {
      const i = queue.indexOf(item);
      if (i !== -1) queue.splice(i, 1);
    });
  }

  App.needsNetworkText = function () {
    return '📴 需要網路：' + (App.prefs.mountain ? '山上模式不連線（關閉山上模式後再試）' : '目前離線（按 ↻ 重新連線）') + '，離線時只能點名、加減分與兌換';
  };

  /** 後台有回應：離線狀態解除，開始上傳 */
  App.reconnected = function () {
    if (!App.s.offline) return;
    App.s.offline = false;
    App.render();
    if (App.pendingCount()) {
      App.toast('📶 已恢復連線，開始上傳');
      setTimeout(App.flush, 0);
    }
  };

  App.setOffline = function (on) {
    on = !!on;
    if (App.s.offline === on) return;
    App.s.offline = on;
    if (on && App.pendingCount()) App.toast('📴 網路不穩，已改為離線暫存，恢復連線後會自動上傳', 'warn');
    App.render();
  };

  function pump() {
    if (sending || queue.length === 0) return;
    if (cloud() && (App.isOffline() || !App.s.user)) {
      // 不能連線：需要後台的操作直接退回；加減分類留在手機
      const blocked = queue.filter(function (i) { return !i.optimistic; });
      queue.forEach(function (i) { if (i.optimistic) defer(i); });
      if (blocked.length) {
        remove(blocked);
        const err = new App.BackendError('OFFLINE', App.s.user ? '需要網路：目前離線，請連上網路後再試' : '請先登入壇務帳號');
        blocked.forEach(function (i) { i.reject(err); });
        App.handleError(err);
      }
      refreshPending();
      return;
    }
    sending = true;
    const gen = ++sendGen;
    // 後台版本較舊時沒有合併送出，改回一次一個
    const canBatch = App.s.backend.applyBatch && !App.s.backendOutdated;
    const items = queue.slice(0, canBatch ? Off.BATCH_MAX : 1);
    const ops = items.map(function (item) {
      return cloud() && item.clientId ? Object.assign({}, item.op, { clientId: item.clientId }) : item.op;
    });
    function finish() {
      sending = false;
      App.s.pending = queue.length;
      if (queue.length === 0 && confirmed) App.s.data = confirmed;
      else replayPending();
      App.render();
    }
    function guard(fn) {
      return function (v) { if (gen === sendGen) fn(v); };
    }
    function failAll(err) {
      sendGen++;
      if (cloud() && (Off.isNetworkError(err) || err.code === 'SESSION_EXPIRED')) {
        // 送不出去、等太久、登入逾時：加減分類留在手機，之後再傳
        const kept = items.filter(function (i) { return i.optimistic; });
        const dropped = items.filter(function (i) { return !i.optimistic; });
        remove(dropped);
        kept.forEach(defer);
        persist();
        if (err.code === 'SESSION_EXPIRED') {
          App.s.backend.setToken(null);
          App.toast('⚠️ 登入已逾時，請重新登入' + (App.pendingCount() ? '；尚未上傳的 ' + App.pendingCount() + ' 筆會保留，登入後自動上傳' : ''), 'warn');
          App.setUser(null);
          finish();
          dropped.forEach(function (i) { i.reject(err); });
          App.refresh(true);
          return;
        }
        App.s.offline = true;
        finish();
        dropped.forEach(function (i) { i.reject(err); });
        App.toast(kept.length ? '📴 網路不穩，已改為離線暫存，恢復連線後會自動上傳' : '⚠️ ' + err.message, 'warn');
        return;
      }
      // 其他錯誤：剛做的操作退回；之前留在手機的保留，之後再試
      const rejected = items.filter(function (i) { return !i.deferred; });
      remove(rejected);
      persist();
      finish();
      rejected.forEach(function (item) { item.reject(err); });
      App.handleError(err);
      if (rejected.length) pump();
    }
    function accepted(res, results) {
      confirmed = res.state;
      App.s.offline = false;
      remove(items);
      persist();
      saveCache();
      finish();
      const conflicts = [];
      results.forEach(function (r, i) {
        const item = items[i];
        if (r.ok) {
          item.resolve({ result: r.result, backup: r.backup, state: res.state });
        } else {
          item.reject(r);
          if (item.deferred) conflicts.push(Off.conflictOf(item, r, AttendStore.localIso(new Date())));
          else App.handleError(r);
        }
      });
      addConflicts(conflicts);
      pump();
    }
    let call;
    if (items.length === 1) {
      call = App.s.backend.apply(ops[0]).then(function (res) {
        return { res: res, results: [{ ok: true, result: res.result, backup: res.backup }] };
      }, function (err) {
        // 單筆被後台擋下（例如已經點過名）：與合併送出時相同處理
        if (err && err.code && !Off.isNetworkError(err) && ['SESSION_EXPIRED', 'SERVER_ERROR', 'BUSY', 'BAD_RESPONSE', 'NOT_CONFIGURED'].indexOf(err.code) === -1 && confirmed) {
          return { res: { state: App.s.backend.base || confirmed }, results: [{ ok: false, code: err.code, message: err.message }] };
        }
        throw err;
      });
    } else {
      call = App.s.backend.applyBatch(ops).then(function (res) { return { res: res, results: res.results }; });
    }
    if (cloud()) {
      call = Off.withTimeout(call, App.SEND_TIMEOUT_MS, function () {
        return new App.BackendError('TIMEOUT', '後台等太久沒有回應');
      });
    }
    call.then(guard(function (r) { accepted(r.res, r.results); }), guard(failAll));
  }

  /**
   * 執行資料操作。成功時 Promise 帶著後端結果 { result, state } 完成。
   * 失敗時已經顯示提示，Promise 不會完成也不會 reject，呼叫端只要寫成功後要做的事。
   * 回傳的 Promise 有 accepted 屬性：true 表示已通過本機檢查（加減分類操作已經顯示在畫面上）。
   * 離線時加減分類操作存在手機，Promise 以本機結果完成（offline: true）；其他操作提示「需要網路」。
   */
  function never() { return new Promise(function () {}); }
  function stalled() {
    const p = never();
    p.accepted = false;
    return p;
  }

  App.run = function (op) {
    const optimistic = Off.isOptimistic(op);
    if (!optimistic && App.isOffline()) {
      App.busyUntil(Promise.resolve()); // 從表單送出時不要讓按鈕一直停用
      App.toast(App.needsNetworkText(), 'warn');
      return stalled();
    }
    let local = null;
    if (optimistic) {
      try {
        const r = localApply(App.s.data, op);
        App.s.data = r.state;
        local = r.result;
      } catch (e) {
        App.handleError(e);
        return stalled();
      }
    }
    let settle;
    const settled = new Promise(function (r) { settle = r; });
    let item;
    const p = new Promise(function (resolve, reject) {
      item = {
        op: op,
        optimistic: optimistic,
        local: local,
        resolve: function (v) { resolve(v); settle(); },
        reject: function (e) { reject(e); settle(); }
      };
    }).then(null, never);
    if (optimistic && cloud()) {
      Object.assign(item, {
        clientId: Off.newClientId(),
        label: Off.describeOp(App.s.data, op),
        at: AttendStore.localIso(new Date()),
        userId: App.s.user && App.s.user.id,
        userName: App.s.user && App.s.user.name
      });
    }
    queue.push(item);
    persist();
    App.busyUntil(settled); // 從表單送出時，按鈕停用到後台回應
    p.accepted = true;
    App.s.pending = queue.length;
    App.render();
    pump();
    return p;
  };

  /** 有操作正在送出或等著送出（留在手機的不算） */
  App.isBusy = function () {
    return sending || queue.some(function (i) { return !i.deferred; });
  };

  /** 立即上傳留在手機的操作（網路恢復、按「立即上傳」、重新登入後） */
  App.flush = function () {
    pump();
  };

  // 還有操作沒上傳時，關閉或重新整理網頁要先提醒（雲端版存在手機，下次開啟會再上傳）
  window.addEventListener('beforeunload', function (e) {
    if (!queue.length) return;
    e.preventDefault();
    e.returnValue = '還有資料尚未上傳';
  });

  /** 以後端資料為準重設畫面資料（初始化、重新整理、匯入後使用）；留在手機的操作照樣顯示 */
  App.loadData = function (state) {
    confirmed = state;
    App.s.data = state;
    if (queue.length) replayPending();
    saveCache();
  };

  /**
   * 雲端版開啟時：先用手機上的資料與未上傳佇列顯示畫面（不必等後台，離線也能用）。
   * 回傳有沒有手機上的資料。
   */
  App.restoreOffline = function () {
    if (!cloud()) return false;
    const st = storage();
    App.s.conflicts = Off.loadConflicts(st);
    Off.loadOutbox(st).forEach(function (entry) {
      queue.push(Object.assign(entry, { optimistic: true, deferred: true, resolve: function () {}, reject: function () {} }));
    });
    const cache = Off.loadCache(st);
    App.s.pending = queue.length;
    if (!cache) {
      if (queue.length) replayPending();
      return false;
    }
    App.s.backend.restore(cache.state, cache.view);
    confirmed = cache.state;
    App.s.data = cache.state;
    let token = null;
    try { token = st.getItem('attendpoint_token'); } catch (e) {}
    App.s.user = token ? cache.user || null : null;
    App.s.cachedAt = cache.savedAt || '';
    replayPending();
    return true;
  };

  App.handleError = function (err) {
    const msg = (err && err.message) || '發生錯誤';
    App.toast('⚠️ ' + msg, 'warn');
    if (err && err.code === 'SESSION_EXPIRED') {
      App.setUser(null);
      App.refresh();
    }
  };

  /** 從後端重新讀取（山上模式不連線；連上後台就自動上傳留在手機的操作） */
  App.refresh = function (silent) {
    if (cloud() && App.prefs.mountain) {
      if (!silent) App.toast('⛰️ 山上模式不連線；要更新資料請先關閉山上模式');
      return Promise.resolve();
    }
    if (App.isBusy()) return Promise.resolve();
    // 等太久還沒回來：先標示離線（回來了再恢復）
    const slow = cloud() ? setTimeout(function () { App.setOffline(true); }, App.SEND_TIMEOUT_MS) : null;
    return App.s.backend.getState().then(function (res) {
      clearTimeout(slow);
      App.reconnected();
      if (App.isBusy() || res.stale) return;
      if (res.sessionExpired) {
        App.setUser(null);
        App.toast('登入已逾時，請重新登入' + (App.pendingCount() ? '；尚未上傳的 ' + App.pendingCount() + ' 筆會保留，登入後自動上傳' : ''), 'warn');
      } else if ('user' in res) {
        App.s.user = res.user;
      }
      App.loadData(res.state);
      App.render();
      if (!silent) App.toast('已更新為最新資料');
      App.flush();
    }, function (err) {
      clearTimeout(slow);
      if (cloud() && Off.isNetworkError(err)) {
        App.setOffline(true);
        if (!silent) App.toast('📴 連不上後台，先顯示手機上的資料' + (App.s.cachedAt ? '（' + App.s.cachedAt.replace('T', ' ').slice(5, 16) + '）' : ''), 'warn');
        return;
      }
      if (!silent) App.handleError(err);
    });
  };

  App.setUser = function (user) {
    App.s.user = user;
    const view = App.views[App.s.tab];
    if (view && !AttendAuth.atLeast(user, view.minRole || 'viewer')) App.s.tab = 'checkin';
  };

  // ---------- LOGO ----------
  // LOGO 不放在程式碼裡：由擁有者上傳存在後台，這台裝置記住上次的 LOGO，開啟時先顯示
  const LOGO_CACHE = 'attendpoint_logo';
  let defaultFavicon = null;

  App.showLogo = function (logo) {
    const img = App.$('#brandLogo');
    const favicon = App.$('#favicon');
    if (defaultFavicon === null) defaultFavicon = favicon.getAttribute('href');
    img.hidden = !logo;
    App.$('#brandMark').hidden = !!logo;
    if (logo) img.src = logo;
    else img.removeAttribute('src');
    favicon.setAttribute('href', logo || defaultFavicon);
    // 加到手機主畫面時使用的圖示
    let touch = App.$('link[rel="apple-touch-icon"]');
    if (logo && !touch) {
      touch = document.createElement('link');
      touch.rel = 'apple-touch-icon';
      document.head.appendChild(touch);
    }
    if (touch) {
      if (logo) touch.href = logo;
      else touch.remove();
    }
    try {
      if (logo) localStorage.setItem(LOGO_CACHE, logo);
      else localStorage.removeItem(LOGO_CACHE);
    } catch (e) { /* 無法記住也沒關係，下次再向後台讀取 */ }
  };

  /** 開啟時：先顯示記住的 LOGO，再向後台確認有沒有更新 */
  App.loadLogo = function () {
    let cached = '';
    try { cached = localStorage.getItem(LOGO_CACHE) || ''; } catch (e) {}
    App.showLogo(cached);
    return App.s.backend.getLogo().then(function (logo) {
      if (logo !== cached) App.showLogo(logo);
    }, function () { /* 讀不到就維持原樣 */ });
  };

  /** 把使用者選的圖片縮成 180×180 的方形 PNG（白底、完整顯示不裁切） */
  App.resizeLogo = function (file) {
    return new Promise(function (resolve, reject) {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = function () {
        const size = 180;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, size, size);
        const scale = (size * 0.92) / Math.max(img.width, img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/png'));
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new App.BackendError('INVALID_INPUT', '無法讀取這個圖片檔'));
      };
      img.src = url;
    });
  };

  // ---------- 外框 ----------

  function renderHeader() {
    const meta = App.s.data.meta || {};
    App.$('#templeTitle').textContent = meta.templeTitle || '佛堂點名加分系統';
    document.title = meta.templeTitle || '佛堂點名加分系統';
    const year = App.$('#yearLabel');
    year.textContent = meta.yearLabel || '';
    year.hidden = !meta.yearLabel;
    App.$('#soundBtn').textContent = App.prefs.sound ? '🔊' : '🔇';
    const u = App.s.user;
    App.setHtml('#userBtn', u
      ? App.html`${u.role === 'owner' ? '👑' : '🙏'} ${u.name}<span class="label-long">・${u.roleLabel}</span>`
      : App.html`🔒 <span class="label-long">壇務</span>登入`);
    const banner = [];
    if (!u) banner.push('👀 訪客模式：只能查看，學員名字已遮蔽。服務人員請點右上角登入');
    if (App.s.backend.mode === 'local') banner.push('💻 單機版：資料只存在這台電腦的瀏覽器');
    if (App.s.backendOutdated) banner.unshift('⚠️ 後台程式需要更新：請擁有者依部署說明更新 Apps Script（npm run build → clasp push → 發布新版本）');
    App.$('#modeBanner').textContent = banner.join('　');
    App.$('#syncStatus').textContent = App.isBusy() ? '⏳ 同步中（' + queue.filter(function (i) { return !i.deferred; }).length + '）…' : '';
    const mountain = App.$('#mountainBtn');
    mountain.hidden = !cloud();
    mountain.setAttribute('aria-pressed', App.prefs.mountain ? 'true' : 'false');
    renderNetBar();
  }

  function renderNetBar() {
    if (!cloud()) return App.setHtml('#netBar', '');
    const st = Off.statusBar({
      mountain: !!App.prefs.mountain,
      offline: App.s.offline,
      pending: App.pendingCount(),
      loggedIn: !!App.s.user,
      sending: sending
    });
    const rows = [];
    if (st) {
      rows.push(App.html`<div class="net-row net-${st.tone}" data-net="${st.tone}"><span>${st.text}</span>${
        st.button === 'flush' ? App.html`<button type="button" class="btn btn-sm" data-action="flush-outbox">立即上傳</button>`
        : st.button === 'login' ? App.html`<button type="button" class="btn btn-sm" data-action="open-login">重新登入</button>` : ''}</div>`);
    }
    if (App.s.conflicts.length) {
      rows.push(App.html`<div class="net-row net-warn" data-net="conflicts"><span>⚠️ 有 ${App.s.conflicts.length} 筆上傳被後台退回</span><button type="button" class="btn btn-sm" data-action="show-conflicts">查看明細</button></div>`);
    }
    App.setHtml('#netBar', rows);
  }

  /** 離線時把需要網路的按鈕標成停用的樣子（按下去會提示「需要網路」） */
  App.markNetwork = function (root) {
    const off = App.isOffline();
    App.$$('[data-action]', root || document).forEach(function (el) {
      const need = off && !Off.allowedOffline(el.dataset.action);
      el.classList.toggle('needs-net', need);
      if (need) el.setAttribute('title', '需要網路');
      else if (el.getAttribute('title') === '需要網路') el.removeAttribute('title');
    });
  };

  function openConflicts() {
    App.modal({
      title: '上傳被退回的項目',
      render: function () {
        const list = App.s.conflicts.slice().reverse();
        return App.html`
          <p class="muted" style="margin:0">這些操作在離線時存在手機，上傳時被後台擋下（例如另一台已經點過名、點數不足），沒有記入資料。請確認後視需要重新操作。</p>
          <div class="card list conflict-list">
            ${list.length ? list.map(function (c) {
              return App.html`<div class="list-item"><b>${c.label}</b><span class="minus">${c.message}</span><span class="faint">操作時間 ${String(c.at).replace('T', ' ').slice(5, 16)}・退回時間 ${String(c.rejectedAt).replace('T', ' ').slice(5, 16)}</span></div>`;
            }) : App.html`<div class="empty">沒有被退回的項目</div>`}
          </div>`;
      },
      foot: App.html`<button type="button" class="btn" data-close>關閉</button><button type="button" class="btn btn-primary" data-action="clear-conflicts">已確認，清除明細</button>`
    });
  }

  function renderClassBar() {
    const classes = App.classes();
    App.setHtml('#classBar', classes.map(function (c) {
      const count = App.students(c.id).length;
      return App.html`
        <button type="button" class="class-chip ${c.id === App.s.classId ? 'active' : ''}" data-action="switch-class" data-id="${c.id}" data-theme="${c.themeColor}">
          <span>${c.icon || '📚'}</span>
          <span>${c.name}<br><small>${count} 位學員</small></span>
        </button>`;
    }));
  }

  function renderSessionBar() {
    const cls = App.cls();
    const bar = App.$('#sessionBar');
    bar.hidden = !cls;
    if (!cls) return;
    const session = App.session();
    const regular = cls.schedule && cls.schedule.length ? App.scheduleText(cls) : '';
    const next = AttendStore.upcomingDates(cls, App.today(), 1)[0];
    const offDay = !session && regular && !AttendStore.scheduleSlotFor(cls, App.s.date);
    App.setHtml(bar, App.html`
      <label class="faint" for="dateInput">上課日期</label>
      <input id="dateInput" class="input" type="date" value="${App.s.date}" data-change="set-date" />
      <div class="session-info">
        ${session
          ? App.html`<b>${App.dateLabel(session.date)}</b> ${App.timeRange(session)} ${session.topic ? App.html`・${session.topic}` : ''}`
          : App.html`<span class="faint">${offDay ? '這天不是常態上課日；' : '這天還沒有課次，'}點名時會自動建立</span>`}
        ${regular ? App.html`<div class="faint">常態：${regular}${next ? App.html`・下次上課 ${App.dateLabel(next)}` : ''}</div>` : ''}
      </div>
      ${App.isStaff() ? App.html`<button type="button" class="btn btn-sm" data-action="edit-session">🗓️ ${session ? '編輯課次' : '建立課次'}</button>` : ''}`);
  }

  function renderTabs() {
    const tabs = Object.keys(App.views)
      .map(function (k) { return Object.assign({ key: k }, App.views[k]); })
      .filter(function (v) { return AttendAuth.atLeast(App.s.user, v.minRole || 'viewer'); })
      .sort(function (a, b) { return a.order - b.order; });
    App.setHtml('#tabBar', tabs.map(function (t) {
      const label = typeof t.label === 'function' ? t.label() : t.label;
      return App.html`<button type="button" class="tab ${t.key === App.s.tab ? 'active' : ''}" data-action="switch-tab" data-tab="${t.key}">${t.icon} ${label}</button>`;
    }));
  }

  function renderEmpty() {
    App.setHtml('#view', App.html`
      <div class="card empty">
        <span class="big">🪷</span>
        <p>目前還沒有任何班別。</p>
        ${App.isStaff()
          ? App.html`<div class="btn-row" style="justify-content:center">
              <button type="button" class="btn btn-primary" data-action="new-class">＋ 建立第一個班別</button>
              ${App.isOwner() && App.s.backend.mode === 'local' ? App.html`<button type="button" class="btn" data-action="load-sample">載入範例資料</button>` : ''}
            </div>`
          : App.html`<p class="faint">請服務人員登入後建立班別。</p>`}
      </div>`);
  }

  App.render = function () {
    const classes = App.classes();
    if (!classes.some(function (c) { return c.id === App.s.classId; })) {
      App.s.classId = classes.length ? classes[0].id : null;
    }
    const cls = App.cls();
    document.body.setAttribute('data-theme', cls ? cls.themeColor : 'amber');
    renderHeader();
    renderClassBar();
    renderSessionBar();
    renderTabs();
    const view = App.views[App.s.tab];
    const needsClass = !view || view.needsClass !== false;
    if (!cls && needsClass) renderEmpty();
    else App.setHtml('#view', view.render());
    App.refreshModals();
    App.markNetwork();
  };

  // ---------- 事件委派 ----------
  // <button data-action="名稱"> 點擊時呼叫 App.actions[名稱](el, event)
  // <input data-change="名稱"> 變更時呼叫 App.actions[名稱](el, event)
  // <input data-input="名稱"> 輸入時呼叫 App.actions[名稱](el, event)
  function dispatch(attr) {
    return function (e) {
      const el = e.target.closest('[' + attr + ']');
      if (!el || el.disabled) return;
      const name = el.getAttribute(attr);
      const fn = App.actions[name];
      if (fn && attr === 'data-action' && App.isOffline() && !Off.allowedOffline(name)) {
        e.preventDefault();
        App.toast(App.needsNetworkText(), 'warn');
        return;
      }
      if (fn) {
        if (attr === 'data-action') e.preventDefault();
        fn(el, e);
      }
    };
  }
  document.addEventListener('click', dispatch('data-action'));
  document.addEventListener('change', dispatch('data-change'));
  document.addEventListener('input', dispatch('data-input'));

  Object.assign(App.actions, {
    'switch-class': function (el) {
      App.s.classId = el.dataset.id;
      App.s.teamFilter = 'all';
      App.render();
    },
    'switch-tab': function (el) {
      App.s.tab = el.dataset.tab;
      App.render();
    },
    'set-date': function (el) {
      if (!el.value) return;
      App.s.date = el.value;
      App.render();
    },
    'toggle-sound': function () {
      App.prefs.sound = !App.prefs.sound;
      App.savePrefs();
      App.render();
      App.toast(App.prefs.sound ? '🔊 音效開啟' : '🔇 已靜音');
    },
    refresh: function () { App.refresh(); },
    'toggle-mountain': function () {
      App.prefs.mountain = !App.prefs.mountain;
      App.savePrefs();
      App.render();
      if (App.prefs.mountain) {
        App.toast('⛰️ 山上模式：不連線，點名加分先存在手機');
      } else {
        App.toast('📶 已關閉山上模式，連線中…');
        App.refresh(true);
      }
    },
    'flush-outbox': function () {
      if (App.prefs.mountain) return App.toast('⛰️ 山上模式不連線；要上傳請先關閉山上模式');
      if (App.s.offline) return App.refresh(false);
      App.flush();
    },
    'show-conflicts': function () { openConflicts(); },
    'clear-conflicts': function () {
      App.s.conflicts = [];
      Off.saveConflicts(storage(), []);
      App.closeTopModal();
      App.render();
    },
    'open-login': function () {
      if (App.s.user) openUserMenu();
      else openLogin();
    }
  });

  // ---------- 登入 ----------

  // 帳號清單要向後台讀取（雲端版要一兩秒）：讀取中不重複開啟；讀過一次後先用上次的清單立即開啟，背景再更新
  let loginLoading = false;
  let loginCache = null;

  function userOptions(users, selected) {
    return users.map(function (u) {
      return App.html`<option value="${u.id}" ${u.id === selected ? 'selected' : ''}>${u.name}（${u.roleLabel}）</option>`;
    });
  }

  function openLogin() {
    if (App.s.backend.mode === 'gas' && App.prefs.mountain) return App.toast('⛰️ 山上模式不連線；要登入請先關閉山上模式', 'warn');
    if (loginCache) {
      showLogin(loginCache);
      // 背景讀最新的帳號清單（例如剛新增的帳號），對話框還開著就更新選單
      App.s.backend.loginOptions().then(function (opts) {
        loginCache = opts;
        const select = document.querySelector('#loginUser');
        if (select && opts.users) App.setHtml(select, userOptions(opts.users, select.value));
      }, function () {});
      return;
    }
    if (loginLoading) return;
    loginLoading = true;
    App.toast('⏳ 讀取帳號清單…');
    App.s.backend.loginOptions().then(function (opts) {
      loginLoading = false;
      if (!opts.needsOwnerSetup) loginCache = opts;
      showLogin(opts);
    }, function (err) {
      loginLoading = false;
      App.handleError(err);
    });
  }

  function showLogin(opts) {
    if (opts.needsOwnerSetup) return openOwnerSetup();
    App.modal({
      title: '壇務登入',
      body: App.html`
        <form class="stack" data-login>
          <div class="field">
            <label for="loginUser">帳號</label>
            <select id="loginUser" class="select" name="userId">
              ${userOptions(opts.users)}
            </select>
          </div>
          <div class="field">
            <label for="loginPin">PIN 碼</label>
            <input id="loginPin" class="input" name="pin" type="password" inputmode="numeric" autocomplete="current-password" maxlength="8" autofocus />
          </div>
          <button type="submit" class="btn btn-primary btn-block">登入</button>
        </form>`,
      onMount: function (el, close) {
        const pin = el.querySelector('[name=pin]');
        App.onSubmit(el.querySelector('form'), '⏳ 登入中…', function (f) {
          return App.s.backend.login(f.userId, f.pin).then(function (user) {
            close();
            App.setUser(user);
            App.toast(`🙏 ${user.name}，歡迎登入（${user.roleLabel}）`, 'ok');
            App.refresh(true);
          }, function (err) {
            // PIN 錯了：清空讓使用者重新輸入
            pin.value = '';
            pin.focus();
            App.handleError(err);
          });
        });
      }
    });
  }

  function openOwnerSetup() {
    App.modal({
      title: '首次使用：設定擁有者',
      body: App.html`
        <p class="muted" style="margin:0">這是單機版第一次使用。請設定擁有者名稱與 PIN 碼，之後可以在「擁有者」分頁建立壇務帳號。</p>
        <form class="stack" data-setup>
          <div class="field"><label>擁有者名稱</label><input class="input" name="name" value="擁有者" maxlength="20" /></div>
          <div class="field"><label>PIN 碼（6–8 位數字）</label><input class="input" name="pin" type="password" inputmode="numeric" maxlength="8" autofocus /></div>
          <div class="field"><label>再輸入一次</label><input class="input" name="pin2" type="password" inputmode="numeric" maxlength="8" /></div>
          <button type="submit" class="btn btn-primary btn-block">完成設定並登入</button>
        </form>`,
      onMount: function (el, close) {
        App.onSubmit(el.querySelector('form'), '⏳ 設定中…', function (f) {
          if (f.pin !== f.pin2) return App.toast('⚠️ 兩次輸入的 PIN 不一樣', 'warn');
          return App.s.backend.setupOwner(f.name, f.pin).then(function (user) {
            close();
            App.setUser(user);
            App.toast('👑 設定完成，已登入為擁有者', 'ok');
            App.refresh(true);
          }, App.handleError);
        });
      }
    });
  }

  function openUserMenu() {
    const u = App.s.user;
    App.modal({
      title: u.name + '（' + u.roleLabel + '）',
      body: App.html`
        <div class="stack">
          ${u.builtin && App.s.backend.mode === 'gas'
            ? App.html`<p class="faint" style="margin:0">擁有者主帳號的 PIN 請在 Apps Script 的「指令碼屬性」OWNER_PIN 修改。</p>`
            : App.html`<button type="button" class="btn" data-action="change-my-pin">🔑 修改我的 PIN</button>`}
          <button type="button" class="btn btn-danger" data-action="logout">登出</button>
        </div>`
    });
  }

  App.actions.logout = function () {
    App.closeTopModal();
    const n = App.pendingCount();
    if (n) {
      App.confirm(`還有 ${n} 筆尚未上傳。\n登出後資料仍保留在這支手機，要重新登入才會上傳。確定要登出嗎？`, { okLabel: '登出' }).then(function (yes) {
        if (yes) logout();
      });
      return;
    }
    logout();
  };

  function logout() {
    // 先在畫面與記憶體遮蔽名字，不必等後台回應（網路慢或斷線時也不會留著完整名冊）
    App.setUser(null);
    App.loadData(AttendAuth.viewFor(confirmed || App.s.data, null));
    App.render();
    App.s.backend.logout().then(function () {
      App.toast('已登出，回到訪客模式');
      App.refresh(true);
    });
  }

  App.actions['change-my-pin'] = function () {
    App.closeTopModal();
    App.modal({
      title: '修改我的 PIN',
      body: App.html`
        <form class="stack">
          <div class="field"><label>目前的 PIN</label><input class="input" name="oldPin" type="password" inputmode="numeric" maxlength="8" autofocus /></div>
          <div class="field"><label>新的 PIN（6–8 位數字）</label><input class="input" name="newPin" type="password" inputmode="numeric" maxlength="8" /></div>
          <div class="field"><label>再輸入一次</label><input class="input" name="newPin2" type="password" inputmode="numeric" maxlength="8" /></div>
          <button type="submit" class="btn btn-primary btn-block">儲存</button>
        </form>`,
      onMount: function (el, close) {
        App.onSubmit(el.querySelector('form'), '⏳ 儲存中…', function (f) {
          if (f.newPin !== f.newPin2) return App.toast('⚠️ 兩次輸入的新 PIN 不一樣', 'warn');
          return App.s.backend.userOp({ type: 'self.changePin', oldPin: f.oldPin, newPin: f.newPin }).then(function () {
            close();
            App.toast('🔑 PIN 已更新', 'ok');
          }, App.handleError);
        });
      }
    });
  };
})(window.App = window.App || {});
