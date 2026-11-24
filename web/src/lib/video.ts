/**
 * 发视频：在手机上压缩 → 分片上传 → 等服务器处理好（服务器那边见 server/src/videos.ts）。
 *
 * 压缩用 WebCodecs（mediabunny 封装，手机上走硬件编码，很快）：长边缩到 1280、画面 2 Mbps 左右，
 * 2 分钟的视频大约 30 MB。已经够小的不压；浏览器不支持的直接传原文件，交给服务器转码。
 */
import { api, API_BASE, ApiError, getToken } from './api';

export interface VideoConfig {
  enabled: boolean;
  maxSeconds: number;
  maxUploadBytes: number;
  chunkBytes: number;
  maxEdge: number;
}

export interface VideoStatus {
  id: string;
  status: 'uploading' | 'processing' | 'ready' | 'failed';
  error?: string;
  received: number;
  progress: number;
  url?: string;
  poster?: string;
  width?: number;
  height?: number;
  duration?: number;
}

export const isVideoFile = (f: File) =>
  f.type.startsWith('video/') || /\.(mp4|m4v|mov|webm|mkv|3gp|avi)$/i.test(f.name);

/** 这台设备能不能在本地压缩、截取视频 */
export const canCompressVideo = () => typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined';

const aborted = () => new DOMException('已取消', 'AbortError');
export const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(aborted());
    const onAbort = () => {
      clearTimeout(t);
      reject(aborted());
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 读时长和宽高（用浏览器自己的播放器，读不出来返回 null，交给后面的步骤） */
export function probeVideo(file: Blob): Promise<{ duration: number; width: number; height: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    const done = (r: { duration: number; width: number; height: number } | null) => {
      clearTimeout(timer);
      v.removeAttribute('src');
      v.load();
      URL.revokeObjectURL(url);
      resolve(r);
    };
    const timer = setTimeout(() => done(null), 10_000);
    v.preload = 'metadata';
    v.muted = true;
    v.onloadedmetadata = () =>
      done(Number.isFinite(v.duration) && v.duration > 0 ? { duration: v.duration, width: v.videoWidth, height: v.videoHeight } : null);
    v.onerror = () => done(null);
    v.src = url;
  });
}

/**
 * 压缩（顺带截取前 trimTo 秒）。不需要压缩、或者这台设备压不了时返回 null，直接传原文件。
 */
