import type { CSSProperties } from 'react';
import './level.css';

/** 贴吧式牌子颜色：1–3 绿、4–9 蓝、10–15 黄、16–18 橙 */
export function tierOf(level: number) {
  return level >= 16 ? 'orange' : level >= 10 ? 'yellow' : level >= 4 ? 'blue' : 'green';
}

/**
 * 等级牌子。compact 只显示数字（时间线上用，不占地方）；否则「数字 | 头衔」两段。
 * board 用在提示文字里，说明这是哪个吧的等级。
 */
export function LevelBadge({
  level,
  title,
  compact = false,
  board,
  className = '',
}: {
  level: number;
  title: string;
  compact?: boolean;
  board?: string;
  className?: string;
}) {
  const label = `${board ? `${board}吧 ` : ''}${level} 级 · ${title}`;
  return (
    <span className={`lv lv-${tierOf(level)} ${compact ? 'compact' : ''} ${className}`} title={label} aria-label={label} role="img">
      <b>{level}</b>
      {!compact && <span>{title}</span>}
    </span>
  );
}

/** 经验条：当前等级起点到下一级门槛之间走了多少 */
export function LevelBar({ exp, from, to, level }: { exp: number; from: number; to: number | null; level: number }) {
  const pct = to === null ? 100 : Math.max(0, Math.min(100, ((exp - from) / (to - from)) * 100));
  return (
    <span className={`lv-bar lv-${tierOf(level)}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
      <i style={{ '--pct': `${pct}%` } as CSSProperties} />
    </span>
  );
}
