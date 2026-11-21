/**
 * 外观由三部分组成，互相独立：
 *  - 深浅色 mode：浅色 / 深色 / 跟随系统
 *  - 背景 bg：默认纯色，或者两种颜色的渐变（预设或自定义）。颜色会按深浅色自动调淡/调暗，保证文字可读
 *  - 强调色 accent：预设或自定义
 */
export type Mode = 'light' | 'dark' | 'system';
export interface Bg {
  id: string;
  c1: string;
  c2: string;
  angle: number;
}

export const BG_PRESETS: (Bg & { name: string })[] = [
  { id: 'none', name: '默认', c1: '', c2: '', angle: 160 },
  { id: 'navy', name: '夜蓝', c1: '#3d6e9e', c2: '#3d6e9e', angle: 160 },
  { id: 'dusk', name: '暮色', c1: '#e0876a', c2: '#7d66b0', angle: 160 },
  { id: 'mint', name: '薄荷', c1: '#3aa58e', c2: '#4a78b0', angle: 160 },
  { id: 'sakura', name: '樱粉', c1: '#e98aa8', c2: '#e8b46c', angle: 160 },
  { id: 'forest', name: '森林', c1: '#4c8a5a', c2: '#a89a4e', angle: 160 },
  { id: 'graphite', name: '石墨', c1: '#7b8794', c2: '#3e4a59', angle: 160 },
];

export const ACCENTS = [
  { id: 'blue', name: '蓝', color: '#1d9bf0' },
  { id: 'yellow', name: '黄', color: '#ffd400' },
  { id: 'pink', name: '粉', color: '#f91880' },
  { id: 'purple', name: '紫', color: '#7856ff' },
  { id: 'orange', name: '橙', color: '#ff7a00' },
  { id: 'green', name: '绿', color: '#00ba7c' },
] as const;

/** 背景颜色和底色混合的比例：深色模式下颜色更浓一点，浅色模式下更淡 */
export const BG_MIX = { dark: 0.3, light: 0.16 };
const BASE = { dark: '#000000', light: '#ffffff' };

const K = { mode: 'txq_mode', bg: 'txq_bg', accent: 'txq_accent', legacy: 'txq_theme' };

function read(k: string) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function write(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
}

const HEX = /^#[0-9a-f]{6}$/i;

/* ---------- 颜色工具 ---------- */
function rgb(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function mix(hex: string, base: string, p: number) {
  const a = rgb(hex);
  const b = rgb(base);
  return `#${a.map((v, i) => Math.round(v * p + b[i] * (1 - p)).toString(16).padStart(2, '0')).join('')}`;
}
/** 强调色上放白字还是黑字 */
export function onColor(hex: string) {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return L > 0.4 ? '#0f1419' : '#ffffff';
}

/* ---------- 读取设置 ---------- */
export function getMode(): Mode {
  const v = read(K.mode);
  if (v === 'light' || v === 'dark' || v === 'system') return v;
  // 兼容旧版本的 txq_theme（当时「暗蓝」算一种主题）
  const old = read(K.legacy);
  if (old === 'light') return 'light';
  if (old === 'dark' || old === 'dim') return 'dark';
  return 'system';
}

export function getBg(): Bg {
  try {
    const v = JSON.parse(read(K.bg) ?? 'null');
    if (v && typeof v.id === 'string' && (v.id === 'none' || (HEX.test(v.c1) && HEX.test(v.c2)))) {
      return { id: v.id, c1: v.c1, c2: v.c2, angle: Number(v.angle) || 0 };
    }
  } catch {
    /* ignore */
  }
  if (read(K.legacy) === 'dim') return BG_PRESETS.find((b) => b.id === 'navy')!;
  return BG_PRESETS[0];
}

/** 返回预设 id，或者自定义的 #rrggbb */
export function getAccent(): string {
  const v = read(K.accent) ?? '';
  if (ACCENTS.some((a) => a.id === v) || HEX.test(v)) return v;
  return 'blue';
}
export function accentColor(a = getAccent()) {
  return HEX.test(a) ? a : (ACCENTS.find((x) => x.id === a) ?? ACCENTS[0]).color;
}

const mq = window.matchMedia('(prefers-color-scheme: light)');
export function resolvedMode(m: Mode = getMode()): 'light' | 'dark' {
  return m === 'system' ? (mq.matches ? 'light' : 'dark') : m;
}

/** 某个背景在当前深浅色下的实际颜色（设置页的预览圆点也用它） */
export function bgColors(bg: Bg, mode = resolvedMode()) {
  if (bg.id === 'none') return null;
  return [mix(bg.c1, BASE[mode], BG_MIX[mode]), mix(bg.c2, BASE[mode], BG_MIX[mode])] as const;
}

/* ---------- 应用 ---------- */
export function applyTheme() {
  const mode = resolvedMode();
  const root = document.documentElement;
  root.dataset.theme = mode;
  const bg = getBg();
  const cols = bgColors(bg, mode);
  if (cols) {
    root.dataset.bg = '';
    root.style.setProperty('--g1', cols[0]);
    root.style.setProperty('--g2', cols[1]);
    root.style.setProperty('--g-angle', `${bg.angle}deg`);
  } else {
    delete root.dataset.bg;
  }
  const a = accentColor();
  root.style.setProperty('--accent', a);
  root.style.setProperty('--on-accent', onColor(a));
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', cols ? cols[0] : BASE[mode]);
}

type VT = { startViewTransition?: (cb: () => void) => { ready: Promise<void> } };

/** 切换外观：支持 View Transition 的浏览器从点击位置圆形展开 */
export function withThemeTransition(change: () => void, origin?: { x: number; y: number }) {
  const doc = document as Document & VT;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!doc.startViewTransition || reduce) return change();
  const x = origin?.x ?? window.innerWidth / 2;
  const y = origin?.y ?? 0;
  const r = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
  const vt = doc.startViewTransition(change);
  vt.ready
    .then(() => {
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
        { duration: 520, easing: 'cubic-bezier(.2,.8,.2,1)', pseudoElement: '::view-transition-new(root)' },
      );
    })
    .catch(() => {});
}

export function setMode(m: Mode, origin?: { x: number; y: number }) {
  write(K.mode, m);
  withThemeTransition(applyTheme, origin);
}
export function setBg(bg: Bg, animate = true) {
  write(K.bg, JSON.stringify(bg));
  if (animate) withThemeTransition(applyTheme);
  else applyTheme();
}
export function setAccent(a: string, animate = true) {
  write(K.accent, a);
  if (animate) withThemeTransition(applyTheme);
  else applyTheme();
}

/* ---------- 左侧栏收起 ---------- */
const NAV_KEY = 'txq_nav_collapsed';
export const getNavCollapsed = () => read(NAV_KEY) === '1';
export const setNavCollapsed = (v: boolean) => write(NAV_KEY, v ? '1' : '0');
/** 展开时的宽度，可以拖动侧栏边缘调整 */
export const NAV_W = { min: 220, max: 380, def: 275, snap: 150 };
export const getNavWidth = () => {
  const n = Number(read('txq_nav_w'));
  return n >= NAV_W.min && n <= NAV_W.max ? n : NAV_W.def;
};
export const setNavWidth = (n: number) => write('txq_nav_w', String(Math.round(n)));

mq.addEventListener('change', () => applyTheme());
