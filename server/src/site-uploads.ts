import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { config, uploadsDir } from './config.ts';
import { all, get, now, run, tx } from './db.ts';
import { hasImageSignature, imageTypes } from './image-upload.ts';
import { makeThumb } from './thumbs.ts';
import { HttpError } from './util.ts';

const prefix = '/uploads/';
const imageName = /^[\w-]+\.(?:jpg|png|webp|gif)$/;
export const siteUploadUrl = /^\/uploads\/[\w-]+\.(?:jpg|png|webp|gif)$/;
export const MAX_REVIEW_IMAGE_BYTES = 5 * 1024 * 1024;
const thumbsDir = path.join(uploadsDir, '.thumbs');
const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
const hour = 3_600_000;
const reviewLeaseMs = 120_000; // 前台校验、审核时保护草稿；待审帖入库后由引用保护
const gcBatchSize = 100;

type Ext = keyof typeof imageTypes;
export type UploadSnapshots = ReadonlyMap<string, fs.Stats>;

interface OpenImage {
  fd: number;
  size: number;
  mime: (typeof imageTypes)[Ext];
}

function positiveEnv(key: string, fallback: number) {
  const value = process.env[key];
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 1) throw new Error(`${key} 必须是正整数`);
  return number;
}

const accountLimit = positiveEnv('UPLOAD_ACCOUNT_LIMIT_BYTES', 256 * 1024 ** 2);
const siteLimit = positiveEnv('UPLOAD_SITE_LIMIT_BYTES', 10 * 1024 ** 3);
const orphanTtl = positiveEnv('UPLOAD_ORPHAN_TTL_MS', 24 * hour);

export class AttachmentError extends HttpError {
  constructor(message = '图片不存在、已失效或无法读取，请重新上传', uploadPath?: string) {
    super(400, message, uploadPath ? { code: 'UPLOAD_UNAVAILABLE', uploadPath } : undefined);
  }
}

function nameFromUrl(url: string) {
  if (!siteUploadUrl.test(url)) throw new AttachmentError('图片地址无效，请重新上传');
  return url.slice(prefix.length);
}

function extOf(name: string): Ext {
  return name.slice(name.lastIndexOf('.') + 1) as Ext;
}

function checkedSize(stat: fs.Stats, maxBytes: number, url: string, expectedSize?: number) {
  if (!stat.isFile() || stat.size <= 0 || (expectedSize !== undefined && stat.size !== expectedSize)) throw new AttachmentError(undefined, url);
  if (stat.size > maxBytes) throw new AttachmentError(`图片超过 ${Math.floor(maxBytes / 1024 ** 2)} MB，无法使用`);
  return stat.size;
}

function sameFile(a: fs.Stats, b: fs.Stats) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

function snapshotOf(url: string, snapshots?: UploadSnapshots) {
  const snapshot = snapshots?.get(url);
  if (snapshots && !snapshot) throw new AttachmentError(undefined, url);
  return snapshot;
}

function openOriginal(name: string, maxBytes = Infinity, expectedSize?: number, snapshot?: fs.Stats): OpenImage {
  let fd: number | undefined;
  try {
    fd = fs.openSync(path.join(uploadsDir, name), flags);
    const stat = fs.fstatSync(fd);
    const size = checkedSize(stat, maxBytes, prefix + name, expectedSize);
    if (snapshot && !sameFile(snapshot, stat)) throw new AttachmentError(undefined, prefix + name);
    const ext = extOf(name);
    const header = Buffer.allocUnsafe(12);
    const read = fs.readSync(fd, header, 0, header.length, 0);
    if (!hasImageSignature(header.subarray(0, read), ext)) throw new AttachmentError('图片内容无效，请重新上传');
    return { fd, size, mime: imageTypes[ext] };
  } catch (e) {
    if (fd !== undefined) fs.closeSync(fd);
    throw e instanceof AttachmentError ? e : new AttachmentError(undefined, prefix + name);
  }
}

