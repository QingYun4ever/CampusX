import '../pages/crystals.css';

/** 紫水晶图标：颜色写死，所有人看到的一样 */
export function CrystalIcon({ size = 16, className = '' }: { size?: number; className?: string }) {
  return (
    <svg className={`crystal-ico ${className}`} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2.5 19.5 9 12 21.5 4.5 9Z" fill="#7c3aed" />
      <path d="M12 2.5 4.5 9 12 21.5Z" fill="#a78bfa" />
      <path d="M12 2.5 9 9 12 21.5 15 9Z" fill="#c4b5fd" opacity=".85" />
      <path d="M4.5 9h15" stroke="#ede9fe" strokeWidth=".9" opacity=".7" />
    </svg>
  );
}

/** 「💎 30」这样的数量 */
export function CrystalAmount({ n, size = 15 }: { n: number; size?: number }) {
  return (
    <span className="crystal-amount">
      <CrystalIcon size={size} />
      {n.toLocaleString('zh-CN')}
    </span>
  );
}
