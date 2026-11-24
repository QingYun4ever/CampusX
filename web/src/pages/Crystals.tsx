import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarCheck, Check, ChevronRight } from 'lucide-react';
import { CrystalIcon } from '../components/Crystal';
import { InfiniteList, useInfiniteList } from '../components/Feed';
import { Empty, Spinner, toast, TopBar } from '../components/ui';
import { api, type CrystalEntry, type Wallet } from '../lib/api';
import { useMe } from '../lib/auth';
import { useSetWallet, useWallet } from '../lib/crystals';
import { DECORATIONS } from '../lib/decorations';
import { timeAgo } from '../lib/format';


/** 新手任务没完成时去哪儿做 */
const TASK_LINK: Record<string, (username: string) => string | null> = {
  avatar: (u) => `/u/${u}`,
  bio: (u) => `/u/${u}`,
  post: () => '/',
  board: () => '/boards',
  follow: () => '/search',
  checkin: () => null,
};

const decorationName = (id: string) => DECORATIONS.find((d) => d.id === id)?.name ?? id;

function entryText(e: CrystalEntry, tasks: Wallet['tasks']) {
  switch (e.kind) {
    case 'checkin': return '每日签到';
    case 'liked': return '帖子被赞或回应';
    case 'task': return `新手任务：${tasks.find((t) => t.id === e.ref)?.title ?? e.ref}`;
    case 'buy': return `解锁装扮：${decorationName(e.ref.replace(/^decoration:/, ''))}`;
    case 'tip_in': return '收到打赏';
    case 'tip_out': return '打赏';
    case 'revoke': return '帖子被删，扣回被赞所得';
    case 'admin': return '管理员调整';
    default: return e.kind;
  }
}

function CheckinCard({ w }: { w: Wallet }) {
  const setWallet = useSetWallet();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const r = await api<{ gained: number; wallet: Wallet }>('/me/crystals/checkin', { method: 'POST', body: {} });
      setWallet(r.wallet);
      if (r.gained) toast(`签到成功，紫水晶 +${r.gained}`);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="crystal-checkin">
      <CalendarCheck size={22} />
      <div className="grow">
        <b>{w.checkedIn ? '今天已签到' : `今天签到 +${w.checkinReward}`}</b>
        <div className="muted small">
          {w.streak ? `已连续签到 ${w.streak} 天` : '每天签到一次'}
          {' · '}每连签 7 天多 1 颗，最多 +{w.rules.checkinBase + w.rules.checkinStreakMax}
        </div>
      </div>
      <button className={`btn sm ${w.checkedIn ? 'btn-outline' : 'btn-primary'}`} disabled={w.checkedIn || busy} onClick={run}>
        {w.checkedIn ? <><Check size={15} strokeWidth={2.5} />已签到</> : '签到'}
      </button>
    </div>
  );
}

function Tasks({ w }: { w: Wallet }) {
  const me = useMe();
  const setWallet = useSetWallet();
  const [busy, setBusy] = useState<string | null>(null);
  const left = w.tasks.filter((t) => !t.claimed);
  if (!left.length) return null;
  const claim = async (id: string) => {
    setBusy(id);
    try {
      const r = await api<{ gained: number; wallet: Wallet }>(`/me/crystals/tasks/${id}/claim`, { method: 'POST', body: {} });
      setWallet(r.wallet);
      toast(`紫水晶 +${r.gained}`);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="crystal-section">
      <h2>新手任务</h2>
      <div className="crystal-tasks">
        {w.tasks.map((t) => {
          const link = TASK_LINK[t.id]?.(me.username);
          return (
            <div className={`crystal-task ${t.claimed ? 'claimed' : ''}`} key={t.id}>
              <span className="grow">{t.title}</span>
              <span className="crystal-reward">+{t.reward}</span>
              {t.claimed ? (
                <span className="crystal-task-state"><Check size={15} strokeWidth={2.5} />已领取</span>
              ) : t.done ? (
                <button className="btn sm btn-primary" disabled={busy !== null} onClick={() => claim(t.id)}>领取</button>
              ) : link ? (
                <Link className="btn sm btn-outline" to={link}>去完成</Link>
              ) : (
                <span className="crystal-task-state muted">未完成</span>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Rules({ w }: { w: Wallet }) {
  const r = w.rules;
  return (
    <section className="crystal-section">
      <h2>怎么获得</h2>
      <ul className="crystal-rules">
        <li><b>每日签到</b>：+{r.checkinBase}，连签越久越多。在这里签，或者在任意一个吧签到都算</li>
        <li><b>帖子被赞或回应</b>：每个人每天给你算 1 次，每天最多 +{r.likedDailyCap}（今天已得 {w.likedToday}）。注册不满 {r.newAccountDays} 天的账号点的赞不算</li>
        <li><b>新手任务</b>：每项领一次</li>
        <li><b>别人打赏</b>：好帖子会收到别人送的紫水晶</li>
      </ul>
      <h2>怎么用</h2>
      <ul className="crystal-rules">
        <li><b>解锁头像装扮</b>：<Link to="/market?tab=halo">去商场看看</Link></li>
        <li><b>打赏</b>：在帖子的「…」菜单里送给作者，每天最多 {r.tipDailyCap} 颗</li>
      </ul>
      <p className="muted small">帖子因为违规被删除，它被赞得到的紫水晶会扣回。</p>
    </section>
  );
}

function History({ w }: { w: Wallet }) {
  const q = useInfiniteList<CrystalEntry>(['crystal-log'], '/me/crystals/log');
  return (
    <section className="crystal-section">
      <h2>明细</h2>
      <InfiniteList
        q={q}
        getKey={(e) => e.id}
        empty={<Empty title="还没有记录">签到或者发帖被赞，就会有紫水晶。</Empty>}
        render={(e) => {
          const body = (
            <>
              <div className="grow">
                <div>{entryText(e, w.tasks)}</div>
                <div className="faint small">{timeAgo(e.createdAt)}</div>
              </div>
              <b className={e.delta > 0 ? 'plus' : 'minus'}>{e.delta > 0 ? `+${e.delta}` : e.delta}</b>
            </>
          );
          return e.postId && e.kind !== 'revoke' ? (
            <Link className="crystal-entry" to={`/post/${e.postId}`}>{body}<ChevronRight size={16} className="faint" /></Link>
          ) : (
            <div className="crystal-entry">{body}</div>
          );
        }}
      />
    </section>
  );
}

export function Crystals() {
  const q = useWallet();
  return (
    <>
      <TopBar back title="紫水晶" />
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <Empty title="加载失败">{(q.error as Error).message}</Empty>
      ) : (
        <div className="crystals">
          <div className="crystal-hero">
            <CrystalIcon size={44} />
            <div className="crystal-balance">{q.data.balance.toLocaleString('zh-CN')}</div>
            <div className="muted">颗紫水晶 · 全站通用，可以解锁头像装扮、给好帖子打赏</div>
          </div>
          <CheckinCard w={q.data} />
          <Tasks w={q.data} />
          <Rules w={q.data} />
          <History w={q.data} />
        </div>
      )}
    </>
  );
}
