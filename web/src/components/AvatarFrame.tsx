import type { AvatarDecoration } from '../lib/api';

/**
 * 头像框的图形部分。坐标系：140×140，头像是圆心 (70,70)、半径 50 的圆，
 * 外框比头像大 40%（CSS 里 inset: -20%），所以装饰可以伸出头像外面。
 * back 画在头像后面（比如猫耳的下半截被头像挡住），front 画在上面。
 */
export const FRAMED: ReadonlySet<AvatarDecoration> = new Set(['prism', 'neon', 'stars', 'sakura', 'neko', 'snow']);

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

export function AvatarFrame({ kind }: { kind: AvatarDecoration }) {
  switch (kind) {
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
      // prism、neon 只用 CSS
      return null;
  }
}
