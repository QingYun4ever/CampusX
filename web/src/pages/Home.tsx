import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { ArrowUp } from 'lucide-react';
import { Composer } from '../components/Composer';
import { Announcements } from '../components/SiteStatus';
import { EventCards } from '../components/EventCards';
import { Feed } from '../components/Feed';
import { Logo } from '../components/Logo';
import { useAccountSheet } from '../components/Layout';
import { Avatar, Empty, Tabs, TopBar } from '../components/ui';
import { api, type Page, type Post } from '../lib/api';
import { useMe } from '../lib/auth';

type Tab = 'all' | 'following';
const TAB_KEY = 'txq_home_tab';

/** 每分钟看一眼有没有新帖子，有的话在顶部浮出提示，点了才刷新（不打断正在读的内容） */
function NewPostsPill({ tab }: { tab: Tab }) {
  const qc = useQueryClient();
  const [seen, setSeen] = useState<number | null>(null);
  const peek = useQuery({
    queryKey: ['feed-peek', tab],
    queryFn: () => api<Page<Post>>(`/feed?tab=${tab}`),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    staleTime: 0,
  });
  const cached = qc.getQueryData<InfiniteData<Page<Post>>>(['feed', tab]);
  // 首页会把同一个人连着发的帖子错开排，所以按 id 比较，不看第一条是谁
  const firstPage = cached?.pages[0]?.items ?? [];
  const topId = firstPage.length ? Math.max(...firstPage.map((p) => p.id)) : undefined;
  const items = peek.data?.items ?? [];
  const fresh = topId === undefined ? [] : items.filter((p) => p.id > topId);
  const newest = items.length ? Math.max(...items.map((p) => p.id)) : null;
  const show = fresh.length > 0 && newest !== seen;
  const authors = [...new Map(fresh.map((p) => [p.author.id, p.author])).values()].slice(0, 3);

  const refresh = () => {
    setSeen(newest);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    qc.invalidateQueries({ queryKey: ['feed', tab] });
  };

  return (
    <div className="new-pill-wrap">
      <button className={`new-pill ${show ? 'show' : ''}`} onClick={refresh} tabIndex={show ? 0 : -1} aria-hidden={!show}>
        <ArrowUp size={16} strokeWidth={2.6} />
        <span className="stack">
          {authors.map((a) => (
            <Avatar key={a.id} src={a.avatar} name={a.displayName} size={22} decoration={a.avatarDecoration} />
          ))}
        </span>
        {fresh.length >= 20 ? '有新帖子' : `${fresh.length} 条新帖子`}
      </button>
    </div>
  );
}

export function Home() {
  const openAccount = useAccountSheet();
  const me = useMe();
  const [tab, setTab] = useState<Tab>(() => {
    // 从「关注的人发了新帖」通知点进来
    if (new URLSearchParams(window.location.search).get('tab') === 'following') return 'following';
    try {
      return (sessionStorage.getItem(TAB_KEY) as Tab) || 'all';
    } catch {
      return 'all';
    }
  });
  const change = (t: Tab) => {
    setTab(t);
    try {
      sessionStorage.setItem(TAB_KEY, t);
    } catch {
      /* ignore */
    }
    window.scrollTo({ top: 0 });
  };

  return (
    <>
      <TopBar>
        <div className="topbar-row mobile-row">
          <button onClick={openAccount} aria-label="我的账号" className="topbar-avatar">
            <Avatar src={me.avatar} name={me.displayName} size={32} decoration={me.avatarDecoration} />
          </button>
          <span className="topbar-logo">
            <Logo size={26} />
          </span>
          <span style={{ width: 32 }} />
        </div>
        <Tabs
          value={tab}
          onChange={change}
          items={[
            ['all', '全部'],
            ['following', '关注'],
          ]}
        />
      </TopBar>
      <NewPostsPill tab={tab} />
      <EventCards />
      <Announcements />
      <div className="desktop-composer">
        <Composer />
      </div>
      <Feed
        key={tab}
        queryKey={['feed', tab]}
        // promo=1：允许插推流帖子；顶部「有新帖子」的轮询不带，不算曝光
        path={tab === 'all' ? '/feed?tab=all&promo=1' : `/feed?tab=${tab}`}
        empty={
          tab === 'following' ? (
            <Empty
              title="还没有关注的动态"
              action={
                <Link to="/boards" className="btn btn-light">
                  去看看有哪些吧
                </Link>
              }
            >
              关注同学或吧以后，他们的帖子会出现在这里。
            </Empty>
          ) : (
            <Empty title="还没有人发帖">写点什么，你就是第一个。</Empty>
          )
        }
      />
    </>
  );
}
