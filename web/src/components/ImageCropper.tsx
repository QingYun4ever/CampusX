import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { ZoomIn, ZoomOut } from 'lucide-react';
import { Modal, Spinner, toast } from './ui';
import './image-cropper.css';

/**
 * 上传前裁剪头像 / 背景图。
 * 状态用「取景框中心落在图片的哪个位置（0~1）+ 缩放倍数」表示，窗口大小变了也不会跑偏。
 * 拖动平移；滑块、滚轮、双指缩放；输出固定尺寸的图片再上传。
 */
export function ImageCropper({
  file,
  title,
  aspect,
  round = false,
  output,
  onCancel,
  onDone,
}: {
  file: File;
  title: string;
  /** 宽 / 高 */
  aspect: number;
  /** 头像用圆形取景框 */
  round?: boolean;
  /** 输出尺寸（像素） */
  output: { width: number; height: number };
  onCancel: () => void;
  onDone: (file: File) => Promise<void> | void;
}) {
  const [src, setSrc] = useState<string>();
  const [img, setImg] = useState<HTMLImageElement>();
  const [frame, setFrame] = useState({ w: 0, h: 0 });
  const [view, setView] = useState({ zoom: 1, cx: 0.5, cy: 0.5 });
  const [busy, setBusy] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; zoom: number } | null>(null);
  const isGif = file.type === 'image/gif';

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setSrc(url);
    const el = new Image();
    el.onload = () => setImg(el);
    el.onerror = () => {
      toast('这张图片打不开，换一张试试', 'error');
      onCancel();
    };
    el.src = url;
    return () => URL.revokeObjectURL(url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setFrame({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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

  const apply = async () => {
    if (!img || !scale || busy) return;
    setBusy(true);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = output.width;
      canvas.height = output.height;
      const ctx = canvas.getContext('2d')!;
      ctx.imageSmoothingQuality = 'high';
      const sw = frame.w / scale;
      const sh = frame.h / scale;
      const sx = view.cx * img.naturalWidth - sw / 2;
      const sy = view.cy * img.naturalHeight - sh / 2;
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, output.width, output.height);
      // WebP 体积小还保留透明；不支持编码 WebP 的浏览器会退回 PNG
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/webp', 0.9));
      if (!blob) throw new Error('图片处理失败');
      const ext = blob.type === 'image/webp' ? 'webp' : 'png';
      await onDone(new File([blob], `crop.${ext}`, { type: blob.type }));
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
          style={{ aspectRatio: String(aspect) }}
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
