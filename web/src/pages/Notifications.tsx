import { useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { AtSign, Heart, MessageCircle, Quote, Repeat2, UserPlus } from 'lucide-react';
import { InfiniteList, useInfiniteList } from '../components/Feed';
import { PostCard } from '../components/PostCard';
import { Avatar, Emoji, Empty, TopBar } from '../components/ui';
import { api, type Notification } from '../lib/api';
import { timeAgo } from '../lib/format';

const META = {
  like: { icon: <Heart size={24} fill="var(--like)" color="var(--like)" />, text: '喜欢了你的帖子' },
  repost: { icon: <Repeat2 size={24} color="var(--repost)" strokeWidth={2.4} />, text: '转发了你的帖子' },
  quote: { icon: <Quote size={24} color="var(--accent)" />, text: '引用了你的帖子' },
  follow: { icon: <UserPlus size={24} color="var(--accent)" fill="var(--accent)" />, text: '关注了你' },
  reply: { icon: <MessageCircle size={24} color="var(--accent)" />, text: '回复了你' },
  mention: { icon: <AtSign size={24} color="var(--accent)" />, text: '提到了你' },
  reaction: { icon: null, text: '回应了你的帖子' },
};

function Item({ n }: { n: Notification }) {
  const nav = useNavigate();
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
          {m.text}
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
      <InfiniteList
        q={q}
        empty={<Empty title="暂无通知">别人回复、点赞、回应、转发、引用或关注你时会显示在这里。</Empty>}
        getKey={(n) => n.id}
        render={(n) => <Item n={n} />}
      />
    </>
  );
}
