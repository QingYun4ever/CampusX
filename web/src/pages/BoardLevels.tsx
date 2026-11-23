import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarCheck, ChevronRight } from 'lucide-react';
import { LevelBadge, LevelBar, tierOf } from '../components/Level';
import { Avatar, Empty, Modal, Spinner, Tabs, toast, Verified } from '../components/ui';
import { api, type Board, type BoardDetail, type MyLevel, type RankingItem } from '../lib/api';
import { useMe } from '../lib/auth';

const fmt = (n: number) => n.toLocaleString('zh-CN');

/** 北京时间的日期，签到按这个算 */
const bjDay = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

/**
 * 页面开着跨过北京时间零点：重新取吧和吧列表，签到按钮回到「签到」。
 * 手机锁屏时定时器可能不准，回到前台时也看一眼。
 */
function useDayRollover() {
  const qc = useQueryClient();
  useEffect(() => {
    let day = bjDay();
    const check = () => {
      if (bjDay() === day) return;
      day = bjDay();
      void qc.invalidateQueries({ queryKey: ['board'] });
      void qc.invalidateQueries({ queryKey: ['boards'] });
      void qc.invalidateQueries({ queryKey: ['board-ranking'] });
    };
    const msToMidnight = 86400_000 - ((Date.now() + 8 * 3600_000) % 86400_000) + 1000;
    let timer = setTimeout(function tick() {
      check();
      timer = setTimeout(tick, 86400_000);
    }, msToMidnight);
    const onVisible = () => document.visibilityState === 'visible' && check();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [qc]);
}

/** 等级变了：已经显示的帖子上的牌子也要换 */
function refreshPostBadges(qc: ReturnType<typeof useQueryClient>, slug?: string) {
  for (const k of ['feed', 'post', 'replies', 'user-posts', 'tag-posts', 'search-posts']) void qc.invalidateQueries({ queryKey: [k] });
  void qc.invalidateQueries({ queryKey: slug ? ['board-posts', slug] : ['board-posts'] });
  void qc.invalidateQueries({ queryKey: slug ? ['board-pinned', slug] : ['board-pinned'] });
}

/** 能改头衔：吧主或站点管理员（和后端一样，不看有没有关注） */
function useCanEditTitles(b: BoardDetail) {
  const me = useMe();
  return b.myRole === 'owner' || me.role === 'admin';
}

/** 签到；成功后刷新吧详情和吧列表 */
function useCheckin(slug: string) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [gain, setGain] = useState<{ n: number; key: number } | null>(null);
  const run = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api<{ gained: number; already: boolean; me: MyLevel }>(`/boards/${slug}/checkin`, { method: 'POST', body: {} });
      const before = qc.getQueryData<BoardDetail>(['board', slug])?.me?.level;
      qc.setQueryData<BoardDetail>(['board', slug], (b) => (b ? { ...b, me: r.me } : b));
      if (before !== undefined && before !== r.me.level) refreshPostBadges(qc, slug);
      if (r.gained) {
        setGain({ n: r.gained, key: Date.now() });
        toast(r.me.streak > 1 ? `签到成功，经验 +${r.gained}，已连签 ${r.me.streak} 天` : `签到成功，经验 +${r.gained}`);
      }
      void qc.invalidateQueries({ queryKey: ['boards'] });
      void qc.invalidateQueries({ queryKey: ['board-ranking', slug] });
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return { run, busy, gain };
}

/** 吧首页：我的等级、经验条和签到按钮（加入了才显示） */
export function LevelStrip({ b }: { b: BoardDetail }) {
  const [open, setOpen] = useState(false);
  const checkin = useCheckin(b.slug);
  const canEdit = useCanEditTitles(b);
  useDayRollover();
  const m = b.me;
  if (!m) {
    // 没关注的吧主 / 管理员也要能改头衔
    if (!canEdit) return null;
    return (
      <>
        <button className="board-team" onClick={() => setOpen(true)}>
          <span className="team-part">等级头衔</span>
          <ChevronRight size={16} className="muted chev" aria-hidden />
        </button>
        {open && <LevelModal b={b} onClose={() => setOpen(false)} />}
      </>
    );
  }
  return (
    <div className="level-strip">
      <button className="level-strip-main" onClick={() => setOpen(true)} aria-label="我的等级和排行">
        <LevelBadge level={m.level} title={m.title} />
        <span className="level-strip-exp">
          <LevelBar exp={m.exp} from={m.levelExp} to={m.nextExp} level={m.level} />
          <small>
            经验 {fmt(m.exp)}
            {m.nextExp !== null ? ` / ${fmt(m.nextExp)}` : ' · 满级'}
          </small>
        </span>
        <ChevronRight size={16} className="chev" aria-hidden />
      </button>
      <button
        className={`btn sm checkin-btn ${m.checkedIn ? 'btn-outline done' : 'btn-primary'}`}
        onClick={m.checkedIn ? () => setOpen(true) : checkin.run}
        disabled={checkin.busy}
        title={m.checkedIn ? `今天已签到，连签 ${m.streak} 天` : `签到 +${m.nextCheckinExp} 经验`}
      >
        {m.checkedIn ? (m.streak > 1 ? `连签 ${m.streak} 天` : '已签到') : <><CalendarCheck size={16} /> 签到</>}
        {checkin.gain && <span key={checkin.gain.key} className="gain">+{checkin.gain.n}</span>}
      </button>
      {open && <LevelModal b={b} onClose={() => setOpen(false)} />}
    </div>
  );
}

