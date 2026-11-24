/**
 * 视频：时长不超过 2 分钟，一条帖子一个，不能和图片一起发（和 X 一样）。
 *
 * 上传分三步（仿 X 的 INIT / APPEND / FINALIZE）：
 *   POST /api/videos {size}         开一个上传，拿到 id 和分片大小
 *   PUT  /api/videos/:id?offset=N   按顺序传分片（application/octet-stream）。分片小，Nginx 的 client_max_body_size 不用改；
 *                                   网断了从服务器记下的位置接着传
 *   POST /api/videos/:id/finish     传完了开始处理；GET /api/videos/:id 查进度
 *
 * App 会先在手机上压缩（WebCodecs），传上来的一般已经是 H.264 的 MP4。服务器用 ffmpeg：
 *   - ffprobe 检查：有画面、不超过 2 分钟
 *   - 已经是 H.264、长边不超过 1280、码率不高的，画面直接复制，只重新封装（1 核的机器也很快）；否则转成 H.264 720p
 *   - 声音统一成 AAC；去掉所有元数据（手机拍的视频里有 GPS 位置）；moov 放到文件头，边下边播
 *   - 截一张封面，再截 3 张画面给 AI 审核用
 * 处理好的文件在 DATA_DIR/videos：<id>.mp4、<id>.jpg 公开访问（文件名随机，和图片一样）；<id>.f1~3.jpg 只给审核用。
 *
 * 没装 ffmpeg 时视频功能自动关闭（/api/videos/config 返回 enabled: false），前端不显示。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { videosDir } from './config.ts';
import { all, get, now, run, tx } from './db.ts';
import { HttpError, me, parse } from './util.ts';

const MB = 1024 ** 2;

function positiveEnv(key: string, fallback: number) {
  const value = process.env[key];
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < 1) throw new Error(`${key} 必须是正整数`);
  return n;
}

export const VIDEO = {
  maxSeconds: 120,
  /** 传上来的文件最大多少。手机压缩不了、直接传原视频时也要放得下 */
  maxUploadBytes: positiveEnv('VIDEO_MAX_UPLOAD_BYTES', 300 * MB),
  /** 建议的分片大小；服务器接受不超过这个的任意大小（Nginx 限制更小时前端会自动改小） */
  chunkBytes: 4 * MB,
  /** 长边最多多少像素（1280 = 720p） */
  maxEdge: 1280,
  /** 每人 24 小时内最多开几个上传 */
  perDay: 20,
};
const accountLimit = positiveEnv('VIDEO_ACCOUNT_LIMIT_BYTES', 2048 * MB);
const siteLimit = positiveEnv('VIDEO_SITE_LIMIT_BYTES', 30 * 1024 * MB);
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const tmpDir = path.join(videosDir, '.tmp');
const ID = /^[\w-]{16}$/;
const HOUR = 3_600_000;
const ORPHAN_TTL = 24 * HOUR;

let enabled = false;
export const videoEnabled = () => enabled;

/** 给用户看的错误（处理失败的原因） */
class VideoError extends Error {}

type Row = {
  id: string; owner_id: number | null; status: 'uploading' | 'processing' | 'ready' | 'failed'; error: string;
  upload_size: number; received: number; size: number; width: number; height: number; duration_ms: number;
  progress: number; created_at: number; used: number;
};

const uploadPath = (id: string) => path.join(tmpDir, `${id}.upload`);
const files = (id: string) => ({
  mp4: path.join(videosDir, `${id}.mp4`),
  poster: path.join(videosDir, `${id}.jpg`),
  frames: [1, 2, 3].map((i) => path.join(videosDir, `${id}.f${i}.jpg`)),
});

export const videoUrls = (id: string) => ({ url: `/uploads/v/${id}.mp4`, poster: `/uploads/v/${id}.jpg` });

/** 帖子里的视频 */
export function videoDTO(id: string | null | undefined, width: number, height: number, durationMs: number) {
  if (!id) return null;
  return { ...videoUrls(id), width, height, duration: Math.round(durationMs) / 1000 };
}
export type VideoDTO = NonNullable<ReturnType<typeof videoDTO>>;

