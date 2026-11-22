import { useState, type CSSProperties, type MouseEvent } from 'react';
import { Link } from 'react-router-dom';
import { Check, ChevronRight, Download, FileText, LogOut, Plus, Shield, Trash2 } from 'lucide-react';
import { TopBar } from '../components/ui';
import { useAuth, useMe } from '../lib/auth';
import { CURRENT } from '../lib/changelog';
import {
  ACCENTS,
  accentColor,
  BG_PRESETS,
  bgColors,
  getAccent,
  getBg,
  getCustomBgs,
  getMode,
  isCustomBg,
  MAX_CUSTOM_BGS,
  resolvedMode,
  saveCustomBgs,
  setAccent,
  setBg,
  setMode,
  type Bg,
  type Mode,
} from '../lib/theme';
import { AccountSecurity } from './AccountSecurity';
import { PushSettings, UpdateRow } from './AppSettings';

const MODES: { id: Mode; name: string }[] = [
  { id: 'light', name: '浅色' },
  { id: 'dark', name: '深色' },
  { id: 'system', name: '自动' },
];

const swatch = (bg: Bg, mode: 'light' | 'dark'): CSSProperties => {
  const c = bgColors(bg, mode);
  const base = mode === 'light' ? '#ffffff' : '#000000';
  return { background: c ? `linear-gradient(${bg.angle}deg, ${c[0]}, ${c[1]})` : base };
};

