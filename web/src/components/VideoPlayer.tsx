/**
 * 视频播放（仿 X）：
 * - 时间线里：划到屏幕上大半时静音自动播放，划走就停；左下角是剩余时间，右下角开关声音。
 *   同一时间只播一个。点画面打开全屏播放
 * - 全屏：有声音，进度条可以拖，点画面显示 / 隐藏控制栏（播放时 2.5 秒不动自动隐藏），手机上往下滑关闭；
 *   键盘：空格暂停，← → 快退 / 快进 5 秒，M 静音，Esc 关闭。关掉后时间线里的视频从同一个位置接着播
 * 「设置 → 显示」里可以关掉自动播放，或者只在 Wi-Fi 下自动播放
 */
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { Pause, Play, RotateCcw, Volume2, VolumeX, X } from 'lucide-react';
import type { Video } from '../lib/api';
import { useEscape } from '../lib/escape';
import { autoplayAllowed, formatDuration } from '../lib/video';
import { resolveMediaUrl } from './MediaImage';
import './video.css';

/** 这次打开 App 期间用户在时间线上打开过声音：之后自动播放的也带声音（X 也是这样） */
let soundOn = false;
/** 正在播放的时间线视频，同一时间只播一个 */
let current: HTMLVideoElement | null = null;
/** 打开全屏的时间线视频；全屏期间不播放任何时间线视频 */
let viewerOwner: HTMLVideoElement | null = null;
let inlinePlayAttempt = 0;

/** 时间线里视频框的宽高：按原始比例，最高 510px（和单张图一样），太窄太扁的兜住 */
function boxStyle(v: Video) {
  const ratio = Math.min(16 / 7, Math.max(9 / 16, v.width / v.height || 16 / 9));
  return { aspectRatio: String(ratio), width: `min(100%, ${Math.round(510 * ratio)}px)` };
}

export function InlineVideo({ video }: { video: Video }) {
  const box = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<'idle' | 'playing' | 'paused' | 'ended' | 'error'>('idle');
  const [waiting, setWaiting] = useState(false);
  const [muted, setMuted] = useState(!soundOn);
  const [left, setLeft] = useState(Math.ceil(video.duration));
  const [viewerAt, setViewerAt] = useState<number | null>(null);
  const visible = useRef(false);
  const src = resolveMediaUrl(video.url);
  const poster = resolveMediaUrl(video.poster);

  const play = () => {
    const v = ref.current;
    if (!v || viewerOwner) return;
    const attempt = ++inlinePlayAttempt;
    if (current && current !== v) current.pause();
    current = v;
    v.muted = !soundOn;
    setMuted(v.muted);
    v.play().catch((error) => {
      if (error?.name !== 'NotAllowedError' || viewerOwner || current !== v || inlinePlayAttempt !== attempt) return;
      // 没有用户手势时浏览器不让带声音自动播：改成静音再试
      if (!v.muted) {
        v.muted = true;
        setMuted(true);
        v.play().catch(() => {});
      }
    });
  };

  useLayoutEffect(() => {
    const el = box.current;
    const v = ref.current;
    if (!el || !v) return;
    const io = new IntersectionObserver(
      ([e]) => {
        visible.current = e.intersectionRatio >= 0.6;
        if (viewerOwner) return;
        if (visible.current) {
          if (v.paused && !v.ended && autoplayAllowed()) play();
        } else if (!v.paused) v.pause();
      },
      { threshold: [0, 0.6] },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      if (current === v) current = null;
      if (viewerOwner === v) viewerOwner = null;
    };
  }, []);

  const openViewer = () => {
    const v = ref.current;
    if (!v || viewerOwner) return;
    viewerOwner = v;
    ++inlinePlayAttempt;
    current?.pause();
    current = null;
    setViewerAt(v.ended ? 0 : v.currentTime);
  };

  const closeViewer = (t: number) => {
    const v = ref.current;
    if (!v || viewerOwner !== v) return;
    viewerOwner = null;
    setViewerAt(null);
    if (t >= video.duration - 0.3) {
      v.currentTime = video.duration;
      return;
    }
    v.currentTime = t;
    if (visible.current && autoplayAllowed()) play();
  };

  const toggleSound = () => {
    const v = ref.current;
    if (!v) return;
    soundOn = v.muted;
    v.muted = !v.muted;
    setMuted(v.muted);
    if (v.paused) play();
  };

  const showPlay = state === 'idle' || state === 'paused';
  return (
    <>
      <div
        ref={box}
        className={`video-inline ${state}`}
        style={boxStyle(video)}
        role="button"
        tabIndex={0}
        aria-label={`播放视频，时长 ${formatDuration(video.duration)}`}
        onClick={(e) => {
          e.stopPropagation();
          if (state === 'error') {
            ref.current?.load();
            setState('idle');
          } else openViewer();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openViewer();
          }
        }}
      >
        <video
          ref={ref}
          src={src}
          poster={poster}
          preload="none"
          playsInline
          muted={muted}
          disablePictureInPicture
          onPlay={() => setState('playing')}
          onPause={(e) => !e.currentTarget.ended && setState('paused')}
          onEnded={() => setState('ended')}
          onWaiting={() => setWaiting(true)}
          onPlaying={() => setWaiting(false)}
          onCanPlay={() => setWaiting(false)}
          onError={() => {
            setWaiting(false);
            setState('error');
          }}
          onTimeUpdate={(e) => setLeft(Math.ceil(Math.max(0, video.duration - e.currentTarget.currentTime)))}
        />
        {state === 'error' ? (
          <div className="vi-center vi-error">视频加载失败，点一下重试</div>
        ) : state === 'ended' ? (
          <span className="vi-center vi-big" aria-hidden><RotateCcw size={26} /></span>
        ) : showPlay ? (
          <span className="vi-center vi-big" aria-hidden><Play size={28} fill="currentColor" /></span>
        ) : waiting ? (
          <span className="vi-spin" aria-hidden />
        ) : null}
        <span className="vi-time">{formatDuration(state === 'idle' || state === 'ended' ? video.duration : left)}</span>
        {state !== 'idle' && state !== 'error' && (
          <button
            className="vi-mute"
            aria-label={muted ? '打开声音' : '静音'}
            onClick={(e) => {
              e.stopPropagation();
              toggleSound();
            }}
          >
            {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
          </button>
        )}
      </div>
      {viewerAt !== null && <VideoViewer video={video} start={viewerAt} onClose={closeViewer} />}
    </>
  );
}