function statusDTO(v: Row) {
  return {
    id: v.id,
    status: v.status,
    error: v.error || undefined,
    received: v.received,
    progress: v.status === 'ready' ? 1 : v.progress,
    ...(v.status === 'ready' ? videoDTO(v.id, v.width, v.height, v.duration_ms) : {}),
  };
}

/* ---------------- 调用 ffmpeg ---------------- */

const running = new Map<string, ChildProcess>();

function exec(cmd: string, args: string[], opts: { timeoutMs: number; job?: string; onLine?: (line: string) => void }) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    // 让出 CPU：转码慢一点没关系，别把网站卡住
    if (child.pid) try { os.setPriority(child.pid, 10); } catch { /* 没权限就算了 */ }
    if (opts.job) running.set(opts.job, child);
    let stdout = '';
    let stderr = '';
    let pending = '';
    child.stdout.on('data', (d: Buffer) => {
      const s = d.toString();
      if (opts.onLine) {
        pending += s;
        const lines = pending.split('\n');
        pending = lines.pop()!;
        lines.forEach(opts.onLine);
      } else if (stdout.length < 4 * MB) stdout += s;
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (opts.job && running.get(opts.job) === child) running.delete(opts.job);
      resolve({ code: code ?? (signal ? -1 : 0), stdout, stderr });
    });
  });
}

interface Probe {
  duration: number;
  /** 显示出来的宽高（已经按旋转换过来） */
  width: number;
  height: number;
  vcodec: string;
  pixfmt: string;
  vbitrate: number;
  fps: number;
  acodec: string | null;
  channels: number;
}

async function probe(file: string): Promise<Probe> {
  const r = await exec(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeoutMs: 60_000 });
  if (r.code !== 0) throw new VideoError('不是有效的视频文件');
  type Stream = {
    codec_type?: string; codec_name?: string; width?: number; height?: number; pix_fmt?: string; bit_rate?: string;
    duration?: string; r_frame_rate?: string; avg_frame_rate?: string; channels?: number;
    disposition?: { attached_pic?: number }; tags?: { rotate?: string }; side_data_list?: { rotation?: number }[];
  };
  let j: { streams?: Stream[]; format?: { duration?: string; bit_rate?: string } };
  try {
    j = JSON.parse(r.stdout);
  } catch {
    throw new VideoError('不是有效的视频文件');
  }
  const streams = j.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic && s.width && s.height);
  if (!v) throw new VideoError('这个文件里没有画面');
  const a = streams.find((s) => s.codec_type === 'audio');
  const rotation = Number(v.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? v.tags?.rotate ?? 0);
  const turned = Math.abs(rotation) % 180 === 90;
  const rate = (s?: string) => {
    const [n, d] = (s ?? '').split('/').map(Number);
    return n > 0 && d > 0 ? n / d : 0;
  };
  const duration = Number(j.format?.duration) || Number(v.duration) || 0;
  if (!(duration > 0)) throw new VideoError('读不出视频时长，换一个视频试试');
  return {
    duration,
    width: turned ? v.height! : v.width!,
    height: turned ? v.width! : v.height!,
    vcodec: v.codec_name ?? '',
    pixfmt: v.pix_fmt ?? '',
    vbitrate: Number(v.bit_rate) || Number(j.format?.bit_rate) || 0,
    fps: rate(v.avg_frame_rate) || rate(v.r_frame_rate),
    acodec: a?.codec_name ?? null,
    channels: a?.channels ?? 0,
  };
}

/** 长边缩到 edge 以内，宽高都是偶数（H.264 要求） */
const fitScale = (edge: number) => `scale=w='if(gte(iw,ih),min(${edge},iw),-2)':h='if(gte(iw,ih),-2,min(${edge},ih))'`;

/* ---------------- 处理队列 ---------------- */

const queue: string[] = [];
let busy = 0;
const CONCURRENCY = positiveEnv('VIDEO_CONCURRENCY', 1);

