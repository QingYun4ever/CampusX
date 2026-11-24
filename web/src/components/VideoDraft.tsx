/**
 * 发帖框里的视频：选好就开始压缩、上传、等服务器处理，处理好之前「发布」是灰的（和 X 一样）。
 * 删掉或者关掉发帖框会停掉上传，并告诉服务器删掉没发出去的视频。
 */
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RotateCcw, X } from 'lucide-react';
import { api } from '../lib/api';
import {
  canCompressVideo, compressVideo, discardVideo, finishVideo, formatDuration, isAbort, probeVideo, uploadVideo,
  type VideoConfig, type VideoStatus,
} from '../lib/video';
import { resolveMediaUrl } from './MediaImage';
import { toast } from './ui';
import './video.css';

export interface VideoDraft {
  key: number;
  file: File;
  stage: 'compress' | 'upload' | 'process' | 'ready' | 'error';
  progress: number;
  /** 本地读到的宽高比，处理好之前用来占位 */
  aspect?: number;
  trimTo?: number;
  info?: VideoStatus;
  error?: string;
}

const MB = 1024 * 1024;

export function useVideoDraft() {
  const cfg = useQuery({
    queryKey: ['video-config'],
    queryFn: () => api<VideoConfig>('/videos/config'),
    staleTime: 10 * 60_000,
    retry: false,
  });
  const [draft, setDraft] = useState<VideoDraft | null>(null);
  const ctrl = useRef<AbortController | null>(null);
  /** 传上去了但还没发出去的视频 id：删掉或者关掉发帖框时让服务器删掉 */
  const pending = useRef<string | undefined>(undefined);

  const drop = () => {
    ctrl.current?.abort();
    ctrl.current = null;
    if (pending.current) discardVideo(pending.current);
    pending.current = undefined;
  };
  useEffect(() => drop, []);

  const run = async (file: File, trimTo?: number, aspect?: number) => {
    const c = cfg.data!;
    drop();
    const ac = new AbortController();
    ctrl.current = ac;
    const key = Date.now();
    setDraft({ key, file, stage: 'compress', progress: 0, trimTo, aspect });
    const update = (patch: Partial<VideoDraft>) => setDraft((d) => (d && d.key === key ? { ...d, ...patch } : d));
    try {
      const small = await compressVideo(file, {
        maxEdge: c.maxEdge,
        trimTo,
        signal: ac.signal,
        onProgress: (p) => update({ progress: p }),
      });
      if (!small && trimTo) throw new Error(`这台设备没法截取视频，先剪到 ${c.maxSeconds / 60} 分钟以内再发吧`);
      const blob = small ?? file;
      if (blob.size > c.maxUploadBytes) {
        throw new Error(`视频太大了（${Math.round(blob.size / MB)} MB，最大 ${Math.round(c.maxUploadBytes / MB)} MB），剪短一点再发吧`);
      }
      update({ stage: 'upload', progress: 0 });
      const id = await uploadVideo(blob, {
        signal: ac.signal,
        onProgress: (p) => update({ progress: p }),
        onId: (x) => (pending.current = x),
      });
      update({ stage: 'process', progress: 0 });
      const info = await finishVideo(id, { signal: ac.signal, onProgress: (p) => update({ progress: p }) });
      update({ stage: 'ready', progress: 1, info });
    } catch (e) {
      if (isAbort(e) || ac.signal.aborted) return;
      update({ stage: 'error', error: (e as Error).message || '视频上传失败了' });
    }
  };

  /** 选了一个视频 */
  const start = async (file: File) => {
    const c = cfg.data;
    if (!c?.enabled) return toast('服务器暂时不支持发视频', 'error');
    const meta = await probeVideo(file);
    let trimTo: number | undefined;
    if (meta && meta.duration > c.maxSeconds + 0.5) {
      const limit = `${c.maxSeconds / 60} 分钟`;
      if (!canCompressVideo()) return toast(`视频不能超过 ${limit}，先剪短再发吧`, 'error');
      if (!confirm(`这个视频有 ${formatDuration(meta.duration)}，最长只能发 ${limit}，只发前 ${limit}吗？`)) return;
      trimTo = c.maxSeconds;
    }
    void run(file, trimTo, meta && meta.width && meta.height ? meta.width / meta.height : undefined);
  };

  return {
    enabled: !!cfg.data?.enabled,
    draft,
    ready: draft?.stage === 'ready',
    /** 发帖时带上的 id */
    id: draft?.stage === 'ready' ? draft.info?.id : undefined,
    start,
    retry: () => draft && void run(draft.file, draft.trimTo, draft.aspect),
    remove: () => {
      drop();
      setDraft(null);
    },
    /** 发出去了：服务器那边已经用上，不能删 */
    posted: () => {
      pending.current = undefined;
      ctrl.current = null;
      setDraft(null);
    },
    /** 发帖时服务器说视频不能用了 */
    fail: (error: string) => setDraft((d) => d && { ...d, stage: 'error', error }),
  };
}

const LABEL = { compress: '压缩中', upload: '上传中', process: '处理中' } as const;

export function VideoDraftTile({ draft, onRemove, onRetry }: { draft: VideoDraft; onRemove: () => void; onRetry: () => void }) {
  const [local, setLocal] = useState<string>();
  useEffect(() => {
    const u = URL.createObjectURL(draft.file);
    setLocal(u);
    return () => URL.revokeObjectURL(u);
  }, [draft.file]);
  const info = draft.stage === 'ready' ? draft.info : undefined;
  const ratio = info?.width && info.height ? info.width / info.height : draft.aspect ?? 16 / 9;
  const r = Math.min(16 / 7, Math.max(9 / 16, ratio));
  const pct = Math.round(draft.progress * 100);
  return (
    <div className="video-draft" style={{ aspectRatio: String(r), width: `min(100%, ${Math.round(400 * r)}px)` }}>
      {info?.url ? (
        <video key="ready" src={resolveMediaUrl(info.url)} poster={info.poster && resolveMediaUrl(info.poster)} controls playsInline preload="metadata" />
      ) : (
        // #t=0.1：没有封面时让浏览器显示第一帧
        local && <video key="local" src={`${local}#t=0.1`} muted playsInline preload="metadata" />
      )}
      {!info && (
        <div className={`vd-veil ${draft.stage}`}>
          {draft.stage === 'error' ? (
            <>
              <span className="vd-msg">{draft.error}</span>
              <button className="vd-retry" onClick={onRetry}>
                <RotateCcw size={14} /> 重试
              </button>
            </>
          ) : (
            <span className="vd-msg">
              {LABEL[draft.stage as keyof typeof LABEL]}
              {draft.stage === 'process' && pct < 2 ? '…' : ` ${pct}%`}
            </span>
          )}
          {draft.stage !== 'error' && (
            <div className="vd-bar" aria-hidden>
              <div style={{ width: `${Math.max(2, pct)}%` }} />
            </div>
          )}
        </div>
      )}
      <button className="thumb-remove" onClick={onRemove} aria-label="移除视频">
        <X size={15} />
      </button>
    </div>
  );
}