function Appearance() {
  const [mode, setM] = useState<Mode>(getMode());
  const [bg, setB] = useState<Bg>(getBg());
  const [accent, setA] = useState(getAccent());
  const [customs, setCustoms] = useState<Bg[]>(getCustomBgs);
  const custom = isCustomBg(bg);
  const [diy, setDiy] = useState(false);
  const look = resolvedMode(mode);
  const isPresetAccent = ACCENTS.some((a) => a.id === accent);

  const pickMode = (m: Mode, e: MouseEvent) => {
    setM(m);
    setMode(m, { x: e.clientX, y: e.clientY });
  };
  const pickBg = (b: Bg, animate = true) => {
    setB(b);
    setBg(b, animate);
  };
  const pickAccent = (a: string, animate = true) => {
    setA(a);
    setAccent(a, animate);
  };
  const storeCustoms = (list: Bg[]) => {
    setCustoms(list);
    saveCustomBgs(list);
  };
  /** 调色时同步更新列表里那一项 */
  const editBg = (next: Bg) => {
    pickBg(next, false);
    storeCustoms(customs.map((c) => (c.id === next.id ? next : c)));
  };
  const addBg = () => {
    // 从当前背景出发再调，比每次都从同一组颜色开始顺手
    const base = bg.id === 'none' ? { c1: '#6a8caf', c2: '#c3829e', angle: 160 } : bg;
    const next: Bg = { id: `custom-${Date.now().toString(36)}`, c1: base.c1, c2: base.c2, angle: base.angle };
    storeCustoms([...customs, next]);
    pickBg(next);
    setDiy(true);
  };
  const removeBg = () => {
    const rest = customs.filter((c) => c.id !== bg.id);
    storeCustoms(rest);
    setDiy(false);
    pickBg(BG_PRESETS[0]);
  };

  return (
    <>
      <section className="section">
        <h3>深浅色</h3>
        <div className="mode-row" role="radiogroup" aria-label="深浅色">
          {MODES.map((m) => (
            <button
              key={m.id}
              role="radio"
              aria-checked={mode === m.id}
              className={`mode-opt ${mode === m.id ? 'on' : ''}`}
              onClick={(e) => pickMode(m.id, e)}
            >
              <span className={`mode-dot ${m.id}`} />
              <span>{m.name}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="section">
        <h3>背景</h3>
        <p className="section-sub">渐变会按深浅色自动调淡或调暗，不影响文字阅读。</p>
        <div className="swatch-row" role="radiogroup" aria-label="背景">
          {BG_PRESETS.map((b) => (
            <button
              key={b.id}
              role="radio"
              aria-checked={bg.id === b.id}
              className={`swatch-opt ${bg.id === b.id ? 'on' : ''}`}
              onClick={() => {
                setDiy(false);
                pickBg(b);
              }}
            >
              <span className="swatch" style={swatch(b, look)}>
                <Check size={16} strokeWidth={3} />
              </span>
              <span>{b.name}</span>
            </button>
          ))}
          {customs.map((c, i) => {
            const on = bg.id === c.id;
            return (
              <button
                key={c.id}
                role="radio"
                aria-checked={on}
                className={`swatch-opt ${on ? 'on' : ''}`}
                title={on ? '再点一次调整颜色' : undefined}
                onClick={() => {
                  if (on) setDiy(!diy);
                  else {
                    setDiy(false);
                    pickBg(c);
                  }
                }}
              >
                <span className="swatch" style={swatch(c, look)}>
                  <Check size={16} strokeWidth={3} />
                </span>
                <span>自定义 {i + 1}</span>
              </button>
            );
          })}
          {customs.length < MAX_CUSTOM_BGS && (
            <button className="swatch-opt" onClick={addBg} aria-label="添加自定义背景">
              <span className="swatch add">
                <Plus size={20} strokeWidth={2.25} />
              </span>
              <span>添加</span>
            </button>
          )}
        </div>
        {diy && custom && (
          <div className="diy-panel">
            <div className="diy-preview" style={swatch(bg, look)} />
            <div className="diy-controls">
              <label className="color-field">
                <input type="color" value={bg.c1} onChange={(e) => editBg({ ...bg, c1: e.target.value })} />
                <span>起始色</span>
                <code>{bg.c1}</code>
              </label>
              <label className="color-field">
                <input type="color" value={bg.c2} onChange={(e) => editBg({ ...bg, c2: e.target.value })} />
                <span>结束色</span>
                <code>{bg.c2}</code>
              </label>
              <label className="range-field">
                <span>方向</span>
                <input
                  type="range"
                  min={0}
                  max={360}
                  step={5}
                  value={bg.angle}
                  onChange={(e) => editBg({ ...bg, angle: Number(e.target.value) })}
                />
                <code>{bg.angle}°</code>
              </label>
              <div className="diy-foot">
                <button className="btn btn-text danger sm" onClick={removeBg}>
                  <Trash2 size={15} />
                  删除这个背景
                </button>
                <button className="btn btn-outline sm" onClick={() => setDiy(false)}>
                  完成
                </button>
              </div>
            </div>
          </div>
        )}
        {custom && !diy && <p className="section-sub diy-tip">再点一次选中的自定义背景可以调整颜色。</p>}
      </section>

      <section className="section">
        <h3>强调色</h3>
        <div className="accent-row" role="radiogroup" aria-label="强调色">
          {ACCENTS.map((a) => (
            <button
              key={a.id}
              role="radio"
              aria-checked={accent === a.id}
              aria-label={a.name}
              className={`accent-dot ${accent === a.id ? 'on' : ''}`}
              style={{ background: a.color }}
              onClick={() => pickAccent(a.id)}
            >
              <Check size={20} strokeWidth={3} />
            </button>
          ))}
          <label
            className={`accent-dot custom ${!isPresetAccent ? 'on' : ''}`}
            style={!isPresetAccent ? { background: accentColor(accent) } : undefined}
            title="自定义颜色"
          >
            <input
              type="color"
              aria-label="自定义强调色"
              value={accentColor(accent)}
              onChange={(e) => pickAccent(e.target.value, false)}
            />
            {!isPresetAccent ? <Check size={20} strokeWidth={3} /> : <Plus size={20} strokeWidth={2.5} />}
          </label>
        </div>
      </section>
    </>
  );
}

export function Settings() {
  const me = useMe();
  const { signOut } = useAuth();
  return (
    <>
      <TopBar back title="设置" />
      <AccountSecurity />
      <Appearance />
      <PushSettings />

      {me.role === 'admin' && (
        <Link to="/admin" className="list-link">
          <Shield size={20} />
          <span className="grow">
            管理后台
            <span className="muted small">内容审核、邀请码、用户</span>
          </span>
          <ChevronRight size={18} className="muted" />
        </Link>
      )}

      <UpdateRow />
      <Link to="/terms" className="list-link">
        <FileText size={20} />
        <span className="grow">用户协议</span>
        <ChevronRight size={18} className="muted" />
      </Link>
      <Link to="/privacy" className="list-link">
        <Shield size={20} />
        <span className="grow">隐私政策</span>
        <ChevronRight size={18} className="muted" />
      </Link>
      <Link to="/install" className="list-link">
        <Download size={20} />
        <span className="grow">安装校墙</span>
        <ChevronRight size={18} className="muted" />
      </Link>

      <button className="list-link danger" onClick={signOut}>
        <LogOut size={20} />
        <span className="grow">
          退出登录
          <span className="muted small">
            {me.displayName} @{me.username}
          </span>
        </span>
      </button>

      <Link to="/changelog" className="version-link">
        校墙 v{CURRENT} · 更新日志
      </Link>
    </>
  );
}
