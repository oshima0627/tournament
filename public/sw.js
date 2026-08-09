/* ===========================================================
 * Service Worker
 * 要件 7.4「一度読み込んだあとは、通信が切れても使えること」を満たす。
 *
 * 方針は stale-while-revalidate：
 *   キャッシュがあれば即座に返し、裏で新しい版を取り込む。
 *   → オフラインでもリロードできる／次回起動時には最新になる
 *
 * アプリを更新したら CACHE の版数を上げること。
 * =========================================================== */
'use strict';

const CACHE = 'taisenhyo-v3';

/** 事前に取り込むファイル（アプリの動作に必要なものすべて） */
const SHELL = [
  './',
  './index.html',
  './assets/style.css',
  './assets/app.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // 外部への通信は素通しする

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);

    // 画面遷移（リロード含む）は index.html を返す。共有URLのハッシュは影響しない
    const key = req.mode === 'navigate' ? './index.html' : req;
    const hit = await cache.match(key, { ignoreSearch: req.mode === 'navigate' });

    const fresh = fetch(req)
      .then((res) => {
        if (res && res.ok) cache.put(key, res.clone());
        return res;
      })
      .catch(() => null);

    // キャッシュがあれば即返し、更新は裏で進める
    if (hit) return hit;

    const res = await fresh;
    if (res) return res;

    // オフラインで初回アクセスした場合の保険
    return (await cache.match('./index.html')) || new Response('オフラインです', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  })());
});