function enqueue(id: string) {
  if (queue.includes(id)) return;
  queue.push(id);
  pump();
}

function pump() {
  while (busy < CONCURRENCY && queue.length) {
    const id = queue.shift()!;
    busy++;
    processVideo(id)
      .catch((e) => console.error('[视频] 处理出错', id, e))
      .finally(() => {
        busy--;
        pump();
      });
  }
}

const rowOf = (id: string) => get<Row>('SELECT * FROM videos WHERE id = $id', { id });

async function processVideo(id: string) {
  if (rowOf(id)?.status !== 'processing') return;
  const src = uploadPath(id);
  const out = path.join(tmpDir, `${id}.mp4`);
  const shots = [path.join(tmpDir, `${id}.jpg`), ...[1, 2, 3].map((i) => path.join(tmpDir, `${id}.f${i}.jpg`))];
  const cleanTmp = () => [src, out, ...shots].forEach((f) => fs.rmSync(f, { force: true }));
  try {
    const p = await probe(src);
    if (p.duration > VIDEO.maxSeconds + 1) throw new VideoError(`视频超过 ${VIDEO.maxSeconds / 60} 分钟了`);
    const copyVideo = p.vcodec === 'h264' && p.pixfmt === 'yuv420p' && Math.max(p.width, p.height) <= VIDEO.maxEdge
      && p.vbitrate > 0 && p.vbitrate <= 3_500_000 && p.fps <= 61;
    const copyAudio = p.acodec === 'aac' && p.channels <= 2;
    let lastWrite = 0;
    const r = await exec(FFMPEG, [
      '-hide_banner', '-nostdin', '-y', '-i', src,
      '-map', '0:v:0', '-map', '0:a:0?', '-map_metadata', '-1', '-map_chapters', '-1', '-sn', '-dn',
      '-t', String(VIDEO.maxSeconds + 1),
      ...(copyVideo
        ? ['-c:v', 'copy']
        : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-maxrate', '2500k', '-bufsize', '5000k',
          '-pix_fmt', 'yuv420p', '-vf', fitScale(VIDEO.maxEdge), '-fpsmax', '30']),
      ...(p.acodec ? (copyAudio ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '128k', '-ac', '2']) : []),
      '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', out,
    ], {
      timeoutMs: 20 * 60_000,
      job: id,
      onLine: (line) => {
        const m = /^out_time_us=(\d+)/.exec(line);
        if (!m || Date.now() - lastWrite < 1000) return;
        lastWrite = Date.now();
        const progress = Math.min(0.95, Number(m[1]) / 1e6 / p.duration);
        run("UPDATE videos SET progress = $p WHERE id = $id AND status = 'processing'", { p: progress, id });
      },
    });
    if (r.code !== 0) {
      if (rowOf(id)?.status !== 'processing') return; // 用户删掉了，进程被杀
      console.error('[视频] ffmpeg 失败', id, r.stderr.slice(-800));
      throw new VideoError('视频处理失败，换一个视频试试');
    }
    const o = await probe(out);
    // 封面：开头附近一帧（很多视频第 0 帧是黑的）；审核：按 15% / 50% / 85% 各截一张，缩小一点
    const grab = (t: number, file: string, edge: number) => exec(FFMPEG, [
      '-hide_banner', '-nostdin', '-y', '-ss', t.toFixed(2), '-i', out, '-frames:v', '1', '-vf', fitScale(edge), '-q:v', '4', file,
    ], { timeoutMs: 60_000, job: id });
    await grab(Math.min(1, o.duration * 0.1), shots[0], VIDEO.maxEdge);
    for (const [i, at] of [0.15, 0.5, 0.85].entries()) await grab(o.duration * at, shots[i + 1], 768);
    if (!fs.existsSync(shots[0])) throw new VideoError('视频处理失败，换一个视频试试');
    const f = files(id);
    const ok = tx(() => {
      if (rowOf(id)?.status !== 'processing') return false;
      fs.renameSync(out, f.mp4);
      fs.renameSync(shots[0], f.poster);
      shots.slice(1).forEach((s, i) => fs.existsSync(s) && fs.renameSync(s, f.frames[i]));
      const size = [f.mp4, f.poster, ...f.frames].reduce((n, file) => n + (fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0), 0);
      run(
        `UPDATE videos SET status = 'ready', progress = 1, size = $size, width = $w, height = $h, duration_ms = $ms WHERE id = $id`,
        { size, w: o.width, h: o.height, ms: Math.round(Math.min(o.duration, p.duration) * 1000), id },
      );
      return true;
    });
    if (!ok) removeFiles(id);
  } catch (e) {
    const msg = e instanceof VideoError ? e.message : '视频处理失败，换一个视频试试';
    if (!(e instanceof VideoError)) console.error('[视频] 处理出错', id, e);
    run("UPDATE videos SET status = 'failed', error = $e WHERE id = $id AND status = 'processing'", { e: msg, id });
  } finally {
    cleanTmp();
  }
}

