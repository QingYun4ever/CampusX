import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronDown, RotateCw, Server } from 'lucide-react';
import { Logo } from '../components/Logo';
import { Avatar, Field, Modal } from '../components/ui';
import { ALLOWS_HTTP_SERVER, API_BASE, api, IS_APP_BUILD, probeServer, setAppServerAddress, type User } from '../lib/api';
import { useAuth } from '../lib/auth';
import { getMode, setMode, type Mode } from '../lib/theme';

/* ---------------- 验证码 ---------------- */
function useCaptcha(enabled: boolean) {
  const [cap, setCap] = useState<{ id: string; src: string } | null>(null);
  const [err, setErr] = useState('');
  const [spin, setSpin] = useState(0);
  const refresh = useCallback(async () => {
    setSpin((n) => n + 1);
    setErr('');
    try {
      const r = await api<{ id: string; svg: string }>('/captcha');
      if (typeof r?.id !== 'string' || typeof r.svg !== 'string') throw new Error('验证码加载失败');
      setCap({ id: r.id, src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(r.svg)}` });
    } catch (e) {
      // 不能只留一块空白：把原因告诉用户，点图片可以重试
      setCap(null);
      setErr(e instanceof Error ? e.message : '验证码加载失败');
    }
  }, []);
  useEffect(() => {
    if (!enabled) return;
    refresh();
    // 验证码 5 分钟过期，定期换新
    const t = setInterval(refresh, 4 * 60_000);
    return () => clearInterval(t);
  }, [enabled, refresh]);
  return { cap, err, refresh, spin };
}

function Captcha({
  value,
  onChange,
  error,
  c,
}: {
  value: string;
  onChange: (v: string) => void;
  error?: string;
  c: ReturnType<typeof useCaptcha>;
}) {
  return (
    <div className="captcha">
      <Field
        variant="outlined"
        label="验证码"
        value={value}
        onChange={onChange}
        error={error || c.err}
        maxLength={6}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
      />
      <button type="button" className="captcha-img" onClick={c.refresh} aria-label="换一张验证码" title="看不清？换一张">
        {c.cap ? <img src={c.cap.src} alt="验证码图片" /> : c.err ? <span className="captcha-fail">点击重试</span> : <span className="captcha-ph" />}
        <span className="captcha-refresh">
          <RotateCw size={14} style={{ transform: `rotate(${c.spin * 360}deg)` }} />
        </span>
      </button>
    </div>
  );
}

/* ---------------- 布局 ---------------- */

/** 高度跟随内容平滑变化 */
function AutoHeight({ children }: { children: ReactNode }) {
  const inner = useRef<HTMLDivElement>(null);
  const [h, setH] = useState<number>();
  useLayoutEffect(() => {
    const el = inner.current!;
    const ro = new ResizeObserver(() => setH(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div className="auto-h" style={{ height: h }}>
      <div ref={inner}>{children}</div>
    </div>
  );
}

function ThemeSelect() {
  const [t, setT] = useState<Mode>(getMode());
  return (
    <label className="auth-select">
      <select
        value={t}
        onChange={(e) => {
          const v = e.target.value as Mode;
          setT(v);
          setMode(v);
        }}
        aria-label="外观"
      >
        <option value="system">外观：跟随系统</option>
        <option value="light">外观：浅色</option>
        <option value="dark">外观：深色</option>
      </select>
      <ChevronDown size={16} />
    </label>
  );
}

function AuthShell({
  busy,
  step,
  dir,
  title,
  subtitle,
  aside,
  children,
  left,
  right,
  onSubmit,
}: {
  busy: boolean;
  step: string;
  dir: 'fwd' | 'back';
  title: ReactNode;
  subtitle?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  left?: ReactNode;
  right: ReactNode;
  onSubmit: (e: FormEvent) => void;
}) {
  return (
    <div className="auth-page">
      <main className={`auth-card ${busy ? 'busy' : ''}`}>
        <div className="auth-progress" aria-hidden />
        <form className="auth-grid" onSubmit={onSubmit} noValidate>
          <div className="auth-intro">
            <Logo size={40} />
            <div key={step} className={`step-anim ${dir}`}>
              <h1>{title}</h1>
              {subtitle && <p>{subtitle}</p>}
              {aside}
            </div>
          </div>
          <div className="auth-form">
            <AutoHeight>
              <div key={step} className={`step-anim ${dir} auth-fields`}>
                {children}
              </div>
            </AutoHeight>
            <div className="auth-actions">
              <div>{left}</div>
              {right}
            </div>
          </div>
        </form>
      </main>
      <footer className="auth-foot">
        <ThemeSelect />
        <span>校墙 · 仅限受邀同学</span>
      </footer>
    </div>
  );
}

function UserChip({ username, onClick }: { username: string; onClick: () => void }) {
  return (
    <button type="button" className="user-chip" onClick={onClick} aria-label={`@${username}，点击更换账号`}>
      <Avatar name={username} size={22} />
      <span>@{username}</span>
      <ChevronDown size={16} />
    </button>
  );
}

function ShowPassword({ on, set }: { on: boolean; set: (v: boolean) => void }) {
  return (
    <label className="check">
      <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} />
      <span className="box" />
      显示密码
    </label>
  );
}

const nextBtn = (label: string, busy: boolean) => (
  <button className="btn btn-primary auth-btn" disabled={busy}>
    {label}
  </button>
);

/* ---------------- 登录 ---------------- */

function ServerAddressModal({ onClose }: { onClose: () => void }) {
  const [address, setAddress] = useState(API_BASE);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    // 弹窗用 portal 渲染，提交事件不能传到外层登录表单。
    event.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      const origin = await probeServer(address);
      if (setAppServerAddress(origin)) window.location.reload();
      else onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="服务器地址"
      onClose={onClose}
      right={<button className="btn btn-light" type="submit" form="server-address" disabled={busy}>{busy ? '连接中…' : '保存'}</button>}
    >
      <form id="server-address" className="modal-body" onSubmit={save} noValidate>
        <Field
          label="服务器地址"
          value={address}
          onChange={(value) => { setAddress(value); setError(''); }}
          error={error}
          inputMode="url"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="https://forum.example.com"
          hint={ALLOWS_HTTP_SERVER ? '调试版允许 HTTP。' : '正式服务器须使用 HTTPS。'}
        />
      </form>
    </Modal>
  );
}

export function Login() {
  const { signIn } = useAuth();
  const nav = useNavigate();
  const [step, setStep] = useState<'user' | 'pass' | 'factor'>('user');
  const [dir, setDir] = useState<'fwd' | 'back'>('fwd');
  const [f, setF] = useState({ username: '', password: '', captchaText: '' });
  const [challenge, setChallenge] = useState('');
  const [factor, setFactor] = useState('');
  const [err, setErr] = useState<{ field?: string; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [server, setServer] = useState(false);
  const c = useCaptcha(step === 'pass');

  const go = (s: typeof step, d: typeof dir) => {
    setErr(null);
    if (s !== 'factor') {
      setChallenge('');
      setFactor('');
    }
    setDir(d);
    setStep(s);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (step === 'user') {
      if (IS_APP_BUILD && !API_BASE) return setServer(true);
      if (!f.username.trim()) return setErr({ field: 'username', msg: '请输入用户名' });
      return go('pass', 'fwd');
    }
    if (step === 'pass') {
      if (!f.password) return setErr({ field: 'password', msg: '请输入密码' });
      if (!f.captchaText) return setErr({ field: 'captcha', msg: '请输入验证码' });
    } else if (!factor.trim()) {
      return setErr({ field: 'factor', msg: '请输入验证器验证码或恢复码' });
    }
    setBusy(true);
    try {
      type Session = { token: string; user: User };
      type NeedsFactor = { twoFactorRequired: true; challenge: string };
      const r = step === 'factor'
        ? await api<Session>('/auth/login/2fa', { body: { challenge, code: factor.trim() } })
        : await api<Session | NeedsFactor>('/auth/login', {
            body: { ...f, username: f.username.trim(), captchaId: c.cap?.id },
          });
      if ('twoFactorRequired' in r) {
        setChallenge(r.challenge);
        setF((x) => ({ ...x, password: '', captchaText: '' }));
        go('factor', 'fwd');
        return;
      }
      signIn(r.token, r.user);
      nav('/', { replace: true });
    } catch (e) {
      const msg = (e as Error).message;
      if (step === 'factor') {
        setErr({ field: 'factor', msg });
        setFactor('');
      } else {
        setErr({ field: msg.includes('验证码') ? 'captcha' : 'password', msg });
        setF((x) => ({ ...x, captchaText: '' }));
        c.refresh();
      }
    } finally {
      setBusy(false);
    }
  };

  const fe = (k: string) => (err?.field === k ? err.msg : undefined);

  if (step === 'factor') return (
    <AuthShell
      busy={busy}
      step={step}
      dir={dir}
      title="两步验证"
      subtitle="输入验证器里的验证码，或使用一个未用过的恢复码。"
      onSubmit={submit}
      left={<button type="button" className="btn btn-text" disabled={busy} onClick={() => go('pass', 'back')}>返回密码</button>}
      right={nextBtn(busy ? '正在验证' : '验证', busy)}
    >
      <Field
        variant="outlined"
        label="验证器验证码或恢复码"
        value={factor}
        onChange={setFactor}
        error={fe('factor')}
        autoComplete="one-time-code"
        autoCapitalize="off"
        spellCheck={false}
        autoFocus
      />
    </AuthShell>
  );

  return step === 'user' ? (
    <AuthShell
      busy={busy}
      step={step}
      dir={dir}
      title="登录"
      aside={IS_APP_BUILD && (
        <button type="button" className="btn btn-text" onClick={() => setServer(true)}>
          <Server size={16} /> 服务器地址
        </button>
      )}
      subtitle="使用你的校墙账号"
      onSubmit={submit}
      left={
        IS_APP_BUILD && !API_BASE ? (
          <button type="button" className="btn btn-text" onClick={() => setServer(true)}>创建账号</button>
        ) : <Link to="/register" className="btn btn-text">创建账号</Link>
      }
      right={nextBtn('下一步', busy)}
    >
      <Field
        variant="outlined"
        label="用户名"
        value={f.username}
        onChange={(v) => setF({ ...f, username: v })}
        error={fe('username')}
        autoComplete="username"
        autoCapitalize="off"
        spellCheck={false}
        autoFocus
      />
      <p className="auth-note">还没有账号？校墙只能凭邀请码注册，可以向班长或管理员要一个。</p>
      {server && <ServerAddressModal onClose={() => setServer(false)} />}
    </AuthShell>
  ) : (
    <AuthShell
      busy={busy}
      step={step}
      dir={dir}
      title="欢迎回来"
      aside={<UserChip username={f.username.trim()} onClick={() => go('user', 'back')} />}
      onSubmit={submit}
      left={
        <button type="button" className="btn btn-text" onClick={() => setForgot((v) => !v)}>
          忘记了密码？
        </button>
      }
      right={nextBtn(busy ? '正在登录' : '登录', busy)}
    >
      {/* 让浏览器的密码管理器能对上用户名 */}
      <input type="text" name="username" autoComplete="username" value={f.username} readOnly hidden />
      <Field
        variant="outlined"
        label="输入你的密码"
        type={show ? 'text' : 'password'}
        value={f.password}
        onChange={(v) => setF({ ...f, password: v })}
        error={fe('password')}
        autoComplete="current-password"
        autoFocus
      />
      <ShowPassword on={show} set={setShow} />
      <Captcha value={f.captchaText} onChange={(v) => setF({ ...f, captchaText: v })} error={fe('captcha')} c={c} />
      <div className={`reveal ${forgot ? 'open' : ''}`}>
        <div>
          <p className="auth-note">
            密码只能由管理员重置。联系管理员，他们会在后台给你一个临时密码，登录后记得在「设置」里改掉。
          </p>
        </div>
      </div>
    </AuthShell>
  );
}

/* ---------------- 注册（分步） ---------------- */

const STEPS = ['invite', 'name', 'username', 'password', 'verify'] as const;
type Step = (typeof STEPS)[number];

function formatCode(v: string) {
  const s = v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  return s.length > 4 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}

function strength(pw: string) {
  if (pw.length < 8) return 0;
  let n = 1;
  if (pw.length >= 12) n++;
  if (/[a-z]/.test(pw) && /[A-Z0-9]/.test(pw) && /[^A-Za-z]/.test(pw)) n++;
  return n;
}

export function Register() {
  const { signIn } = useAuth();
  const nav = useNavigate();
  const [step, setStep] = useState<Step>('invite');
  const [dir, setDir] = useState<'fwd' | 'back'>('fwd');
  const [f, setF] = useState({
    inviteCode: formatCode(new URLSearchParams(window.location.search).get('invite') ?? ''),
    displayName: '',
    className: '',
    username: '',
    password: '',
    password2: '',
    captchaText: '',
  });
  const [note, setNote] = useState('');
  const [err, setErr] = useState<{ field: string; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);
  const c = useCaptcha(step === 'verify');
  const set = (k: keyof typeof f) => (v: string) => {
    setF((x) => ({ ...x, [k]: v }));
    if (err?.field === k) setErr(null);
  };
  const idx = STEPS.indexOf(step);

  const go = (s: Step) => {
    setDir(STEPS.indexOf(s) > idx ? 'fwd' : 'back');
    setStep(s);
  };
  const fail = (field: string, msg: string) => setErr({ field, msg });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      switch (step) {
        case 'invite': {
          if (f.inviteCode.replace('-', '').length < 8) return fail('inviteCode', '邀请码是 8 位');
          const r = await api<{ note: string }>('/auth/invite/check', { body: { inviteCode: f.inviteCode } });
          setNote(r.note);
          return go('name');
        }
        case 'name':
          if (!f.displayName.trim()) return fail('displayName', '请填写昵称');
          return go('username');
        case 'username':
          if (!/^[A-Za-z0-9_]{3,20}$/.test(f.username)) return fail('username', '用户名要 3–20 位，只能用字母、数字和下划线');
          await api('/auth/username/check', { body: { username: f.username } });
          return go('password');
        case 'password':
          if (f.password.length < 8) return fail('password', '密码至少 8 位');
          if (f.password !== f.password2) return fail('password2', '两次输入的密码不一样');
          return go('verify');
        case 'verify': {
          if (!f.captchaText) return fail('captchaText', '请输入验证码');
          const { password2: _, ...body } = f;
          const r = await api<{ token: string; user: User }>('/auth/register', {
            body: { ...body, captchaId: c.cap?.id },
          });
          signIn(r.token, r.user);
          nav('/', { replace: true });
          return;
        }
      }
    } catch (e) {
      const msg = (e as Error).message;
      // 最后一步提交失败时，跳回出问题的那一步
      const back: [string, Step, keyof typeof f][] = [
        ['邀请码', 'invite', 'inviteCode'],
        ['用户名', 'username', 'username'],
        ['昵称', 'name', 'displayName'],
        ['班级', 'name', 'className'],
        ['密码', 'password', 'password'],
      ];
      const hit = back.find(([k]) => msg.includes(k));
      if (hit && hit[1] !== step) go(hit[1]);
      fail(hit ? hit[2] : step === 'verify' ? 'captchaText' : STEP_FIELD[step], msg);
      if (step === 'verify') {
        setF((x) => ({ ...x, captchaText: '' }));
        c.refresh();
      }
    } finally {
      setBusy(false);
    }
  };

  const fe = (k: string) => (err?.field === k ? err.msg : undefined);
  const back =
    idx === 0 ? (
      <Link to="/login" className="btn btn-text">
        登录已有账号
      </Link>
    ) : (
      <button type="button" className="btn btn-text" onClick={() => go(STEPS[idx - 1])}>
        上一步
      </button>
    );
  const progress = (
    <div className="steps" aria-label={`第 ${idx + 1} 步，共 ${STEPS.length} 步`}>
      {STEPS.map((s, i) => (
        <i key={s} className={i <= idx ? 'on' : ''} />
      ))}
    </div>
  );

  const common = { busy, step, dir, onSubmit: submit, left: back };

  switch (step) {
    case 'invite':
      return (
        <AuthShell
          {...common}
          title="创建账号"
          subtitle="校墙只对受邀的同学开放。输入你收到的邀请码。"
          aside={progress}
          right={nextBtn('下一步', busy)}
        >
          <Field
            variant="outlined"
            label="邀请码"
            value={f.inviteCode}
            onChange={(v) => set('inviteCode')(formatCode(v))}
            error={fe('inviteCode')}
            hint="格式像 ABCD-2345，不区分大小写"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            className="mono"
            autoFocus
          />
        </AuthShell>
      );
    case 'name':
      return (
        <AuthShell
          {...common}
          title="你的名字"
          subtitle={note ? `邀请来自：${note}` : '同学们会在帖子和主页上看到这个名字。'}
          aside={progress}
          right={nextBtn('下一步', busy)}
        >
          <Field
            variant="outlined"
            label="昵称"
            value={f.displayName}
            onChange={set('displayName')}
            error={fe('displayName')}
            hint="建议用真名，方便大家认出你"
            maxLength={20}
            autoComplete="nickname"
            autoFocus
          />
          <Field
            variant="outlined"
            label="班级（选填）"
            value={f.className}
            onChange={set('className')}
            error={fe('className')}
            placeholder="高三(2)班"
            maxLength={20}
          />
        </AuthShell>
      );
    case 'username':
      return (
        <AuthShell
          {...common}
          title="设置用户名"
          subtitle="登录和被 @ 时用到，设置后不能修改。"
          aside={progress}
          right={nextBtn(busy ? '正在检查' : '下一步', busy)}
        >
          <Field
            variant="outlined"
            label="用户名"
            prefix="@"
            value={f.username}
            onChange={(v) => set('username')(v.replace(/\s/g, ''))}
            error={fe('username')}
            hint="3–20 位字母、数字或下划线"
            maxLength={20}
            autoComplete="username"
            autoCapitalize="off"
            spellCheck={false}
            autoFocus
          />
        </AuthShell>
      );
    case 'password': {
      const s = strength(f.password);
      return (
        <AuthShell
          {...common}
          title="设置密码"
          subtitle="至少 8 位。字母、数字和符号混着用会更安全。"
          aside={progress}
          right={nextBtn('下一步', busy)}
        >
          <input type="text" name="username" autoComplete="username" value={f.username} readOnly hidden />
          <Field
            variant="outlined"
            label="密码"
            type={show ? 'text' : 'password'}
            value={f.password}
            onChange={set('password')}
            error={fe('password')}
            autoComplete="new-password"
            autoFocus
          />
          <div className={`strength s${s}`} aria-live="polite">
            <i />
            <i />
            <i />
            <span>{f.password ? ['太短', '一般', '不错', '很强'][s] : ''}</span>
          </div>
          <Field
            variant="outlined"
            label="确认密码"
            type={show ? 'text' : 'password'}
            value={f.password2}
            onChange={set('password2')}
            error={fe('password2')}
            autoComplete="new-password"
          />
          <ShowPassword on={show} set={setShow} />
        </AuthShell>
      );
    }
    case 'verify':
      return (
        <AuthShell
          {...common}
          title="最后确认"
          subtitle="输入图片里的字符就完成了。看不清可以点图片换一张。"
          aside={progress}
          right={nextBtn(busy ? '正在创建' : '创建账号', busy)}
        >
          <dl className="summary">
            <div>
              <dt>昵称</dt>
              <dd>{f.displayName}</dd>
            </div>
            {f.className && (
              <div>
                <dt>班级</dt>
                <dd>{f.className}</dd>
              </div>
            )}
            <div>
              <dt>用户名</dt>
              <dd>@{f.username}</dd>
            </div>
          </dl>
          <Captcha value={f.captchaText} onChange={set('captchaText')} error={fe('captchaText')} c={c} />
        </AuthShell>
      );
  }
}

const STEP_FIELD: Record<Step, string> = {
  invite: 'inviteCode',
  name: 'displayName',
  username: 'username',
  password: 'password',
  verify: 'captchaText',
};
