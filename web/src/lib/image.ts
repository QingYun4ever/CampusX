/** 浏览器端的图片处理：压缩、导出 */

/** 长边超过这个就缩小（X 的大图也是 2048 左右） */
const MAX_EDGE = 2560;
/** 小于这个大小、尺寸也不超的图片原样上传 */
const KEEP_BYTES = 500 * 1024;

let webpOk: boolean | undefined;
function canWebp() {
  if (webpOk === undefined) {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    webpOk = c.toDataURL('image/webp').startsWith('data:image/webp');
  }
  return webpOk;
}

/** 画布导出成文件：优先 WebP（体积小、保留透明），老系统退回 JPEG / PNG */
export async function canvasToFile(canvas: HTMLCanvasElement, name: string, opaque = false): Promise<File> {
  const type = canWebp() ? 'image/webp' : opaque ? 'image/jpeg' : 'image/png';
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, type, 0.85));
  if (!blob) throw new Error('图片处理失败');
  const ext = blob.type.split('/')[1].replace('jpeg', 'jpg');
  return new File([blob], `${name}.${ext}`, { type: blob.type });
}

function decode(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('这张图片打不开，换一张试试'));
    };
    img.src = url;
  });
}

/**
 * 上传前压缩：手机拍的照片动辄 5–10 MB，原样上传既慢又费流量，别人刷到也要等很久。
 * 动图和本来就不大的图片保持原样；压缩后反而更大时也用原图。
 */
export async function prepareImage(file: File): Promise<File> {
  if (file.type === 'image/gif' || !file.type.startsWith('image/')) return file;
  let img: HTMLImageElement;
  try {
    img = await decode(file);
  } catch {
    return file; // 让服务器去报错
  }
  const long = Math.max(img.naturalWidth, img.naturalHeight);
  if (file.size <= KEEP_BYTES && long <= MAX_EDGE) return file;
  const k = Math.min(1, MAX_EDGE / long);
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * k);
  c.height = Math.round(img.naturalHeight * k);
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const out = await canvasToFile(c, file.name.replace(/\.[^.]+$/, '') || 'image', file.type === 'image/jpeg');
  return out.size < file.size ? out : file;
}
