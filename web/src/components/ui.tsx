import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type FocusEvent,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
} from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, CircleAlert, X } from 'lucide-react';
import { media } from '../lib/api';
import { compact } from '../lib/format';

/* ---------- 蓝标认证：由管理员手动指定 ---------- */
export function Verified({ user, size = 18 }: { user: { verified?: boolean; verifiedNote?: string }; size?: number }) {
  if (!user.verified) return null;
  const label = user.verifiedNote ? `已认证：${user.verifiedNote}` : '已认证';
  return (
    <svg className="verified" width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={label}>
      <title>{label}</title>
      <path
        fill="currentColor"
        d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"
      />
      <path d="m8.6 12.2 2.3 2.3 4.6-4.9" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ---------- 颜色：由字符串稳定地算出一个低饱和色（头像、吧的字标） ---------- */
const TONES = ['#5b7083', '#7a6a58', '#5f7a61', '#7a5f73', '#5d6f8a', '#86705a', '#4f7a78', '#7d6450', '#6a6587'];
export function toneFor(s: string) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.codePointAt(0)!) >>> 0;
  return TONES[h % TONES.length];
}

export function Avatar({ src, name, size = 40 }: { src?: string | null; name: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const url = media(src);
  if (url && !failed) {
    return (
      <img
        className="avatar"
        src={url}
        alt=""
        width={size}
        height={size}
        style={{ width: size, height: size }}
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span
      className="avatar"
      style={{ width: size, height: size, fontSize: size * 0.42, background: toneFor(name || '?') }}
      aria-hidden
    >
      {[...(name || '?')][0]}
    </span>
  );
}

/** 吧的标识：方形字标，取吧名首字 */
export function BoardMark({ name, slug, size = 44 }: { name: string; slug: string; size?: number }) {
  return (
    <span
      className="board-mark"
      style={{ width: size, height: size, fontSize: size * 0.44, background: toneFor(slug), borderRadius: size * 0.24 }}
      aria-hidden
    >
      {[...name][0]}
    </span>
  );
}

export function Spinner({ size = 28, inline }: { size?: number; inline?: boolean }) {
  return (
    <svg className={`spinner ${inline ? 'inline' : ''}`} width={size} height={size} viewBox="0 0 24 24" aria-label="加载中">
      <circle cx="12" cy="12" r="9.5" fill="none" strokeWidth="2.5" />
    </svg>
  );
}

export function PostSkeleton({ n = 5 }: { n?: number }) {
  return (
    <div aria-busy="true" aria-label="加载中">
      {Array.from({ length: n }, (_, i) => (
        <div className="sk-post" key={i} style={{ animationDelay: `${i * 60}ms` }}>
          <span className="sk sk-avatar" />
          <div className="sk-lines">
            <span className="sk" style={{ width: `${28 + ((i * 17) % 20)}%` }} />
            <span className="sk" style={{ width: '94%' }} />
            <span className="sk" style={{ width: `${52 + ((i * 23) % 36)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

/** 数字变化时上下滚动 */
export function Rolling({ value }: { value: number }) {
  const prev = useRef(value);
  const dir = value > prev.current ? 'up' : value < prev.current ? 'down' : '';
  useEffect(() => {
    prev.current = value;
  }, [value]);
  return (
    <span className="roll">
      <span key={value} className={`roll-v ${dir}`}>
        {value > 0 ? compact(value) : ''}
      </span>
    </span>
  );
}

/* ---------- 输入框：标签浮动，Google 式描边（variant="outlined"）或 X 式内嵌 ---------- */
type FieldProps = {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  hint?: ReactNode;
  prefix?: string;
  trailing?: ReactNode;
  multiline?: boolean;
  counter?: boolean;
  variant?: 'outlined' | 'filled';
  inputRef?: Ref<HTMLInputElement & HTMLTextAreaElement>;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'prefix'>;

export function Field({
  label,
  value,
  onChange,
  error,
  hint,
  prefix,
  trailing,
  multiline,
  counter,
  variant = 'filled',
  inputRef,
  maxLength,
  onFocus,
  onBlur,
  ...rest
}: FieldProps) {
  const id = useId();
  const [focus, setFocus] = useState(false);
  const up = focus || value.length > 0;
  const common = {
    id,
    value,
    maxLength,
    'aria-invalid': !!error || undefined,
    'aria-describedby': error || hint ? `${id}-msg` : undefined,
    onFocus: (e: FocusEvent<HTMLInputElement & HTMLTextAreaElement>) => {
      setFocus(true);
      onFocus?.(e);
    },
    onBlur: (e: FocusEvent<HTMLInputElement & HTMLTextAreaElement>) => {
      setFocus(false);
      onBlur?.(e);
    },
    onChange: (e: ChangeEvent<HTMLInputElement & HTMLTextAreaElement>) => onChange(e.target.value),
  };
  return (
    <div className={`tf ${variant} ${focus ? 'focus' : ''} ${up ? 'up' : ''} ${error ? 'error' : ''}`}>
      <div className="tf-box">
        <label htmlFor={id}>{label}</label>
        {counter && maxLength && (
          <span className="tf-count">
            {[...value].length} / {maxLength}
          </span>
        )}
        <div className="tf-row">
          {prefix && <span className="tf-prefix">{prefix}</span>}
          {multiline ? (
            <textarea ref={inputRef} rows={3} {...common} {...(rest as object)} />
          ) : (
            <input ref={inputRef} {...common} {...rest} />
          )}
          {trailing}
        </div>
      </div>
      <div className="tf-msg" id={`${id}-msg`} aria-live="polite">
        {error ? (
          <span className="tf-error" key={error}>
            <CircleAlert size={15} /> {error}
          </span>
        ) : (
          hint
        )}
      </div>
    </div>
  );
}

export function TopBar({
  title,
  sub,
  back,
  right,
  children,
  titleHidden,
}: {
  title?: ReactNode;
  sub?: ReactNode;
  back?: boolean;
  right?: ReactNode;
  children?: ReactNode;
  /** 个人主页：滚过资料区之前不显示标题 */
  titleHidden?: boolean;
}) {
  const nav = useNavigate();
  return (
    <header className="topbar">
      {(title || back || right) && (
        <div className="topbar-row">
          {back && (
            <button
              className="icon-btn"
              aria-label="返回"
              onClick={() => (window.history.state?.idx > 0 ? nav(-1) : nav('/'))}
            >
              <ArrowLeft size={20} />
            </button>
          )}
          <div className={`topbar-title ${titleHidden ? 'hidden' : ''}`}>
            {title && <h1 className="ellipsis">{title}</h1>}
            {sub && <div className="sub">{sub}</div>}
          </div>
          {right}
        </div>
      )}
      {children}
    </header>
  );
}

/** 标签页：底部指示条在标签之间滑动 */
export function Tabs<T extends string>({
  value,
  onChange,
  items,
}: {
  value: T;
  onChange: (v: T) => void;
  items: [T, string][];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [ind, setInd] = useState<{ x: number; w: number } | null>(null);
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    const nav = ref.current;
    if (!nav) return;
    const update = () => {
      const el = nav.querySelector<HTMLElement>('.tab.active span');
      if (!el) return;
      const nr = nav.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      setInd({ x: r.left - nr.left, w: r.width });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(nav);
    return () => ro.disconnect();
  }, [value, items.length]);
  useEffect(() => {
    if (ind && !ready) requestAnimationFrame(() => setReady(true));
  }, [ind, ready]);
  return (
    <div className="tabs" ref={ref} role="tablist">
      {items.map(([k, label]) => (
        <button
          key={k}
          role="tab"
          aria-selected={value === k}
          className={`tab ${value === k ? 'active' : ''}`}
          onClick={() => onChange(k)}
        >
          <span>{label}</span>
        </button>
      ))}
      <i
        className={`tab-ind ${ready ? 'ready' : ''}`}
        style={ind ? { transform: `translateX(${ind.x}px)`, width: ind.w } : { opacity: 0 }}
      />
    </div>
  );
}

/* ---------- 弹窗：进入/退出都有动画；手机上是从底部升起的整屏 ---------- */
const ModalCtx = createContext<() => void>(() => {});
/** 在弹窗内部调用，带退出动画地关闭弹窗 */
export const useModalClose = () => useContext(ModalCtx);

export function Modal({
  title,
  onClose,
  right,
  children,
  className,
}: {
  title?: ReactNode;
  onClose: () => void;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const [leaving, setLeaving] = useState(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const close = useCallback(() => setLeaving(true), []);

  useEffect(() => {
    if (!leaving) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const t = window.setTimeout(() => closeRef.current(), reduce ? 0 : 200);
    return () => clearTimeout(t);
  }, [leaving]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [close]);

  return createPortal(
    <ModalCtx.Provider value={close}>
      <div className={`overlay ${leaving ? 'leaving' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && close()}>
        <div className={`modal ${className ?? ''}`} role="dialog" aria-modal="true">
          <div className="modal-head">
            <button className="icon-btn" onClick={close} aria-label="关闭">
              <X size={20} />
            </button>
            <h2>{title}</h2>
            {right}
          </div>
          {children}
        </div>
      </div>
    </ModalCtx.Provider>,
    document.body,
  );
}

/* ---------- 全局轻提示 & 图片查看器（事件驱动，任何地方都可调用） ---------- */

export function toast(message: string, type: 'info' | 'error' = 'info') {
  window.dispatchEvent(new CustomEvent('app:toast', { detail: { message, type } }));
}

/** from：被点击的缩略图，查看器会从它的位置放大出来 */
export function openLightbox(src: string, from?: HTMLElement | null) {
  window.dispatchEvent(new CustomEvent('app:lightbox', { detail: { src, from } }));
}

type ToastItem = { id: number; message: string; type: string; leaving?: boolean };

function Lightbox({ src, from, onDone }: { src: string; from?: HTMLElement | null; onDone: () => void }) {
  const img = useRef<HTMLImageElement>(null);
  const bg = useRef<HTMLDivElement>(null);
  const closing = useRef(false);
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const delta = () => {
    const el = img.current;
    if (!el || !from) return null;
    const a = from.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    if (!b.width || !a.width) return null;
    return `translate(${a.left + a.width / 2 - (b.left + b.width / 2)}px, ${a.top + a.height / 2 - (b.top + b.height / 2)}px) scale(${Math.max(a.width / b.width, a.height / b.height)})`;
  };

  const onLoad = () => {
    if (reduce) return;
    const d = delta();
    img.current?.animate(
      d ? [{ transform: d, borderRadius: '16px' }, { transform: 'none', borderRadius: '4px' }] : [{ opacity: 0, transform: 'scale(.94)' }, {}],
      { duration: 380, easing: 'cubic-bezier(.2,.9,.25,1)' },
    );
  };

  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    if (reduce) return onDone();
    const d = delta();
    bg.current?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 260, fill: 'forwards', easing: 'ease' });
    const a = img.current?.animate(
      d ? [{ transform: 'none' }, { transform: d, borderRadius: '16px' }] : [{}, { opacity: 0, transform: 'scale(.94)' }],
      { duration: 280, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' },
    );
    if (a) a.onfinish = onDone;
    else onDone();
  }, [onDone]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  return (
    <div className="lightbox" onClick={close}>
      <div className="lightbox-bg" ref={bg} />
      <img ref={img} src={src} alt="" onLoad={onLoad} />
      <button className="icon-btn lightbox-close" aria-label="关闭">
        <X size={22} />
      </button>
    </div>
  );
}

export function Overlays() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [img, setImg] = useState<{ src: string; from?: HTMLElement | null } | null>(null);
  useEffect(() => {
    let seq = 0;
    const onToast = (e: Event) => {
      const id = ++seq;
      const d = (e as CustomEvent).detail;
      setToasts((list) => [...list.slice(-2), { id, ...d }]);
      setTimeout(() => setToasts((list) => list.map((t) => (t.id === id ? { ...t, leaving: true } : t))), 2600);
      setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 2900);
    };
    const onImg = (e: Event) => setImg((e as CustomEvent).detail);
    window.addEventListener('app:toast', onToast);
    window.addEventListener('app:lightbox', onImg);
    return () => {
      window.removeEventListener('app:toast', onToast);
      window.removeEventListener('app:lightbox', onImg);
    };
  }, []);
  return (
    <>
      <div className="toasts" role="status">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.type === 'error' ? 'error' : ''} ${t.leaving ? 'leaving' : ''}`}>
            {t.message}
          </div>
        ))}
      </div>
      {img && <Lightbox key={img.src} src={img.src} from={img.from} onDone={() => setImg(null)} />}
    </>
  );
}

/** 元素进入视口时触发（无限滚动） */
export function useOnVisible(cb: () => void, enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const cbRef = useRef(cb);
  cbRef.current = cb;
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const io = new IntersectionObserver((es) => es[0].isIntersecting && cbRef.current(), { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [enabled]);
  return ref;
}

/**
 * 弹出菜单：点外面关闭。
 * float 为 true 时用 fixed 定位贴着触发按钮，不会被弹窗等滚动容器裁掉；下面放不下就向上展开。
 */
export function usePopover(float = false) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<CSSProperties>({});
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open || !float || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - 328));
    setPos(
      below >= 240 || below >= above
        ? { position: 'fixed', top: r.bottom + 4, left, right: 'auto', maxHeight: Math.min(below, 380), transformOrigin: 'top left' }
        : { position: 'fixed', bottom: window.innerHeight - r.top + 4, top: 'auto', left, right: 'auto', maxHeight: Math.min(above, 380), transformOrigin: 'bottom left' },
    );
  }, [open, float]);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
    };
    const away = (e: Event) => float && !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc, true);
    window.addEventListener('scroll', away, true);
    window.addEventListener('resize', away);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc, true);
      window.removeEventListener('scroll', away, true);
      window.removeEventListener('resize', away);
    };
  }, [open, float]);
  return { open, setOpen, ref, style: float ? pos : undefined };
}
