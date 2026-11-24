import { useId } from 'react';
import type { AvatarDecoration } from '../lib/api';

/**
 * 头像框的图形部分。坐标系：140×140，头像是圆心 (70,70)、半径 50 的圆，
 * 外框比头像大 40%（CSS 里 inset: -20%），所以装饰可以伸出头像外面。
 * back 画在头像后面（比如猫耳的下半截被头像挡住），front 画在上面。
 * 光环（halo、aurora、rose）没有图形，也走这里，是为了外层能用伪元素做动画。
 */
export const FRAMED: ReadonlySet<AvatarDecoration> = new Set([
  'halo', 'aurora', 'rose', 'prism', 'neon', 'stars', 'sakura', 'neko', 'snow',
  'maple', 'bubble', 'orbit', 'hearts', 'flame', 'thunder', 'crown',
]);

const reducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const star = 'M0 -1 Q0 0 1 0 Q0 0 0 1 Q0 0 -1 0 Q0 0 0 -1Z';
const petal = 'M0 0 C-7 -5 -8 -15 -3.2 -20 L0 -17 L3.2 -20 C8 -15 7 -5 0 0Z';

function Flower({ x, y, s, r = 0 }: { x: number; y: number; s: number; r?: number }) {
  return (
    <g transform={`translate(${x} ${y}) rotate(${r}) scale(${s})`}>
      {[0, 72, 144, 216, 288].map((a) => (
        <path key={a} d={petal} transform={`rotate(${a})`} fill="#ffc2d6" stroke="#ff8fb1" strokeWidth="1.2" />
      ))}
      <circle r="3.4" fill="#ffd166" />
    </g>
  );
}

const maple = 'M0 -12 L2 -7 L5 -9 L4.5 -4 L9 -6 L8 -2 L12 -1 L7 3 L8 5 L2 4 L1 7 L-1 7 L-2 4 L-8 5 L-7 3 L-12 -1 L-8 -2 L-9 -6 L-4.5 -4 L-5 -9 L-2 -7Z';

function Leaf({ x, y, s, r = 0, fill = '#ff6a3d' }: { x: number; y: number; s: number; r?: number; fill?: string }) {
  return (
    <g transform={`translate(${x} ${y}) rotate(${r}) scale(${s})`}>
      <path d={maple} fill={fill} stroke="#d9481f" strokeWidth="0.8" strokeLinejoin="round" />
      <path d="M0 11 L0 -8 M0 2 L-8 -3 M0 2 L8 -3" fill="none" stroke="#b83a14" strokeWidth="0.8" strokeLinecap="round" opacity="0.7" />
    </g>
  );
}

const heart = 'M0 5 C-7 0 -9 -5 -5.6 -8.4 C-3.4 -10.4 -1 -9.4 0 -7.2 C1 -9.4 3.4 -10.4 5.6 -8.4 C9 -5 7 0 0 5Z';
const bolt = 'M3 -15 L-5 1 L0 1 L-3 15 L7 -3 L2 -3 L6 -15Z';

function Flake({ x, y, r, cls }: { x: number; y: number; r: number; cls?: string }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <g className={cls}>
        {[0, 60, 120, 180, 240, 300].map((a) => (
          <g key={a} transform={`rotate(${a})`}>
            <line y2={-r} />
            <polyline points={`${-r * 0.28},${-r * 0.78} 0,${-r * 0.52} ${r * 0.28},${-r * 0.78}`} />
          </g>
        ))}
      </g>
    </g>
  );
}

