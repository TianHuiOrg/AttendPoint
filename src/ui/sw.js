/*
 * Service Worker：把網頁存在手機，山上沒有網路也能開啟（雲端版，GitHub Pages）。
 *
 *   - 網頁（index.html）先上網抓最新版，等太久（4 秒）或沒有網路時改用手機上存的版本
 *   - 字型（Google Fonts）存過一次就直接用手機上的
 *   - 版本更新：建置時把網頁內容的指紋寫進 VERSION，sw.js 內容改變，瀏覽器會自動安裝新版並清掉舊的快取
 *   - 後台（script.google.com）的資料不經過這裡：資料與尚未上傳的操作由網頁自己存（見 offline.js）
 */
const VERSION = '@SW_VERSION@';
const CACHE = 'attendpoint-' + VERSION;
const FONT_CACHE = 'attendpoint-fonts';
const NETWORK_WAIT_MS = 4000;
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

function pageKey(url) {
  const u = new URL(url);
  u.search = '';
  u.hash = '';
  return u.href;
}

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(CACHE).then(function (cache) {
    // 存下網站首頁與目前開著的網頁（第一次開啟時網頁還不是由 Service Worker 提供）
    return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clients) {
      const urls = [new URL('./', self.registration.scope).href].concat(clients.map(function (c) { return pageKey(c.url); }));
      return Promise.all(urls.filter(function (u, i) { return urls.indexOf(u) === i; }).map(function (u) {
        return fetch(u, { cache: 'reload' }).then(function (res) {
          if (res.ok) return cache.put(u, res);
        }).catch(function () {});
      }));
    });
  }));
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) {
      return k.indexOf('attendpoint-') === 0 && k !== CACHE && k !== FONT_CACHE;
    }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

/** 先上網抓；失敗或等太久就用手機上存的 */
function networkFirst(request) {
  const key = pageKey(request.url);
  return caches.open(CACHE).then(function (cache) {
    const network = fetch(request).then(function (res) {
      if (res.ok) cache.put(key, res.clone());
      return res;
    });
    const fallback = function () {
      return cache.match(key).then(function (hit) {
        return hit || cache.match(new URL('./', self.registration.scope).href).then(function (home) {
          return home || network;
        });
      });
    };
    let timer;
    const slow = new Promise(function (resolve) { timer = setTimeout(resolve, NETWORK_WAIT_MS); }).then(function () {
      return cache.match(key).then(function (hit) { return hit || network; });
    });
    return Promise.race([network.catch(fallback), slow]).then(function (res) {
      clearTimeout(timer);
      return res;
    }, function () {
      clearTimeout(timer);
      return fallback();
    });
  });
}

function cacheFirst(request) {
  return caches.open(FONT_CACHE).then(function (cache) {
    return cache.match(request).then(function (hit) {
      return hit || fetch(request).then(function (res) {
        if (res.ok || res.type === 'opaque') cache.put(request, res.clone());
        return res;
      });
    });
  });
}

self.addEventListener('fetch', function (event) {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (FONT_HOSTS.indexOf(url.hostname) !== -1) {
    event.respondWith(cacheFirst(req));
    return;
  }
  if (url.origin === self.location.origin && (req.mode === 'navigate' || /\.html?$/.test(url.pathname) || url.pathname.slice(-1) === '/')) {
    event.respondWith(networkFirst(req));
  }
});
