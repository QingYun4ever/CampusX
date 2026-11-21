/** 标志：一个圈，带一个小尾巴，像一个对话气泡。单色，跟随文字颜色。 */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden className="logo">
      <circle cx="16.5" cy="15" r="10" stroke="currentColor" strokeWidth="3" />
      <path d="M9.4 21.5 6 27.6l7.1-3.1" fill="currentColor" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="wordmark">
      <Logo size={26} />
      <span>同学圈</span>
    </span>
  );
}
