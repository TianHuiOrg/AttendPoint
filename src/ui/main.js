/* 啟動：選擇後端、讀取資料、定時同步 */
(function (App) {
  'use strict';

  const POLL_MS = 30000;

  function start() {
    App.loadPrefs();
    App.s.backend = App.createBackend();
    App.s.date = App.today();
    const cloud = App.s.backend.mode === 'gas';
    // 雲端版：先用手機上的資料與尚未上傳的操作顯示畫面（離線也能用），再向後台更新
    const cached = App.restoreOffline();
    if (cloud && typeof navigator !== 'undefined' && navigator.onLine === false) App.s.offline = true;
    App.render();
    if (!cached) App.$('#syncStatus').textContent = '讀取資料中…';

    App.loadLogo();
    if (cloud && App.prefs.mountain) {
      App.toast('⛰️ 山上模式：使用手機上的資料，點名加分先存在手機', 'ok');
    } else {
      App.s.backend.init().then(function (res) {
        App.s.user = res.user || null;
        App.loadData(res.state);
        App.render();
        if (res.notice) App.toast(res.notice, 'ok');
        if (res.sessionExpired) App.toast('登入已逾時，請重新登入' + (App.pendingCount() ? '；尚未上傳的資料會保留，登入後自動上傳' : ''), 'warn');
        App.flush();
      }, function (err) {
        if (cloud && cached && AttendOffline.isNetworkError(err)) {
          App.setOffline(true);
          App.toast('📴 連不上後台，先顯示手機上的資料', 'warn');
          return;
        }
        App.handleError(err);
        App.$('#syncStatus').textContent = '⚠️ 讀取失敗，請重新整理頁面';
      });
    }

    // 雲端版：定時取得其他服務人員的變更（畫面在背景、有操作進行中或對話框開啟時暫停）
    // 離線時同一個計時器也負責偵測網路恢復、自動上傳
    if (cloud) {
      setInterval(function () {
        if (document.hidden || App.isBusy() || App.hasModal()) return;
        App.refresh(true);
      }, POLL_MS);
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden && !App.isBusy()) App.refresh(true);
      });
      window.addEventListener('online', function () { App.refresh(true); });
      window.addEventListener('offline', function () { App.setOffline(true); });
      registerServiceWorker();
    }
  }

  /** 網頁檔案存在手機（sw.js），沒有網路也能開啟；有新版本時自動換新 */
  function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').catch(function () { /* 不支援或被封鎖：照常線上使用 */ });
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (hadController) App.toast('🆕 網頁已更新，重新整理後使用新版');
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})(window.App = window.App || {});
