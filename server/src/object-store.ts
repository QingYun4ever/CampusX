/**
 * 图片和视频放到国内对象存储（S3 兼容，比如雨云 RainS3）。
 *
 * 本机的文件照旧保留（审核、缩略图、备份都读本机，本机文件不会因为传上去而删掉）。
 * 后台把公开的图片、缩略图、表情、视频传一份到存储桶：启动后补传已有的，之后有人访问到还没传的就排队传。
 * 已经传上去的，服务器验证完权限（文件还登记着、没被删）就 302 跳到 MEDIA_PUBLIC_BASE 上的同名对象，
 * 大流量走国内存储，不占服务器带宽。私信图片要登录才能看，不传。
 *
 * 上限：存储桶里的总大小超过 MEDIA_REMOTE_MAX_GB 就不再上传；本月估算的下载流量超过 MEDIA_REMOTE_MONTHLY_GB
 * 就不再跳转（改回服务器直出，下个月自动恢复）。估算按每次跳转要下载的字节（视频按 Range 的范围，其余按整个文件），偏保守。
 * 去掉 S3_* 环境变量或设 MEDIA_REMOTE=off，全部改回服务器直出。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { Transform } from 'node:stream';
import { db, get, run } from './db.ts';

const env = (k: string) => process.env[k]?.trim() || '';
const positive = (k: string, fallback: number) => {
  const n = Number(env(k));
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const GB = 1024 ** 3;

const remote = (() => {
  const endpoint = env('S3_ENDPOINT').replace(/\/+$/, '');
  const bucket = env('S3_BUCKET');
  const accessKey = env('S3_ACCESS_KEY');
  const secretKey = env('S3_SECRET_KEY');
  const publicBase = env('MEDIA_PUBLIC_BASE').replace(/\/+$/, '');
  if (!endpoint || !bucket || !accessKey || !secretKey || !publicBase || env('MEDIA_REMOTE') === 'off') return null;
  let url: URL;
  try {
    url = new URL(endpoint);
    new URL(publicBase);
  } catch {
    console.error('[对象存储] S3_ENDPOINT 或 MEDIA_PUBLIC_BASE 不是有效地址，改回服务器直出');
    return null;
  }
  return {
    url,
    bucket,
    accessKey,
    secretKey,
    publicBase,
    region: env('S3_REGION') || 'us-east-1',
    /** 存储桶里的目录前缀，比如 campusx/（测试时用来和正式数据分开） */
    prefix: env('S3_PREFIX').replace(/^\/+/, ''),
    maxBytes: positive('MEDIA_REMOTE_MAX_GB', 18) * GB,
    monthlyBytes: positive('MEDIA_REMOTE_MONTHLY_GB', 90) * GB,
    /** 往存储桶传文件的限速，别把服务器的出口带宽占满 */
    uploadBytesPerSec: positive('MEDIA_UPLOAD_KBPS', 1024) * 1024,
  };
})();

export const remoteEnabled = () => remote !== null;

db.exec(`
CREATE TABLE IF NOT EXISTS remote_media (
  key TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  uploaded_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS remote_media_trash (key TEXT PRIMARY KEY) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS remote_media_usage (
  month TEXT PRIMARY KEY,
  bytes INTEGER NOT NULL DEFAULT 0,
  redirects INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
`);

/* ---------------- S3 签名（AWS Signature V4） ---------------- */

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (key: crypto.BinaryLike, s: string) => crypto.createHmac('sha256', key).update(s).digest();
/** S3 的路径编码：除了 unreserved 字符和 / 都要编码 */
const encodePath = (p: string) =>
  p.split('/').map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');

interface S3Request {
  method: 'PUT' | 'DELETE' | 'HEAD' | 'GET' | 'POST';
  key: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: { file: string; size: number } | Buffer;
}

/** 限速：所有上传共用一个令牌桶 */
let tokens = 0;
let tokensAt = Date.now();
function throttle(rate: number) {
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      const now = Date.now();
      tokens = Math.min(rate, tokens + ((now - tokensAt) / 1000) * rate);
      tokensAt = now;
      tokens -= chunk.length;
      const wait = tokens < 0 ? (-tokens / rate) * 1000 : 0;
      if (wait > 0) setTimeout(() => done(null, chunk), wait);
      else done(null, chunk);
    },
  });
}