/** 引用卡片、后台等小地方：只显示封面和时长，点进帖子再看 */
export function VideoThumb({ video, className = '' }: { video: Video; className?: string }) {
  return (
    <div className={`video-thumb ${className}`}>
      <img src={resolveMediaUrl(video.poster)} alt="" loading="lazy" decoding="async" />
      <span className="vt-play" aria-hidden><Play size={14} fill="currentColor" /></span>
      <span className="vi-time">{formatDuration(video.duration)}</span>
    </div>
  );
}

function VideoViewer({ video, start, onClose }: { video: Video; start: number; onClose: (t: number) => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [ended, setEnded] = useState(false);
  const [time, setTime] = useState(start);
  const [dur, setDur] = useState(video.duration);
  const [buffered, setBuffered] = useState(0);
  const [muted, setMuted] = useState(false);
  const [waiting, setWaiting] = useState(true);
  const [failed, setFailed] = useState(false);
  const [idle, setIdle] = useState(false);
  const [dragY, setDragY] = useState(0);
  const idleTimer = useRef(0);
  const swipe = useRef<{ y: number; moved: boolean } | null>(null);
  /** 刚滑过：松手后浏览器还会补一个 click，别把它当成点击 */
  const swiped = useRef(false);
  const scrubbing = useRef(false);
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const close = () => onClose(ref.current?.currentTime ?? time);
  useEscape(close);

  const poke = () => {
    setIdle(false);
    clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => !scrubbing.current && setIdle(true), 2500);
  };

  useEffect(() => {
    const v = ref.current!;
    let active = true;
    v.currentTime = start;
    // 刚点过，算用户手势，可以带声音播放；不让就静音
    v.play().catch((error) => {
      if (error?.name !== 'NotAllowedError' || !active || ref.current !== v || v.muted) return;
      v.muted = true;
      setMuted(true);
      v.play().catch(() => {});
    });
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      active = false;
      document.body.style.overflow = overflow;
      clearTimeout(idleTimer.current);
    };
  }, []);

  useEffect(() => {
    if (playing) poke();
    else {
      clearTimeout(idleTimer.current);
      setIdle(false);
    }
  }, [playing]);

  const toggle = () => {
    const v = ref.current!;
    if (v.paused || v.ended) v.play().catch(() => {});
    else v.pause();
  };
  const seek = (t: number) => {
    const v = ref.current!;
    v.currentTime = Math.min(Math.max(0, t), dur);
    setTime(v.currentTime);
  };
  const toggleMute = () => {
    const v = ref.current!;
    v.muted = !v.muted;
    setMuted(v.muted);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const v = ref.current;
      if (!v) return;
      if (e.key === ' ' || e.key === 'k') toggle();
      else if (e.key === 'ArrowLeft') seek(v.currentTime - 5);
      else if (e.key === 'ArrowRight') seek(v.currentTime + 5);
      else if (e.key === 'm') toggleMute();
      else return;
      e.preventDefault();
      poke();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const scrubTo = (e: RPointerEvent) => {
    const r = bar.current!.getBoundingClientRect();
    seek(((e.clientX - r.left) / r.width) * dur);
  };

  // 手机上往下滑关闭（像图片查看器）
  const onStageDown = (e: RPointerEvent) => {
    if (e.pointerType === 'mouse') return;
    swipe.current = { y: e.clientY, moved: false };
  };
  const onStageMove = (e: RPointerEvent) => {
    const s = swipe.current;
    if (!s) return;
    const dy = e.clientY - s.y;
    if (Math.abs(dy) > 8) s.moved = true;
    if (s.moved) setDragY(Math.max(0, dy));
  };
  const onStageUp = () => {
    const s = swipe.current;
    swipe.current = null;
    swiped.current = !!s?.moved;
    if (!s?.moved) return;
    if (dragY > 110) close();
    else setDragY(0);
  };

  const pct = dur > 0 ? Math.min(100, (time / dur) * 100) : 0;
  const fade = dragY ? Math.max(0.2, 1 - dragY / 400) : 1;
  return createPortal(
    <div
      className={`video-viewer ${idle && playing ? 'idle' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label="视频"
      // 播放器通过 portal 挂在 body 上，但 React 事件还是会冒泡到帖子卡片（点卡片会打开帖子）
      onClick={(e) => e.stopPropagation()}
      onPointerMove={() => playing && poke()}
    >
      <div className="vv-bg" style={{ opacity: fade }} />
      <div
        className="vv-stage"
        onPointerDown={onStageDown}
        onPointerMove={onStageMove}
        onPointerUp={onStageUp}
        onPointerCancel={onStageUp}
        onClick={(e) => {
          if (e.target !== e.currentTarget && e.target !== ref.current) return;
          if (swiped.current) {
            swiped.current = false;
            return;
          }
          // 控制栏藏着：先叫出来；露着：暂停 / 继续
          if (idle && playing) poke();
          else toggle();
        }}
      >
        <video
          ref={ref}
          src={resolveMediaUrl(video.url)}
          poster={resolveMediaUrl(video.poster)}
          playsInline
          disablePictureInPicture
          style={dragY ? { transform: `translateY(${dragY}px) scale(${1 - dragY / 1600})`, transition: 'none' } : reduce ? undefined : { transition: 'transform 0.2s' }}
          onPlay={() => {
            setPlaying(true);
            setEnded(false);
          }}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false);
            setEnded(true);
          }}
          onWaiting={() => setWaiting(true)}
          onPlaying={() => setWaiting(false)}
          onCanPlay={() => setWaiting(false)}
          onError={() => {
            setWaiting(false);
            setFailed(true);
          }}
          onLoadedMetadata={(e) => Number.isFinite(e.currentTarget.duration) && setDur(e.currentTarget.duration)}
          onTimeUpdate={(e) => !scrubbing.current && setTime(e.currentTarget.currentTime)}
          onProgress={(e) => {
            const b = e.currentTarget.buffered;
            if (b.length) setBuffered(b.end(b.length - 1));
          }}
        />
        {failed ? (
          <div className="vv-center vv-error">视频加载失败</div>
        ) : !playing ? (
          <button className="vv-center vv-big" aria-label={ended ? '重播' : '播放'} onClick={toggle}>
            {ended ? <RotateCcw size={30} /> : <Play size={32} fill="currentColor" />}
          </button>
        ) : waiting ? (
          <span className="vi-spin" aria-hidden />
        ) : null}
      </div>
      <div className="vv-top" style={{ opacity: dragY ? 0 : undefined }}>
        <button className="vv-btn" aria-label="关闭" onClick={close}>
          <X size={22} />
        </button>
      </div>
      <div className="vv-bottom" style={{ opacity: dragY ? 0 : undefined }} onPointerDown={poke}>
        <div
          ref={bar}
          className="vv-scrub"
          role="slider"
          aria-label="进度"
          aria-valuemin={0}
          aria-valuemax={Math.round(dur)}
          aria-valuenow={Math.round(time)}
          aria-valuetext={`${formatDuration(time)} / ${formatDuration(dur)}`}
          tabIndex={0}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            scrubbing.current = true;
            scrubTo(e);
          }}
          onPointerMove={(e) => scrubbing.current && scrubTo(e)}
          onPointerUp={() => {
            scrubbing.current = false;
            poke();
          }}
          onPointerCancel={() => (scrubbing.current = false)}
        >
          <div className="vv-track">
            <div className="vv-buffered" style={{ width: `${dur ? Math.min(100, (buffered / dur) * 100) : 0}%` }} />
            <div className="vv-fill" style={{ width: `${pct}%` }} />
          </div>
          <div className="vv-knob" style={{ left: `${pct}%` }} />
        </div>
        <div className="vv-row">
          <button className="vv-btn" aria-label={playing ? '暂停' : '播放'} onClick={toggle}>
            {playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
          </button>
          <span className="vv-time">
            {formatDuration(time)} / {formatDuration(dur)}
          </span>
          <span className="spacer" />
          <button className="vv-btn" aria-label={muted ? '打开声音' : '静音'} onClick={toggleMute}>
            {muted ? <VolumeX size={20} /> : <Volume2 size={20} />}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
