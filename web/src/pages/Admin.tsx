import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Link, Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  BadgeCheck,
  Check,
  Copy,
  ExternalLink,
  FlaskConical,
  KeyRound,
  LayoutDashboard,
  ScanEye,
  Search,
  Ticket,
  Trash2,
  Users as UsersIcon,
  X,
} from 'lucide-react';
import { InfiniteList, useInfiniteList } from '../components/Feed';
import { Logo } from '../components/Logo';
import { Avatar, Empty, Field, Modal, PostSkeleton, Spinner, toast, useModalClose, Verified } from '../components/ui';
import { api, media, WEB_ORIGIN, type Invite, type User, type UserLite } from '../lib/api';
import { useMe } from '../lib/auth';
import { fullTime, timeAgo } from '../lib/format';

/* ---------------- 类型 ---------------- */
interface Stats {
  users: number;
  newUsers: number;
  posts: number;
  newPosts: number;
  boards: number;
  verified: number;
  invitesLeft: number;
  pending: number;
  blocked: number;
  moderation: boolean;
}
interface ModConfig {
  enabled: boolean;
  provider: 'anthropic' | 'openai';
  model: string;
  baseUrl: string;
  reviewImages: boolean;
  failPolicy: 'pass' | 'hold';
  rules: string;
  keyHint: string;
  hasKey: boolean;
}
interface ModLog {
  id: number;
  verdict: 'pass' | 'block' | 'error' | 'manual_pass' | 'manual_block' | 'pending';
  category: string;
  reason: string;
  provider: string;
  model: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  createdAt: number;
  actor: string | null;
  post: { id: number; content: string; images: string[]; status: string; author: UserLite };
}

const VERDICT: Record<ModLog['verdict'], [string, string]> = {
  pass: ['通过', 'ok'],
  block: ['拦截', 'bad'],
  error: ['出错', 'warn'],
  manual_pass: ['人工通过', 'ok'],
  manual_block: ['人工拦截', 'bad'],
  pending: ['审核中', 'warn'],
};
const CATEGORY: Record<string, string> = {
  sexual: '色情',
  violence: '暴力',
  hate: '歧视仇恨',
  harassment: '辱骂骚扰',
  privacy: '隐私',
  illegal: '违法',
  spam: '广告刷屏',
  self_harm: '自残',
  other: '其他',
};
const STATUS: Record<string, string> = { ok: '已公开', pending: '审核中', rejected: '仅作者可见', deleted: '已删除' };

function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)}>
      <i />
    </button>
  );
}

function PageHead({ title, sub, right }: { title: string; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="admin-head">
      <div>
        <h1>{title}</h1>
        {sub && <p className="muted">{sub}</p>}
      </div>
      {right}
    </div>
  );
}

/* ---------------- 概览 ---------------- */
function Overview() {
  const stats = useQuery({ queryKey: ['admin-stats'], queryFn: () => api<Stats>('/admin/stats'), refetchInterval: 30_000 });
  const cfg = useQuery({ queryKey: ['admin-mod-config'], queryFn: () => api<ModConfig>('/admin/moderation/config') });
  const s = stats.data;
  const tiles: [string, number | undefined, string?, string?][] = [
    ['同学', s?.users, s?.newUsers ? `今天 +${s.newUsers}` : undefined],
    ['帖子', s?.posts, s?.newPosts ? `今天 +${s.newPosts}` : undefined],
    ['审核中', s?.pending, undefined, s?.pending ? 'warn' : undefined],
    ['24 小时内拦截', s?.blocked, undefined, s?.blocked ? 'bad' : undefined],
    ['认证用户', s?.verified],
    ['剩余邀请名额', s?.invitesLeft],
  ];
  return (
    <>
      <PageHead title="概览" sub="同学圈的整体情况" />
      <div className="stat-grid">
        {tiles.map(([label, value, delta, tone], i) => (
          <div key={label} className={`stat-tile enter ${tone ?? ''}`} style={{ '--i': i } as CSSProperties}>
            <span className="muted">{label}</span>
            <b>{value ?? '—'}</b>
            {delta && <span className="delta">{delta}</span>}
          </div>
        ))}
      </div>

      <Link to="/admin/moderation" className="admin-card mod-status">
        <span className={`dot ${cfg.data?.enabled ? 'on' : ''}`} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="name">AI 内容审核{cfg.data ? (cfg.data.enabled ? '已开启' : '未开启') : ''}</div>
          <div className="muted small ellipsis">
            {cfg.data?.enabled
              ? `${cfg.data.provider === 'anthropic' ? 'Claude' : 'OpenAI 兼容接口'} · ${cfg.data.model} · ${cfg.data.reviewImages ? '文字和图片' : '仅文字'}`
              : '开启后，每条帖子发出前都会先经过 AI 审核，发帖的人不会察觉'}
          </div>
        </div>
        <span className="btn btn-outline sm">{cfg.data?.enabled ? '查看记录' : '去设置'}</span>
      </Link>

      <h2 className="admin-h2">最近的审核记录</h2>
      <LogList filter="all" limit={5} />
    </>
  );
}