export async function compressVideo(
  file: File,
  opts: { maxEdge: number; trimTo?: number; signal: AbortSignal; onProgress: (p: number) => void },
): Promise<Blob | null> {
  if (!canCompressVideo()) return null;
  const mb = await import('mediabunny');
  if (opts.signal.aborted) throw aborted();
  const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) return null;
    const duration = await input.computeDuration();
    const w = track.displayWidth;
    const h = track.displayHeight;
    const long = Math.max(w, h);
    const bitrate = duration > 0 ? (file.size * 8) / duration : Infinity;
    const trim = opts.trimTo && duration > opts.trimTo + 0.5 ? opts.trimTo : undefined;
    // 已经是 H.264、不大、码率不高：不用压，原样上传（服务器只重新封装）
    if (!trim && track.codec === 'avc' && long <= opts.maxEdge && bitrate <= 3_000_000) return null;

    const scale = long > opts.maxEdge ? opts.maxEdge / long : 1;
    const even = (x: number) => Math.max(2, Math.round((x * scale) / 2) * 2);
    const width = even(w);
    const height = even(h);
    const quality = new mb.Quality({ bitrate: 2_000_000 });
    if (!(await mb.getFirstEncodableVideoCodec(['avc'], { width, height, quality }))) return null;
    const stats = await track.computePacketStats(90).catch(() => null);

    const audio = await input.getPrimaryAudioTrack();
    let audioOpts: import('mediabunny').ConversionAudioOptions = { discard: true };
    if (audio) {
      const channels = Math.min(2, audio.numberOfChannels || 2);
      const codec = audio.codec === 'aac'
        ? 'aac'
        : await mb.getFirstEncodableAudioCodec(['aac', 'opus'], { numberOfChannels: channels, sampleRate: 48_000, quality: new mb.Quality({ bitrate: 128_000 }) });
      // 声音编不了：别把声音丢了，原文件交给服务器
      if (!codec) return null;
      audioOpts = audio.codec === 'aac' && !trim
        ? {}
        : { codec, numberOfChannels: channels, sampleRate: 48_000, quality: new mb.Quality({ bitrate: 128_000 }) };
    }

    const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new mb.BufferTarget() });
    const conversion = await mb.Conversion.init({
      input,
      output,
      tracks: 'primary',
      video: {
        codec: 'avc',
        width,
        height,
        fit: 'contain',
        quality,
        keyFrameInterval: 2,
        // 旋转直接画进画面里，宽高就是看到的样子
        allowTransformationMetadata: false,
        ...(stats && stats.averagePacketRate > 31 ? { frameRate: 30 } : {}),
      },
      audio: audioOpts,
      ...(trim ? { trim: { start: 0, end: trim } } : {}),
    });
    if (opts.signal.aborted) throw aborted();
    if (!conversion.isValid) return null;
    // 视频轨可用时转换仍可能有效，但不能把丢了音轨的结果传上去。
    if (conversion.discardedTracks.some(({ track }) => track.isAudioTrack())) return null;
    conversion.onProgress = (p) => opts.onProgress(Math.min(1, p));
    const onAbort = () => void conversion.cancel();
    opts.signal.addEventListener('abort', onAbort, { once: true });
    try {
      await conversion.execute();
    } finally {
      opts.signal.removeEventListener('abort', onAbort);
    }
    if (opts.signal.aborted) throw aborted();
    const buffer = (output.target as InstanceType<typeof mb.BufferTarget>).buffer;
    if (!buffer) return null;
    // 压完反而更大（原视频本来就很省）：传原文件
    if (!trim && buffer.byteLength >= file.size) return null;
    return new Blob([buffer], { type: 'video/mp4' });
  } catch (e) {
    if (opts.signal.aborted) throw aborted();
    console.warn('[视频] 本地压缩失败，改传原文件', e);
    return null;
  } finally {
    input.dispose();
  }
}

class ChunkRateLimitError extends ApiError {
  constructor(message: string, data: Record<string, unknown>, readonly retryAfter: string | null) {
    super(message, 429, data);
  }
}

function chunkRetryDelay(retryAfter: string | null) {
  const value = retryAfter?.trim() ?? '';
  const ms = /^\d+$/.test(value)
    ? Number(value) * 1000
    : /[a-z]/i.test(value) ? Date.parse(value) - Date.now() : NaN;
  // 没有可用的 Retry-After（跨域也可能读不到）：等满分片限流的一分钟窗口。
  return ms >= 0 && ms <= 2_147_483_647 ? ms : 60_000;
}

/** 传一片。用 XHR 是为了拿到上传进度（fetch 没有） */
function putChunk(id: string, offset: number, part: Blob, onSent: (n: number) => void, signal: AbortSignal) {
  return new Promise<{ received: number }>((resolve, reject) => {
    if (signal.aborted) return reject(aborted());
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `${API_BASE}/api/videos/${id}?offset=${offset}`);
    const token = getToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.timeout = 120_000;
    xhr.upload.onprogress = (e) => onSent(e.loaded);
    xhr.onload = () => {
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* Nginx 的 413 之类返回的是 HTML */
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data as { received: number });
      } else {
        const message = (data.error as string) ?? `上传失败（${xhr.status}）`;
        reject(xhr.status === 429
          ? new ChunkRateLimitError(message, data, xhr.getResponseHeader('Retry-After'))
          : new ApiError(message, xhr.status, data));
      }
    };
    xhr.onerror = xhr.ontimeout = () => reject(new ApiError('网络断了', 0));
    xhr.onabort = () => reject(aborted());
    const onAbort = () => xhr.abort();
    xhr.onloadend = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    xhr.send(part);
  });
}

