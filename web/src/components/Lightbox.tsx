import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { ChevronLeft, ChevronRight, Download, X, ZoomIn, ZoomOut } from 'lucide-react';
import { AndroidShell, isAndroid } from '../lib/android';
import { useEscape } from '../lib/escape';
import { toast } from './ui';
import './lightbox.css';

export interface LightboxRequest {
  images: string[];
  /** 和 images 一一对应的缩略图（时间线上已经加载过）：先显示它，原图加载好再换上 */
  previews?: string[];
  index: number;
  /** 第 i 张图在页面上的缩略图，打开和关闭时从它的位置放大 / 缩回去 */
  origin?: (i: number) => HTMLElement | null | undefined;
}

type View = { s: number; x: number; y: number };
const MAX_ZOOM = 5;
const ONE: View = { s: 1, x: 0, y: 0 };

/**
 * 图片查看器（类似 X）：
 * - 多图：左右箭头 / 键盘 ← → / 手指左右滑动翻页，顶部显示第几张
 * - 缩放：双指捏合、滚轮、鼠标单击或手指双击放大，放大后可以拖动
 * - 关闭：点空白处、Esc、手机上往下滑
 */
export function Lightbox({ images, previews, index: start, origin, onDone }: LightboxRequest & { onDone: () => void }) {
  const [index, setIndex] = useState(start);
  const [view, setView] = useState<View>(ONE);
  const [drag, setDrag] = useState({ dx: 0, dy: 0 });
  const [smooth, setSmooth] = useState(false);
  /** 原图加载好了的页 */
  const [full, setFull] = useState<Record<number, boolean>>({});
  /** 每页图片的尺寸（先来自缩略图，原图加载后更新），用来算显示大小，换图时不跳 */
  const [dims, setDims] = useState<Record<number, { w: number; h: number; real: boolean }>>({});
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [saving, setSaving] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const bg = useRef<HTMLDivElement>(null);
  const closing = useRef(false);
  const entered = useRef(false);
  const slideFrom = useRef(0);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const g = useRef<{
    mode: 'none' | 'pending' | 'pan' | 'swipe-x' | 'swipe-y' | 'pinch';
    sx: number;
    sy: number;
    t: number;
    view: View;
    dist?: number;
    mid?: { x: number; y: number };
    onImg?: boolean;
  }>({ mode: 'none', sx: 0, sy: 0, t: 0, view: ONE });
  const lastTap = useRef({ t: 0, x: 0, y: 0 });
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const many = images.length > 1;
  const src = images[index];
  const preview = previews?.[index];
  const shown = full[index] || !preview ? src : preview;

  // 舞台可用的大小（去掉内边距）
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 加载原图；缩略图先顶上
  useEffect(() => {
    if (full[index]) return;
    const el = new Image();
    el.onload = () => {
      setFull((m) => ({ ...m, [index]: true }));
      setDims((m) => ({ ...m, [index]: { w: el.naturalWidth, h: el.naturalHeight, real: true } }));
    };
    el.src = src;
    return () => {
      el.onload = null;
    };
  }, [index, src, full]);

  /** 图片显示尺寸：装进舞台，原图比舞台小时不放大（缩略图比原图小，所以可以放大到舞台大小） */
  const d = dims[index];
  const size = (() => {
    if (!d || !box.w) return undefined;
    const k = Math.min(box.w / d.w, box.h / d.h, d.real ? 1 : Infinity);
    return { width: Math.round(d.w * k), height: Math.round(d.h * k) };
  })();
  /* ---------- 打开 / 关闭动画：从缩略图的位置放大 ---------- */
  const delta = () => {
    const el = img.current;
    const from = origin?.(index);
    if (!el || !from || !from.isConnected) return null;
    const a = from.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    if (!b.width || !a.width) return null;
    const s = Math.max(a.width / b.width, a.height / b.height);
    return `translate(${a.left + a.width / 2 - (b.left + b.width / 2)}px, ${a.top + a.height / 2 - (b.top + b.height / 2)}px) scale(${s})`;
  };

  const onLoad = () => {
    const el = img.current;
    if (!el) return;
    // 缩略图长边不到 1280，说明服务器给的就是原图
    const small = Math.max(el.naturalWidth, el.naturalHeight) < 1280;
    setDims((m) => (m[index]?.real ? m : { ...m, [index]: { w: el.naturalWidth, h: el.naturalHeight, real: shown === src || small } }));
    if (reduce) return;
    if (!entered.current) {
      entered.current = true;
      const d = delta();
      el.animate(
        d ? [{ transform: d, borderRadius: '16px' }, { transform: 'none', borderRadius: '0px' }] : [{ opacity: 0, transform: 'scale(.94)' }, {}],
        { duration: 360, easing: 'cubic-bezier(.2,.9,.25,1)' },
      );
    }
  };

  // 换页时新图从滑动方向进来
  useLayoutEffect(() => {
    const dir = slideFrom.current;
    slideFrom.current = 0;
    if (!dir || reduce || !img.current) return;
    img.current.animate([{ transform: `translateX(${dir * 70}px)`, opacity: 0.2 }, { transform: 'none', opacity: 1 }], {
      duration: 240,
      easing: 'cubic-bezier(.2,.9,.25,1)',
    });
  }, [index, reduce]);

  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    if (reduce) return onDone();
    const el = img.current;
    const d = view.s === 1 ? delta() : null;
    const current = el ? getComputedStyle(el).transform : 'none';
    bg.current?.animate([{ opacity: getComputedStyle(bg.current).opacity }, { opacity: 0 }], {
      duration: 240,
      fill: 'forwards',
      easing: 'ease',
    });
    const a = el?.animate(
      d
        ? [{ transform: current }, { transform: d, borderRadius: '16px' }]
        : [{ transform: current, opacity: 1 }, { transform: `${current === 'none' ? '' : current} scale(.92)`, opacity: 0 }],
      { duration: 260, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' },
    );
    if (a) a.onfinish = onDone;
    else onDone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onDone, view.s, index]);

  useEscape(close);

  /* ---------- 翻页 ---------- */
  const go = useCallback(
    (dir: -1 | 1) => {
      const next = index + dir;
      if (next < 0 || next >= images.length) return;
      slideFrom.current = dir;
      setSmooth(false);
      setView(ONE);
      setDrag({ dx: 0, dy: 0 });
      setIndex(next);
    },
    [index, images.length],
  );

  // 预先加载前后两张
  useEffect(() => {
    for (const i of [index - 1, index + 1]) if (images[i]) new Image().src = previews?.[i] ?? images[i];
  }, [index, images, previews]);

  /* ---------- 缩放 ---------- */
  const clamp = (v: View): View => {
    const el = img.current;
    const st = stage.current;
    if (!el || !st) return v;
    const s = Math.min(MAX_ZOOM, Math.max(1, v.s));
    if (s === 1) return ONE;
    const mx = Math.max(0, (el.offsetWidth * s - st.clientWidth) / 2);
    const my = Math.max(0, (el.offsetHeight * s - st.clientHeight) / 2);
    return { s, x: Math.min(mx, Math.max(-mx, v.x)), y: Math.min(my, Math.max(-my, v.y)) };
  };

  /** 以屏幕上的点 (qx, qy) 为中心缩放到 s */
  const zoomAt = (from: View, s: number, qx: number, qy: number): View => {
    const r = stage.current!.getBoundingClientRect();
    const px = qx - (r.left + r.width / 2);
    const py = qy - (r.top + r.height / 2);
    const k = s / from.s;
    return clamp({ s, x: px - (px - from.x) * k, y: py - (py - from.y) * k });
  };

  const zoomBy = (factor: number) => {
    const r = stage.current!.getBoundingClientRect();
    setSmooth(true);
    setView((v) => zoomAt(v, v.s * factor, r.left + r.width / 2, r.top + r.height / 2));
  };

  const toggleZoom = (qx: number, qy: number) => {
    setSmooth(true);
    setView((v) => (v.s > 1 ? ONE : zoomAt(v, 2.5, qx, qy)));
  };

  // 键盘：← → 翻页，+ - 缩放，0 还原
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'ArrowRight') go(1);
      else if (e.key === '+' || e.key === '=') zoomBy(1.5);
      else if (e.key === '-') zoomBy(1 / 1.5);
      else if (e.key === '0') {
        setSmooth(true);
        setView(ONE);
      } else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  // 滚轮缩放（要阻止页面滚动，只能用非 passive 监听）
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      setSmooth(false);
      setView((v) => zoomAt(v, v.s * Math.exp(-e.deltaY / 300), e.clientX, e.clientY));
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  });

  /* ---------- 手势 ---------- */
  const down = (e: RPointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    setSmooth(false);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      g.current = {
        mode: 'pinch',
        sx: 0,
        sy: 0,
        t: e.timeStamp,
        view,
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      };
      setDrag({ dx: 0, dy: 0 });
    } else if (pointers.current.size === 1) {
      g.current = { mode: 'pending', sx: e.clientX, sy: e.clientY, t: e.timeStamp, view, onImg: e.target === img.current };
    }
  };

  const move = (e: RPointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const st = g.current;
    if (st.mode === 'pinch' && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const z = zoomAt(st.view, (st.view.s * dist) / st.dist!, st.mid!.x, st.mid!.y);
      setView(clamp({ ...z, x: z.x + mid.x - st.mid!.x, y: z.y + mid.y - st.mid!.y }));
      return;
    }
    const dx = e.clientX - st.sx;
    const dy = e.clientY - st.sy;
    if (st.mode === 'pending') {
      if (Math.hypot(dx, dy) < 6) return;
      st.mode = st.view.s > 1 ? 'pan' : Math.abs(dx) > Math.abs(dy) ? 'swipe-x' : 'swipe-y';
    }
    if (st.mode === 'pan') setView(clamp({ ...st.view, x: st.view.x + dx, y: st.view.y + dy }));
    else if (st.mode === 'swipe-x') {
      const edge = (dx > 0 && index === 0) || (dx < 0 && index === images.length - 1);
      setDrag({ dx: edge ? dx * 0.3 : dx, dy: 0 });
    } else if (st.mode === 'swipe-y') {
      setDrag({ dx: 0, dy });
      if (bg.current) bg.current.style.opacity = String(Math.max(0.2, 1 - Math.abs(dy) / 400));
    }
  };

  const up = (e: RPointerEvent) => {
    if (!pointers.current.delete(e.pointerId)) return;
    const st = g.current;
    const dx = e.clientX - st.sx;
    const dy = e.clientY - st.sy;
    const dt = Math.max(1, e.timeStamp - st.t);
    if (st.mode === 'pinch') {
      // 松开一根手指后，剩下那根接着拖
      const rest = [...pointers.current.values()][0];
      g.current = rest ? { mode: 'pan', sx: rest.x, sy: rest.y, t: e.timeStamp, view } : { mode: 'none', sx: 0, sy: 0, t: 0, view };
      return;
    }
    const mode = st.mode;
    g.current = { mode: 'none', sx: 0, sy: 0, t: 0, view };
    setSmooth(true);
    if (mode === 'swipe-x') {
      const w = stage.current?.clientWidth ?? 400;
      setDrag({ dx: 0, dy: 0 });
      if (Math.abs(dx) > w * 0.18 || Math.abs(dx) / dt > 0.5) go(dx < 0 ? 1 : -1);
      return;
    }
    if (mode === 'swipe-y') {
      if (Math.abs(dy) > 110 || Math.abs(dy) / dt > 0.6) {
        close();
        return;
      }
      setDrag({ dx: 0, dy: 0 });
      if (bg.current) bg.current.style.opacity = '';
      return;
    }
    if (mode !== 'pending') return;
    // 没怎么动：算一次点击
    if (!st.onImg) {
      close();
      return;
    }
    if (e.pointerType === 'mouse') {
      toggleZoom(e.clientX, e.clientY);
      return;
    }
    const last = lastTap.current;
    if (e.timeStamp - last.t < 320 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 30) {
      lastTap.current = { t: 0, x: 0, y: 0 };
      toggleZoom(e.clientX, e.clientY);
    } else lastTap.current = { t: e.timeStamp, x: e.clientX, y: e.clientY };
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await saveImage(src);
      toast(isAndroid ? '已保存到相册' : '已开始下载');
    } catch (e) {
      toast((e as Error).message || '保存失败', 'error');
    } finally {
      setSaving(false);
    }
  };

  const zoomed = view.s > 1;
  return (
    <div className={`lightbox ${zoomed ? 'zoomed' : ''}`} role="dialog" aria-label="查看图片">
      <div className="lightbox-bg" ref={bg} />
      <div
        ref={stage}
        className="lightbox-stage"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
      >
        <img
          key={index}
          ref={img}
          src={shown}
          alt={many ? `第 ${index + 1} 张，共 ${images.length} 张` : ''}
          draggable={false}
          onLoad={onLoad}
          className={smooth ? 'smooth' : ''}
          style={{ ...size, transform: `translate(${view.x + drag.dx}px, ${view.y + drag.dy}px) scale(${view.s})` }}
        />
        {!d && <span className="lightbox-spin" aria-label="加载中" />}
        {d && !full[index] && <span className="lightbox-loading" aria-label="正在加载原图" />}
      </div>

      <div className="lightbox-bar">
        <button className="lightbox-btn" aria-label="关闭" onClick={close}>
          <X size={22} />
        </button>
        {many && (
          <span className="lightbox-count">
            {index + 1} / {images.length}
          </span>
        )}
        <span className="lightbox-tools">
          <button className="lightbox-btn desk" aria-label="缩小" onClick={() => zoomBy(1 / 1.5)} disabled={!zoomed}>
            <ZoomOut size={20} />
          </button>
          <button className="lightbox-btn desk" aria-label="放大" onClick={() => zoomBy(1.5)} disabled={view.s >= MAX_ZOOM}>
            <ZoomIn size={20} />
          </button>
          <button className="lightbox-btn" aria-label="保存图片" title="保存图片" onClick={save} disabled={saving}>
            <Download size={19} />
          </button>
        </span>
      </div>

      {many && index > 0 && (
        <button className="lightbox-btn lightbox-nav prev" aria-label="上一张" onClick={() => go(-1)}>
          <ChevronLeft size={26} />
        </button>
      )}
      {many && index < images.length - 1 && (
        <button className="lightbox-btn lightbox-nav next" aria-label="下一张" onClick={() => go(1)}>
          <ChevronRight size={26} />
        </button>
      )}
      {many && (
        <div className="lightbox-dots" aria-hidden>
          {images.map((_, i) => (
            <i key={i} className={i === index ? 'on' : ''} />
          ))}
        </div>
      )}
    </div>
  );
}

function blobToBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(new Error('读取图片失败'));
    r.readAsDataURL(blob);
  });
}

/** 保存原图：App 里存进相册，网页上直接下载 */
async function saveImage(src: string) {
  const name = `campusx-${Date.now()}`;
  if (isAndroid) {
    try {
      if (src.startsWith('blob:') || src.startsWith('data:')) {
        const blob = await (await fetch(src)).blob();
        await AndroidShell.saveImage({ data: await blobToBase64(blob), mime: blob.type });
      } else {
        await AndroidShell.saveImage({ url: new URL(src, location.href).href });
      }
    } catch (e) {
      // 老版本 App 没有这个方法：用浏览器打开，长按保存
      if ((e as { code?: string }).code === 'UNIMPLEMENTED' && !src.startsWith('blob:')) {
        await AndroidShell.openBrowser({ url: src });
        return;
      }
      throw e;
    }
    return;
  }
  let href = src;
  let revoke = false;
  try {
    const res = await fetch(src);
    if (!res.ok) throw new Error();
    const blob = await res.blob();
    href = URL.createObjectURL(blob);
    revoke = true;
    const ext = { 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }[blob.type] ?? 'jpg';
    const a = Object.assign(document.createElement('a'), { href, download: `${name}.${ext}` });
    document.body.append(a);
    a.click();
    a.remove();
  } catch {
    // 跨域拿不到：新标签页打开原图
    window.open(src, '_blank', 'noopener');
  } finally {
    if (revoke) setTimeout(() => URL.revokeObjectURL(href), 10_000);
  }
}