export function checkStoredUploads(urls: string[], maxBytes?: number, snapshots?: UploadSnapshots) {
  for (const url of new Set(urls)) {
    fs.closeSync(openOriginal(nameFromUrl(url), maxBytes, undefined, snapshotOf(url, snapshots)).fd);
  }
}

export async function readStoredUpload(url: string, maxBytes: number) {
  const name = nameFromUrl(url);
  try {
    const file = await fsp.open(path.join(uploadsDir, name), flags);
    try {
      const snapshot = await file.stat();
      const size = checkedSize(snapshot, maxBytes, url);
      const ext = extOf(name);
      const buffer = Buffer.allocUnsafe(size);
      let offset = 0;
      while (offset < size) {
        const { bytesRead } = await file.read(buffer, offset, size - offset, offset);
        if (!bytesRead) throw new AttachmentError(undefined, url);
        offset += bytesRead;
      }
      if (!sameFile(snapshot, await file.stat())) throw new AttachmentError(undefined, url);
      if (!hasImageSignature(buffer, ext)) throw new AttachmentError('图片内容无效，请重新上传');
      return { buffer, ext, mime: imageTypes[ext], snapshot };
    } finally {
      await file.close();
    }
  } catch (e) {
    throw e instanceof AttachmentError ? e : new AttachmentError(undefined, url);
  }
}

function validateDraftUploads(urls: string[], ownerId: number, maxBytes?: number, snapshots?: UploadSnapshots) {
  const names: string[] = [];
  for (const url of new Set(urls)) {
    const name = nameFromUrl(url);
    const row = get<{ size: number }>(
      'SELECT size FROM site_uploads WHERE name = $name AND owner_id = $ownerId AND used = 0', { name, ownerId },
    );
    if (!row) throw new AttachmentError('不能使用不属于你、已使用或已过期的图片，请重新上传', url);
    fs.closeSync(openOriginal(name, maxBytes, row.size, snapshotOf(url, snapshots)).fd);
    names.push(name);
  }
  return names;
}

/** 审核前锁住草稿的清理期限；最终写库时再核对，防止两次提交复用同一路径。 */
export function holdDraftUploads(urls: string[], ownerId: number, maxBytes?: number) {
  if (!urls.length) return;
  tx(() => {
    const names = validateDraftUploads(urls, ownerId, maxBytes);
    const until = now() + reviewLeaseMs;
    for (const name of names) run('UPDATE site_uploads SET hold_until = MAX(hold_until, $until) WHERE name = $name', { until, name });
  });
}

/** 与写入帖子或资料同处一个事务；使用过的地址不再作为新附件。 */
export function consumeDraftUploads(urls: string[], ownerId: number, maxBytes?: number, snapshots?: UploadSnapshots) {
  for (const name of validateDraftUploads(urls, ownerId, maxBytes, snapshots)) {
    run('UPDATE site_uploads SET used = 1 WHERE name = $name', { name });
  }
}

export function storeSiteUpload(ownerId: number, buffer: Buffer, ext: string) {
  const name = `${randomBytes(12).toString('base64url')}.${ext}`;
  const target = path.join(uploadsDir, name);
  const size = buffer.length;
  let created = false;
  try {
    tx(() => {
      // 先在写事务中预占，未满额才写文件；拒绝时计数和预占一同回滚。
      run('INSERT INTO site_uploads (name, owner_id, size, created_at, used) VALUES ($name, $ownerId, $size, $t, 0)', {
        name, ownerId, size, t: now(),
      });
      const ownerBytes = get<{ bytes: number }>('SELECT COALESCE(SUM(charge), 0) AS bytes FROM site_uploads WHERE owner_id = $ownerId', { ownerId })!.bytes;
      const siteBytes = get<{ bytes: number }>('SELECT bytes FROM site_upload_usage WHERE id = 1')!.bytes;
      if (ownerBytes > accountLimit) throw new HttpError(413, '你已达到图片存储上限');
      if (siteBytes > siteLimit) throw new HttpError(413, '站点图片存储空间已满');
      const fd = fs.openSync(target, 'wx', 0o600);
      created = true;
      try {
        fs.writeFileSync(fd, buffer);
      } finally {
        fs.closeSync(fd);
      }
    });
  } catch (error) {
    if (created) fs.rmSync(target, { force: true });
    throw error;
  }
  return prefix + name;
}

