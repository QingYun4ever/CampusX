import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Link, Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  BadgeCheck,
  Bot,
  Check,
  Copy,
  ExternalLink,
  Flag,
  FlaskConical,
  KeyRound,
  LayoutDashboard,
  Megaphone,
  PartyPopper,
  ScanEye,
  Search,
  Ticket,
  Trash2,
  Users as UsersIcon,
  X,
} from 'lucide-react';
import { ContentLink } from '../components/ContentLink';
import { InfiniteList, useInfiniteList } from '../components/Feed';
import { Logo } from '../components/Logo';
import { MediaImage } from '../components/MediaImage';
import { Avatar, Empty, Field, Modal, PostSkeleton, Spinner, Switch, toast, useModalClose, Verified } from '../components/ui';
import { api, ApiError, WEB_ORIGIN, type Announcement, type CampusEvent, type EventEntry, type AssistantConfig, type Invite, type MaintenanceConfig, type ReportGroup, type User, type UserLite } from '../lib/api';
import { refreshStatus } from '../lib/site';
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
  mainRules?: string | null;
  defaultMainRules?: string;
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
const STATUS: Record<string, string> = { ok: '已公开', pending: '审核中', rejected: '未通过，未发布', deleted: '已删除' };

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
      <PageHead title="概览" sub="校墙的整体情况" />
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
    mainRules: f.mainRules,
    rules: f.rules,
  });
  const keyChanged = !!key.trim();
  const providerChanged = q.data && f.provider !== q.data.provider;
  const mainRulesBlank = typeof f.mainRules === 'string' && !f.mainRules.trim();

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
        <div className="name">主审核规则</div>
        {f.defaultMainRules === undefined ? (
          <p className="muted small">此站点的服务器版本尚不支持编辑主审核规则。</p>
        ) : (
          <>
            <p className="muted small">可以直接修改默认的判定标准。保存后，新审核会使用这里的主规则，再应用下方的补充规则。</p>
            <Field
              label="主审核规则"
              multiline
              value={f.mainRules ?? f.defaultMainRules}
              onChange={(v) => set({ mainRules: v === f.defaultMainRules ? null : v })}
              maxLength={6000}
              counter
              error={mainRulesBlank ? '请填写主审核规则，或恢复默认规则' : undefined}
              style={{ minHeight: '14em', resize: 'vertical' }}
            />
            <div>
              <button className="btn btn-outline sm" disabled={busy || f.mainRules == null} onClick={() => set({ mainRules: null })}>
                恢复默认主规则
              </button>
            </div>
          </>
        )}
      </div>

      <div className="admin-card">
        <div className="name">补充规则（选填）</div>
        <p className="muted small">写本社区额外的要求。恢复默认主规则不会清除这里的内容。</p>
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
        <button className="btn btn-primary" onClick={save} disabled={busy || mainRulesBlank}>
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
          <button className="btn btn-outline" onClick={test} disabled={testing || mainRulesBlank}>
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
      <Avatar src={log.post.author.avatar} name={log.post.author.displayName} size={36} decoration={log.post.author.avatarDecoration} />
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
              <ContentLink key={src} href={src} image>
                <MediaImage src={src} alt="查看审核附件" loading="lazy" />
              </ContentLink>
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
            <Link to={`/post/${log.post.id}`}>
              查看帖子 <ExternalLink size={12} />
            </Link>
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
      await navigator.clipboard.writeText(`校墙注册链接：${link}\n邀请码：${code}`);
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
        <Avatar src={user.avatar} name={user.displayName} size={48} decoration={user.avatarDecoration} />
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
              <Avatar src={u.avatar} name={u.displayName} size={40} decoration={u.avatarDecoration} />
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
  const entries = useQuery({
    queryKey: ['admin-entries-count'],
    queryFn: () => api<{ n: number }>('/admin/event-entries/count'),
    enabled: me.role === 'admin',
    refetchInterval: 60_000,
  });
  const reports = useQuery({
    queryKey: ['admin-reports-count'],
    queryFn: () => api<{ count: number }>('/admin/reports/count'),
    enabled: me.role === 'admin',
    refetchInterval: 60_000,
  });
  useEffect(() => {
    document.title = '管理后台 · 校墙';
    return () => {
      document.title = '校墙';
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
    ['/admin/reports', '举报', Flag, reports.data?.count],
    ['/admin/events', '活动', PartyPopper, entries.data?.n],
    ['/admin/site', '站点', Megaphone],
    ['/admin/assistant', 'AI 助手', Bot],
    ['/admin/invites', '邀请码', Ticket],
    ['/admin/users', '用户', UsersIcon],
  ];
  return (
    <div className="admin">
      <header className="admin-top">
        <Link to="/admin" className="admin-brand">
          <Logo size={26} />
          <span>校墙</span>
          <span className="admin-badge">管理后台</span>
        </Link>
        <span className="spacer" />
        <Link to="/" className="btn btn-outline sm admin-back">
          <ArrowLeft size={16} /> <span>返回校墙</span>
        </Link>
        <Avatar src={me.avatar} name={me.displayName} size={32} decoration={me.avatarDecoration} />
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
            <Route path="reports" element={<Reports />} />
            <Route path="events" element={<EventsAdminPage />} />
            <Route path="site" element={<SitePage />} />
            <Route path="assistant" element={<AssistantPage />} />
            <Route path="invites" element={<InvitesPage />} />
            <Route path="users" element={<Users />} />
            <Route path="*" element={<Navigate to="/admin" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

/* ---------------- 站点：维护模式、公告 ---------------- */
function SitePage() {
  return (
    <>
      <PageHead title="站点" sub="维护模式和公告" />
      <div className="admin-form">
        <MaintenanceForm />
        <AnnouncementsForm />
      </div>
    </>
  );
}

function MaintenanceForm() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin-maintenance'], queryFn: () => api<MaintenanceConfig>('/admin/maintenance') });
  const [f, setF] = useState<{ message: string; until: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (q.data && !f) setF({ message: q.data.message, until: q.data.until ? toLocalInput(q.data.until) : '' });
  }, [q.data, f]);
  if (!f || !q.data) return <PostSkeleton n={1} />;
  const on = q.data.enabled;

  const save = async (enabled: boolean) => {
    if (enabled && !on && !confirm('开启后，除管理员以外的人都不能使用校墙，直到你解除。确定开启？')) return;
    setBusy(true);
    try {
      const next = await api<MaintenanceConfig>('/admin/maintenance', {
        method: 'PUT',
        body: { enabled, message: f.message, until: f.until ? new Date(f.until).getTime() : null },
      });
      qc.setQueryData(['admin-maintenance'], next);
      await refreshStatus();
      toast(enabled ? (on ? '维护说明已更新' : '已开启维护模式') : '已解除维护，大家可以正常使用了');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`admin-card ${on ? 'maint-on' : ''}`}>
      <div className="setting-row">
        <div>
          <div className="name">
            维护模式 {on && <span className="pill warn">开启中 · {timeAgo(q.data.since ?? Date.now())}开始</span>}
          </div>
          <div className="muted small">开启后普通用户打开校墙只会看到下面这段说明，接口也都暂停；管理员照常使用。解除后会自动恢复，不用刷新。</div>
        </div>
      </div>
      <Field
        label="维护说明"
        multiline
        value={f.message}
        onChange={(v) => setF({ ...f, message: v })}
        maxLength={500}
        counter
        style={{ minHeight: '5em', resize: 'vertical' }}
      />
      <Field
        label="预计恢复时间（选填）"
        type="datetime-local"
        value={f.until}
        onChange={(v) => setF({ ...f, until: v })}
        hint="只用来显示给大家看，到点不会自动解除"
      />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {on ? (
          <>
            <button className="btn btn-primary" disabled={busy} onClick={() => save(false)}>
              解除维护
            </button>
            <button className="btn btn-outline" disabled={busy} onClick={() => save(true)}>
              更新说明
            </button>
          </>
        ) : (
          <button className="btn btn-danger" disabled={busy} onClick={() => save(true)}>
            开启维护模式
          </button>
        )}
      </div>
    </div>
  );
}

function toLocalInput(ts: number) {
  const d = new Date(ts - new Date().getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

function AnnouncementsForm() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin-announcements'], queryFn: () => api<Announcement[]>('/admin/announcements') });
  const blank = { title: '', body: '', link: '', days: '7' };
  const [f, setF] = useState(blank);
  const [busy, setBusy] = useState(false);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['admin-announcements'] });
    qc.invalidateQueries({ queryKey: ['announcements'] });
  };

  const create = async () => {
    if (!f.title.trim()) return toast('请填写标题', 'error');
    setBusy(true);
    try {
      await api('/admin/announcements', { body: { title: f.title, body: f.body, link: f.link, days: Number(f.days) || 7 } });
      setF(blank);
      refresh();
      toast('已发布。大家打开首页就能看到，App 会推送一次');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const end = async (a: Announcement) => {
    if (!confirm(`结束公告「${a.title}」？首页上不再显示。`)) return;
    await api(`/admin/announcements/${a.id}/end`, { method: 'POST' }).catch((e) => toast(e.message, 'error'));
    refresh();
  };
  const remove = async (a: Announcement) => {
    if (!confirm(`删除公告「${a.title}」？`)) return;
    await api(`/admin/announcements/${a.id}`, { method: 'DELETE' }).catch((e) => toast(e.message, 'error'));
    refresh();
  };

  return (
    <>
      <div className="admin-card">
        <div className="name">发布公告</div>
        <p className="muted small">比如学生会活动、放假通知。显示在首页顶部，每个人可以自己关掉；不是置顶帖，不占帖子列表。App 打开了通知的同学会收到一条推送。</p>
        <Field label="标题" value={f.title} onChange={(v) => setF({ ...f, title: v })} maxLength={40} counter />
        <Field label="内容（选填）" multiline value={f.body} onChange={(v) => setF({ ...f, body: v })} maxLength={500} counter style={{ minHeight: '4em', resize: 'vertical' }} />
        <div className="row">
          <Field label="链接（选填）" value={f.link} onChange={(v) => setF({ ...f, link: v })} placeholder="/post/123 或 https://…" hint="站内帖子、吧或外部网页" />
          <Field label="显示天数" inputMode="numeric" value={f.days} onChange={(v) => setF({ ...f, days: v.replace(/\D/g, '').slice(0, 2) })} hint="1–60 天，到期自动下线" />
        </div>
        <div>
          <button className="btn btn-primary" disabled={busy} onClick={create}>
            发布
          </button>
        </div>
      </div>
      {q.data?.map((a) => (
        <div key={a.id} className="table-row">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <b className="ellipsis">{a.title}</b>
              <span className={`pill ${a.active ? 'ok' : ''}`}>{a.active ? '显示中' : '已结束'}</span>
            </div>
            <div className="faint ellipsis" style={{ fontSize: 13 }}>
              {a.author ?? '已注销'} · {fullTime(a.createdAt)} 发布{a.expiresAt && a.active ? ` · ${fullTime(a.expiresAt)} 下线` : ''}
            </div>
          </div>
          {a.active && (
            <button className="btn btn-outline sm" onClick={() => end(a)}>
              结束
            </button>
          )}
          <button className="icon-btn" onClick={() => remove(a)} aria-label="删除">
            <Trash2 size={18} />
          </button>
        </div>
      ))}
    </>
  );
}

/* ---------------- 活动：审核参与、办活动 ---------------- */
function EventsAdminPage() {
  const [tab, setTab] = useState<'pending' | 'done' | 'events'>('pending');
  return (
    <>
      <PageHead
        title="活动"
        sub="带活动话题发的帖子先在这里审核，通过了才发紫水晶"
        right={
          <div className="seg">
            <button className={tab === 'pending' ? 'on' : ''} onClick={() => setTab('pending')}>待审核</button>
            <button className={tab === 'done' ? 'on' : ''} onClick={() => setTab('done')}>已审核</button>
            <button className={tab === 'events' ? 'on' : ''} onClick={() => setTab('events')}>办活动</button>
          </div>
        }
      />
      {tab === 'events' ? (
        <div className="admin-form">
          <EventsForm />
        </div>
      ) : (
        <EntryList status={tab} key={tab} />
      )}
    </>
  );
}

function EntryList({ status }: { status: 'pending' | 'done' }) {
  const qc = useQueryClient();
  const q = useInfiniteList<EventEntry>(['admin-entries', status], `/admin/event-entries?status=${status}`);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['admin-entries'] });
    qc.invalidateQueries({ queryKey: ['admin-entries-count'] });
    qc.invalidateQueries({ queryKey: ['admin-events'] });
  };
  return (
    <InfiniteList
      q={q}
      getKey={(x) => x.id}
      empty={<Empty title={status === 'pending' ? '没有要审核的' : '还没有审核记录'}>{status === 'pending' ? '有人带活动话题发帖后会出现在这里。' : ''}</Empty>}
      render={(x) => <EntryItem x={x} onDone={refresh} />}
    />
  );
}