/** 分片上传，返回视频 id。网断了自动重试，从服务器记下的位置接着传 */
export async function uploadVideo(blob: Blob, opts: { signal: AbortSignal; onProgress: (p: number) => void; onId?: (id: string) => void }) {
  if (opts.signal.aborted) throw aborted();
  // 不取消初始化请求：即使用户已经移除草稿，也要拿到 id 才能删掉会话。
  const init = await api<{ id: string; chunkBytes: number; received: number }>('/videos', { body: { size: blob.size } });
  if (opts.signal.aborted) {
    discardVideo(init.id);
    throw aborted();
  }
  opts.onId?.(init.id);
  let chunk = init.chunkBytes;
  let offset = init.received;
  let retries = 0;
  while (offset < blob.size) {
    if (opts.signal.aborted) throw aborted();
    try {
      const r = await putChunk(init.id, offset, blob.slice(offset, offset + chunk), (n) => opts.onProgress((offset + n) / blob.size), opts.signal);
      if (opts.signal.aborted) throw aborted();
      offset = r.received;
      retries = 0;
      opts.onProgress(offset / blob.size);
    } catch (e) {
      if (opts.signal.aborted || isAbort(e) || !(e instanceof ApiError)) throw e;
      // 上一片其实到了，只是没收到回复：从服务器记下的位置接着传
      if (e.status === 409 && typeof e.data.received === 'number') {
        offset = e.data.received;
        continue;
      }
      // 反向代理限制了请求大小：分片改小
      if (e.status === 413 && chunk > 256 * 1024) {
        chunk = Math.max(256 * 1024, chunk >> 2);
        continue;
      }
      if (e instanceof ChunkRateLimitError && retries < 6) {
        retries++;
        await sleep(chunkRetryDelay(e.retryAfter), opts.signal);
        continue;
      }
      if ((e.status === 0 || e.status >= 500) && retries < 6) {
        await sleep(1000 * 2 ** retries++, opts.signal);
        if (opts.signal.aborted) throw aborted();
        const s = await api<VideoStatus>(`/videos/${init.id}`).catch(() => null);
        if (s) offset = s.received;
        continue;
      }
      throw e;
    }
  }
  if (opts.signal.aborted) throw aborted();
  return init.id;
}

/** 传完了：让服务器开始处理，等它处理好 */
export async function finishVideo(id: string, opts: { signal: AbortSignal; onProgress: (p: number) => void }) {
  if (opts.signal.aborted) throw aborted();
  let s = await api<VideoStatus>(`/videos/${id}/finish`, { body: {} });
  let errors = 0;
  while (s.status === 'processing' || s.status === 'uploading') {
    if (opts.signal.aborted) throw aborted();
    opts.onProgress(s.progress);
    await sleep(1000, opts.signal);
    if (opts.signal.aborted) throw aborted();
    try {
      s = await api<VideoStatus>(`/videos/${id}`);
      errors = 0;
    } catch (e) {
      if (++errors > 10) throw e;
    }
  }
  if (opts.signal.aborted) throw aborted();
  if (s.status !== 'ready') throw new Error(s.error || '视频处理失败了');
  return s;
}

/** 发帖框里删掉没发的视频 */
export function discardVideo(id: string) {
  void api(`/videos/${id}`, { method: 'DELETE' }).catch(() => {});
}

export function formatDuration(sec: number) {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/* ---------------- 自动播放设置 ---------------- */

export type AutoplayPref = 'always' | 'wifi' | 'never';
const PREF_KEY = 'txq_video_autoplay';

export function getAutoplayPref(): AutoplayPref {
  try {
    const v = localStorage.getItem(PREF_KEY);
    if (v === 'always' || v === 'wifi' || v === 'never') return v;
  } catch {
    /* 隐私模式 */
  }
  return 'always';
}

export function setAutoplayPref(v: AutoplayPref) {
  try {
    localStorage.setItem(PREF_KEY, v);
  } catch {
    /* 隐私模式 */
  }
}

/** 时间线里的视频现在能不能自动（静音）播放 */
export function autoplayAllowed() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  const conn = (navigator as Navigator & { connection?: { type?: string; saveData?: boolean } }).connection;
  if (conn?.saveData) return false;
  const pref = getAutoplayPref();
  if (pref === 'never') return false;
  if (pref === 'wifi') return conn?.type === 'wifi' || conn?.type === 'ethernet';
  return true;
}
