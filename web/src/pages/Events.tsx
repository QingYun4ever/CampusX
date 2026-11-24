import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CalendarCheck, Check, ChevronRight, Clock, Hash, PartyPopper, Users, XCircle } from 'lucide-react';
import { CrystalIcon } from '../components/Crystal';
import { Feed } from '../components/Feed';
import { useCompose } from '../components/compose';
import { Empty, Spinner, TopBar } from '../components/ui';
import { api, type CampusEvent } from '../lib/api';
import { eventMine, eventPerks, eventRange, eventWhen } from '../lib/events';
import './events.css';

const STATUS = { active: '进行中', upcoming: '即将开始', ended: '已结束' } as const;

/** 活动详情：介绍、奖励、我的参与情况，下面是所有参与的帖子 */
export function EventPage() {
  const id = Number(useParams().id);
  const compose = useCompose();
  const q = useQuery({ queryKey: ['events', id], queryFn: () => api<CampusEvent>(`/events/${id}`) });
  const e = q.data;
  return (
    <>
      <TopBar back title="活动" />
      {q.isPending ? (
        <Spinner />
      ) : !e ? (
        <Empty title="活动不存在">{(q.error as Error | null)?.message}</Empty>
      ) : (
        <>
          <section className="event-hero">
            <div className="event-hero-top">
              <span className={`event-label ${e.status}`}>{STATUS[e.status]}</span>
              <span className="muted small">{eventRange(e)}{e.status !== 'ended' && ` · ${eventWhen(e)}`}</span>
            </div>
            <h1>{e.title}</h1>
            {e.body && <p className="event-body">{e.body}</p>}
            <ul className="event-perks">
              <li>
                <Hash size={18} />
                <span>
                  活动期间带 <Link to={`/t/${encodeURIComponent(e.tag)}`}>#{e.tag}</Link> 发一条帖子
                  {e.postReward ? <>，管理员审核通过后得 <b className="crystal-text">{e.postReward} 颗紫水晶</b>（每人一次）</> : '就算参加'}
                </span>
              </li>
              {e.checkinBonus > 1 && (
                <li>
                  <CalendarCheck size={18} />
                  <span>活动期间每日签到的紫水晶 <b className="crystal-text">×{e.checkinBonus}</b></span>
                </li>
              )}
              <li>
                <Users size={18} />
                <span>{e.people} 人参加 · {e.posts} 条帖子</span>
              </li>
            </ul>
            {e.me.review?.status === 'rejected' ? (
              <div className="event-joined rejected">
                <XCircle size={16} strokeWidth={2.4} />
                <span className="grow">
                  参与没有通过{e.me.review.note ? `：${e.me.review.note}` : ''}
                  {e.status === 'active' && <span className="event-joined-hint">可以改一改，再发一条重新参加</span>}
                </span>
                {e.status === 'active' && (
                  <button className="btn sm btn-primary" onClick={() => compose({ text: `#${e.tag} ` })}>重新参加</button>
                )}
              </div>
            ) : e.me.review?.status === 'pending' && e.postReward ? (
              <div className="event-joined">
                <Clock size={16} strokeWidth={2.4} />
                已参加，等管理员审核，通过后得 <CrystalIcon size={14} /> {e.postReward}
              </div>
            ) : e.me.posted || e.me.rewarded ? (
              <div className="event-joined">
                <Check size={16} strokeWidth={2.6} />
                已参加{e.me.rewarded ? <>，拿到 <CrystalIcon size={14} /> {e.me.rewarded}</> : ''}
                {e.status === 'active' && (
                  <button className="btn sm btn-outline" onClick={() => compose({ text: `#${e.tag} ` })}>再发一条</button>
                )}
              </div>
            ) : e.status === 'active' ? (
              <button className="btn btn-primary event-join" onClick={() => compose({ text: `#${e.tag} ` })}>
                带 #{e.tag} 发帖参加
              </button>
            ) : null}
            <p className="faint small event-note">只算公开的主帖（不在私密吧里，不是回复）。管理员看过参加的帖子才发紫水晶；没通过可以再发一条。拿到奖励后帖子因为违规被删，奖励会扣回。</p>
          </section>
          <Feed
            queryKey={['events', id, 'posts']}
            path={`/events/${id}/posts`}
            empty={<Empty title={e.status === 'upcoming' ? '活动还没开始' : '还没有人参加'}>{e.status === 'active' ? '发第一条吧。' : ''}</Empty>}
          />
        </>
      )}
    </>
  );
}

/** 所有活动 */
export function EventsPage() {
  const q = useQuery({ queryKey: ['events', 'all'], queryFn: () => api<CampusEvent[]>('/events') });
  return (
    <>
      <TopBar back title="活动" />
      {q.isPending ? (
        <Spinner />
      ) : !q.data?.length ? (
        <Empty title="现在没有活动">管理员办活动的时候，这里和首页顶部都会显示。</Empty>
      ) : (
        <div className="event-list">
          {q.data.map((e) => <EventRow key={e.id} e={e} />)}
        </div>
      )}
    </>
  );
}

export function EventRow({ e }: { e: CampusEvent }) {
  return (
    <Link to={`/events/${e.id}`} className={`event-row ${e.status}`}>
      <span className="event-card-icon"><PartyPopper size={18} /></span>
      <span className="grow" style={{ minWidth: 0 }}>
        <span className="event-card-head">
          <span className={`event-label ${e.status}`}>{STATUS[e.status]}</span>
          <b className="ellipsis">{e.title}</b>
        </span>
        <span className="event-card-sub ellipsis">
          {eventMine(e) ?? eventPerks(e).join(' · ')}
          {e.status !== 'ended' ? ` · ${eventWhen(e)}` : ` · ${e.people} 人参加`}
        </span>
      </span>
      <ChevronRight size={18} className="faint" />
    </Link>
  );
}