const ENTRY_STATUS = { pending: ['待审核', 'warn'], approved: ['已通过', 'ok'], rejected: ['已驳回', ''] } as const;

function EntryItem({ x, onDone }: { x: EventEntry; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const p = x.post;
  const gone = !p || p.deleted;
  const act = async (action: 'approve' | 'reject') => {
    setBusy(true);
    try {
      if (action === 'approve') {
        const r = await api<{ gained: number }>(`/admin/event-entries/${x.id}/approve`, { body: {} });
        toast(r.gained ? `已通过，发了 ${r.gained} 颗紫水晶` : '已通过');
      } else {
        await api(`/admin/event-entries/${x.id}/reject`, { body: { note } });
        toast('已驳回，对方会收到通知，可以重新发一条');
      }
      onDone();
    } catch (e) {
      toast((e as Error).message, 'error');
      setBusy(false);
    }
  };
  const [label, tone] = ENTRY_STATUS[x.status];
  return (
    <div className="log-item">
      <Avatar src={x.user?.avatar ?? null} name={x.user?.displayName ?? '?'} size={36} decoration={x.user?.avatarDecoration} />
      <div className="log-body">
        <div className="log-head">
          <span className="name">{x.user?.displayName ?? '已注销'}</span>
          {x.user && <span className="muted">@{x.user.username}</span>}
          <span className="muted">·</span>
          <time className="muted" title={fullTime(x.createdAt)}>{timeAgo(x.createdAt)}</time>
          <span className={`pill ${tone}`}>{label}</span>
        </div>
        <div className="muted small">
          参加 <Link to={`/events/${x.event.id}`}>{x.event.title}</Link> · #{x.event.tag} · 通过后发 {x.reward} 颗
        </div>
        {gone ? (
          <div className="log-content muted">帖子已经删除</div>
        ) : (
          <>
            {p.content && <div className="log-content">{p.content}</div>}
            {p.images.length > 0 && (
              <div className="log-thumbs">
                {p.images.map((src) => (
                  <ContentLink key={src} href={src} image>
                    <MediaImage src={src} alt="查看参与帖子的图片" loading="lazy" />
                  </ContentLink>
                ))}
              </div>
            )}
          </>
        )}
        {x.status === 'rejected' && x.note && <div className="log-reason">驳回理由：{x.note}</div>}
        {rejecting && (
          <div className="entry-reject">
            <Field label="驳回理由（选填，会告诉对方）" value={note} onChange={setNote} maxLength={100} placeholder="比如：和活动无关" />
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-danger sm" disabled={busy} onClick={() => act('reject')}>确认驳回</button>
              <button className="btn btn-outline sm" disabled={busy} onClick={() => setRejecting(false)}>取消</button>
            </div>
          </div>
        )}
        {!gone && (
          <div className="log-meta muted small">
            <Link to={`/post/${p.id}`}>查看帖子 <ExternalLink size={12} /></Link>
          </div>
        )}
      </div>
      {x.status === 'pending' && !rejecting && (
        <div className="log-actions">
          {!gone && (
            <button className="btn btn-outline sm" disabled={busy} onClick={() => act('approve')}>
              <Check size={15} /> 通过
            </button>
          )}
          <button className="btn btn-outline sm danger" disabled={busy} onClick={() => setRejecting(true)}>
            <X size={15} /> 驳回
          </button>
        </div>
      )}
    </div>
  );
}

const EVENT_STATUS = { active: '进行中', upcoming: '未开始', ended: '已结束' } as const;

function EventsForm() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin-events'], queryFn: () => api<CampusEvent[]>('/admin/events') });
  const blank = () => ({
    title: '', body: '', tag: '', postReward: '10', checkinBonus: '1',
    startsAt: toLocalInput(Date.now()), endsAt: toLocalInput(Date.now() + 7 * 86_400_000),
  });
  const [f, setF] = useState(blank);
  const [busy, setBusy] = useState(false);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['admin-events'] });
    qc.invalidateQueries({ queryKey: ['events'] });
    qc.invalidateQueries({ queryKey: ['wallet'] });
  };
  const create = async () => {
    if (!f.title.trim()) return toast('请填写活动名称', 'error');
    if (!f.tag.trim()) return toast('请填写话题', 'error');
    setBusy(true);
    try {
      await api('/admin/events', {
        body: {
          title: f.title, body: f.body, tag: f.tag,
          postReward: Number(f.postReward) || 0, checkinBonus: Number(f.checkinBonus) || 1,
          startsAt: new Date(f.startsAt).getTime(), endsAt: new Date(f.endsAt).getTime(),
        },
      });
      setF(blank());
      refresh();
      toast('活动已创建。开始时 App 会推送一次，首页顶部会显示');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const end = async (e: CampusEvent) => {
    if (!confirm(`提前结束活动「${e.title}」？已经发出去的紫水晶不收回。`)) return;
    await api(`/admin/events/${e.id}/end`, { method: 'POST' }).catch((err) => toast(err.message, 'error'));
    refresh();
  };
  const remove = async (e: CampusEvent) => {
    if (!confirm(`删除活动「${e.title}」？`)) return;
    await api(`/admin/events/${e.id}`, { method: 'DELETE' }).catch((err) => toast(err.message, 'error'));
    refresh();
  };
  return (
    <>
      <div className="admin-card">
        <div className="name">办活动</div>
        <p className="muted small">
          比如校运会、迎新。活动期间带指定话题发一条公开的主帖就算参加，在「待审核」里通过后作者得紫水晶（每人一次）；还可以让签到的紫水晶翻倍。
          开始时 App 推送一次，首页顶部显示活动卡片，活动页列出所有参与的帖子。
        </p>
        <Field label="活动名称" value={f.title} onChange={(v) => setF({ ...f, title: v })} maxLength={30} counter />
        <Field label="介绍（选填）" multiline value={f.body} onChange={(v) => setF({ ...f, body: v })} maxLength={1000} counter style={{ minHeight: '4em', resize: 'vertical' }} />
        <div className="row">
          <Field label="话题" value={f.tag} onChange={(v) => setF({ ...f, tag: v.replace(/^#+/, '') })} placeholder="校运会" hint="大家发帖时带上 #话题 就算参加" maxLength={20} />
          <Field label="发帖奖励" inputMode="numeric" value={f.postReward} onChange={(v) => setF({ ...f, postReward: v.replace(/\D/g, '').slice(0, 2) })} hint="0–50 颗，审核通过才发" />
          <Field label="签到倍数" inputMode="numeric" value={f.checkinBonus} onChange={(v) => setF({ ...f, checkinBonus: v.replace(/[^1-3]/g, '').slice(-1) })} hint="1–3，1 就是不翻倍" />
        </div>
        <div className="row">
          <Field label="开始" type="datetime-local" value={f.startsAt} onChange={(v) => setF({ ...f, startsAt: v })} />
          <Field label="结束" type="datetime-local" value={f.endsAt} onChange={(v) => setF({ ...f, endsAt: v })} hint="最长 31 天" />
        </div>
        <div>
          <button className="btn btn-primary" disabled={busy} onClick={create}>
            创建活动
          </button>
        </div>
      </div>
      {q.data?.map((e) => (
        <div key={e.id} className="table-row">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <b className="ellipsis">{e.title}</b>
              <span className={`pill ${e.status === 'active' ? 'ok' : ''}`}>{EVENT_STATUS[e.status]}</span>
            </div>
            <div className="faint ellipsis" style={{ fontSize: 13 }}>
              #{e.tag} · 发帖 +{e.postReward}{e.checkinBonus > 1 ? ` · 签到 ×${e.checkinBonus}` : ''} · {fullTime(e.startsAt)} – {fullTime(e.endsAt)} · {e.people} 人参加
            </div>
          </div>
          {e.status !== 'ended' && (
            <button className="btn btn-outline sm" onClick={() => end(e)}>
              结束
            </button>
          )}
          {e.status === 'upcoming' && (
            <button className="icon-btn" onClick={() => remove(e)} aria-label="删除">
              <Trash2 size={18} />
            </button>
          )}
        </div>
      ))}
    </>
  );
}

/* ---------------- AI 助手 ---------------- */
function AssistantPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin-assistant'], queryFn: () => api<AssistantConfig>('/admin/assistant') });
  const [f, setF] = useState<AssistantConfig | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (q.data && !f) setF(q.data);
  }, [q.data, f]);
  if (!f) return <PostSkeleton n={2} />;
  const set = (patch: Partial<AssistantConfig>) => setF({ ...f, ...patch });

  const save = async () => {
    setBusy(true);
    try {
      const next = await api<AssistantConfig>('/admin/assistant', {
        method: 'PUT',
        body: { enabled: f.enabled, username: f.username, displayName: f.displayName, model: f.model, persona: f.persona, dailyLimit: f.dailyLimit },
      });
      setF(next);
      qc.setQueryData(['admin-assistant'], next);
      toast(next.enabled ? `已保存。在帖子里 @${next.username} 试试` : '已保存');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHead title="AI 助手" sub={<>在帖子或回复里 @{f.username}，它会在下面简短地回一条。没有单独的聊天界面</>} />
      <div className="admin-form">
        <div className="admin-card setting-row">
          <div>
            <div className="name">开启 AI 助手</div>
            <div className="muted small">
              使用「内容审核」里配置的接口和密钥
              {f.hasKey ? '。' : '，但那里还没有设置密钥，请先去填写。'}
              直接回复它的帖子也会被当作在问它。
            </div>
          </div>
          <Switch on={f.enabled} onChange={(v) => set({ enabled: v })} label="开启 AI 助手" />
        </div>

        <div className="admin-card">
          <div className="name">账号</div>
          <p className="muted small">助手是一个不能登录的账号，带「AI」标签。第一次保存时自动创建，改名字不会丢掉它以前的回复。</p>
          <div className="row">
            <Field label="昵称" value={f.displayName} onChange={(v) => set({ displayName: v })} maxLength={20} />
            <Field label="用户名" value={f.username} onChange={(v) => set({ username: v.replace(/[^A-Za-z0-9_]/g, '') })} prefix="@" maxLength={20} hint="大家 @ 的就是这个" />
          </div>
          {f.botId && f.username === q.data?.username && (
            <div>
              <Link to={`/u/${f.username}`} className="btn btn-outline sm">
                查看主页
              </Link>
            </div>
          )}
        </div>

        <div className="admin-card">
          <div className="name">回复</div>
          <Field
            label="模型（选填）"
            value={f.model}
            onChange={(v) => set({ model: v })}
            placeholder={f.defaultModel}
            hint={`留空使用审核用的模型（${f.defaultModel}）`}
            list="assistant-model-hints"
          />
          <datalist id="assistant-model-hints">
            {MODEL_HINTS[f.provider].map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <Field
            label="每人每天最多问几次"
            inputMode="numeric"
            value={String(f.dailyLimit)}
            onChange={(v) => set({ dailyLimit: Math.min(200, Number(v.replace(/\D/g, '')) || 1) })}
          />
          <Field
            label="补充设定（选填）"
            multiline
            value={f.persona}
            onChange={(v) => set({ persona: v })}
            maxLength={1000}
            counter
            placeholder="例如：学校在杭州；周三下午是社团时间；说话可以活泼一点。"
            hint="回复简短、不写长段落、不帮忙抄作业这些是固定的，这里写学校的背景或者语气"
            style={{ minHeight: '6em', resize: 'vertical' }}
          />
        </div>

        <div>
          <button className="btn btn-primary" disabled={busy} onClick={save}>
            保存
          </button>
        </div>
      </div>
    </>
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

/* ---------------- 举报 ---------------- */
function ReportItem({ g, onDone }: { g: ReportGroup; onDone: (deleted?: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const open = g.status === 'open';
  const versioned = g.batchId != null && g.revision != null;
  const post = g.targetType === 'post' && g.target && 'excerpt' in g.target ? g.target : null;
  const user = g.targetType === 'user' && g.target && 'user' in g.target ? g.target.user : post?.author;

  const handle = async (status: 'resolved' | 'dismissed', deletePost = false) => {
    if (!versioned) return;
    if (deletePost && !confirm(`删除这条${post?.isRepost ? '转发' : '帖子'}并标记举报已处理？举报人会收到通知。`)) return;
    setBusy(true);
    try {
      await api('/admin/reports/settle', {
        body: { batchId: g.batchId, revision: g.revision, status, deletePost },
      });
      toast(status === 'resolved' ? (deletePost ? '已删除并处理' : '已标记为处理完成') : '已驳回');
      onDone(deletePost);
    } catch (e) {
      toast((e as Error).message, 'error');
      if (e instanceof ApiError && e.status === 409) onDone();
    } finally {
      setBusy(false);
    }
  };

  const reasons = [...new Set(g.reports.map((r) => r.reasonText))];
  return (
    <div className="log-item">
      {user ? (
        <Avatar src={user.avatar} name={user.displayName} size={36} decoration={user.avatarDecoration} />
      ) : (
        <span className="avatar" style={{ width: 36, height: 36 }} />
      )}
      <div className="log-body">
        <div className="log-head">
          <span className="pill">{g.targetType === 'post' ? (post?.isRepost ? '转发' : post?.isReply ? '回复' : '帖子') : '用户'}</span>
          {user && (
            <>
              <span className="name">{user.displayName}</span>
              <Link to={`/u/${user.username}`} className="muted">@{user.username}</Link>
            </>
          )}
          <span className="muted">·</span>
          <time className="muted" title={fullTime(g.lastAt)}>{timeAgo(g.lastAt)}</time>
          <span className={`pill ${g.count > 1 ? 'warn' : ''}`}>{g.count} 人举报</span>
          {!open && <span className={`pill ${g.status === 'resolved' ? 'ok' : ''}`}>{g.status === 'resolved' ? '已处理' : '已驳回'}</span>}
        </div>
        {!g.target && <div className="log-content muted">{g.identityUnknown ? '无法确认原举报对象' : '目标已经不存在'}</div>}
        {post && (
          <>
            {post.deleted ? (
              <div className="log-content muted">（帖子已删除）</div>
            ) : (
              post.excerpt && <div className="log-content">{post.excerpt}</div>
            )}
            {!post.deleted && post.images.length > 0 && (
              <div className="log-thumbs">
                {post.images.map((src) => (
                  <ContentLink key={src} href={src} image>
                    <MediaImage src={src} alt="查看被举报的图片" loading="lazy" />
                  </ContentLink>
                ))}
              </div>
            )}
          </>
        )}
        <div className="log-reason">
          {reasons.join('、')}
          {g.reports.filter((r) => r.note && r.reporter).map((r, i) => (
            <div key={i} className="report-note-line">
              <b>{r.reporter!.displayName}</b>：{r.note}
            </div>
          ))}
        </div>
        <div className="log-meta muted small">
          {g.identityUnknown ? (
            <span>原举报对象无法确认，举报人和说明已隐藏，不能处理这批举报</span>
          ) : g.involvesMe ? (
            <span>举报涉及你本人，举报人和说明已隐藏，请交给其他管理员处理</span>
          ) : (
            <span>举报人：{g.reports.map((r) => r.reporter?.displayName).join('、')}{g.count > g.reports.length ? ` 等 ${g.count} 人` : ''}</span>
          )}
          {post && !post.deleted && (
            <Link to={`/post/${post.id}`}>
              查看帖子 <ExternalLink size={12} />
            </Link>
          )}
          {open && !versioned && <span>服务器版本过旧，升级后才能处理举报</span>}
        </div>
      </div>
      {open && versioned && !g.involvesMe && (
        <div className="log-actions">
          {post && !post.deleted && (
            <button className="btn btn-outline sm danger" disabled={busy} onClick={() => handle('resolved', true)}>
              <Trash2 size={15} /> {post.isRepost ? '删除转发' : '删除帖子'}
            </button>
          )}
          <button className="btn btn-outline sm" disabled={busy} onClick={() => handle('resolved')}>
            <Check size={15} /> 已处理
          </button>
          <button className="btn btn-outline sm" disabled={busy} onClick={() => handle('dismissed')}>
            <X size={15} /> 驳回
          </button>
        </div>
      )}
    </div>
  );
}

function Reports() {
  const [status, setStatus] = useState<'open' | 'closed' | 'archived'>('open');
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin-reports', status], queryFn: () => api<ReportGroup[]>(`/admin/reports?status=${status}&batch=1`) });
  const refresh = (deleted = false) => {
    if (deleted) {
      // 删除可能同时影响转发、原帖计数、回复、引用和通知，与普通删帖一致。
      void qc.invalidateQueries();
      return;
    }
    qc.invalidateQueries({ queryKey: ['admin-reports'] });
    qc.invalidateQueries({ queryKey: ['admin-reports-count'] });
  };
  return (
    <>
      <PageHead
        title="举报"
        sub="同学举报的帖子和用户。处理后举报人会收到通知，被举报的人不知道是谁举报的"
        right={
          <div className="seg">
            <button className={status === 'open' ? 'on' : ''} onClick={() => setStatus('open')}>待处理</button>
            <button className={status === 'closed' ? 'on' : ''} onClick={() => setStatus('closed')}>已处理</button>
            <button className={status === 'archived' ? 'on' : ''} onClick={() => setStatus('archived')}>归档</button>
          </div>
        }
      />
      <div className="admin-list">
        {q.isPending ? (
          <PostSkeleton n={2} />
        ) : q.isError ? (
          <Empty title="加载失败">{(q.error as Error).message}</Empty>
        ) : !q.data.length ? (
          <Empty title={status === 'open' ? '没有待处理的举报' : status === 'closed' ? '还没有处理过举报' : '没有归档的举报'} />
        ) : (
          q.data.map((g) => <ReportItem key={g.batchId ?? `${g.targetType}-${g.targetId}-${g.handledAt ?? ''}`} g={g} onDone={refresh} />)
        )}
      </div>
    </>
  );
}