function removeFiles(id: string) {
  const f = files(id);
  for (const file of [f.mp4, f.poster, ...f.frames, uploadPath(id), ...['mp4', 'jpg', 'f1.jpg', 'f2.jpg', 'f3.jpg'].map((x) => path.join(tmpDir, `${id}.${x}`))]) {
    fs.rmSync(file, { force: true });
  }
}

/* ---------------- 发帖、审核用 ---------------- */

/** 发帖前（审核之前）检查：是自己的、处理好了、没发过 */
export function assertVideoUsable(id: string, userId: number) {
  const v = rowOf(id);
  if (!v || v.owner_id !== userId || (v.status === 'ready' && !fs.existsSync(files(id).mp4))) {
    throw new HttpError(400, '视频不存在或者已经失效了，删掉重新选一下吧', { code: 'VIDEO_UNAVAILABLE' });
  }
  if (v.status === 'failed') throw new HttpError(400, v.error || '视频处理失败了', { code: 'VIDEO_UNAVAILABLE' });
  if (v.status !== 'ready') throw new HttpError(400, '视频还在处理，等一下再发');
  // 没通过审核被打回来的帖子：同一个人改一改再发，可以接着用这个视频
  if (v.used && get("SELECT 1 FROM posts WHERE video = $id AND NOT (author_id = $u AND status = 'rejected')", { id, u: userId })) {
    throw new HttpError(400, '这个视频已经发过了');
  }
}

/** 和写帖子在同一个事务里：再查一遍，标成用过 */
export function consumeVideo(id: string, userId: number) {
  assertVideoUsable(id, userId);
  run('UPDATE videos SET used = 1 WHERE id = $id', { id });
}

/** 审核用：从视频里截的 3 张画面 */
export function videoReviewFrames(id: string): { mime: 'image/jpeg'; data: string }[] {
  const f = files(id);
  const list = f.frames.filter((x) => fs.existsSync(x));
  return (list.length ? list : [f.poster]).flatMap((file) => {
    try {
      return [{ mime: 'image/jpeg' as const, data: fs.readFileSync(file).toString('base64') }];
    } catch {
      return [];
    }
  });
}

/* ---------------- 清理 ---------------- */

/** 没发出去的（24 小时）、帖子删了的视频，连文件一起删掉 */
function collect() {
  try {
    const t = now();
    const rows = all<{ id: string }>(
      `SELECT v.id FROM videos v
       WHERE v.status <> 'processing' AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.video = v.id)
         AND (v.used = 1 OR v.created_at < $cutoff)
       LIMIT 500`,
      { cutoff: t - ORPHAN_TTL },
    );
    for (const { id } of rows) {
      removeFiles(id);
      run('DELETE FROM videos WHERE id = $id', { id });
    }
    // 崩溃留下的临时文件
    for (const name of fs.readdirSync(tmpDir)) {
      const id = name.split('.')[0];
      const row = ID.test(id) ? rowOf(id) : undefined;
      if (!row || row.status === 'ready' || row.status === 'failed') fs.rmSync(path.join(tmpDir, name), { force: true });
    }
  } catch (e) {
    console.error('[视频] 清理失败', e);
  }
}

