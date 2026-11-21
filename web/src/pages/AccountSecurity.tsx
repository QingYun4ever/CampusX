import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronRight, Copy, Download, KeyRound, Mail, ShieldCheck } from 'lucide-react';
import { Field, Modal, Spinner, toast } from '../components/ui';
import { api, setToken } from '../lib/api';
import { AndroidShell, isAndroid } from '../lib/android';
import { useMe } from '../lib/auth';
import './account-security.css';

type Security = { email: string | null; emailAvailable: boolean; twoFactorEnabled: boolean };
const securityKey = ['account-security'];

function Password({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <Field label="当前密码" type="password" autoComplete="current-password" value={value} onChange={onChange} required />;
}

function FactorCode({ value, onChange, recovery = true }: { value: string; onChange: (value: string) => void; recovery?: boolean }) {
  return (
    <Field
      label={recovery ? '验证器验证码或恢复码' : '验证器验证码'}
      value={value}
      onChange={onChange}
      autoComplete="one-time-code"
      autoCapitalize="off"
      inputMode={recovery ? 'text' : 'numeric'}
      spellCheck={false}
      required
    />
  );
}

function EmailSettings({ status, update, back }: { status: Security; update: (status: Security) => void; back: () => void }) {
  const [stage, setStage] = useState<'address' | 'verify' | 'remove'>('address');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const changeStage = (next: typeof stage) => {
    setCode('');
    setPassword('');
    setError('');
    setStage(next);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      const reauth = { password, code: status.twoFactorEnabled ? code.trim() : undefined };
      if (stage === 'address') {
        await api('/me/email/start', { body: { email: email.trim(), ...reauth } });
        changeStage('verify');
      } else if (stage === 'verify') {
        update(await api<Security>('/me/email/confirm', { body: { code: code.trim() } }));
        toast('邮箱已验证');
        back();
      } else {
        update(await api<Security>('/me/email', { method: 'DELETE', body: reauth }));
        toast('已解除绑定');
        back();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="modal-body security-panel" onSubmit={submit}>
      {status.email && <p className="muted">已验证：<strong>{status.email}</strong></p>}
      {stage === 'verify' ? (
        <>
          <p className="muted">输入邮件中的验证码。未验证前，不会替换原邮箱。</p>
          <Field label="邮箱验证码" value={code} onChange={setCode} inputMode="numeric" autoComplete="one-time-code" required />
        </>
      ) : stage === 'remove' || status.emailAvailable ? (
        <>
          {stage === 'remove' ? <p>验证身份后解除邮箱绑定。</p> : (
            <Field label={status.email ? '新邮箱' : '邮箱地址'} type="email" value={email} onChange={setEmail} autoComplete="email" required />
          )}
          <Password value={password} onChange={setPassword} />
          {status.twoFactorEnabled && <FactorCode value={code} onChange={setCode} />}
        </>
      ) : <p className="muted">站点尚未配置邮件发送，暂不能绑定邮箱。</p>}
      {error && <p className="security-error" role="alert">{error}</p>}
      <div className="security-actions">
        <button type="button" className="btn btn-text" disabled={busy} onClick={back}>返回</button>
        {stage === 'address' && status.emailAvailable && (
          <button type="button" className="btn btn-text" disabled={busy} onClick={() => changeStage('verify')}>输入收到的验证码</button>
        )}
        {stage === 'address' && status.email && (
          <button type="button" className="btn btn-outline security-error" disabled={busy} onClick={() => changeStage('remove')}>解除绑定</button>
        )}
        {(stage !== 'address' || status.emailAvailable) && (
          <button type="submit" className={`btn ${stage === 'remove' ? 'btn-outline security-error' : 'btn-primary'}`} disabled={busy}>
            {stage === 'address' ? '发送验证码' : stage === 'verify' ? '确认绑定' : '确认解除'}
          </button>
        )}
        {stage !== 'address' && status.emailAvailable && (
          <button type="button" className="btn btn-text" disabled={busy} onClick={() => changeStage('address')}>
            {stage === 'verify' ? '重新发送' : '取消解除'}
          </button>
        )}
      </div>
    </form>
  );
}

/** 恢复码文件：纯文本，换台电脑、打印出来都能直接看懂 */
function recoveryText(codes: string[], username: string) {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const when = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return [
    '校墙 · 两步验证恢复码',
    '',
    `账号：@${username}`,
    `生成于：${when}`,
    `网站：${location.origin}`,
    '',
    ...codes.map((c, i) => `${String(i + 1).padStart(2, ' ')}.  ${c}`),
    '',
    '验证器用不了的时候（换手机、删了 App），登录时在验证码一栏填任意一个还没用过的恢复码。',
    '每个恢复码只能用一次。重新开启两步验证后，这里的恢复码会全部作废。',
    '请把这个文件放在安全的地方，不要发给任何人。',
    '',
  ].join('\r\n');
}

function RecoveryCodes({ codes, done }: { codes: string[]; done: () => void }) {
  const me = useMe();
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = recoveryText(codes, me.username);
  const filename = `校墙恢复码-${me.username}.txt`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      setCopied(true);
      setSaved(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast('复制失败，可以手动选中恢复码', 'error');
    }
  };
  const download = async () => {
    if (isAndroid) {
      try {
        await AndroidShell.saveText({ name: filename, text });
        setSaved(true);
        toast('已保存恢复码');
      } catch (e) {
        const msg = e instanceof Error ? e.message : '';
        if (!msg.includes('取消')) toast(msg.includes('not implemented') ? '当前 App 版本不支持下载，请先复制保存' : '保存失败，请先复制保存', 'error');
      }
      return;
    }
    // 加 BOM，Windows 记事本才不会把中文认成乱码
    const url = URL.createObjectURL(new Blob(['\ufeff' + text], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setSaved(true);
  };

  return (
    <div className="modal-body security-panel recovery">
      <div className="recovery-head">
        <span className="recovery-icon"><ShieldCheck size={22} /></span>
        <div>
          <h3>两步验证已开启</h3>
          <p>验证器用不了时，可以用下面的恢复码登录。每个只能用一次，关掉这个窗口后就看不到了。</p>
        </div>
      </div>
      <div className="recovery-sheet">
        <ol className="recovery-codes" aria-label="恢复码">
          {codes.map((c, i) => (
            <li key={c}>
              <span className="recovery-no" aria-hidden>{String(i + 1).padStart(2, '0')}</span>
              <code>{c}</code>
            </li>
          ))}
        </ol>
        <div className="recovery-tools">
          <button type="button" className="btn btn-outline sm" onClick={copy}>
            {copied ? <Check size={16} /> : <Copy size={16} />}
            {copied ? '已复制' : '复制'}
          </button>
          <button type="button" className="btn btn-outline sm" onClick={download}>
            <Download size={16} />
            下载 .txt
          </button>
        </div>
      </div>
      <label className="check recovery-confirm">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        <span className="box" />
        我已经把恢复码保存好了
      </label>
      <div className="security-actions">
        <button type="button" className="btn btn-primary" disabled={!saved} onClick={done}>完成</button>
      </div>
    </div>
  );
}

function TwoFactorSettings({ status, update, back }: { status: Security; update: (status: Security) => void; back: () => void }) {
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [qr, setQr] = useState<string>();
  const [codes, setCodes] = useState<string[] | null>(null);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!setup) return;
    let active = true;
    // 二维码在本机生成，不把设置密钥发给第三方。
    import('qrcode').then(({ toDataURL }) => toDataURL(setup.uri, { width: 224 })).then((image) => {
      if (active) setQr(image);
    }).catch(() => {});
    return () => { active = false; };
  }, [setup]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (status.twoFactorEnabled) {
        await api('/me/2fa', { method: 'DELETE', body: { password, code: code.trim() } });
        update({ ...status, twoFactorEnabled: false });
        toast('两步验证已关闭');
        back();
      } else if (setup) {
        const result = await api<{ recoveryCodes: string[] }>('/me/2fa/confirm', { body: { code: code.trim() } });
        setCodes(result.recoveryCodes);
        setSetup(null);
        setQr(undefined);
        setCode('');
        update({ ...status, twoFactorEnabled: true });
      } else {
        setSetup(await api<{ secret: string; uri: string }>('/me/2fa/setup', { body: { password } }));
        setPassword('');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
    } finally {
      setBusy(false);
    }
  };

  if (codes) return <RecoveryCodes codes={codes} done={back} />;

  return (
    <form className="modal-body security-panel" onSubmit={submit}>
      {setup ? (
        <>
          <p>用验证器扫描二维码，或手动输入密钥。</p>
          {qr && <img className="security-qr" src={qr} width={224} height={224} alt="验证器设置二维码" />}
          <p className="muted">设置密钥：<code className="security-secret">{setup.secret}</code></p>
          <FactorCode value={code} onChange={setCode} recovery={false} />
        </>
      ) : (
        <>
          <p>{status.twoFactorEnabled ? '验证身份后可关闭两步验证。' : '开启后，登录时还需要验证器中的验证码。邮箱不是必需项。'}</p>
          <Password value={password} onChange={setPassword} />
          {status.twoFactorEnabled && <FactorCode value={code} onChange={setCode} />}
        </>
      )}
      {error && <p className="security-error" role="alert">{error}</p>}
      <div className="security-actions">
        <button type="button" className="btn btn-text" disabled={busy} onClick={back}>返回</button>
        <button type="submit" className={`btn ${status.twoFactorEnabled ? 'btn-outline security-error' : 'btn-primary'}`} disabled={busy}>
          {status.twoFactorEnabled ? '关闭两步验证' : setup ? '开启两步验证' : '设置验证器'}
        </button>
      </div>
    </form>
  );
}