/* ---------------- 审核 ---------------- */
const MODEL_HINTS = {
  anthropic: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
  openai: ['qwen-vl-max', 'qwen-plus', 'glm-4v-plus', 'deepseek-chat'],
};

function ModSettings() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin-mod-config'], queryFn: () => api<ModConfig>('/admin/moderation/config') });
  const [f, setF] = useState<ModConfig | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [testText, setTestText] = useState('');
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; error?: string; result?: { verdict: string; category: string; reason: string; latencyMs: number; inputTokens: number; outputTokens: number } } | null>(null);
  useEffect(() => {
    if (q.data && !f) setF(q.data);
  }, [q.data, f]);
  if (!f) return <PostSkeleton n={2} />;
  const set = (patch: Partial<ModConfig>) => setF({ ...f, ...patch });
  const payload = () => ({
    enabled: f.enabled,
    provider: f.provider,
    model: f.model,
    baseUrl: f.baseUrl,
    reviewImages: f.reviewImages,
    failPolicy: f.failPolicy,
    rules: f.rules,
  });
  const keyChanged = !!key.trim();
  const providerChanged = q.data && f.provider !== q.data.provider;

  const save = async () => {
    if (f.enabled && !f.hasKey && !keyChanged && f.provider === 'openai') return toast('请先填写 API 密钥', 'error');
    setBusy(true);
    try {
      const next = await api<ModConfig>('/admin/moderation/config', { method: 'PUT', body: { ...payload(), apiKey: key } });
      setF(next);
      setKey('');
      qc.setQueryData(['admin-mod-config'], next);
      qc.invalidateQueries({ queryKey: ['admin-stats'] });
      toast(next.enabled ? '已保存，之后的新帖会先经过审核' : '已保存');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      setResult(await api('/admin/moderation/test', { body: { config: payload(), apiKey: key, text: testText } }));
    } catch (e) {
      setResult({ ok: false, error: (e as Error).message });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="admin-form">
      <div className="admin-card setting-row">
        <div>
          <div className="name">开启 AI 审核</div>
          <div className="muted small">新帖先对作者本人显示，审核通过后其他人才能看到；没通过的帖子只有作者自己看得到。</div>
        </div>
        <Switch on={f.enabled} onChange={(v) => set({ enabled: v })} label="开启 AI 审核" />
      </div>

      <div className="admin-card">
        <div className="name">模型</div>
        <div className="seg" role="radiogroup" aria-label="接口类型">
          {(
            [
              ['anthropic', 'Claude'],
              ['openai', 'OpenAI 兼容接口'],
            ] as const
          ).map(([id, name]) => (
            <button
              key={id}
              role="radio"
              aria-checked={f.provider === id}
              className={f.provider === id ? 'on' : ''}
              onClick={() => set({ provider: id, model: MODEL_HINTS[id][0], baseUrl: id === 'anthropic' ? '' : f.baseUrl })}
            >
              {name}
            </button>
          ))}
        </div>
        <p className="muted small">
          {f.provider === 'anthropic'
            ? '使用 Anthropic 官方 SDK。被安全策略拒绝时会自动换模型重试，模型都拒绝的内容按拦截处理。'
            : '通义千问、智谱、DeepSeek 等提供 /chat/completions 接口的服务。审核图片需要支持视觉的模型（如 qwen-vl-max、glm-4v-plus）。'}
        </p>
        <Field label="模型名称" value={f.model} onChange={(v) => set({ model: v })} list="model-hints" />
        <datalist id="model-hints">
          {MODEL_HINTS[f.provider].map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        <Field
          label={f.provider === 'anthropic' ? '接口地址（选填）' : '接口地址'}
          value={f.baseUrl}
          onChange={(v) => set({ baseUrl: v })}
          placeholder={f.provider === 'anthropic' ? '留空使用官方接口' : 'https://dashscope.aliyuncs.com/compatible-mode/v1'}
          hint={f.provider === 'anthropic' ? '使用代理或网关时填写' : '填到 /v1 为止，不要带 /chat/completions'}
        />
        <Field
          label="API 密钥"
          type="password"
          value={key}
          onChange={setKey}
          autoComplete="off"
          hint={
            providerChanged
              ? '换了接口类型，需要重新填写密钥'
              : f.keyHint
                ? `当前：${f.keyHint}。留空则保持不变`
                : '还没有设置密钥'
          }
        />
      </div>

      <div className="admin-card">
        <div className="setting-row">
          <div>
            <div className="name">审核图片</div>
            <div className="muted small">把帖子里的图片一起发给模型。关掉后只审核文字。</div>
          </div>
          <Switch on={f.reviewImages} onChange={(v) => set({ reviewImages: v })} label="审核图片" />
        </div>
        <hr />
        <div className="name">审核接口出错时</div>
        <div className="radio-list" role="radiogroup" aria-label="审核接口出错时">
          {(
            [
              ['hold', '先不公开，等管理员处理', '更稳妥。帖子会出现在「审核中」，可以手动通过'],
              ['pass', '直接公开', '不影响大家发帖，但这段时间的内容没有审核'],
            ] as const
          ).map(([id, name, desc]) => (
            <label key={id} className={`radio-item ${f.failPolicy === id ? 'on' : ''}`}>
              <input type="radio" name="fail" checked={f.failPolicy === id} onChange={() => set({ failPolicy: id })} />
              <span>
                <span className="name">{name}</span>
                <span className="muted small">{desc}</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="admin-card">
        <div className="name">补充规则（选填）</div>
        <p className="muted small">内置规则已经覆盖色情、暴力、歧视、辱骂、隐私、违法、广告等。这里写本社区额外的要求。</p>
        <Field
          label="补充规则"
          multiline
          value={f.rules}
          onChange={(v) => set({ rules: v })}
          maxLength={2000}
          counter
          placeholder="例如：不允许发布其他同学的照片，除非本人同意"
        />
      </div>

      <div className="admin-actions">
        <button className="btn btn-primary" onClick={save} disabled={busy}>
          {busy ? <Spinner size={18} inline /> : '保存设置'}
        </button>
      </div>

      <div className="admin-card">
        <div className="name">
          <FlaskConical size={16} /> 试一试
        </div>
        <p className="muted small">用上面的设置（包括还没保存的改动）审核一段文字，不会影响任何帖子。会产生少量费用。</p>
        <Field label="测试内容" multiline value={testText} onChange={setTestText} placeholder="留空会用一句普通的问候" />
        <div>
          <button className="btn btn-outline" onClick={test} disabled={testing}>
            {testing ? <Spinner size={18} inline /> : '发送测试'}
          </button>
        </div>
        {result && (
          <div className={`test-result ${result.ok ? (result.result?.verdict === 'pass' ? 'ok' : 'bad') : 'warn'}`}>
            {result.ok && result.result ? (
              <>
                <b>{result.result.verdict === 'pass' ? '通过' : `拦截 · ${CATEGORY[result.result.category] ?? result.result.category}`}</b>
                <span>{result.result.reason}</span>
                <span className="muted small">
                  耗时 {(result.result.latencyMs / 1000).toFixed(1)} 秒 · 输入 {result.result.inputTokens} / 输出 {result.result.outputTokens} tokens
                </span>
              </>
            ) : (
              <>
                <b>调用失败</b>
                <span>{result.error}</span>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function LogItem({ log, onDecided }: { log: ModLog; onDecided: () => void }) {
  const [busy, setBusy] = useState(false);
  const [label, tone] = VERDICT[log.verdict];
  const decide = async (action: 'approve' | 'reject') => {
    setBusy(true);
    try {
      await api(`/admin/posts/${log.post.id}/moderate`, { body: { action } });
      toast(action === 'approve' ? '已通过，帖子现在对所有人可见' : '已拦截，帖子现在只有作者能看到');
      onDecided();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const st = log.post.status;
  return (
    <div className="log-item">
      <Avatar src={log.post.author.avatar} name={log.post.author.displayName} size={36} />
      <div className="log-body">
        <div className="log-head">
          <span className="name">{log.post.author.displayName}</span>
          <span className="muted">@{log.post.author.username}</span>
          <span className="muted">·</span>
          <time className="muted" title={fullTime(log.createdAt)}>
            {timeAgo(log.createdAt)}
          </time>
          <span className={`pill ${tone}`}>{label}</span>
          {log.category && log.category !== 'none' && <span className="pill">{CATEGORY[log.category] ?? log.category}</span>}
        </div>
        {log.post.content && <div className="log-content">{log.post.content}</div>}
        {log.post.images.length > 0 && (
          <div className="log-thumbs">
            {log.post.images.map((src) => (
              <a key={src} href={media(src)} target="_blank" rel="noreferrer">
                <img src={media(src)} alt="" loading="lazy" />
              </a>
            ))}
          </div>
        )}
        {log.reason && <div className="log-reason">{log.reason}</div>}
        <div className="log-meta muted small">
          {log.verdict.startsWith('manual') ? (
            <span>由 @{log.actor} 处理</span>
          ) : log.model ? (
            <span>
              {log.model} · {(log.latencyMs / 1000).toFixed(1)} 秒 · {log.inputTokens + log.outputTokens} tokens
            </span>
          ) : null}
          <span>帖子{STATUS[st] ?? st}</span>
          {st !== 'deleted' && (
            <a href={`/post/${log.post.id}`} target="_blank" rel="noreferrer">
              查看帖子 <ExternalLink size={12} />
            </a>
          )}
        </div>
      </div>
      {st !== 'deleted' && (
        <div className="log-actions">
          {st !== 'ok' && (
            <button className="btn btn-outline sm" disabled={busy} onClick={() => decide('approve')}>
              <Check size={15} /> 通过
            </button>
          )}
          {st !== 'rejected' && (
            <button className="btn btn-outline sm danger" disabled={busy} onClick={() => decide('reject')}>
              <X size={15} /> 拦截
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function LogList({ filter, limit }: { filter: string; limit?: number }) {
  const qc = useQueryClient();
  const q = useInfiniteList<ModLog>(['admin-mod-logs', filter], `/admin/moderation/logs?filter=${filter}`);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['admin-mod-logs'] });
    qc.invalidateQueries({ queryKey: ['admin-stats'] });
  };
  if (limit) {
    const items = q.data?.pages[0]?.items.slice(0, limit);
    if (q.isPending) return <PostSkeleton n={2} />;
    if (!items?.length) return <div className="admin-card muted">还没有审核记录。</div>;
    return (
      <div className="admin-list">
        {items.map((l) => (
          <LogItem key={l.id} log={l} onDecided={refresh} />
        ))}
      </div>
    );
  }
  return (
    <div className="admin-list">
      <InfiniteList
        q={q}
        getKey={(l) => l.id}
        render={(l) => <LogItem log={l} onDecided={refresh} />}
        empty={<Empty title={filter === 'pending' ? '没有待审核的帖子' : '没有记录'} />}
      />
    </div>
  );
}

function Moderation() {
  const [tab, setTab] = useState<'logs' | 'settings'>('logs');
  const [filter, setFilter] = useState('all');
  const stats = useQuery({ queryKey: ['admin-stats'], queryFn: () => api<Stats>('/admin/stats') });
  const filters: [string, string][] = [
    ['all', '全部'],
    ['pending', `审核中${stats.data?.pending ? ` ${stats.data.pending}` : ''}`],
    ['block', '已拦截'],
    ['error', '出错'],
    ['manual', '人工处理'],
  ];
  return (
    <>
      <PageHead
        title="内容审核"
        sub="每条新帖在公开之前由 AI 审核文字和图片，发帖的人看不出区别"
        right={
          <div className="seg">
            <button className={tab === 'logs' ? 'on' : ''} onClick={() => setTab('logs')}>
              记录
            </button>
            <button className={tab === 'settings' ? 'on' : ''} onClick={() => setTab('settings')}>
              设置
            </button>
          </div>
        }
      />
      {tab === 'settings' ? (
        <ModSettings />
      ) : (
        <>
          <div className="chip-row">
            {filters.map(([id, name]) => (
              <button key={id} className={`chip ${filter === id ? 'on' : ''}`} onClick={() => setFilter(id)}>
                {name}
              </button>
            ))}
          </div>
          <LogList filter={filter} key={filter} />
        </>
      )}
    </>
  );
}

/* ---------------- 邀请码 ---------------- */
function Invites() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin-invites'], queryFn: () => api<Invite[]>('/admin/invites') });
  const [f, setF] = useState({ maxUses: '50', note: '', expiresDays: '30' });
  const [busy, setBusy] = useState(false);

  const copy = async (code: string) => {
    const link = `${WEB_ORIGIN}/register?invite=${code}`;
    try {
      await navigator.clipboard.writeText(`同学圈注册链接：${link}\n邀请码：${code}`);
      toast('注册链接和邀请码已复制');
    } catch {
      toast(code);
    }
  };

  const create = async () => {
    setBusy(true);
    try {
      const r = await api<{ code: string }>('/admin/invites', {
        body: {
          maxUses: Number(f.maxUses) || 1,
          note: f.note,
          expiresDays: f.expiresDays ? Number(f.expiresDays) : null,
        },
      });
      await qc.invalidateQueries({ queryKey: ['admin-invites'] });
      copy(r.code);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (code: string) => {
    if (!confirm(`删除邀请码 ${code}？已注册的用户不受影响。`)) return;
    await api(`/admin/invites/${code}`, { method: 'DELETE' }).catch((e) => toast(e.message, 'error'));
    qc.invalidateQueries({ queryKey: ['admin-invites'] });
  };

  return (
    <>
      <section className="section">
        <h3>生成邀请码</h3>
        <div className="row">
          <Field label="备注" value={f.note} placeholder="例如：高三(2)班" onChange={(v) => setF({ ...f, note: v })} hint="注册时会显示给对方" />
          <Field label="可用次数" inputMode="numeric" value={f.maxUses} onChange={(v) => setF({ ...f, maxUses: v.replace(/\D/g, '') })} />
          <Field
            label="有效天数"
            inputMode="numeric"
            value={f.expiresDays}
            placeholder="留空为永久"
            onChange={(v) => setF({ ...f, expiresDays: v.replace(/\D/g, '') })}
          />
        </div>
        <div>
          <button className="btn btn-primary" disabled={busy} onClick={create}>
            生成并复制
          </button>
        </div>
      </section>
      {q.isPending ? (
        <PostSkeleton n={3} />
      ) : !q.data?.length ? (
        <Empty title="还没有邀请码" />
      ) : (
        q.data.map((i) => {
          const expired = i.expiresAt !== null && i.expiresAt < Date.now();
          const full = i.usedCount >= i.maxUses;
          return (
            <div key={i.code} className="table-row">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span className="code">{i.code}</span>
                  <span className={`pill ${!expired && !full ? 'ok' : ''}`}>
                    {expired ? '已过期' : full ? '已用完' : '可用'} · {i.usedCount}/{i.maxUses}
                  </span>
                </div>
                <div className="faint ellipsis" style={{ fontSize: 13 }}>
                  {i.note || '无备注'} · {i.expiresAt ? `${fullTime(i.expiresAt)} 过期` : '永久有效'}
                </div>
              </div>
              <button className="icon-btn" onClick={() => copy(i.code)} aria-label="复制">
                <Copy size={18} />
              </button>
              <button className="icon-btn" onClick={() => remove(i.code)} aria-label="删除">
                <Trash2 size={18} />
              </button>
            </div>
          );
        })
      )}
    </>
  );
}


/* ---------------- 用户 ---------------- */
function VerifyForm({ user, onDone }: { user: User; onDone: () => void }) {
  const close = useModalClose();
  const [note, setNote] = useState(user.verifiedNote ?? '');
  const [busy, setBusy] = useState(false);
  const save = async (verified: boolean) => {
    setBusy(true);
    try {
      await api(`/admin/users/${user.id}`, { method: 'PATCH', body: { verified, verifiedNote: note } });
      toast(verified ? `已给 ${user.displayName} 加上蓝标` : `已取消 ${user.displayName} 的认证`);
      onDone();
      close();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-body">
      <div className="verify-preview">
        <Avatar src={user.avatar} name={user.displayName} size={48} />
        <div>
          <div className="name">
            {user.displayName} <Verified user={{ verified: true, verifiedNote: note }} />
          </div>
          <div className="muted small">{note ? `已认证 · ${note}` : '已认证'}</div>
        </div>
      </div>
      <Field
        label="认证说明（选填）"
        value={note}
        onChange={setNote}
        maxLength={30}
        counter
        placeholder="例如：高三(2)班班长"
        hint="会显示在个人主页，鼠标停在蓝标上也能看到"
      />
      <div className="modal-actions">
        {user.verified && (
          <button className="btn btn-outline danger" disabled={busy} onClick={() => save(false)}>
            取消认证
          </button>
        )}
        <span className="spacer" />
        <button className="btn btn-primary" disabled={busy} onClick={() => save(true)}>
          {user.verified ? '保存' : '认证'}
        </button>
      </div>
    </div>
  );
}

function Users() {
  const me = useMe();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin-users'], queryFn: () => api<User[]>('/admin/users') });
  const [filter, setFilter] = useState('');
  const [verifying, setVerifying] = useState<User | null>(null);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['admin-users'] });
    qc.invalidateQueries({ queryKey: ['admin-stats'] });
    // 帖子、主页里的蓝标也要刷新
    for (const k of ['feed', 'user', 'post', 'replies', 'me', 'suggested']) qc.invalidateQueries({ queryKey: [k] });
  };
  const setRole = async (u: User, role: 'user' | 'admin') => {
    if (!confirm(`${role === 'admin' ? '设为管理员' : '取消管理员'}：${u.displayName}？`)) return;
    try {
      await api(`/admin/users/${u.id}`, { method: 'PATCH', body: { role } });
      refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const reset = async (u: User) => {
    if (!confirm(`为 ${u.displayName}（@${u.username}）生成临时密码？对方所有设备都会退出登录。`)) return;
    try {
      const r = await api<{ password: string }>(`/admin/users/${u.id}/reset-password`, { method: 'POST' });
      try {
        await navigator.clipboard.writeText(r.password);
      } catch {
        /* ignore */
      }
      prompt(`@${u.username} 的临时密码（已复制），请私下发给对方，并提醒登录后修改：`, r.password);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const kw = filter.trim().toLowerCase();
  const list = (q.data ?? []).filter(
    (u) => !kw || [u.displayName, u.username, u.className].some((x) => x?.toLowerCase().includes(kw)),
  );
  return (
    <>
      <PageHead title="用户" sub={q.data ? `共 ${q.data.length} 人` : undefined} />
      <label className="search-box admin-search">
        <Search size={18} />
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="按昵称、用户名、班级筛选" aria-label="筛选用户" />
      </label>
      {q.isPending ? (
        <PostSkeleton n={4} />
      ) : (
        <div className="admin-list">
          {list.map((u) => (
            <div key={u.id} className="table-row">
              <Avatar src={u.avatar} name={u.displayName} size={40} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="name">
                  <Link to={`/u/${u.username}`} className="ellipsis">
                    {u.displayName}
                  </Link>
                  <Verified user={u} size={16} />
                  {u.role === 'admin' && <span className="tag">管理员</span>}
                </div>
                <div className="muted ellipsis small">
                  @{u.username}
                  {u.className && ` · ${u.className}`} · {fullTime(u.createdAt)} 注册
                </div>
              </div>
              <div className="row-actions">
                <button
                  className={`icon-btn ${u.verified ? 'verified-on' : ''}`}
                  onClick={() => setVerifying(u)}
                  aria-label={u.verified ? '编辑认证' : '蓝标认证'}
                  title={u.verified ? '编辑认证' : '蓝标认证'}
                >
                  <BadgeCheck size={19} />
                </button>
                {u.id !== me.id && (
                  <>
                    <button className="icon-btn" onClick={() => reset(u)} aria-label="重置密码" title="重置密码">
                      <KeyRound size={18} />
                    </button>
                    <button className="btn btn-outline sm" onClick={() => setRole(u, u.role === 'admin' ? 'user' : 'admin')}>
                      {u.role === 'admin' ? '取消管理员' : '设为管理员'}
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
          {!list.length && <Empty title="没有匹配的同学" />}
        </div>
      )}
      {verifying && (
        <Modal title={verifying.verified ? '编辑认证' : '蓝标认证'} onClose={() => setVerifying(null)}>
          <VerifyForm user={verifying} onDone={refresh} />
        </Modal>
      )}
    </>
  );
}

/* ---------------- 外壳 ---------------- */
export function Admin() {
  const me = useMe();
  const stats = useQuery({
    queryKey: ['admin-stats'],
    queryFn: () => api<Stats>('/admin/stats'),
    enabled: me.role === 'admin',
    refetchInterval: 30_000,
  });
  useEffect(() => {
    document.title = '管理后台 · 同学圈';
    return () => {
      document.title = '同学圈';
    };
  }, []);
  if (me.role !== 'admin') {
    return (
      <div className="admin-denied">
        <Empty title="需要管理员权限" action={<Link to="/" className="btn btn-primary">回到首页</Link>}>
          这个页面只有管理员能打开。
        </Empty>
      </div>
    );
  }
  const nav: [string, string, typeof LayoutDashboard, number?][] = [
    ['/admin', '概览', LayoutDashboard],
    ['/admin/moderation', '内容审核', ScanEye, stats.data?.pending],
    ['/admin/invites', '邀请码', Ticket],
    ['/admin/users', '用户', UsersIcon],
  ];
  return (
    <div className="admin">
      <header className="admin-top">
        <Link to="/admin" className="admin-brand">
          <Logo size={26} />
          <span>同学圈</span>
          <span className="admin-badge">管理后台</span>
        </Link>
        <span className="spacer" />
        <Link to="/" className="btn btn-outline sm admin-back">
          <ArrowLeft size={16} /> <span>返回同学圈</span>
        </Link>
        <Avatar src={me.avatar} name={me.displayName} size={32} />
      </header>
      <div className="admin-body">
        <nav className="admin-nav" aria-label="管理后台">
          {nav.map(([to, label, Icon, badge]) => (
            <NavLink key={to} to={to} end={to === '/admin'} className={({ isActive }) => (isActive ? 'active' : '')}>
              <Icon size={19} />
              <span>{label}</span>
              {!!badge && <span className="badge">{badge}</span>}
            </NavLink>
          ))}
        </nav>
        <main className="admin-main">
          <Routes>
            <Route index element={<Overview />} />
            <Route path="moderation" element={<Moderation />} />
            <Route path="invites" element={<InvitesPage />} />
            <Route path="users" element={<Users />} />
            <Route path="*" element={<Navigate to="/admin" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

function InvitesPage() {
  return (
    <>
      <PageHead title="邀请码" sub="只有拿到邀请码的人才能注册。生成后会自动复制注册链接" />
      <div className="admin-list">
        <Invites />
      </div>
    </>
  );
}
