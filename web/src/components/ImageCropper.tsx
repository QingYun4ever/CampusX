import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { RotateCcw, RotateCw, ZoomIn, ZoomOut } from 'lucide-react';
import { canvasToFile } from '../lib/image';
import { Modal, Spinner, toast } from './ui';
import './image-cropper.css';

/** 帖子配图可选的裁剪比例；null = 保持原图比例 */
const ASPECTS: { label: string; value: number | null }[] = [
  { label: '原图', value: null },
  { label: '1:1', value: 1 },
  { label: '4:3', value: 4 / 3 },
  { label: '3:4', value: 3 / 4 },
  { label: '16:9', value: 16 / 9 },
];

type Output = { width: number; height: number } | { maxEdge: number };

/**
 * 上传前编辑图片：头像 / 背景图（固定比例），以及帖子配图（可旋转、换比例）。
 * 状态用「取景框中心落在图片的哪个位置（0~1）+ 缩放倍数」表示，窗口大小变了也不会跑偏。
 * 拖动平移；滑块、滚轮、双指缩放。
 */
export function ImageCropper({
  file,
  title,
  aspect: fixedAspect,
  round = false,
  editable = false,
  output,
  onCancel,
  onDone,
}: {
  file: File;
  title: string;
  /** 宽 / 高；editable 时作为初始比例，不传就是原图比例 */
  aspect?: number;
  /** 头像用圆形取景框 */
  round?: boolean;
  /** 帖子配图：可以旋转、选择比例 */
  editable?: boolean;
  /** 固定输出尺寸，或者只限制长边 */
  output: Output;
  onCancel: () => void;
  onDone: (file: File) => Promise<void> | void;
}) {
  const [src, setSrc] = useState<string>();
  const [img, setImg] = useState<HTMLImageElement>();
  const [rot, setRot] = useState(0);
  const [aspect, setAspect] = useState<number | null>(fixedAspect ?? null);
  const [frame, setFrame] = useState({ w: 0, h: 0 });
  const [view, setView] = useState({ zoom: 1, cx: 0.5, cy: 0.5 });
  const [busy, setBusy] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; zoom: number } | null>(null);
  const isGif = file.type === 'image/gif';

  // 旋转后的图片单独生成一张，后面的计算都当它是原图
  useEffect(() => {
    let url = '';
    let cancelled = false;
    const fail = () => {
      toast('这张图片打不开，换一张试试', 'error');
      onCancel();
    };
    const load = (u: string) => {
      const el = new Image();
      el.onload = () => {
        if (cancelled) return;
        setSrc(u);
        setImg(el);
      };
      el.onerror = fail;
      el.src = u;
    };
    const orig = URL.createObjectURL(file);
    if (!rot) {
      url = orig;
      load(orig);
    } else {
      const base = new Image();
      base.onload = () => {
        const c = document.createElement('canvas');
        const swap = rot % 180 !== 0;
        c.width = swap ? base.naturalHeight : base.naturalWidth;
        c.height = swap ? base.naturalWidth : base.naturalHeight;
        const ctx = c.getContext('2d')!;
        ctx.translate(c.width / 2, c.height / 2);
        ctx.rotate((rot * Math.PI) / 180);
        ctx.drawImage(base, -base.naturalWidth / 2, -base.naturalHeight / 2);
        URL.revokeObjectURL(orig);
        c.toBlob((b) => {
          if (!b || cancelled) return;
          url = URL.createObjectURL(b);
          load(url);
        }, 'image/png');
      };
      base.onerror = fail;
      base.src = orig;
    }
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, rot]);

  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setFrame({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const ratio = aspect ?? (img ? img.naturalWidth / img.naturalHeight : fixedAspect ?? 1);

  // 换比例、旋转后重新居中
  useEffect(() => setView({ zoom: 1, cx: 0.5, cy: 0.5 }), [aspect, img]);

  // 缩放 1 = 图片刚好铺满取景框
  const base = img && frame.w ? Math.max(frame.w / img.naturalWidth, frame.h / img.naturalHeight) : 0;
  const scale = base * view.zoom;
  const dw = img ? img.naturalWidth * scale : 0;
  const dh = img ? img.naturalHeight * scale : 0;

  /** 保证取景框始终被图片盖满 */
  const clamp = (v: { zoom: number; cx: number; cy: number }) => {
    if (!img || !base) return v;
    const zoom = Math.min(5, Math.max(1, v.zoom));
    const w = img.naturalWidth * base * zoom;
    const h = img.naturalHeight * base * zoom;
    const hx = frame.w / 2 / w;
    const hy = frame.h / 2 / h;
    return { zoom, cx: Math.min(1 - hx, Math.max(hx, v.cx)), cy: Math.min(1 - hy, Math.max(hy, v.cy)) };
  };
  const update = (fn: (v: typeof view) => typeof view) => setView((v) => clamp(fn(v)));

  const down = (e: RPointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: view.zoom };
    }
  };
  const move = (e: RPointerEvent) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      const p = pinch.current;
      update((v) => ({ ...v, zoom: (p.zoom * Math.hypot(a.x - b.x, a.y - b.y)) / p.dist }));
      return;
    }
    if (!dw) return;
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    update((v) => ({ ...v, cx: v.cx - dx / dw, cy: v.cy - dy / dh }));
  };
  const up = (e: RPointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
  };

  // 滚轮缩放要阻止页面滚动，只能用非 passive 的原生监听
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      setView((v) => clamp({ ...v, zoom: v.zoom * Math.exp(-e.deltaY / 400) }));
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  });

  const untouched = editable && !rot && aspect === null && view.zoom === 1;

  const apply = async () => {
    if (!img || !scale || busy) return;
    setBusy(true);
    try {
      // 什么都没改就直接用原文件，不重新压一遍
      if (untouched) return await onDone(file);
      const sw = frame.w / scale;
      const sh = frame.h / scale;
      const sx = view.cx * img.naturalWidth - sw / 2;
      const sy = view.cy * img.naturalHeight - sh / 2;
      let ow: number;
      let oh: number;
      if ('maxEdge' in output) {
        const k = Math.min(1, output.maxEdge / Math.max(sw, sh));
        ow = Math.round(sw * k);
        oh = Math.round(sh * k);
      } else {
        ow = output.width;
        oh = output.height;
      }
      const canvas = document.createElement('canvas');
      canvas.width = ow;
      canvas.height = oh;
      const ctx = canvas.getContext('2d')!;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, ow, oh);
      await onDone(await canvasToFile(canvas, 'edited'));
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const useOriginal = async () => {
    setBusy(true);
    try {
      await onDone(file);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={title}
      onClose={onCancel}
      className="cropper-modal"
      right={
        <button className="btn btn-light" onClick={apply} disabled={!img || busy}>
          {busy ? '上传中…' : '应用'}
        </button>
      }
    >
      <div className="cropper">
        <div
          ref={stage}
          className={`cropper-stage ${round ? 'round' : ''}`}
          style={{
            aspectRatio: String(ratio),
            // 竖图不能把弹窗撑得太高
            width: round ? undefined : `min(100%, calc(56vh * ${ratio}))`,
          }}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
        >
          {src && img && base > 0 && (
            <img
              src={src}
              alt=""
              draggable={false}
              style={{
                width: dw,
                height: dh,
                transform: `translate(${frame.w / 2 - view.cx * dw}px, ${frame.h / 2 - view.cy * dh}px)`,
              }}
            />
          )}
          {!img && <Spinner inline />}
          <div className="cropper-mask" aria-hidden />
        </div>

        {editable && !isGif && (
          <div className="cropper-tools">
            <div className="cropper-aspects" role="radiogroup" aria-label="裁剪比例">
              {ASPECTS.map((a) => (
                <button
                  key={a.label}
                  role="radio"
                  aria-checked={aspect === a.value}
                  className={aspect === a.value ? 'on' : ''}
                  onClick={() => setAspect(a.value)}
                >
                  {a.label}
                </button>
              ))}
            </div>
            <div className="cropper-rotate">
              <button className="icon-btn" aria-label="向左旋转" title="向左旋转" onClick={() => setRot((r) => (r + 270) % 360)}>
                <RotateCcw size={18} />
              </button>
              <button className="icon-btn" aria-label="向右旋转" title="向右旋转" onClick={() => setRot((r) => (r + 90) % 360)}>
                <RotateCw size={18} />
              </button>
            </div>
          </div>
        )}

        <div className="cropper-zoom">
          <button className="icon-btn" aria-label="缩小" onClick={() => update((v) => ({ ...v, zoom: v.zoom / 1.25 }))}>
            <ZoomOut size={18} />
          </button>
          <input
            type="range"
            aria-label="缩放"
            min={1}
            max={5}
            step={0.01}
            value={view.zoom}
            onChange={(e) => update((v) => ({ ...v, zoom: Number(e.target.value) }))}
          />
          <button className="icon-btn" aria-label="放大" onClick={() => update((v) => ({ ...v, zoom: v.zoom * 1.25 }))}>
            <ZoomIn size={18} />
          </button>
        </div>
        <p className="cropper-hint">拖动调整位置，滚轮或双指缩放。</p>
        {isGif && (
          <button className="btn btn-text cropper-original" disabled={busy} onClick={useOriginal}>
            保留动图，不裁剪
          </button>
        )}
      </div>
    </Modal>
  );
}
