/*
 * 媒体缓存（网页和 App 共用）。只管站内公开的图片、表情、视频封面和缓存好的视频；
 * 页面、接口、私信图片一概不碰，所以出了问题也只是回落到普通网络请求。
 *
 * 这些文件名是随机的、内容不变，缓存命中就不用再走网络（也不用再经过服务器跳转到对象存储）。
 * 上限：图片 IMG_MAX_BYTES / IMG_MAX_COUNT，超了按最久没看的先删。视频由页面写入（见 src/lib/media-cache.ts）。
 */
const IMG_CACHE = 'media-img-v1';
const VID_CACHE = 'media-vid-v1';
const IMG_MAX_BYTES = 200 * 1024 * 1024;
const IMG_MAX_COUNT = 6000;
const IMG = /^\/uploads\/(?:[sa]\/)?[\w-]+\.(?:jpg|png|webp|gif)$|^\/uploads\/v\/[\w-]{16}\.jpg$/;
const VID = /^\/uploads\/v\/[\w-]{16}\.mp4$/;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // 以后改了缓存名：删掉旧的
    for (const name of await caches.keys()) {
      if (name.startsWith('media-') && name !== IMG_CACHE && name !== VID_CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (IMG.test(url.pathname)) event.respondWith(image(event, req, url));
  // 视频只接管页面确认缓存过的（地址带 c=1），其余照常走网络，拖进度条不受影响
  else if (VID.test(url.pathname) && url.searchParams.get('c') === '1') event.respondWith(video(req, url));
});

/* ---------------- 索引（IndexedDB）：每个文件多大、最近什么时候看过 ---------------- */

let dbPromise;
function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const r = indexedDB.open('media-cache', 1);
    r.onupgradeneeded = () => {
      const s = r.result.createObjectStore('entries', { keyPath: 'url' });
      s.createIndex('kind', 'kind');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }).catch((e) => {
    dbPromise = undefined;
    throw e;
  });
  return dbPromise;
}
const done = (t) => new Promise((resolve, reject) => {
  t.oncomplete = () => resolve();
  t.onerror = t.onabort = () => reject(t.error);
});

/** 命中时记一下时间；同一个文件 10 分钟内只记一次，少写库 */
const touched = new Map();
async function touch(key) {
  const now = Date.now();
  if (now - (touched.get(key) ?? 0) < 600_000) return;
  touched.set(key, now);
  if (touched.size > 2000) touched.clear();
  const db = await openDb();
  const t = db.transaction('entries', 'readwrite');
  const s = t.objectStore('entries');
  const g = s.get(key);
  g.onsuccess = () => g.result && s.put({ ...g.result, t: now });
  await done(t);
}

let evicting = null;
async function record(key, size) {
  const db = await openDb();
  const t = db.transaction('entries', 'readwrite');
  t.objectStore('entries').put({ url: key, kind: 'img', size, t: Date.now() });
  await done(t);
  evicting ??= evict().finally(() => (evicting = null));
  await evicting;
}

/** 超过上限：按最久没看的删到 90% */
async function evict() {
  const db = await openDb();
  const all = await new Promise((resolve, reject) => {
    const r = db.transaction('entries').objectStore('entries').index('kind').getAll('img');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  let bytes = all.reduce((n, e) => n + e.size, 0);
  let count = all.length;
  if (bytes <= IMG_MAX_BYTES && count <= IMG_MAX_COUNT) return;
  all.sort((a, b) => a.t - b.t);
  const cache = await caches.open(IMG_CACHE);
  const t = db.transaction('entries', 'readwrite');
  const s = t.objectStore('entries');
  for (const e of all) {
    if (bytes <= IMG_MAX_BYTES * 0.9 && count <= IMG_MAX_COUNT * 0.9) break;
    s.delete(e.url);
    void cache.delete(e.url);
    bytes -= e.size;
    count--;
  }
  await done(t);
}

/* ---------------- 图片 ---------------- */

async function image(event, req, url) {
  const key = url.href;
  try {
    const cache = await caches.open(IMG_CACHE);
    const hit = await cache.match(key);
    if (hit) {
      event.waitUntil(touch(key).catch(() => {}));
      return hit;
    }
  } catch {
    // 缓存坏了：照常走网络
  }
  let res;
  try {
    // 用 CORS 取才能读到内容和大小（跨到对象存储也允许）；不行再按原样取
    res = await fetch(key, { mode: 'cors', credentials: 'omit' });
  } catch {
    return fetch(req);
  }
  // 只存服务器标了长期不变的（临时退回原图的不存，下次还要取缩略图）
  if (res.status === 200 && /immutable/.test(res.headers.get('cache-control') || '')) {
    event.waitUntil(store(key, res.clone()).catch(() => {}));
  }
  return res;
}

async function store(key, res) {
  const blob = await res.blob();
  if (!blob.size || blob.size > 20 * 1024 * 1024) return;
  const cache = await caches.open(IMG_CACHE);
  await cache.put(key, new Response(blob, {
    headers: {
      'Content-Type': res.headers.get('content-type') || blob.type || 'application/octet-stream',
      'Content-Length': String(blob.size),
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  }));
  await record(key, blob.size);
}

/* ---------------- 视频：从缓存按 Range 取 ---------------- */

async function video(req, url) {
  url.searchParams.delete('c');
  const key = url.href;
  let hit;
  try {
    hit = await (await caches.open(VID_CACHE)).match(key);
  } catch {
    // 照常走网络
  }
  // 页面以为缓存过、其实已经被清掉了：原样走网络（带着 Range）
  if (!hit) return fetch(req);
  const blob = await hit.blob();
  const size = blob.size;
  const type = hit.headers.get('content-type') || 'video/mp4';
  const range = /^bytes=(\d*)-(\d*)$/.exec((req.headers.get('range') || '').trim());
  if (!range) {
    return new Response(blob, { status: 200, headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' } });
  }
  let start;
  let end;
  if (range[1] === '') {
    // bytes=-500：最后 500 字节
    start = Math.max(0, size - Number(range[2]));
    end = size - 1;
  } else {
    start = Number(range[1]);
    end = range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1);
  }
  if (!(start <= end) || start >= size) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': type,
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
    },
  });
}