function PasswordSettings({ back }: { back: () => void }) {
  const [pw, setPw] = useState({ oldPassword: '', newPassword: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mismatch = pw.confirm && pw.newPassword !== pw.confirm ? '两次输入的新密码不一样' : '';
  const short = pw.newPassword && pw.newPassword.length < 8 ? '至少 8 位' : '';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || short || mismatch) return;
    setBusy(true);
    setError('');
    try {
      const r = await api<{ token: string | null }>('/me/password', {
        body: { oldPassword: pw.oldPassword, newPassword: pw.newPassword },
      });
      if (r.token) setToken(r.token);
      toast('密码已修改，其他设备需要重新登录');
      back();
    } catch (e) {
      setError(e instanceof Error ? e.message : '修改失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="modal-body security-panel" onSubmit={submit}>
      <p className="muted">修改后，其他已登录的设备会退出，需要用新密码重新登录。</p>
      <Password value={pw.oldPassword} onChange={(v) => setPw({ ...pw, oldPassword: v })} />
      <Field
        label="新密码"
        type="password"
        autoComplete="new-password"
        value={pw.newPassword}
        onChange={(v) => setPw({ ...pw, newPassword: v })}
        hint="至少 8 位"
        required
      />
      <Field
        label="确认新密码"
        type="password"
        autoComplete="new-password"
        value={pw.confirm}
        onChange={(v) => setPw({ ...pw, confirm: v })}
        error={mismatch}
        required
      />
      {error && <p className="security-error" role="alert">{error}</p>}
      <div className="security-actions">
        <button type="button" className="btn btn-text" onClick={back}>取消</button>
        <button className="btn btn-primary" disabled={busy || !pw.oldPassword || !pw.newPassword || !pw.confirm || !!short || !!mismatch}>
          {busy ? '正在修改…' : '修改密码'}
        </button>
      </div>
    </form>
  );
}

export function AccountSecurity() {
  const qc = useQueryClient();
  const [view, setView] = useState<'password' | 'email' | 'factor' | null>(null);
  const q = useQuery({ queryKey: securityKey, queryFn: () => api<Security>('/me/security') });
  const status = q.data;
  const update = (next: Security) => qc.setQueryData(securityKey, next);
  const close = () => setView(null);
  return (
    <>
      <section className="section">
        <h3>账户安全</h3>
        <div>
          <button type="button" className="list-link" onClick={() => setView('password')}>
            <KeyRound size={18} /> <span>修改密码</span>
            <ChevronRight size={16} className="security-end" />
          </button>
          <button type="button" className="list-link" onClick={() => setView('email')}>
            <Mail size={18} /> <span>邮箱绑定</span>
            <span className="muted small security-end">
              {status ? status.email ? '已验证' : status.emailAvailable ? '未绑定' : '未配置' : ''}
            </span>
            <ChevronRight size={16} />
          </button>
          <button type="button" className="list-link" onClick={() => setView('factor')}>
            <ShieldCheck size={18} /> <span>两步验证</span>
            <span className="muted small security-end">{status ? status.twoFactorEnabled ? '已开启' : '未开启' : ''}</span>
            <ChevronRight size={16} />
          </button>
        </div>
      </section>
      {view === 'password' && (
        <Modal title="修改密码" onClose={close}>
          <PasswordSettings back={close} />
        </Modal>
      )}
      {view && view !== 'password' && (
        <Modal title={view === 'email' ? '邮箱绑定' : '两步验证'} onClose={close}>
          {q.isPending ? <div className="modal-body"><Spinner inline /></div> : q.isError ? (
            <div className="modal-body">
              <p role="alert">{q.error.message}</p>
              <button type="button" className="btn btn-outline" onClick={() => q.refetch()}>重新加载</button>
            </div>
          ) : view === 'email' ? <EmailSettings status={q.data} update={update} back={close} />
            : <TwoFactorSettings status={q.data} update={update} back={close} />}
        </Modal>
      )}
    </>
  );
}
