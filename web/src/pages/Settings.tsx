import { useState, type CSSProperties, type MouseEvent } from 'react';
import { Link } from 'react-router-dom';
import { Check, ChevronRight, LogOut, Palette, Plus, Shield } from 'lucide-react';
import { Field, toast, TopBar } from '../components/ui';
import { api, setToken } from '../lib/api';
import { useAuth, useMe } from '../lib/auth';
import { CURRENT } from '../lib/changelog';
import {
  ACCENTS,
  accentColor,
  BG_PRESETS,
  bgColors,
  getAccent,
  getBg,
  getMode,
  resolvedMode,
  setAccent,
  setBg,
  setMode,
  type Bg,
  type Mode,
} from '../lib/theme';

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
  const custom = bg.id === 'custom';
  const [diy, setDiy] = useState(custom);
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
  const customBg: Bg = custom ? bg : { id: 'custom', c1: '#6a8caf', c2: '#c3829e', angle: 160 };

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
          <button
            role="radio"
            aria-checked={custom}
            className={`swatch-opt ${custom ? 'on' : ''}`}
            onClick={() => {
              setDiy(true);
              if (!custom) pickBg(customBg);
            }}
          >
            <span className="swatch diy" style={custom ? swatch(bg, look) : undefined}>
              {custom ? <Check size={16} strokeWidth={3} /> : <Palette size={18} />}
            </span>
            <span>自定义</span>
          </button>
        </div>
        {diy && custom && (
          <div className="diy-panel">
            <div className="diy-preview" style={swatch(bg, look)} />
            <div className="diy-controls">
              <label className="color-field">
                <input type="color" value={bg.c1} onChange={(e) => pickBg({ ...bg, c1: e.target.value }, false)} />
                <span>起始色</span>
                <code>{bg.c1}</code>
              </label>
              <label className="color-field">
                <input type="color" value={bg.c2} onChange={(e) => pickBg({ ...bg, c2: e.target.value }, false)} />
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
                  onChange={(e) => pickBg({ ...bg, angle: Number(e.target.value) }, false)}
                />
                <code>{bg.angle}°</code>
              </label>
            </div>
          </div>
        )}
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
  const [pw, setPw] = useState({ oldPassword: '', newPassword: '', confirm: '' });
  const [busy, setBusy] = useState(false);

  const mismatch = pw.confirm && pw.newPassword !== pw.confirm ? '两次输入的新密码不一样' : '';
  const changePw = async () => {
    if (pw.newPassword.length < 8) return toast('新密码至少 8 位', 'error');
    if (mismatch) return;
    setBusy(true);
    try {
      const r = await api<{ token: string | null }>('/me/password', {
        body: { oldPassword: pw.oldPassword, newPassword: pw.newPassword },
      });
      if (r.token) setToken(r.token);
      setPw({ oldPassword: '', newPassword: '', confirm: '' });
      toast('密码已修改，其他设备需要重新登录');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <TopBar back title="设置" />
      <Appearance />

      <section className="section">
        <h3>修改密码</h3>
        <Field
          label="当前密码"
          type="password"
          value={pw.oldPassword}
          onChange={(v) => setPw({ ...pw, oldPassword: v })}
          autoComplete="current-password"
        />
        <div className="row">
          <Field
            label="新密码"
            type="password"
            value={pw.newPassword}
            onChange={(v) => setPw({ ...pw, newPassword: v })}
            autoComplete="new-password"
            hint="至少 8 位"
          />
          <Field
            label="确认新密码"
            type="password"
            value={pw.confirm}
            onChange={(v) => setPw({ ...pw, confirm: v })}
            autoComplete="new-password"
            error={mismatch}
          />
        </div>
        <div>
          <button
            className="btn btn-primary"
            disabled={busy || !pw.oldPassword || !pw.newPassword || !!mismatch}
            onClick={changePw}
          >
            修改密码
          </button>
        </div>
      </section>

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
