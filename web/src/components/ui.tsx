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
import { subscribeMediaSession, thumb, type AvatarDecoration } from '../lib/api';
import { useEscape } from '../lib/escape';
import { Lightbox, type LightboxRequest } from './Lightbox';
import { resolveMediaUrl, useMediaResource } from './MediaImage';
import { AvatarFrame, FRAMED } from './AvatarFrame';
import { compact } from '../lib/format';
import './identity.css';

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

function useAvatarImage(src?: string | null, original = false) {
  const primary = src && !original ? thumb(src, 'avatar') : src;
  const { url: primaryUrl } = useMediaResource(primary);
  const [failure, setFailure] = useState<{ url: string; exhausted: boolean }>();
  const primaryFailed = !!primaryUrl && failure?.url === primaryUrl;
  let url = primaryUrl;
  if (primaryFailed) {
    // App 比站点先更新时，旧站点没有头像专用接口，仍可使用已有的帖子缩略图。
    const fallback = !failure.exhausted && src && primary !== src ? thumb(src) : undefined;
    url = fallback && fallback !== src ? resolveMediaUrl(fallback) : undefined;
  }
  return {
    url,
    onError: () => {
      if (primaryUrl) setFailure({ url: primaryUrl, exhausted: primaryFailed });
    },
  };
}

/**
 * 头像框动画只在头像出现在屏幕上时播放：首页一屏可能有很多带框的头像，
 * 滑出去的就停掉，省电也不卡。所有头像共用一个 IntersectionObserver。
 */
const onScreenCallbacks = new Map<Element, (visible: boolean) => void>();
let onScreenObserver: IntersectionObserver | undefined;
function useOnScreen(ref: { current: Element | null }, enabled: boolean) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el || typeof IntersectionObserver === 'undefined') return;
    onScreenObserver ??= new IntersectionObserver(
      (entries) => {
        for (const e of entries) onScreenCallbacks.get(e.target)?.(e.isIntersecting);
      },
      { rootMargin: '40px' },
    );
    onScreenCallbacks.set(el, setVisible);
    onScreenObserver.observe(el);
    return () => {
      onScreenObserver?.unobserve(el);
      onScreenCallbacks.delete(el);
      setVisible(false);
    };
  }, [ref, enabled]);
  return visible;
}

export function Avatar({ src, name, size = 40, decoration, original = false }: {
  src?: string | null;
  name: string;
  size?: number;
  decoration?: AvatarDecoration;
  original?: boolean;
}) {
  const { url, onError } = useAvatarImage(src, original);
  const loading = original ? 'eager' : 'lazy';
  const framed = !!decoration && FRAMED.has(decoration);
  const frameRef = useRef<HTMLSpanElement>(null);
  // 大头像（主页、商场）一直播放；帖子、私信里的头像（32px 起）在屏幕上时播放；更小的太小看不清，不动
  const onScreen = useOnScreen(frameRef, framed && size >= 32 && size < 64);
  const live = size >= 64 || onScreen;
  if (decoration && framed) {
    // 头像框：外层占位、画框，里面才是头像
    return (
      <span
        ref={frameRef}
        className={`avatar framed ${live ? 'live' : ''} ${size < 32 ? 'tiny' : ''}`}
        data-avatar-decoration={decoration}
        style={{ width: size, height: size }}
      >
        {url ? (
          <img className="avatar-face" src={url} alt="" width={size} height={size} loading={loading} decoding="async" onError={onError} />
        ) : (
          <span className="avatar-face" style={{ fontSize: size * 0.42, background: toneFor(name || '?') }} aria-hidden>
            {[...(name || '?')][0]}
          </span>
        )}
        <AvatarFrame kind={decoration} live={live} />
      </span>
    );
  }
  if (url) {
    return (
      <img
        className="avatar"
        data-avatar-decoration={decoration || undefined}
        src={url}
        alt=""
        width={size}
        height={size}
        loading={loading}
        decoding="async"
        style={{ width: size, height: size }}
        onError={onError}
      />
    );
  }
  return (
    <span
      className="avatar"
      data-avatar-decoration={decoration || undefined}
      style={{ width: size, height: size, fontSize: size * 0.42, background: toneFor(name || '?') }}
      aria-hidden
    >
      {[...(name || '?')][0]}
    </span>
  );
}

