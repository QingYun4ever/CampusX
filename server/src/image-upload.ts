import type { MultipartFile } from '@fastify/multipart';
import { HttpError } from './util.ts';

export const imageTypes = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
} as const;

type ImageExt = keyof typeof imageTypes;

export interface UploadedImage {
  buffer: Buffer;
  ext: ImageExt;
}

const extensions = new Map<string, ImageExt>(Object.entries(imageTypes).map(([ext, type]) => [type, ext as ImageExt]));
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function hasImageSignature(buffer: Buffer, ext: ImageExt): boolean {
  switch (ext) {
    case 'jpg':
      return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    case 'png':
      return buffer.subarray(0, 8).equals(pngSignature);
    case 'gif': {
      const signature = buffer.toString('latin1', 0, 6);
      return signature === 'GIF87a' || signature === 'GIF89a';
    }
    case 'webp':
      return buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP';
  }
}

export async function readUploadedImage(file: MultipartFile): Promise<UploadedImage> {
  const ext = extensions.get(file.mimetype);
  const buffer = await file.toBuffer();
  if (file.file.truncated) throw new HttpError(413, '文件太大了');
  if (!ext) throw new HttpError(400, '只支持 JPG / PNG / WebP / GIF 图片');
  if (!hasImageSignature(buffer, ext)) throw new HttpError(400, '文件内容不是有效的图片');
  return { buffer, ext };
}
