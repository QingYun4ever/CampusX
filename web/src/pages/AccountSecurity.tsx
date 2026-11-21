import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Mail, ShieldCheck } from 'lucide-react';
import { Field, Modal, Spinner, toast } from '../components/ui';
import { api } from '../lib/api';
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

  if (codes) return (
    <div className="modal-body security-panel">
      <h3>保存恢复码</h3>
      <p>两步验证已开启。这些恢复码只显示一次，每个只能用一次。请存放在安全的地方。</p>
      <ul className="security-recovery" aria-label="恢复码">
        {codes.map((item) => <li key={item}><code>{item}</code></li>)}
      </ul>
      <div className="security-actions">
        <button type="button" className="btn btn-outline" onClick={async () => {
          try {
            await navigator.clipboard.writeText(codes.join('\n'));
            toast('已复制恢复码');
          } catch {
            toast('复制失败，可以手动选中恢复码', 'error');
          }
        }}>复制恢复码</button>
        <button type="button" className="btn btn-primary" onClick={back}>完成</button>
      </div>
    </div>
  );

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

function SecurityModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [view, setView] = useState<'summary' | 'email' | 'factor'>('summary');
  const q = useQuery({ queryKey: securityKey, queryFn: () => api<Security>('/me/security'), refetchOnMount: 'always' });
  const update = (status: Security) => qc.setQueryData(securityKey, status);
  const back = () => setView('summary');
  return (
    <Modal title={view === 'email' ? '邮箱绑定' : view === 'factor' ? '两步验证' : '账户安全'} onClose={onClose}>
      {q.isPending ? <div className="modal-body"><Spinner inline /></div> : q.isError ? (
        <div className="modal-body">
          <p role="alert">{q.error.message}</p>
          <button type="button" className="btn btn-outline" onClick={() => q.refetch()}>重新加载</button>
        </div>
      ) : view === 'email' ? <EmailSettings status={q.data} update={update} back={back} />
        : view === 'factor' ? <TwoFactorSettings status={q.data} update={update} back={back} /> : (
          <>
            <button type="button" className="list-link" onClick={() => setView('email')}>
              <Mail size={18} /> <span>邮箱绑定</span>
              <span className="muted small security-end">{q.data.email ? '已验证' : '未绑定'}</span><ChevronRight size={16} />
            </button>
            <button type="button" className="list-link" onClick={() => setView('factor')}>
              <ShieldCheck size={18} /> <span>两步验证</span>
              <span className="muted small security-end">{q.data.twoFactorEnabled ? '已开启' : '未开启'}</span><ChevronRight size={16} />
            </button>
          </>
        )}
    </Modal>
  );
}

export function AccountSecurity() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="list-link" onClick={() => setOpen(true)}>
        <ShieldCheck size={18} /> <span>账户安全</span><ChevronRight size={16} className="muted security-end" />
      </button>
      {open && <SecurityModal onClose={() => setOpen(false)} />}
    </>
  );
}
