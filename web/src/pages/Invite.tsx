import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Copy, Link2, RefreshCw, UserPlus } from 'lucide-react';
import { CrystalAmount } from '../components/Crystal';
import { Avatar, Empty, Spinner, toast, TopBar } from '../components/ui';
import { api, WEB_ORIGIN, type InviteInfo } from '../lib/api';
import { timeAgo } from '../lib/format';
import './invite.css';

async function copy(text: string, done: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch {
    toast(text);
  }
}

function Person({ p, rules }: { p: InviteInfo['people'][number]; rules: InviteInfo['rules'] }) {
  return (
    <li className="invite-person">
      <Link to={`/u/${p.username}`} className="invite-person-main">
        <Avatar src={p.avatar} name={p.displayName} size={40} decoration={p.avatarDecoration} />
        <div className="grow">
          <div className="invite-person-name">{p.displayName}</div>
          <div className="faint small">@{p.username} · {timeAgo(p.joinedAt)}加入</div>
        </div>
      </Link>
      {p.status === 'rewarded' ? (
        <span className="invite-state got"><CrystalAmount n={p.reward} size={14} /></span>
      ) : p.status === 'none' ? (
        <span className="invite-state muted" title="同一网络注册的，或者已经拿满奖励人数">不计奖励</span>
      ) : (
        <span className="invite-state muted">签到 {p.checkinDays}/{rules.activeDays} 天</span>
      )}
    </li>
  );
}

export function InvitePage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['my-invites'], queryFn: () => api<InviteInfo>('/me/invites') });
  const [busy, setBusy] = useState(false);
  const create = async (reset: boolean) => {
    if (reset && !confirm('换一个邀请码？旧的会马上失效，已经注册的人不受影响。')) return;
    setBusy(true);
    try {
      qc.setQueryData(['my-invites'], await api<InviteInfo>('/me/invites', { method: 'POST', body: {} }));
      toast(reset ? '已换成新的邀请码' : '邀请码生成好了');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  if (q.isPending) return <><TopBar back title="邀请同学" /><Spinner /></>;
  if (q.isError) return <><TopBar back title="邀请同学" /><Empty title="加载失败">{(q.error as Error).message}</Empty></>;
  const d = q.data;
  const r = d.rules;
  const raw = d.code?.replace(/-/g, '') ?? '';
  const link = `${WEB_ORIGIN}/register?invite=${raw}`;

  return (
    <>
      <TopBar back title="邀请同学" />
      <div className="invite-page">
        <div className="invite-hero">
          <UserPlus size={32} />
          <p>
            同学用你的邀请码注册，签到满 {r.activeDays} 天，你得 <CrystalAmount n={r.reward} size={15} />。
            最多算 {r.maxRewarded} 个人。
          </p>
        </div>

        {!d.enabled ? (
          <div className="invite-card muted">管理员暂时关闭了用户邀请。</div>
        ) : d.code ? (
          <div className="invite-card">
            <div className="faint small">我的邀请码</div>
            <div className="invite-code">{d.code}</div>
            <div className="invite-actions">
              <button className="btn btn-primary" onClick={() => copy(d.code!, '邀请码已复制')}>
                <Copy size={16} /> 复制邀请码
              </button>
              <button
                className="btn btn-outline"
                onClick={() => copy(`来校墙一起玩，邀请码 ${d.code}\n注册：${link}`, '邀请链接已复制')}
              >
                <Link2 size={16} /> 复制链接
              </button>
            </div>
            <button className="invite-reset" disabled={busy} onClick={() => create(true)}>
              <RefreshCw size={13} /> 换一个
            </button>
          </div>
        ) : d.canCreate ? (
          <div className="invite-card">
            <button className="btn btn-primary" disabled={busy} onClick={() => create(false)}>
              {busy ? '…' : '生成我的邀请码'}
            </button>
          </div>
        ) : (
          <div className="invite-card muted">注册满 3 天后就能邀请同学了。</div>
        )}

        <section className="invite-section">
          <h2>
            我邀请的人
            {d.people.length > 0 && (
              <span className="faint small">
                {d.people.length} 人 · 得了 {d.earned} 颗（{d.rewardedCount}/{r.maxRewarded}）
              </span>
            )}
          </h2>
          {d.people.length ? (
            <ul className="invite-people">{d.people.map((p) => <Person key={p.id} p={p} rules={r} />)}</ul>
          ) : (
            <p className="muted small">还没有人用你的邀请码注册。</p>
          )}
        </section>

        <ul className="invite-rules">
          <li>和你在同一个网络（同一个 Wi-Fi）注册的人不计奖励。</li>
          <li>每个网络最多注册几个账号，管理员定的；小号注册不了，也拿不到奖励。</li>
          <li>一个邀请码最多邀请 {r.maxInvites} 个人。</li>
        </ul>
      </div>
    </>
  );
}
