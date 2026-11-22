import { HttpError } from './util.ts';

const thumbEdge = 1280;
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

export function validateReviewImage<T extends { buffer: Buffer; ext: string }>(read: () => Promise<T>) {
  return useSharp(async (sharp) => {
    const image = await read();
    await processImage(sharp, image.buffer, image.ext, false);
    return image;
  });
}

export function makeThumb(read: () => Promise<Buffer>) {
  return useSharp(async (sharp) => sharp(await read(), sharpOptions).timeout({ seconds: 10 })
    .rotate()
    .resize({ width: thumbEdge, height: thumbEdge, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80, effort: 4 })
    .toBuffer());
}