function thumbPath(name: string, avatar: boolean) {
  return path.join(thumbsDir, name + (avatar ? '.avatar.webp' : '.webp'));
}

function cachedThumb(file: string, size: number) {
  try {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    // 空文件表示缩略图不比原图小，不作为图片发送。
    if (stat?.isFile() && stat.size < size) return stat.size ? file : null;
    return undefined;
  } catch {
    return undefined;
  }
}

// null 是确定不需要缩略图；undefined 表示本次暂不可用，不应长期缓存原图。
const thumbJobs = new Map<string, Promise<string | null | undefined>>();

function thumbnailFor(name: string, size: number, avatar: boolean) {
  if ((!avatar && name.endsWith('.gif')) || size > config.maxUploadBytes) return null;
  const output = thumbPath(name, avatar);
  const cached = cachedThumb(output, size);
  if (cached !== undefined) return cached;
  let job = thumbJobs.get(output);
  if (!job) {
    job = (async () => {
      let snapshot: fs.Stats | undefined;
      const thumb = await makeThumb(async () => {
        const original = await readStoredUpload(prefix + name, config.maxUploadBytes);
        snapshot = original.snapshot;
        return original.buffer;
      }, avatar);
      return tx(() => {
        // 在转码等待期间，GC 有可能已删除不再使用的图。
        if (!get('SELECT 1 FROM site_uploads WHERE name = $name AND size = $size', { name, size })) return null;
        fs.closeSync(openOriginal(name, undefined, size, snapshot).fd);
        const existing = cachedThumb(output, size);
        if (existing !== undefined) return existing;
        const temp = output + '.tmp';
        // 两个预览的文件大小合计不能超出原图的存储预留。
        const other = fs.lstatSync(thumbPath(name, !avatar), { throwIfNoEntry: false });
        const smaller = thumb.length < size * 0.9 && thumb.length <= size - (other?.size ?? 0) ? thumb : null;
        try {
          fs.writeFileSync(temp, smaller ?? '', { flag: 'wx', mode: 0o600 });
          fs.renameSync(temp, output);
        } finally {
          fs.rmSync(temp, { force: true });
        }
        return smaller ? output : null;
      });
    })().catch(() => undefined).finally(() => thumbJobs.delete(output));
    thumbJobs.set(output, job);
  }
  return job;
}

/** 站点图片按随机文件名公开访问（和私信图片不同）；只发送已登记的文件 */
function registeredSize(name: string) {
  const row = get<{ size: number }>('SELECT size FROM site_uploads WHERE name = $name', { name });
  if (!row) throw new HttpError(404, '图片不存在');
  return row.size;
}

export function registerSiteUploadRoutes(app: FastifyInstance) {
  for (const [route, variant] of [['/uploads/:name', null], ['/uploads/s/:name', 'post'], ['/uploads/a/:name', 'avatar']] as const) {
    app.get<{ Params: { name: string } }>(route, async (req, reply) => {
      const { name } = req.params;
      if (!imageName.test(name)) throw new HttpError(404, '图片不存在');
      let size = registeredSize(name);
      let thumb: string | null | undefined = null;
      if (variant) {
        const result = thumbnailFor(name, size, variant === 'avatar');
        if (result instanceof Promise) {
          thumb = await result;
          size = registeredSize(name); // 生成期间可能已被清理
        } else {
          thumb = result;
        }
      }
      let file: OpenImage;
      try {
        file = openOriginal(name, undefined, size);
      } catch (e) {
        if (e instanceof AttachmentError) throw new HttpError(404, '图片不存在');
        throw e;
      }
      if (thumb) {
        // 缩略缓存缺失或失效时直接返回已经打开的原图。
        let fd: number | undefined;
        let size = 0;
        try {
          fd = fs.openSync(thumb, flags);
          const stat = fs.fstatSync(fd);
          if (stat.isFile() && stat.size < file.size) size = stat.size;
        } catch {
          // 缓存不是授权或发送原图的前提。
        }
        if (fd !== undefined && size) {
          fs.closeSync(file.fd);
          file = { fd, size, mime: 'image/webp' };
        } else {
          if (fd !== undefined) fs.closeSync(fd);
          thumb = undefined;
        }
      }
      // 文件名随机、内容不会变，浏览器和 App 的 WebView 都可以缓存一年
      reply.type(file.mime).header('Content-Length', file.size).header(
        'Cache-Control',
        thumb === undefined ? 'no-store' : 'public, max-age=31536000, immutable',
      );
      if (req.method === 'HEAD') {
        fs.closeSync(file.fd);
        return reply.send();
      }
      return reply.send(fs.createReadStream(path.join(uploadsDir, name), { fd: file.fd, autoClose: true }));
    });
  }
}

