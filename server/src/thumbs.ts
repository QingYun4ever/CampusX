import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { uploadsDir } from './config.ts';

/**
 * 时间线上用的缩略图：长边 1280、WebP。点开大图时才加载原图。
 * 第一次被请求（或刚上传完）时生成，存到 uploads/.thumbs，之后直接读文件。
 * 旧图片不用迁移，访问时自动补上。
 */
export const THUMB_EDGE = 1280;
const thumbsDir = path.join(uploadsDir, '.thumbs');
fs.mkdirSync(thumbsDir, { recursive: true });

const NAME = /^[\w-]+\.(jpg|png|webp)$/;

// sharp 是原生模块；万一在某个平台上装不上，服务照常运行，只是不出缩略图、不在服务器上压缩
type Sharp = typeof import('sharp');
let sharpLib: Promise<Sharp | null> | undefined;
function loadSharp() {
  sharpLib ??= import('sharp').then(
    (m) => m.default,
    (e) => {
      console.warn('[thumbs] sharp 加载失败，缩略图和服务器端压缩已关闭：', (e as Error).message);
      return null;
    },
  );
  return sharpLib;
}
const pending = new Map<string, Promise<string | null>>();

/** 返回缩略图路径；原图本身就够小（或不是可处理的格式）时返回 null，直接用原图 */
export function thumbFor(name: string): Promise<string | null> {
  if (!NAME.test(name)) return Promise.resolve(null);
  const out = path.join(thumbsDir, name.replace(/\.\w+$/, '.webp'));
  const marker = out + '.orig'; // 缩略图不比原图小时留个标记，不用每次重算
  if (fs.existsSync(out)) return Promise.resolve(out);
  if (fs.existsSync(marker)) return Promise.resolve(null);
  let job = pending.get(name);
  if (!job) {
    job = (async () => {
      const src = path.join(uploadsDir, name);
      const stat = await fsp.stat(src).catch(() => null);
      const sharp = await loadSharp();
      if (!stat || !sharp) return null;
      const buf = await sharp(src, { failOn: 'none' })
        .rotate()
        .resize({ width: THUMB_EDGE, height: THUMB_EDGE, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80, effort: 4 })
        .toBuffer();
      if (buf.length >= stat.size * 0.9) {
        await fsp.writeFile(marker, '');
        return null;
      }
      const tmp = `${out}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, buf);
      await fsp.rename(tmp, out);
      return out;
    })()
      .catch(() => null)
      .finally(() => pending.delete(name));
    pending.set(name, job);
  }
  return job;
}

/** 太大的原图（老版本 App、第三方客户端没在本地压缩）在服务器上压一遍：长边 2560 */
export async function shrinkOriginal(buffer: Buffer, ext: string): Promise<{ buffer: Buffer; ext: string }> {
  if (ext === 'gif' || buffer.length <= 1_500_000) return { buffer, ext };
  const sharp = await loadSharp();
  if (!sharp) return { buffer, ext };
  try {
    const img = sharp(buffer, { failOn: 'none' }).rotate();
    const out = await img
      .resize({ width: 2560, height: 2560, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 86 })
      .toBuffer();
    return out.length < buffer.length ? { buffer: out, ext: 'webp' } : { buffer, ext };
  } catch {
    return { buffer, ext };
  }
}