type Tab = 'rank' | 'titles' | 'rules';

function LevelModal({ b, onClose }: { b: BoardDetail; onClose: () => void }) {
  const m = b.me;
  const [tab, setTab] = useState<Tab>(m ? 'rank' : 'titles');
  // 头衔草稿放在这里：切到别的标签再回来不会丢
  const [draft, setDraft] = useState<string[] | null>(null);
  const toNext = m && m.nextExp !== null ? m.nextExp - m.exp : 0;
  return (
    <Modal title={m ? `${b.name}吧 · 我的等级` : `${b.name}吧 · 等级头衔`} onClose={onClose}>
      <div className="level-sheet">
        {m && (
        <div className="level-sheet-head">
          <div className="row">
            <LevelBadge level={m.level} title={m.title} className="big" />
            <span>
              {m.nextExp !== null ? (
                <>
                  还差 <b>{fmt(toNext)}</b> 经验升 {m.level + 1} 级
                </>
              ) : (
                '已经满级了'
              )}
            </span>
          </div>
          <LevelBar exp={m.exp} from={m.levelExp} to={m.nextExp} level={m.level} />
          <div className="level-facts">
            <span>
              经验 <b>{fmt(m.exp)}</b>
            </span>
            <span>
              连签 <b>{m.streak}</b> 天
            </span>
            <span>
              累计签到 <b>{m.checkinTotal}</b> 天
            </span>
          </div>
        </div>
        )}
        <Tabs
          value={tab}
          onChange={setTab}
          items={[
            ['rank', '排行'],
            ['titles', '等级头衔'],
            ['rules', '怎么升级'],
          ]}
        />
        {tab === 'rank' && <Ranking slug={b.slug} />}
        {tab === 'titles' && <Titles b={b} draft={draft} setDraft={setDraft} />}
        {tab === 'rules' && <Rules />}
      </div>
    </Modal>
  );
}

function Ranking({ slug }: { slug: string }) {
  const q = useQuery({
    queryKey: ['board-ranking', slug],
    queryFn: () => api<{ items: RankingItem[]; me: (MyLevel & { rank: number | null }) | null }>(`/boards/${slug}/ranking`),
  });
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Empty title="加载失败" />;
  const { items, me } = q.data;
  if (!items.length) return <Empty title="还没有人有经验">签到、发帖就能上榜。</Empty>;
  const meOnList = me?.rank && me.rank <= items.length;
  return (
    <div>
      {me && !meOnList && (
        <div className="rank-row me">
          <span className="rank top">{me.rank ?? '–'}</span>
          <span className="who">
            <span className="name">我</span>
          </span>
          <LevelBadge level={me.level} title={me.title} />
          <span className="exp">{fmt(me.exp)}</span>
        </div>
      )}
      {items.map((x) => (
        <Link key={x.user.id} to={`/u/${x.user.username}`} className={`rank-row ${me?.rank === x.rank ? 'me' : ''}`}>
          <span className={`rank ${x.rank <= 3 ? 'top' : ''}`}>{x.rank}</span>
          <Avatar src={x.user.avatar} name={x.user.displayName} size={36} decoration={x.user.avatarDecoration} />
          <span className="who">
            <span className="name">
              <span className="ellipsis">{x.user.displayName}</span>
              <Verified user={x.user} size={15} />
            </span>
            <LevelBadge level={x.level} title={x.title} />
          </span>
          <span className="exp">{fmt(x.exp)}</span>
        </Link>
      ))}
    </div>
  );
}