function s3(req: S3Request): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const r = remote!;
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const pathname = encodePath(`/${r.bucket}/${r.prefix}${req.key}`);
  const query = Object.entries(req.query ?? {})
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const headers: Record<string, string> = {
    host: r.url.host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
    ...Object.fromEntries(Object.entries(req.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
  };
  if (req.body) headers['content-length'] = String(Buffer.isBuffer(req.body) ? req.body.length : req.body.size);
  // host、x-amz-* 和其余带上的头一起签
  const signed = Object.keys(headers).sort();
  const canonical = [
    req.method, pathname, query,
    signed.map((k) => `${k}:${headers[k].trim()}\n`).join(''),
    signed.join(';'),
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const scope = `${day}/${r.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${r.secretKey}`, day), r.region), 's3'), 'aws4_request');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${r.accessKey}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${hmac(key, toSign).toString('hex')}`;

  const lib = r.url.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const q = lib.request({
      method: req.method,
      host: r.url.hostname,
      port: r.url.port || undefined,
      path: pathname + (query ? `?${query}` : ''),
      headers,
      timeout: 120_000,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { if (body.length < 256 * 1024) body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      res.on('error', reject);
    });
    q.on('timeout', () => q.destroy(new Error('对象存储请求超时')));
    q.on('error', reject);
    if (!req.body) q.end();
    else if (Buffer.isBuffer(req.body)) q.end(req.body);
    else {
      const stream = fs.createReadStream(req.body.file, { end: Math.max(0, req.body.size - 1) });
      stream.on('error', (e) => q.destroy(e));
      stream.pipe(throttle(r.uploadBytesPerSec)).pipe(q);
    }
  });
}

const errorOf = (r: { status: number; body: string }) => `${r.status} ${/<Code>([^<]+)<\/Code>/.exec(r.body)?.[1] ?? r.body.slice(0, 120)}`;

/** 上传一个本机文件；对象公开可读，带长期缓存 */
async function putFile(key: string, file: string, contentType: string) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || !stat.size) throw new Error('本机文件不存在或是空的');
  const r = await s3({
    method: 'PUT',
    key,
    headers: { 'content-type': contentType, 'cache-control': 'public, max-age=31536000, immutable', 'x-amz-acl': 'public-read' },
    body: { file, size: stat.size },
  });
  if (r.status !== 200) throw new Error(`上传失败：${errorOf(r)}`);
  return stat.size;
}

async function deleteObject(key: string) {
  const r = await s3({ method: 'DELETE', key });
  // 本来就不存在也算删掉了
  if (r.status !== 204 && r.status !== 200 && r.status !== 404) throw new Error(`删除失败：${errorOf(r)}`);
}

/** 列出前缀下的对象（测试清理用） */
async function listKeys(prefix: string) {
  const out: string[] = [];
  let token = '';
  for (let i = 0; i < 100; i++) {
    const r = await s3({ method: 'GET', key: '', query: { 'list-type': '2', prefix: remote!.prefix + prefix, 'max-keys': '1000', ...(token ? { 'continuation-token': token } : {}) } });
    if (r.status !== 200) throw new Error(`列目录失败：${errorOf(r)}`);
    for (const m of r.body.matchAll(/<Key>([^<]+)<\/Key>/g)) out.push(m[1].replace(/&amp;/g, '&'));
    token = /<NextContinuationToken>([^<]+)</.exec(r.body)?.[1] ?? '';
    if (!token) break;
  }
  return out;
}

/* ---------------- 类型 ---------------- */

const TYPES: Record<string, string> = { webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', mp4: 'video/mp4' };
export const contentTypeOf = (key: string) => TYPES[key.slice(key.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream';
const publicUrl = (key: string) => `${remote!.publicBase}/${encodePath(remote!.prefix + key)}`;

/* ---------------- 用量 ---------------- */

const monthNow = () => new Date().toISOString().slice(0, 7);
/** 跳转次数和估算流量先记在内存里，每 30 秒写一次库 */
let pendingUsage = { month: monthNow(), bytes: 0, redirects: 0 };
function flushUsage() {
  if (!pendingUsage.redirects) return;
  run(`INSERT INTO remote_media_usage (month, bytes, redirects) VALUES ($m, $b, $r)
       ON CONFLICT(month) DO UPDATE SET bytes = bytes + $b, redirects = redirects + $r`,
  { m: pendingUsage.month, b: pendingUsage.bytes, r: pendingUsage.redirects });
  pendingUsage = { month: monthNow(), bytes: 0, redirects: 0 };
}
function monthUsage() {
  const m = monthNow();
  const row = get<{ bytes: number; redirects: number }>('SELECT bytes, redirects FROM remote_media_usage WHERE month = $m', { m });
  const extra = pendingUsage.month === m ? pendingUsage : { bytes: 0, redirects: 0 };
  return { bytes: (row?.bytes ?? 0) + extra.bytes, redirects: (row?.redirects ?? 0) + extra.redirects };
}
let storedBytes = 0;
const refreshStored = () => {
  storedBytes = get<{ b: number }>('SELECT COALESCE(SUM(size), 0) AS b FROM remote_media')!.b;
};

/* ---------------- 上传队列 ---------------- */

export interface MediaFile { key: string; file: string }
const queue: MediaFile[] = [];
const queued = new Set<string>();
/** 失败过的对象：半小时内不再试 */
const failedAt = new Map<string, number>();
let active = 0;
let pausedUntil = 0;
let consecutiveFailures = 0;
const MAX_ACTIVE = 4;
const stats = { uploaded: 0, uploadedBytes: 0, failed: 0, deleted: 0, lastError: '', lastErrorAt: 0 };
let overStorage = false;
let overTraffic = false;

function pump() {
  if (!remote) return;
  while (active < MAX_ACTIVE && queue.length && Date.now() >= pausedUntil) {
    const job = queue.shift()!;
    if (storedBytes >= remote.maxBytes) {
      overStorage = true;
      queued.delete(job.key);
      continue;
    }
    active++;
    void (async () => {
      try {
        const size = await putFile(job.key, job.file, contentTypeOf(job.key));
        // 上传期间本机文件被清理掉了：存储桶里的也不留
        if (!fs.existsSync(job.file)) {
          await deleteObject(job.key).catch(() => run('INSERT OR IGNORE INTO remote_media_trash (key) VALUES ($key)', { key: job.key }));
          return;
        }
        run('INSERT OR REPLACE INTO remote_media (key, size, uploaded_at) VALUES ($key, $size, $at)', { key: job.key, size, at: Date.now() });
        storedBytes += size;
        stats.uploaded++;
        stats.uploadedBytes += size;
        consecutiveFailures = 0;
        failedAt.delete(job.key);
      } catch (e) {
        stats.failed++;
        stats.lastError = (e as Error).message.slice(0, 200);
        stats.lastErrorAt = Date.now();
        failedAt.set(job.key, Date.now());
        // 本机文件不在了不算存储桶的问题
        if (!/本机文件/.test(stats.lastError) && ++consecutiveFailures >= 5) {
          // 连续失败（存储桶挂了、密钥失效）：暂停一会儿，期间照常由服务器直出
          pausedUntil = Date.now() + 10 * 60_000;
          consecutiveFailures = 0;
          console.error('[对象存储] 连续上传失败，暂停 10 分钟：', stats.lastError);
          setTimeout(pump, 10 * 60_000 + 100).unref();
        }
      } finally {
        active--;
        queued.delete(job.key);
        setImmediate(pump);
        setImmediate(feedBackfill);
      }
    })();
  }
}

function enqueue(job: MediaFile) {
  if (queued.has(job.key)) return;
  const failed = failedAt.get(job.key);
  if (failed && Date.now() - failed < 30 * 60_000) return;
  queued.add(job.key);
  queue.push(job);
  pump();
}

/**
 * 服务器要发送某个公开文件时调用（已经确认文件可以公开）：已经在存储桶里就返回跳转地址；
 * 还没有就排队上传（这次仍由服务器直出），返回 null。range 是请求的 Range 头，用来估算这次下载多少字节。
 */
export function remoteFor(key: string, file: string, range?: string): string | null {
  if (!remote) return null;
  const row = get<{ size: number }>('SELECT size FROM remote_media WHERE key = $key', { key });
  if (!row) {
    if (queue.length < 2000) enqueue({ key, file });
    return null;
  }
  if (pendingUsage.month !== monthNow()) flushUsage();
  const bytes = estimateBytes(row.size, range);
  if (monthUsage().bytes + bytes > remote.monthlyBytes) {
    overTraffic = true;
    return null;
  }
  overTraffic = false;
  pendingUsage.bytes += bytes;
  pendingUsage.redirects++;
  return publicUrl(key);
}

/** 这次跳转大概会下载多少：看视频时手机会分很多段 Range 来取，按整个文件算会高估好几倍 */
function estimateBytes(size: number, range?: string) {
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!m || (m[1] === '' && m[2] === '')) return size;
  if (m[1] === '') return Math.min(size, Number(m[2]));
  const start = Math.min(Number(m[1]), size);
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  return Math.max(0, end - start + 1);
}

/** 文件在本机删掉了：存储桶里的也删掉（失败的记下来，之后再试） */
export function removeRemote(keys: string[]) {
  if (!remote) return;
  for (const key of keys) {
    const row = get<{ size: number }>('SELECT size FROM remote_media WHERE key = $key', { key });
    if (!row) continue;
    void deleteObject(key)
      .then(() => {
        const { changes } = run('DELETE FROM remote_media WHERE key = $key', { key });
        if (changes) storedBytes = Math.max(0, storedBytes - row.size);
        run('DELETE FROM remote_media_trash WHERE key = $key', { key });
        stats.deleted++;
      })
      .catch((e) => {
        stats.lastError = (e as Error).message.slice(0, 200);
        stats.lastErrorAt = Date.now();
        run('INSERT OR IGNORE INTO remote_media_trash (key) VALUES ($key)', { key });
      });
  }
}

/* ---------------- 补传已有的文件 ---------------- */

/** 各模块登记「现在有哪些公开文件」，启动后按批补传 */
const sources: (() => MediaFile[])[] = [];
export function registerMediaSource(fn: () => MediaFile[]) {
  sources.push(fn);
}
let backfill: MediaFile[] | null = null;
const backfillStats = { total: 0, done: 0, finishedAt: 0 };

function feedBackfill() {
  if (!remote || !backfill || queue.length >= 20) return;
  while (backfill.length && queue.length < 20) {
    const job = backfill.shift()!;
    backfillStats.done++;
    if (get('SELECT 1 FROM remote_media WHERE key = $key', { key: job.key })) continue;
    enqueue(job);
  }
  if (!backfill.length && !queue.length && !active) {
    backfill = null;
    backfillStats.finishedAt = Date.now();
  }
}

function startBackfill() {
  if (!remote) return;
  const seen = new Set<string>();
  const all: MediaFile[] = [];
  for (const source of sources) {
    try {
      for (const f of source()) {
        if (seen.has(f.key) || get('SELECT 1 FROM remote_media WHERE key = $key', { key: f.key })) continue;
        seen.add(f.key);
        all.push(f);
      }
    } catch (e) {
      console.error('[对象存储] 列出要补传的文件失败', e);
    }
  }
  backfill = all;
  backfillStats.total = all.length;
  backfillStats.done = 0;
  backfillStats.finishedAt = 0;
  if (all.length) console.log(`[对象存储] 开始补传 ${all.length} 个文件`);
  feedBackfill();
}

/** 启动：补删上次没删成的，再补传已有的文件 */
export function startObjectStore() {
  if (!remote) return;
  refreshStored();
  console.log(`[对象存储] 已启用：${remote.publicBase}（存储桶 ${remote.bucket}${remote.prefix ? `/${remote.prefix}` : ''}）`);
  const retry = () => {
    const rows = db.prepare('SELECT key FROM remote_media_trash LIMIT 500').all() as { key: string }[];
    removeRemote(rows.map((r) => r.key));
  };
  setInterval(flushUsage, 30_000).unref();
  setTimeout(() => {
    retry();
    startBackfill();
  }, Number(env('MEDIA_BACKFILL_DELAY_MS')) || 30_000).unref();
  // 每天再对一次账：中途新增、上传失败的都会补上
  setInterval(() => {
    retry();
    if (!backfill) startBackfill();
  }, 24 * 3600_000).unref();
}

export function objectStoreStats() {
  if (!remote) return null;
  const n = get<{ n: number }>('SELECT COUNT(*) AS n FROM remote_media')!.n;
  const usage = monthUsage();
  return {
    publicBase: remote.publicBase,
    objects: n,
    bytes: storedBytes,
    maxBytes: remote.maxBytes,
    monthBytes: usage.bytes,
    monthRedirects: usage.redirects,
    monthlyBytes: remote.monthlyBytes,
    overStorage,
    overTraffic,
    queued: queue.length,
    active,
    paused: Date.now() < pausedUntil,
    backfill: { ...backfillStats, running: backfill !== null },
    ...stats,
  };
}

/** 测试用 */
export const _s3ForTest = { s3, putFile, deleteObject, listKeys, publicUrl, startBackfill, flushUsage };