function collectExpiredUploads() {
  const t = now();
  const cutoff = t - orphanTtl;
  let cursor = '';
  const batch = () => {
    try {
      const rows = tx(() => {
        const rows = all<{ name: string }>(
          `SELECT su.name FROM site_uploads su
           WHERE su.name > $cursor AND su.created_at < $cutoff AND su.hold_until <= $t
             AND NOT EXISTS (SELECT 1 FROM post_upload_refs WHERE url = '/uploads/' || su.name)
             AND NOT EXISTS (SELECT 1 FROM users WHERE avatar = '/uploads/' || su.name OR banner = '/uploads/' || su.name)
             AND NOT EXISTS (SELECT 1 FROM boards WHERE avatar = '/uploads/' || su.name)
           ORDER BY su.name LIMIT $limit`,
          { cursor, cutoff, t, limit: gcBatchSize },
        );
        for (const { name } of rows) {
          try {
            fs.rmSync(thumbPath(name, false), { force: true });
            fs.rmSync(thumbPath(name, true), { force: true });
            fs.rmSync(path.join(uploadsDir, name), { force: true });
          } catch (error) {
            console.error('[uploads] 无法清理', name, error);
            continue;
          }
          run('DELETE FROM site_uploads WHERE name = $name', { name });
        }
        return rows;
      });
      if (rows.length === gcBatchSize) {
        cursor = rows[rows.length - 1].name;
        setImmediate(batch).unref();
      }
    } catch (error) {
      console.error('[uploads] 清理失败', error);
    }
  };
  batch();
}

export function startSiteUploads() {
  tx(() => {
    // 导入未登记的历史原图；意外退出留下的原图也计入额度。历史所有者未知，不允许重新绑定。
    for (const entry of fs.readdirSync(uploadsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !imageName.test(entry.name)) continue;
      const stat = fs.lstatSync(path.join(uploadsDir, entry.name));
      run(`INSERT INTO site_uploads (name, size, created_at) VALUES ($name, $size, $created)
           ON CONFLICT(name) DO UPDATE SET size = excluded.size WHERE size <> excluded.size`,
        { name: entry.name, size: stat.size, created: Math.floor(stat.mtimeMs) });
    }
    fs.mkdirSync(thumbsDir, { recursive: true });
    // 丢弃旧命名格式、没有原图的缓存和崩溃残留；以后按实际文件名惰性重建。
    for (const entry of fs.readdirSync(thumbsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) continue;
      const name = entry.name.endsWith('.webp') ? entry.name.replace(/(?:\.avatar)?\.webp$/, '') : '';
      const original = imageName.test(name) ? fs.lstatSync(path.join(uploadsDir, name), { throwIfNoEntry: false }) : undefined;
      const file = path.join(thumbsDir, entry.name);
      if (!original?.isFile() || !entry.isFile() || fs.lstatSync(file).size >= original.size) fs.rmSync(file, { force: true });
    }
  });
  collectExpiredUploads();
  setInterval(collectExpiredUploads, hour).unref();
}
