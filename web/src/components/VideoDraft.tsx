/**
 * 发帖框里的视频：选好就开始压缩、上传、等服务器处理，处理好之前「发布」是灰的（和 X 一样）。
 * 删掉或者关掉发帖框会停掉上传，并告诉服务器删掉没发出去的视频。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RotateCcw, X } from 'lucide-react';
import { api } from '../lib/api';
import {
  canCompressVideo, compressVideo, discardVideo, finishVideo, formatDuration, isAbort, probeVideo, uploadVideo,
  type VideoConfig, type VideoStatus,
} from '../lib/video';
import { resolveMediaUrl } from './MediaImage';
import { toast, useModalLeaving } from './ui';
import './video.css';

export interface VideoDraft {
  key: symbol;
  file: File;
  stage: 'probe' | 'compress' | 'upload' | 'process' | 'ready' | 'error';
  progress: number;
  /** 本地读到的宽高比，处理好之前用来占位 */
  aspect?: number;
  trimTo?: number;
  info?: VideoStatus;
  error?: string;
}

type DraftOperation = { key: symbol; controller: AbortController; id?: string };

const MB = 1024 * 1024;

export function useVideoDraft() {
  const leaving = useModalLeaving();
  const cfg = useQuery({
    queryKey: ['video-config'],
    queryFn: () => api<VideoConfig>('/videos/config'),
    staleTime: 10 * 60_000,
    retry: false,
  });
  const [draft, setDraft] = useState<VideoDraft | null>(null);
  const current = useRef<DraftOperation | null>(null);
  const drop = useCallback(() => {
    const op = current.current;
    current.current = null;
    op?.controller.abort();
    if (op?.id) discardVideo(op.id);
  }, []);
  useLayoutEffect(() => drop, [drop]);
  useLayoutEffect(() => {
    if (leaving) drop();
  }, [leaving, drop]);

  const remove = () => {
    drop();
    setDraft(null);
  };

  const begin = () => {
    drop();
    const op: DraftOperation = { key: Symbol(), controller: new AbortController() };
    current.current = op;
    return op;
  };

  const run = async (op: DraftOperation, c: VideoConfig, file: File, trimTo?: number, aspect?: number) => {
    const { key, controller: { signal } } = op;
    if (signal.aborted) return;
    setDraft({ key, file, stage: 'compress', progress: 0, trimTo, aspect });
    const update = (patch: Partial<VideoDraft>) => {
      if (!signal.aborted) setDraft((d) => (d && d.key === key ? { ...d, ...patch } : d));
    };
    try {
      const small = await compressVideo(file, {
        maxEdge: c.maxEdge,
        trimTo,
        signal,
        onProgress: (p) => update({ progress: p }),
      });
      if (signal.aborted) return;
      if (!small && trimTo) throw new Error(`这台设备没法截取视频，先剪到 ${c.maxSeconds / 60} 分钟以内再发吧`);
      const blob = small ?? file;
      if (blob.size > c.maxUploadBytes) {
        throw new Error(`视频太大了（${Math.round(blob.size / MB)} MB，最大 ${Math.round(c.maxUploadBytes / MB)} MB），剪短一点再发吧`);
      }
      update({ stage: 'upload', progress: 0 });
      const id = await uploadVideo(blob, {
        signal,
        onProgress: (p) => update({ progress: p }),
        onId: (id) => { op.id = id; },
      });
      if (signal.aborted) return;
      update({ stage: 'process', progress: 0 });
      const info = await finishVideo(id, { signal, onProgress: (p) => update({ progress: p }) });
      update({ stage: 'ready', progress: 1, info });
    } catch (e) {
      if (isAbort(e) || signal.aborted) return;
      update({ stage: 'error', error: (e as Error).message || '视频上传失败了' });
    }
  };

  /** 选了一个视频 */
  const start = async (file: File) => {
    if (leaving) return;
    const c = cfg.data;
    if (!c?.enabled) return toast('服务器暂时不支持发视频', 'error');
    const op = begin();
    setDraft({ key: op.key, file, stage: 'probe', progress: 0 });
    const meta = await probeVideo(file).catch(() => null);
    if (op.controller.signal.aborted) return;
    let trimTo: number | undefined;
    if (meta && meta.duration > c.maxSeconds + 0.5) {
      const limit = `${c.maxSeconds / 60} 分钟`;
      if (!canCompressVideo()) {
        remove();
        return toast(`视频不能超过 ${limit}，先剪短再发吧`, 'error');
      }
      if (!confirm(`这个视频有 ${formatDuration(meta.duration)}，最长只能发 ${limit}，只发前 ${limit}吗？`)) {
        remove();
        return;
      }
      trimTo = c.maxSeconds;
    }
    void run(op, c, file, trimTo, meta && meta.width && meta.height ? meta.width / meta.height : undefined);
  };

  return {
    enabled: !!cfg.data?.enabled,
    draft,
    ready: draft?.stage === 'ready',
    hasDraft: () => current.current !== null,
    canPublish: () => !leaving && draft?.key === current.current?.key && (!draft || draft.stage === 'ready'),
    /** 发帖时带上的 id */
    id: draft?.stage === 'ready' ? draft.info?.id : undefined,
    start,
    retry: () => {
      if (!leaving && draft && cfg.data) void run(begin(), cfg.data, draft.file, draft.trimTo, draft.aspect);
    },
    remove,
    /** 发出去了：服务器那边已经用上，不能删 */
    posted: () => {
      if (current.current) current.current.id = undefined;
      remove();
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
      ) : draft.stage !== 'probe' && local ? (
        // #t=0.1：没有封面时让浏览器显示第一帧
        <video key="local" src={`${local}#t=0.1`} muted playsInline preload="metadata" />
      ) : null}
      {!info && (
        <div className={`vd-veil ${draft.stage}`}>
          {draft.stage === 'probe' ? (
            <span className="vd-msg" style={{ overflowWrap: 'anywhere' }}>读取视频…<br />{draft.file.name}</span>
          ) : draft.stage === 'error' ? (
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
          {draft.stage !== 'probe' && draft.stage !== 'error' && (
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