/** 吧的标识：优先显示头像，缺图时取吧名首字。 */
export function BoardMark({ name, slug, avatar, size = 44 }: { name: string; slug: string; avatar?: string | null; size?: number }) {
  const { url, onError } = useAvatarImage(avatar);
  return (
    <span
      className="board-mark"
      style={{ width: size, height: size, fontSize: size * 0.44, background: toneFor(slug), borderRadius: size * 0.24 }}
      aria-hidden
    >
      {url ? (
        <img src={url} alt="" width={size} height={size} loading="lazy" decoding="async" onError={onError} />
      ) : [...name][0]}
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
  const bar = useRef<HTMLElement>(null);
  // 帖子头像吸顶要停在顶栏下面：把顶栏高度（含刘海、标签页）写到 --topbar-h
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el) return;
    const root = document.documentElement;
    const update = () => root.style.setProperty('--topbar-h', `${el.offsetHeight}px`);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <header className="topbar" ref={bar}>
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
const ModalLeavingCtx = createContext(false);
export const useModalLeaving = () => useContext(ModalLeavingCtx);

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
  useEscape(close);

  useEffect(() => {
    if (!leaving) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const t = window.setTimeout(() => closeRef.current(), reduce ? 0 : 200);
    return () => clearTimeout(t);
  }, [leaving]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

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
          <ModalLeavingCtx.Provider value={leaving}>{children}</ModalLeavingCtx.Provider>
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
  openGallery({ images: [src], index: 0, origin: () => from });
}

/** 多张图一起看，可以左右翻页 */
export function openGallery(req: LightboxRequest) {
  window.dispatchEvent(new CustomEvent<LightboxRequest>('app:lightbox', { detail: req }));
}

/** 私有图片被撤回或卸载时，关闭同一资源的查看器。 */
export function closeLightbox(src: string) {
  window.dispatchEvent(new CustomEvent('app:lightbox-close', { detail: src }));
}

type ToastItem = { id: number; message: string; type: string; leaving?: boolean };

export function Overlays() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [img, setImg] = useState<LightboxRequest | null>(null);
  useEffect(() => {
    let seq = 0;
    const onToast = (e: Event) => {
      const id = ++seq;
      const d = (e as CustomEvent).detail;
      setToasts((list) => [...list.slice(-2), { id, ...d }]);
      setTimeout(() => setToasts((list) => list.map((t) => (t.id === id ? { ...t, leaving: true } : t))), 2600);
      setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 2900);
    };
    const onImg = (e: Event) => setImg((e as CustomEvent<LightboxRequest>).detail);
    const onImgClose = (e: Event) =>
      setImg((current) => (current?.images.includes((e as CustomEvent<string>).detail) ? null : current));
    const unsubscribe = subscribeMediaSession(() => setImg(null));
    window.addEventListener('app:toast', onToast);
    window.addEventListener('app:lightbox', onImg);
    window.addEventListener('app:lightbox-close', onImgClose);
    return () => {
      unsubscribe();
      window.removeEventListener('app:toast', onToast);
      window.removeEventListener('app:lightbox', onImg);
      window.removeEventListener('app:lightbox-close', onImgClose);
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
      {img && (
        <Lightbox
          key={img.images.join('|') + img.index}
          {...img}
          onDone={() => setImg((current) => (current === img ? null : current))}
        />
      )}
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
/* ---------- 表情图片（Twemoji，各平台显示一致，不会出现方块或错位） ---------- */
export function emojiUrl(e: string) {
  const cps = [...e].map((c) => c.codePointAt(0)!);
  // Twemoji 的文件名：不含零宽连接符时去掉 FE0F 变体选择符
  const code = (e.includes('\u200d') ? cps : cps.filter((c) => c !== 0xfe0f)).map((c) => c.toString(16)).join('-');
  return `${import.meta.env.BASE_URL}emoji/${code}.svg`;
}
export function Emoji({ e, size = 18 }: { e: string; size?: number }) {
  return <img className="emoji" src={emojiUrl(e)} alt={e} width={size} height={size} draggable={false} />;
}

/** float：用 fixed 定位浮在最上层；width：已知宽度时以按钮为中心对齐 */
export function usePopover(float = false, width = 0) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<CSSProperties>({});
  useEscape(() => setOpen(false), open);
  const ref = useRef<HTMLDivElement>(null);
  const place = useCallback(() => {
    if (!ref.current) return false;
    const r = ref.current.getBoundingClientRect();
    // 按钮已经滚出屏幕就收起
    if (r.bottom < 0 || r.top > window.innerHeight) return false;
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const want = width ? r.left + r.width / 2 - width / 2 : r.left;
    const left = Math.max(8, Math.min(want, window.innerWidth - (width || 332) - 8));
    setPos(
      below >= 240 || below >= above
        ? { position: 'fixed', top: r.bottom + 4, left, right: 'auto', maxHeight: Math.min(below, 380), transformOrigin: 'top left' }
        : { position: 'fixed', bottom: window.innerHeight - r.top + 4, top: 'auto', left, right: 'auto', maxHeight: Math.min(above, 380), transformOrigin: 'bottom left' },
    );
    return true;
  }, [width]);
  useLayoutEffect(() => {
    if (open && float) place();
  }, [open, float, place]);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => !ref.current?.contains(e.target as Node) && setOpen(false);
    // 页面滚动（包括图片、公式加载后浏览器自动调整的滚动）时跟着按钮移动，而不是直接关掉
    const follow = (e: Event) => {
      if (!float || ref.current?.contains(e.target as Node)) return;
      if (!place()) setOpen(false);
    };
    const resize = () => float && setOpen(false);
    document.addEventListener('mousedown', close);
    window.addEventListener('scroll', follow, true);
    window.addEventListener('resize', resize);
    return () => {
      document.removeEventListener('mousedown', close);
      window.removeEventListener('scroll', follow, true);
      window.removeEventListener('resize', resize);
    };
  }, [open, float, place]);
  return { open, setOpen, ref, style: float ? pos : undefined };
}

export function Switch({
  on,
  onChange,
  label,
  disabled,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      className={`switch ${on ? 'on' : ''}`}
      onClick={() => onChange(!on)}
    >
      <i />
    </button>
  );
}