/** live：大头像，播放动画（星轨用 SVG 自带的动画，要在这里判断） */
export function AvatarFrame({ kind, live = false }: { kind: AvatarDecoration; live?: boolean }) {
  const id = useId().replace(/:/g, '');
  switch (kind) {
    case 'maple':
      return (
        <svg className="avatar-frame front" viewBox="0 0 140 140" aria-hidden>
          <Leaf x={30} y={108} s={1.45} r={-28} />
          <Leaf x={112} y={29} s={1.05} r={24} fill="#ffa23a" />
          <g className="petal-fall">
            <Leaf x={124} y={92} s={0.7} r={130} fill="#ff8a3d" />
          </g>
        </svg>
      );
    case 'bubble':
      return (
        <svg className="avatar-frame front" viewBox="0 0 140 140" aria-hidden>
          {[
            [120, 100, 7, 0],
            [128, 70, 4.5, 1.2],
            [112, 34, 5.5, 2.3],
            [22, 96, 4, 0.7],
            [16, 60, 6, 1.8],
          ].map(([x, y, r, d]) => (
            <g key={`${x}-${y}`} transform={`translate(${x} ${y})`}>
              <g className="rise" style={{ animationDelay: `${d}s` }}>
                <circle r={r} fill="rgba(127,214,255,.22)" stroke="#5cc8f5" strokeWidth="1.3" />
                <path d={`M${-r * 0.55} ${-r * 0.1} A${r * 0.6} ${r * 0.6} 0 0 1 ${-r * 0.05} ${-r * 0.6}`} fill="none" stroke="#fff" strokeWidth="1.2" strokeLinecap="round" />
              </g>
            </g>
          ))}
        </svg>
      );
    case 'orbit': {
      // 椭圆轨道：上半圈在头像后面，下半圈在前面；行星转到后面时变小、被挡住
      const still = !live || reducedMotion();
      const ring = { fill: 'none', stroke: '#9a8cff', strokeWidth: 1.6 } as const;
      return (
        <>
          <svg className="avatar-frame back" viewBox="0 0 140 140" aria-hidden>
            <g transform="rotate(-20 70 70)">
              <path d="M6 70 A64 18 0 0 1 134 70" {...ring} opacity="0.55" />
            </g>
          </svg>
          <svg className="avatar-frame front" viewBox="0 0 140 140" aria-hidden>
            <g transform="rotate(-20 70 70)">
              <path d="M134 70 A64 18 0 0 1 6 70" {...ring} />
              {still ? (
                <circle cx="119" cy="81.5" r="5.5" fill="#ffcf5c" stroke="#fff4cc" strokeWidth="1" />
              ) : (
                <circle r="5.5" fill="#ffcf5c" stroke="#fff4cc" strokeWidth="1">
                  <animateMotion dur="7s" repeatCount="indefinite" path="M134 70 A64 18 0 0 1 6 70 A64 18 0 0 1 134 70" />
                  <animate attributeName="opacity" dur="7s" repeatCount="indefinite" keyTimes="0;0.5;0.54;0.96;1" values="1;1;0;0;1" />
                  <animate attributeName="r" dur="7s" repeatCount="indefinite" keyTimes="0;0.25;0.5;0.75;1" values="5.5;6.5;5;4;5.5" />
                </circle>
              )}
            </g>
            <g fill="#c9c0ff" stroke="#fff" strokeWidth="0.4">
              <g transform="translate(118 26)"><g className="twinkle"><path d={star} transform="scale(5)" /></g></g>
              <g transform="translate(24 118)"><g className="twinkle" style={{ animationDelay: '1.2s' }}><path d={star} transform="scale(3.5)" /></g></g>
            </g>
          </svg>
        </>
      );
    }
    case 'hearts':
      return (
        <svg className="avatar-frame front" viewBox="0 0 140 140" aria-hidden>
          {[
            [114, 110, 1.25, 0, '#ff4f8b'],
            [127, 80, 0.8, 1.4, '#ff7aa8'],
            [26, 112, 0.85, 0.7, '#ff7aa8'],
            [14, 74, 0.6, 2.1, '#ff4f8b'],
          ].map(([x, y, sc, d, c]) => (
            <g key={`${x}`} transform={`translate(${x} ${y})`}>
              <g className="rise" style={{ animationDelay: `${d}s` }}>
                <path d={heart} transform={`scale(${sc})`} fill={c as string} stroke="#fff" strokeWidth="0.8" />
              </g>
            </g>
          ))}
        </svg>
      );
    case 'flame': {
      // 火苗画在头像后面，只露出外面那截：从两侧往上烧，越往上越高，方向往上偏
      const flames = Array.from({ length: 11 }, (_, i) => {
        const a = 160 + (i * 220) / 10; // 160°（左下）经过顶上到 380°（右下）
        const rad = (a * Math.PI) / 180;
        const up = Math.max(0, -Math.sin(rad));
        return {
          a,
          x: 70 + 46 * Math.cos(rad),
          y: 70 + 46 * Math.sin(rad),
          rot: (a + 90 > 180 ? a + 90 - 360 : a + 90) * 0.55,
          s: 0.5 + 0.75 * up,
          d: (i * 0.37) % 1.3,
        };
      });
      return (
        <svg className="avatar-frame back" viewBox="0 0 140 140" aria-hidden>
          {flames.map((f) => (
            <g key={f.a} transform={`translate(${f.x.toFixed(1)} ${f.y.toFixed(1)}) rotate(${f.rot.toFixed(1)}) scale(${f.s.toFixed(2)})`}>
              <g className="flicker" style={{ animationDelay: `${f.d.toFixed(2)}s` }}>
                <path d="M0 3 C-8 1 -9 -9 0 -22 C9 -9 8 1 0 3Z" fill="#ff5a1f" />
                <path d="M0 2 C-4.5 1 -5 -6 0 -13 C5 -6 4.5 1 0 2Z" fill="#ffd23f" />
              </g>
            </g>
          ))}
        </svg>
      );
    }
    case 'thunder':
      return (
        <svg className="avatar-frame front" viewBox="0 0 140 140" aria-hidden>
          <g className="bolt-glow" fill="#8f8cff" stroke="#fff" strokeWidth="1" strokeLinejoin="round">
            <g transform="translate(115 25) rotate(18) scale(1.3)"><g className="zap"><path d={bolt} /></g></g>
            <g transform="translate(24 113) rotate(200) scale(1)"><g className="zap late"><path d={bolt} /></g></g>
            <g transform="translate(129 88) rotate(-20) scale(0.65)"><g className="zap later"><path d={bolt} /></g></g>
          </g>
        </svg>
      );
    case 'crown':
      return (
        <svg className="avatar-frame front" viewBox="0 0 140 140" aria-hidden>
          <defs>
            <clipPath id={`crown-${id}`}>
              <path d="M-19 9 L-22 -9 L-10 1 L0 -14 L10 1 L22 -9 L19 9 Z M-19 6 H19 V12 H-19Z" />
            </clipPath>
          </defs>
          <g transform="translate(50 15) rotate(-16) scale(1.15)">
            <path d="M-19 9 L-22 -9 L-10 1 L0 -14 L10 1 L22 -9 L19 9 Z" fill="#ffd34d" stroke="#d99a00" strokeWidth="1.6" strokeLinejoin="round" />
            <rect x="-19.5" y="6" width="39" height="6.5" rx="2" fill="#f5b400" stroke="#d99a00" strokeWidth="1.3" />
            <circle cy="-14" r="2.6" fill="#ff5c8a" stroke="#fff" strokeWidth="0.8" />
            <circle cx="-22" cy="-9" r="2.1" fill="#4fc3f7" stroke="#fff" strokeWidth="0.8" />
            <circle cx="22" cy="-9" r="2.1" fill="#4fc3f7" stroke="#fff" strokeWidth="0.8" />
            <circle cy="9.2" r="2.2" fill="#ff5c8a" />
            <g clipPath={`url(#crown-${id})`}>
              <g className="shine">
                <rect x="-6" y="-20" width="7" height="40" fill="#fff" opacity="0.75" transform="skewX(-20)" />
              </g>
            </g>
          </g>
          <g fill="#ffc83d" stroke="#fff3c4" strokeWidth="0.6">
            <g transform="translate(86 10)"><g className="twinkle"><path d={star} transform="scale(7)" /></g></g>
            <g transform="translate(16 48)"><g className="twinkle" style={{ animationDelay: '1.1s' }}><path d={star} transform="scale(5)" /></g></g>
            <g transform="translate(124 104)"><g className="twinkle" style={{ animationDelay: '0.5s' }}><path d={star} transform="scale(3.5)" /></g></g>
          </g>
        </svg>
      );
    case 'stars':
      return (
        <svg className="avatar-frame front" viewBox="0 0 140 140" aria-hidden>
          <g fill="#ffc83d" stroke="#fff3c4" strokeWidth="0.6">
            {[
              [108, 28, 14, 0],
              [27, 110, 10, 0.6],
              [124, 86, 6.5, 1.1],
              [20, 44, 5, 1.6],
              [98, 126, 4.5, 2.1],
            ].map(([x, y, s, d]) => (
              <g key={`${x}`} transform={`translate(${x} ${y})`}>
                <g className="twinkle" style={{ animationDelay: `${d}s` }}>
                  <path d={star} transform={`scale(${s})`} />
                </g>
              </g>
            ))}
          </g>
        </svg>
      );
    case 'sakura':
      return (
        <svg className="avatar-frame front" viewBox="0 0 140 140" aria-hidden>
          <Flower x={30} y={110} s={0.95} r={-12} />
          <Flower x={112} y={28} s={0.62} r={20} />
          <g className="petal-fall">
            <path d={petal} transform="translate(124 96) rotate(130) scale(.5)" fill="#ffc2d6" stroke="#ff8fb1" />
          </g>
          <g className="petal-fall late">
            <path d={petal} transform="translate(16 58) rotate(-40) scale(.42)" fill="#ffc2d6" stroke="#ff8fb1" />
          </g>
        </svg>
      );
    case 'neko':
      return (
        <svg className="avatar-frame back" viewBox="0 0 140 140" aria-hidden>
          <g strokeLinejoin="round">
            <g className="ear left">
              <path d="M27 58 L30 10 L66 30Z" fill="#f4a259" stroke="#f4a259" strokeWidth="8" />
              <path d="M36 46 L37 24 L56 35Z" fill="#ffb8c9" stroke="#ffb8c9" strokeWidth="4" />
            </g>
            <g className="ear right">
              <path d="M113 58 L110 10 L74 30Z" fill="#f4a259" stroke="#f4a259" strokeWidth="8" />
              <path d="M104 46 L103 24 L84 35Z" fill="#ffb8c9" stroke="#ffb8c9" strokeWidth="4" />
            </g>
          </g>
        </svg>
      );
    case 'snow':
      return (
        <svg className="avatar-frame front" viewBox="0 0 140 140" aria-hidden>
          <g fill="none" stroke="#5fb4f0" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <Flake x={110} y={30} r={13} cls="spin" />
            <Flake x={27} y={108} r={9} cls="spin rev" />
            <Flake x={123} y={86} r={5.5} />
            <Flake x={20} y={44} r={4.5} />
          </g>
        </svg>
      );
    default:
      // 光环、prism、neon 只用 CSS
      return null;
  }
}