export async function startVideos() {
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    const [a, b] = await Promise.all([
      exec(FFMPEG, ['-hide_banner', '-version'], { timeoutMs: 10_000 }),
      exec(FFPROBE, ['-hide_banner', '-version'], { timeoutMs: 10_000 }),
    ]);
    enabled = a.code === 0 && b.code === 0;
  } catch {
    enabled = false;
  }
  if (!enabled) console.warn('[视频] 找不到 ffmpeg / ffprobe，视频上传已关闭。装好 ffmpeg（或设置 FFMPEG_PATH、FFPROBE_PATH）后重启即可');
  // 上次没处理完的接着处理
  for (const { id } of all<{ id: string }>("SELECT id FROM videos WHERE status = 'processing' ORDER BY created_at")) {
    if (enabled && fs.existsSync(uploadPath(id))) enqueue(id);
    else run("UPDATE videos SET status = 'failed', error = '视频处理中断了，重新上传一下吧' WHERE id = $id", { id });
  }
  collect();
  setInterval(collect, HOUR).unref();
}

/* ---------------- 接口 ---------------- */

function ownVideo(req: FastifyRequest) {
  const user = me(req);
  const { id } = req.params as { id: string };
  const v = ID.test(id) ? rowOf(id) : undefined;
  if (!v || v.owner_id !== user.id) throw new HttpError(404, '视频不存在');
  return v;
}

export async function videoRoutes(app: FastifyInstance) {
  // 分片是原始字节：不解析，直接把请求流交给处理函数（大小在下面自己数）
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

  app.get('/videos/config', async () => ({
    enabled,
    maxSeconds: VIDEO.maxSeconds,
    maxUploadBytes: VIDEO.maxUploadBytes,
    chunkBytes: VIDEO.chunkBytes,
    maxEdge: VIDEO.maxEdge,
  }));

  app.post('/videos', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const user = me(req);
    if (!enabled) throw new HttpError(503, '服务器暂时不支持上传视频');
    const { size } = parse(z.object({ size: z.number().int().positive() }), req.body);
    if (size > VIDEO.maxUploadBytes) throw new HttpError(413, `视频文件太大了（最大 ${Math.round(VIDEO.maxUploadBytes / MB)} MB）`);
    const id = randomBytes(12).toString('base64url');
    tx(() => {
      const recent = get<{ n: number }>('SELECT COUNT(*) AS n FROM videos WHERE owner_id = $u AND created_at > $t', { u: user.id, t: now() - 24 * HOUR })!.n;
      if (recent >= VIDEO.perDay) throw new HttpError(429, `每天最多上传 ${VIDEO.perDay} 个视频，明天再来吧`);
      const charge = `COALESCE(SUM(CASE WHEN status = 'ready' THEN size ELSE upload_size END), 0)`;
      const mine = get<{ n: number }>(`SELECT ${charge} AS n FROM videos WHERE owner_id = $u AND status <> 'failed'`, { u: user.id })!.n;
      if (mine + size > accountLimit) throw new HttpError(413, '你的视频存储空间用完了，删掉一些带视频的帖子再试试');
      const site = get<{ n: number }>(`SELECT ${charge} AS n FROM videos WHERE status <> 'failed'`)!.n;
      if (site + size > siteLimit) throw new HttpError(413, '站点视频存储空间满了，请联系管理员');
      run('INSERT INTO videos (id, owner_id, upload_size, created_at) VALUES ($id, $u, $size, $t)', { id, u: user.id, size, t: now() });
    });
    return { id, chunkBytes: VIDEO.chunkBytes, received: 0 };
  });

  const writing = new Set<string>();
  app.put('/videos/:id', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (req) => {
    const v = ownVideo(req);
    if (v.status !== 'uploading') throw new HttpError(409, '这个视频已经传完了', { received: v.received });
    const offset = Number((req.query as { offset?: string }).offset);
    // 位置对不上（比如上一片其实传成功了，只是没收到回复）：告诉前端从哪接着传
    if (offset !== v.received || writing.has(v.id)) throw new HttpError(409, '分片位置不对', { received: v.received });
    const body = req.body as Readable | undefined;
    if (!body || typeof body.pipe !== 'function') throw new HttpError(415, '分片格式不对');
    writing.add(v.id);
    try {
      const limit = Math.min(VIDEO.chunkBytes, v.upload_size - offset);
      let n = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          n += chunk.length;
          cb(n > limit ? new HttpError(413, '分片太大了') : null, chunk);
        },
      });
      await pipeline(body, counter, fs.createWriteStream(uploadPath(v.id), { flags: offset === 0 ? 'w' : 'r+', start: offset }));
      if (!n) throw new HttpError(400, '分片是空的');
      run('UPDATE videos SET received = $r WHERE id = $id AND received = $o', { r: offset + n, id: v.id, o: offset });
      return { received: offset + n };
    } finally {
      writing.delete(v.id);
    }
  });

  app.post('/videos/:id/finish', async (req) => {
    const v = ownVideo(req);
    if (v.status === 'uploading') {
      if (v.received !== v.upload_size) throw new HttpError(400, '视频还没传完', { received: v.received });
      await fsp.truncate(uploadPath(v.id), v.upload_size);
      run("UPDATE videos SET status = 'processing', progress = 0 WHERE id = $id AND status = 'uploading'", { id: v.id });
      enqueue(v.id);
    }
    return statusDTO(rowOf(v.id)!);
  });

  app.get('/videos/:id', async (req) => statusDTO(ownVideo(req)));

  /** 发帖框里删掉：还没发出去的直接删 */
  app.delete('/videos/:id', async (req) => {
    const v = ownVideo(req);
    if (v.used) return { ok: true };
    run('DELETE FROM videos WHERE id = $id', { id: v.id });
    queue.splice(0, queue.length, ...queue.filter((x) => x !== v.id));
    running.get(v.id)?.kill('SIGKILL');
    removeFiles(v.id);
    return { ok: true };
  });
}