function Titles({ b, draft, setDraft }: { b: BoardDetail; draft: string[] | null; setDraft: (d: string[] | null | ((d: string[] | null) => string[] | null)) => void }) {
  const qc = useQueryClient();
  const canEdit = useCanEditTitles(b);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const next = await api<BoardDetail>(`/boards/${b.slug}`, {
        method: 'PATCH',
        body: { levelTitles: draft.map((x, i) => x.trim() || b.levels.defaults[i]) },
      });
      qc.setQueryData(['board', b.slug], next);
      refreshPostBadges(qc, b.slug);
      void qc.invalidateQueries({ queryKey: ['board-ranking', b.slug] });
      setDraft(null);
      toast('头衔已保存');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      {b.levels.titles.map((t, i) => {
        const lv = i + 1;
        return (
          <div key={lv}>
            {i > 0 && tierOf(lv) !== tierOf(lv - 1) && <div className="tier-gap" />}
            <div className={`title-row ${b.me?.level === lv ? 'current' : ''}`}>
              <LevelBadge level={lv} title={t} compact />
              {draft ? (
                <input
                  value={draft[i]}
                  maxLength={8}
                  readOnly={busy}
                  placeholder={b.levels.defaults[i]}
                  aria-label={`${lv} 级头衔`}
                  onChange={(e) => setDraft((d) => d!.map((x, j) => (j === i ? e.target.value : x)))}
                />
              ) : (
                <span>
                  {t}
                  {b.me?.level === lv && <span className="muted"> · 我在这</span>}
                </span>
              )}
              <span className="exp">{fmt(b.levels.exp[i])}</span>
            </div>
          </div>
        );
      })}
      {canEdit &&
        (draft ? (
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="btn btn-outline" onClick={() => setDraft(null)} disabled={busy}>
              取消
            </button>
            <button className="btn btn-outline" onClick={() => setDraft([...b.levels.defaults])} disabled={busy}>
              恢复默认
            </button>
            <button className="btn btn-primary" style={{ marginLeft: 'auto' }} onClick={save} disabled={busy}>
              保存
            </button>
          </div>
        ) : (
          <>
            <button className="btn btn-outline" style={{ marginTop: 12, width: '100%' }} onClick={() => setDraft([...b.levels.titles])}>
              编辑头衔
            </button>
            <p className="level-note">头衔最多 8 个字，留空就用默认的。改完吧里所有人的牌子都会跟着变。</p>
          </>
        ))}
    </div>
  );
}

function Rules() {
  return (
    <div>
      <ul className="level-rules">
        <li>
          <b>签到 +6</b>：每个吧每天一次；连签每满 7 天多 1 点，最多 +10。断签一天重新算。
        </li>
        <li>
          <b>发主题帖 +4</b>，<b>回复 +2</b>：少于 5 个字又没带图的回复不算。每个吧每天最多从发帖拿 40 点。
        </li>
        <li>
          <b>被点赞 / 被回应 +1</b>：同一个人一天只算一次，每天最多 10 点。自己赞自己不算。
        </li>
        <li>帖子过了审核才加经验；被吧务或管理员当作违规删掉，会扣回这条帖子给的经验。</li>
        <li>退出吧不会清空经验，只是不显示牌子，重新加入就回来了。</li>
      </ul>
      <p className="level-note">
        牌子颜色：1–3 级绿牌，4–9 级蓝牌，10–15 级黄牌，16–18 级橙牌。每天都来的话，大概半年到一学年能拿到黄牌。
      </p>
      <p className="level-note">
        <Link to="/help#levels">在帮助里查看完整等级表</Link>
      </p>
    </div>
  );
}

/** 吧列表顶部：一键签到所有加入了的吧 */
export function CheckinAll({ boards }: { boards: Board[] }) {
  const qc = useQueryClient();
  useDayRollover();
  const [busy, setBusy] = useState(false);
  const pending = boards.filter((b) => b.myLevel && !b.myLevel.checkedIn).length;
  const joined = boards.some((b) => b.myLevel);
  if (!joined) return null;
  const run = async () => {
    setBusy(true);
    try {
      const r = await api<{ count: number; gained: number }>('/checkin/all', { method: 'POST', body: {} });
      toast(r.count ? `签到了 ${r.count} 个吧，经验一共 +${r.gained}` : '今天都签过了');
      await qc.invalidateQueries({ queryKey: ['boards'] });
      void qc.invalidateQueries({ queryKey: ['board'] });
      void qc.invalidateQueries({ queryKey: ['board-ranking'] });
      if (r.count) refreshPostBadges(qc);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <button className={`btn sm ${pending ? 'btn-primary' : 'btn-outline'}`} onClick={run} disabled={busy || !pending}>
      <CalendarCheck size={16} />
      {pending ? (
        <>
          <span className="checkin-all-long">一键</span>签到 · {pending}
        </>
      ) : (
        '今天都签了'
      )}
    </button>
  );
}
