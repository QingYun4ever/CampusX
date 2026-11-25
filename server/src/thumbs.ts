import { HttpError } from './util.ts';

const thumbEdge = 1280;
const avatarEdge = 192;
const maxQueuedThumbnails = 24;
const maxInputPixels = 24_000_000;
const maxConcurrentImages = 2;
const sharpOptions = { failOn: 'warning', limitInputPixels: maxInputPixels } as const;

export class ImageInputError extends HttpError {
  constructor() {
    super(400, '图片无法解码或像素过多，请重新上传');
  }
}

export class ImageProcessingUnavailable extends HttpError {
  constructor() {
    super(503, '暂时无法处理图片，请稍后重试');
  }
}
// sharp 是原生模块，按需加载；不可用时仍可以读取已存的原图。
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

let activeImages = 0;

async function useSharp<T>(work: (sharp: Sharp) => Promise<T>): Promise<T> {
  if (activeImages >= maxConcurrentImages) throw new ImageProcessingUnavailable();
  activeImages++;
  try {
    const sharp = await loadSharp();
    if (!sharp) throw new ImageProcessingUnavailable();
    return await work(sharp);
  } finally {
    activeImages--;
  }
}

async function processImage(sharp: Sharp, buffer: Buffer, ext: string, shrink: boolean) {
  try {
    const image = sharp(buffer, { ...sharpOptions, animated: ext === 'gif' || ext === 'webp' })
      .timeout({ seconds: 10 });
    const { format, width, height, pageHeight, pages = 1 } = await image.metadata();
    if (format !== (ext === 'jpg' ? 'jpeg' : ext) || !width || !height ||
        width * (pageHeight ?? height) * pages > maxInputPixels) throw new ImageInputError();
    if (shrink && ext !== 'gif' && pages === 1 && buffer.length > 1_500_000) {
      const out = await image.rotate()
        .resize({ width: 2560, height: 2560, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 86 })
        .toBuffer();
      if (out.length < buffer.length) return { buffer: out, ext: 'webp' };
    } else {
      // 读取元数据只会解析文件头；实际解码也必须成功。
      await image.stats();
    }
    return { buffer, ext };
  } catch {
    throw new ImageInputError();
  }
}

/** 太大的普通原图（旧客户端没在本地压缩）在服务器上压一遍：长边 2560。 */
export function prepareUploadImage(buffer: Buffer, ext: string) {
  return useSharp((sharp) => processImage(sharp, buffer, ext, true));
}

/** 校验图片能完整解码；给了 edge 就再缩一份（JPEG，透明处垫白）送审用 */
export function validateReviewImage<T extends { buffer: Buffer; ext: string }>(read: () => Promise<T>, edge?: number) {
  return useSharp(async (sharp) => {
    const image = await read();
    await processImage(sharp, image.buffer, image.ext, false);
    if (!edge) return { ...image, shrunk: undefined };
    try {
      const shrunk = await sharp(image.buffer, sharpOptions).timeout({ seconds: 10 })
        .rotate()
        .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 80 })
        .toBuffer();
      return { ...image, shrunk };
    } catch {
      throw new ImageInputError();
    }
  });
}

// 缩略图排队且只占一个处理槽，避免首屏并发让后续图片全部退回原图。
let makingThumbnail = false;
const queuedThumbnails: (() => void)[] = [];

export async function makeThumb(read: () => Promise<Buffer>, avatar: boolean) {
  if (makingThumbnail) {
    if (queuedThumbnails.length >= maxQueuedThumbnails) throw new ImageProcessingUnavailable();
    const { promise, resolve } = Promise.withResolvers<void>();
    queuedThumbnails.push(resolve);
    await promise;
  } else {
    makingThumbnail = true;
  }
  const edge = avatar ? avatarEdge : thumbEdge;
  try {
    return await useSharp(async (sharp) => sharp(await read(), sharpOptions).timeout({ seconds: 10 })
      .rotate()
      .resize({ width: edge, height: edge, fit: avatar ? 'cover' : 'inside', withoutEnlargement: true })
      .webp({ quality: 80, effort: 4 })
      .toBuffer());
  } finally {
    const next = queuedThumbnails.shift();
    if (next) next();
    else makingThumbnail = false;
  }
}

const emojiEdge = 160;
const emojiMaxFrames = 150;
export const EMOJI_MAX_BYTES = 600 * 1024;

/**
 * 自定义表情：长边压到 160，统一存成 WebP（动图保留动画）。
 * 动图压缩后还超过 600 KB 就拒绝，避免一个表情拖慢整页。
 */
export function makeEmojiImage(buffer: Buffer, ext: string) {
  return useSharp(async (sharp) => {
    let animated = false;
    let out: Buffer;
    try {
      const probe = sharp(buffer, { ...sharpOptions, animated: ext === 'gif' || ext === 'webp' }).timeout({ seconds: 15 });
      const { format, width, height, pageHeight, pages = 1 } = await probe.metadata();
      if (format !== (ext === 'jpg' ? 'jpeg' : ext) || !width || !height ||
          width * (pageHeight ?? height) * pages > maxInputPixels) throw new ImageInputError();
      if (pages > emojiMaxFrames) throw new HttpError(400, `动图最多 ${emojiMaxFrames} 帧`);
      animated = pages > 1;
      out = await probe
        .rotate()
        .resize({ width: emojiEdge, height: emojiEdge, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: animated ? 70 : 82, effort: 4, ...(animated ? { loop: 0 } : {}) })
        .toBuffer();
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new ImageInputError();
    }
    if (out.length > EMOJI_MAX_BYTES) throw new HttpError(413, '动图压缩后还是太大了，换一个短一点的吧');
    return { buffer: out, ext: 'webp', animated };
  });
}
