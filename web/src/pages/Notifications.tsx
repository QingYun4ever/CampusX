import { useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { AtSign, Heart, MessageCircle, Quote, Repeat2, ShieldAlert, ShieldCheck, UserPlus } from 'lucide-react';
import { InfiniteList, useInfiniteList } from '../components/Feed';
import { PostCard } from '../components/PostCard';
import { Avatar, Emoji, Empty, TopBar } from '../components/ui';
import { api, type Notification } from '../lib/api';
import { PushAsk } from './AppSettings';
import { CrystalIcon } from '../components/Crystal';
import { timeAgo } from '../lib/format';

const META = {
  like: { icon: <Heart size={24} fill="var(--like)" color="var(--like)" />, text: '喜欢了你的帖子' },
  repost: { icon: <Repeat2 size={24} color="var(--repost)" strokeWidth={2.4} />, text: '转发了你的帖子' },
  quote: { icon: <Quote size={24} color="var(--accent)" />, text: '引用了你的帖子' },
  follow: { icon: <UserPlus size={24} color="var(--accent)" fill="var(--accent)" />, text: '关注了你' },
  reply: { icon: <MessageCircle size={24} color="var(--accent)" />, text: '回复了你' },
  mention: { icon: <AtSign size={24} color="var(--accent)" />, text: '提到了你' },
  reaction: { icon: null, text: '回应了你的帖子' },
  moderation: { icon: null, text: '' },
  report: { icon: null, text: '' },
  tip: { icon: <CrystalIcon size={26} />, text: '打赏了你的帖子' },
};

/** 举报处理完成 */
function ReportItem({ n }: { n: Notification }) {
  let info: { targetType?: string; status?: string } = {};
  try {
    info = JSON.parse(n.extra || '{}');
  } catch {
    /* 忽略 */
  }
  return (
    <div className={`notif notif-system ${n.read ? '' : 'unread'}`}>
      <div className="notif-icon">
        <ShieldCheck size={24} color="var(--accent)" />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div>
          {info.status === 'dismissed' ? (
            <>
              <b>举报结果</b>：你举报的{info.targetType === 'user' ? '用户' : '帖子'}，管理员看过了，暂时没有发现违规。还是谢谢你的反馈
            </>
          ) : (
            <>
              <b>举报已处理</b>：你举报的{info.targetType === 'user' ? '用户' : '帖子'}，管理员已经处理。感谢你帮校墙变得更好
            </>
          )}
          <span className="faint"> · {timeAgo(n.createdAt)}</span>
        </div>
      </div>
    </div>
  );
}

/** 内容没通过审核：系统通知，带理由和警告次数 */
function ModerationItem({ n }: { n: Notification }) {
  let info: { reason?: string; excerpt?: string; warnings?: number } = {};
  try {
    info = JSON.parse(n.extra || '{}');
  } catch {
    /* 忽略 */
  }
  return (
    <div className={`notif notif-system ${n.read ? '' : 'unread'}`}>
      <div className="notif-icon">
        <ShieldAlert size={24} color="var(--danger)" />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div>
          <b>内容警告</b>：你的帖子没有通过审核，没有发布
          <span className="faint"> · {timeAgo(n.createdAt)}</span>
        </div>
        {info.excerpt && <div className="muted clamp notif-excerpt">{info.excerpt}</div>}
        {info.reason && <div className="notif-reason">原因：{info.reason}</div>}
        {!!info.warnings && <div className="faint small">这是第 {info.warnings} 次警告，多次违规可能会被限制账号。</div>}
      </div>
    </div>
  );
}

function Item({ n }: { n: Notification }) {
  const nav = useNavigate();
  if (n.type === 'moderation') return <ModerationItem n={n} />;
  if (n.type === 'report') return <ReportItem n={n} />;
  // 回复和 @ 直接展示完整帖子，可以就地互动
  if ((n.type === 'reply' || n.type === 'mention') && n.post) {
    return (
      <div className={n.read ? '' : 'unread-wrap'}>
        <PostCard post={n.post} />
      </div>
    );
  }
  const m = META[n.type];
  return (
    <div
      className={`notif ${n.read ? '' : 'unread'}`}
      onClick={() => nav(n.post ? `/post/${n.post.id}` : `/u/${n.actor.username}`)}
    >
      <div className="notif-icon">{m.icon ?? (n.extra ? <Emoji e={n.extra} size={26} /> : null)}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Link to={`/u/${n.actor.username}`} onClick={(e) => e.stopPropagation()}>
          <Avatar src={n.actor.avatar} name={n.actor.displayName} size={32} decoration={n.actor.avatarDecoration} />
        </Link>
        <div style={{ marginTop: 8 }}>
          <Link to={`/u/${n.actor.username}`} className="name" onClick={(e) => e.stopPropagation()}>
            {n.actor.displayName}
          </Link>{' '}
          {n.type === 'tip' ? `打赏了你 ${n.extra} 颗紫水晶` : m.text}
          <span className="faint"> · {timeAgo(n.createdAt)}</span>
        </div>
        {n.post && (
          n.type === 'quote' ? (
            <Link to={`/post/${n.post.id}`} className="muted clamp" style={{ marginTop: 4 }} onClick={(e) => e.stopPropagation()}>
              {n.post.content || '[图片]'}
            </Link>
          ) : (
            <div className="muted clamp" style={{ marginTop: 4 }}>
              {n.post.content || (n.post.images.length ? '[图片]' : '')}
            </div>
          )
        )}
      </div>
    </div>
  );
}

export function Notifications() {
  const qc = useQueryClient();
  const q = useInfiniteList<Notification>(['notifications'], '/notifications');

  // 进入页面后把未读标记为已读（列表里的高亮保留到下次进入）
  useEffect(() => {
    if (!q.isSuccess) return;
    api('/notifications/read-all', { method: 'POST' })
      .then(() => qc.setQueryData(['unread'], { count: 0 }))
      .catch(() => {});
  }, [q.isSuccess, qc]);

  return (
    <>
      <TopBar title="通知" />
      <PushAsk />
      <InfiniteList
        q={q}
        empty={<Empty title="暂无通知">别人回复、点赞、回应、转发、引用或关注你时会显示在这里。</Empty>}
        getKey={(n) => n.id}
        render={(n) => <Item n={n} />}
      />
    </>
  );
}
