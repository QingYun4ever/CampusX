/**
 * 手机（和网页）上的媒体缓存：图片、表情、视频封面由 public/media-sw.js 自动缓存；
 * 视频看完大半后，这里在 Wi-Fi 下完整存一份，下次播放、拖进度都不再走网络。
 * 上限：图片 200 MB / 6000 个（Service Worker 里管），视频 200 MB / 30 个（这里管），超了先删最久没看的。
 */
const IMG_CACHE = 'media-img-v1';
const VID_CACHE = 'media-vid-v1';
export const IMG_MAX_BYTES = 200 * 1024 * 1024;
export const VID_MAX_BYTES = 200 * 1024 * 1024;
const VID_MAX_COUNT = 30;
/** 单个视频超过这么大就不存 */
const VID_MAX_ONE = 60 * 1024 * 1024;
const LIST_KEY = 'txq_cached_videos';

interface Entry { url: string; kind: 'img' | 'vid'; size: number; t: number }

const supported = () => typeof window !== 'undefined' && 'caches' in window && 'indexedDB' in window && 'serviceWorker' in navigator;

/** 生产环境注册 Service Worker；失败了就是没有缓存，不影响别的 */
export function registerMediaCache() {
  if (!import.meta.env.PROD || !supported()) return;
  const go = () => navigator.serviceWorker.register('/media-sw.js', { scope: '/' }).catch(() => {});
  if (document.readyState === 'complete') go();
  else window.addEventListener('load', go, { once: true });
}

let dbPromise: Promise<IDBDatabase> | undefined;
function openDb() {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
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
const done = (t: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = t.onabort = () => reject(t.error);
  });
async function entries(kind: Entry['kind']) {
  const db = await openDb();
  return new Promise<Entry[]>((resolve, reject) => {
    const r = db.transaction('entries').objectStore('entries').index('kind').getAll(kind);
    r.onsuccess = () => resolve(r.result as Entry[]);
    r.onerror = () => reject(r.error);
  });
}

/* ---------------- 缓存过的视频清单（同步读，决定播放地址） ---------------- */

function readList(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(LIST_KEY) || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function writeList(list: string[]) {
  try {
    localStorage.setItem(LIST_KEY, JSON.stringify(list.slice(-VID_MAX_COUNT * 2)));
  } catch {
    /* 隐私模式 */
  }
}

/**
 * 视频的播放地址：缓存过的加上 c=1，Service Worker 从缓存里按 Range 给；没缓存的原样。
 * 组件里要固定住（换地址会让视频重新加载）。
 */
export function videoSrc(url: string) {
  if (!supported() || !navigator.serviceWorker.controller || !readList().includes(url)) return url;
  void touchVideo(url);
  return url + (url.includes('?') ? '&' : '?') + 'c=1';
}

async function touchVideo(url: string) {
  try {
    const db = await openDb();
    const t = db.transaction('entries', 'readwrite');
    const s = t.objectStore('entries');
    const g = s.get(url);
    g.onsuccess = () => g.result && s.put({ ...g.result, t: Date.now() });
    await done(t);
  } catch {
    /* 没关系 */
  }
}

/* ---------------- 看完大半后存一份 ---------------- */

const tried = new Set<string>();
let busy = false;

function allowedNetwork() {
  const conn = (navigator as Navigator & { connection?: { type?: string; saveData?: boolean } }).connection;
  if (conn?.saveData) return false;
  // 知道是手机流量就不存（再下一遍费流量）；不知道的（比如 iPhone）照常
  return conn?.type !== 'cellular';
}

/** 视频播放进度更新时调用：看到 80% 以上就在后台缓存整个文件（每个视频只试一次） */
export function noteVideoProgress(url: string, el: HTMLVideoElement) {
  if (!el.duration || el.currentTime / el.duration < 0.8) return;
  if (tried.has(url) || busy || !supported() || !navigator.serviceWorker.controller || readList().includes(url)) return;
  if (!/\/uploads\/v\/[\w-]{16}\.mp4$/.test(new URL(url, location.href).pathname)) return;
  tried.add(url);
  if (!allowedNetwork()) return;
  busy = true;
  void cacheVideo(url).catch(() => {}).finally(() => {
    busy = false;
  });
}

async function cacheVideo(url: string) {
  // 浏览器自己的缓存里可能已经有完整的文件，有就不用再下载
  const res = await fetch(url, { mode: 'cors', credentials: 'omit', cache: 'force-cache' });
  if (res.status !== 200) return;
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > VID_MAX_ONE) {
    void res.body?.cancel();
    return;
  }
  const blob = await res.blob();
  if (!blob.size || blob.size > VID_MAX_ONE) return;
  await makeRoom(blob.size);
  const cache = await caches.open(VID_CACHE);
  await cache.put(url, new Response(blob, { headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(blob.size) } }));
  const db = await openDb();
  const t = db.transaction('entries', 'readwrite');
  t.objectStore('entries').put({ url, kind: 'vid', size: blob.size, t: Date.now() } satisfies Entry);
  await done(t);
  writeList([...readList().filter((x) => x !== url), url]);
}

/** 放得下 incoming 字节：按最久没看的删 */
async function makeRoom(incoming: number) {
  const all = (await entries('vid')).sort((a, b) => a.t - b.t);
  let bytes = all.reduce((n, e) => n + e.size, 0) + incoming;
  let count = all.length + 1;
  const cache = await caches.open(VID_CACHE);
  const db = await openDb();
  const t = db.transaction('entries', 'readwrite');
  const s = t.objectStore('entries');
  const gone = new Set<string>();
  for (const e of all) {
    if (bytes <= VID_MAX_BYTES && count <= VID_MAX_COUNT) break;
    s.delete(e.url);
    gone.add(e.url);
    void cache.delete(e.url);
    bytes -= e.size;
    count--;
  }
  await done(t);
  if (gone.size) writeList(readList().filter((x) => !gone.has(x)));
}

/* ---------------- 设置页：看用量、清空 ---------------- */

export async function mediaCacheUsage() {
  if (!supported()) return null;
  try {
    const [img, vid] = await Promise.all([entries('img'), entries('vid')]);
    const sum = (l: Entry[]) => l.reduce((n, e) => n + e.size, 0);
    return { imgBytes: sum(img), imgCount: img.length, vidBytes: sum(vid), vidCount: vid.length };
  } catch {
    return null;
  }
}

export async function clearMediaCache() {
  writeList([]);
  tried.clear();
  await Promise.all([caches.delete(IMG_CACHE), caches.delete(VID_CACHE)]);
  const db = await openDb();
  const t = db.transaction('entries', 'readwrite');
  t.objectStore('entries').clear();
  await done(t);
}