/* ---------------- 播放（公开，支持 Range，手机拖进度条要用） ---------------- */

export function registerVideoFiles(app: FastifyInstance) {
  const serve = async (req: FastifyRequest<{ Params: { file: string } }>, reply: FastifyReply) => {
    const m = /^([\w-]{16})\.(mp4|jpg)$/.exec(req.params.file);
    const row = m ? get<{ status: string }>('SELECT status FROM videos WHERE id = $id', { id: m[1] }) : undefined;
    if (!m || row?.status !== 'ready') throw new HttpError(404, '视频不存在');
    const f = files(m[1]);
    const file = m[2] === 'mp4' ? f.mp4 : f.poster;
    let fd: fsp.FileHandle;
    try {
      fd = await fsp.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch {
      throw new HttpError(404, '视频不存在');
    }
    const { size } = await fd.stat();
    reply
      .type(m[2] === 'mp4' ? 'video/mp4' : 'image/jpeg')
      .header('Accept-Ranges', 'bytes')
      .header('Cache-Control', 'public, max-age=31536000, immutable');
    let start = 0;
    let end = size - 1;
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    if (range && (range[1] || range[2])) {
      if (range[1]) {
        start = Number(range[1]);
        if (range[2]) end = Math.min(Number(range[2]), size - 1);
      } else {
        start = Math.max(0, size - Number(range[2]));
      }
      if (start > end || start >= size) {
        await fd.close();
        return reply.code(416).header('Content-Range', `bytes */${size}`).send();
      }
      reply.code(206).header('Content-Range', `bytes ${start}-${end}/${size}`);
    }
    reply.header('Content-Length', end - start + 1);
    if (req.method === 'HEAD') {
      await fd.close();
      return reply.send();
    }
    return reply.send(fd.createReadStream({ start, end, autoClose: true }));
  };
  // Fastify 自动生成的 HEAD 会把 Content-Length 改成 0，自己注册
  app.get('/uploads/v/:file', { exposeHeadRoute: false }, serve);
  app.head('/uploads/v/:file', serve);
}
