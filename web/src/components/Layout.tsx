import { createContext, useContext, useEffect, useState, type FormEvent } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowUpRight,
  Bell,
  Feather,
  Hash,
  Home,
  LayoutGrid,
  LogOut,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  Shield,
  User as UserIcon,
} from 'lucide-react';
import { api, type Board, type User } from '../lib/api';
import { useAuth, useMe } from '../lib/auth';
import { getNavCollapsed, setNavCollapsed } from '../lib/theme';
import { useCompose } from './compose';
import { FollowButton } from './FollowButton';
import { Logo } from './Logo';
import { preloadMarkdown } from './PostCard';
import { Avatar, BoardMark, Modal, useModalClose, usePopover, Verified } from './ui';

function useUnread() {
  return useQuery({
    queryKey: ['unread'],
    queryFn: () => api<{ count: number }>('/notifications/unread-count'),
    refetchInterval: 30_000,
    select: (d) => d.count,
  });
}

function Badge({ n }: { n?: number }) {
  if (!n) return null;
  return (
    <span className="badge" key={n}>
      {n > 99 ? '99+' : n}
    </span>
  );
}

// 这些图标在选中时可以实心填充
const FILLABLE = new Set([Home, Bell, UserIcon, LayoutGrid]);

/* ---------- 账号菜单：桌面端左下角弹出，手机上是底部弹层 ---------- */
function AccountMenuItems({ onDone }: { onDone: () => void }) {
  const me = useMe();
  const { signOut } = useAuth();
  return (
    <>
      <Link to={`/u/${me.username}`} className="account-head" onClick={onDone}>
        <Avatar src={me.avatar} name={me.displayName} size={44} />
        <div style={{ minWidth: 0 }}>
          <div className="name">
            <span className="ellipsis">{me.displayName}</span>
            <Verified user={me} size={16} />
          </div>
          <div className="muted ellipsis small">
            @{me.username}
            {me.className && ` · ${me.className}`}
          </div>
        </div>
      </Link>
      <hr />
      <Link to={`/u/${me.username}`} onClick={onDone}>
        <UserIcon size={18} /> 个人主页
      </Link>
      <Link to="/settings" onClick={onDone}>
        <Settings size={18} /> 设置
      </Link>
      {me.role === 'admin' && (
        <Link to="/admin" onClick={onDone}>
          <Shield size={18} /> 管理后台
          <ArrowUpRight size={15} className="menu-trail" />
        </Link>
      )}
      <hr />
      <button className="danger" onClick={signOut}>
        <LogOut size={18} /> 退出登录
      </button>
    </>
  );
}

function AccountSheetBody() {
  const close = useModalClose();
  return (
    <div className="menu sheet-menu">
      <AccountMenuItems onDone={close} />
    </div>
  );
}

const AccountSheetCtx = createContext<() => void>(() => {});
/** 手机端打开账号菜单（顶栏头像、底栏「我」都用它） */
export const useAccountSheet = () => useContext(AccountSheetCtx);

function Nav({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const me = useMe();
  const compose = useCompose();
  const unread = useUnread().data;
  const menu = usePopover();
  const items: [string, string, typeof Home, number?][] = [
    ['/', '首页', Home],
    ['/boards', '吧', LayoutGrid],
    ['/search', '搜索', Search],
    ['/notifications', '通知', Bell, unread],
  ];

  return (
    <nav className="nav">
      <div className="nav-top">
        <Link to="/" className="brand" aria-label="同学圈首页">
          <Logo size={30} />
        </Link>
        <button
          className="icon-btn nav-toggle"
          onClick={onToggle}
          aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'}
          title={collapsed ? '展开侧边栏' : '收起侧边栏'}
        >
          {collapsed ? <PanelLeftOpen size={20} /> : <PanelLeftClose size={20} />}
        </button>
      </div>
      {items.map(([to, label, Icon, badge]) => (
        <NavLink
          key={to}
          to={to}
          end={to === '/'}
          title={collapsed ? label : undefined}
          className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
        >
          {({ isActive }) => (
            <>
              <span className="nav-ico">
                <Icon
                  size={26}
                  strokeWidth={isActive ? 2.4 : 1.8}
                  fill={isActive && FILLABLE.has(Icon) ? 'currentColor' : 'none'}
                />
                <Badge n={badge} />
              </span>
              <span className="label">{label}</span>
            </>
          )}
        </NavLink>
      ))}
      <button className="btn btn-primary nav-post" onClick={() => compose()} title={collapsed ? '发帖' : undefined}>
        <Feather size={22} className="mobile-icon" />
        <span className="label">发帖</span>
      </button>
      <div className="nav-user-wrap" ref={menu.ref}>
        {menu.open && (
          <div className="menu up account-menu" role="menu">
            <AccountMenuItems onDone={() => menu.setOpen(false)} />
          </div>
        )}
        <button
          className={`nav-user ${menu.open ? 'open' : ''}`}
          onClick={() => menu.setOpen((m) => !m)}
          aria-expanded={menu.open}
          aria-haspopup="menu"
          aria-label="账号菜单"
        >
          <Avatar src={me.avatar} name={me.displayName} size={40} />
          <div className="meta">
            <div className="name">
              <span className="ellipsis">{me.displayName}</span>
              <Verified user={me} size={16} />
            </div>
            <div className="muted ellipsis">@{me.username}</div>
          </div>
          <MoreHorizontal size={18} className="meta" />
        </button>
      </div>
    </nav>
  );
}

function Side() {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const boards = useQuery({ queryKey: ['boards'], queryFn: () => api<Board[]>('/boards'), staleTime: 60_000 });
  const suggested = useQuery({
    queryKey: ['suggested'],
    queryFn: () => api<User[]>('/users/suggested'),
    staleTime: 5 * 60_000,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (q.trim()) nav(`/search?q=${encodeURIComponent(q.trim())}`);
  };
  const tags = useQuery({
    queryKey: ['trending-tags'],
    queryFn: () => api<{ tag: string; count: number }[]>('/tags/trending'),
    staleTime: 60_000,
  });
  const hot = boards.data ? [...boards.data].sort((a, b) => b.postCount - a.postCount).slice(0, 5) : [];
  return (
    <aside className="side">
      <form onSubmit={submit} className="side-search">
        <label className="search-box">
          <Search size={18} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索" aria-label="搜索" />
        </label>
      </form>

      {hot.length > 0 && (
        <section className="card">
          <h2 className="card-title">热门吧</h2>
          {hot.map((b, i) => (
            <Link key={b.slug} to={`/b/${b.slug}`} className="card-row">
              <span className="rank">{i + 1}</span>
              <BoardMark name={b.name} slug={b.slug} size={36} />
              <div style={{ minWidth: 0 }}>
                <div className="name">{b.name}吧</div>
                <div className="muted small">
                  {b.postCount} 帖 · {b.memberCount} 人关注
                </div>
              </div>
            </Link>
          ))}
          <Link to="/boards" className="card-more">
            全部吧
          </Link>
        </section>
      )}

      {!!tags.data?.length && (
        <section className="card">
          <h2 className="card-title">热门标签</h2>
          {tags.data.slice(0, 6).map((t) => (
            <Link key={t.tag} to={`/t/${encodeURIComponent(t.tag)}`} className="card-row tag-row">
              <span className="tag-ico">
                <Hash size={18} />
              </span>
              <div style={{ minWidth: 0 }}>
                <div className="name ellipsis">{t.tag}</div>
                <div className="muted small">{t.count} 条帖子</div>
              </div>
            </Link>
          ))}
        </section>
      )}

      {!!suggested.data?.length && (
        <section className="card">
          <h2 className="card-title">推荐关注</h2>
          {suggested.data.map((u) => (
            <div key={u.id} className="card-row">
              <Link to={`/u/${u.username}`}>
                <Avatar src={u.avatar} name={u.displayName} size={40} />
              </Link>
              <Link to={`/u/${u.username}`} style={{ flex: 1, minWidth: 0 }}>
                <div className="name">
                  <span className="ellipsis">{u.displayName}</span>
                  <Verified user={u} size={16} />
                </div>
                <div className="muted ellipsis small">{u.className || `@${u.username}`}</div>
              </Link>
              <FollowButton username={u.username} initial={!!u.isFollowing} small />
            </div>
          ))}
        </section>
      )}

      <footer className="side-foot">
        <span>同学圈</span>
        <span>© {new Date().getFullYear()}</span>
      </footer>
    </aside>
  );
}

function TabBar() {
  const me = useMe();
  const unread = useUnread().data;
  const openAccount = useAccountSheet();
  const loc = useLocation();
  const items: [string, string, typeof Home, number?][] = [
    ['/', '首页', Home],
    ['/boards', '吧', LayoutGrid],
    ['/search', '搜索', Search],
    ['/notifications', '通知', Bell, unread],
  ];
  const mine = loc.pathname.startsWith(`/u/${me.username}`) || loc.pathname === '/settings';
  return (
    <nav className="tabbar mobile-only">
      {items.map(([to, label, Icon, badge]) => (
        <NavLink key={to} to={to} end={to === '/'} aria-label={label} className={({ isActive }) => (isActive ? 'active' : '')}>
          {({ isActive }) => (
            <span className="nav-ico">
              <Icon
                size={24}
                strokeWidth={isActive ? 2.4 : 1.8}
                fill={isActive && FILLABLE.has(Icon) ? 'currentColor' : 'none'}
              />
              <Badge n={badge} />
            </span>
          )}
        </NavLink>
      ))}
      <button className={`tab-me ${mine ? 'active' : ''}`} onClick={openAccount} aria-label="我的账号">
        <Avatar src={me.avatar} name={me.displayName} size={28} />
      </button>
    </nav>
  );
}

/** 手机上向下滚动时收起顶栏、淡化底栏（和 X 一样），向上滚动时恢复 */
function useScrollDirection() {
  useEffect(() => {
    let last = window.scrollY;
    let raf = 0;
    const root = document.documentElement;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const y = window.scrollY;
        if (y < 60) root.dataset.scroll = 'top';
        else if (y > last + 6) root.dataset.scroll = 'down';
        else if (y < last - 6) root.dataset.scroll = 'up';
        last = y;
      });
    };
    root.dataset.scroll = 'top';
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
}

export function Layout() {
  const compose = useCompose();
  const loc = useLocation();
  const [collapsed, setCollapsed] = useState(getNavCollapsed);
  const [sheet, setSheet] = useState(false);
  useScrollDirection();
  useEffect(() => {
    document.documentElement.dataset.scroll = 'top';
    setSheet(false);
  }, [loc.pathname]);
  // 空闲时预先加载 Markdown 渲染器，避免第一次遇到公式时闪一下
  useEffect(() => {
    const id = setTimeout(() => void preloadMarkdown(), 1500);
    return () => clearTimeout(id);
  }, []);
  const toggle = () => {
    setCollapsed((c) => {
      setNavCollapsed(!c);
      return !c;
    });
  };
  return (
    <AccountSheetCtx.Provider value={() => setSheet(true)}>
      <div className={`shell ${collapsed ? 'nav-collapsed' : ''}`}>
        <div className="nav-col">
          <Nav collapsed={collapsed} onToggle={toggle} />
        </div>
        <main className="main-col">
          <div className="page" key={loc.pathname.replace(/\/(followers|following)$/, '')}>
            <Outlet />
          </div>
        </main>
        <div className="side-col">
          <Side />
        </div>
      </div>
      <button
        className="fab mobile-only"
        onClick={() => compose({ boardSlug: /^\/b\/([^/]+)/.exec(loc.pathname)?.[1] })}
        aria-label="发帖"
      >
        <Feather size={24} />
      </button>
      <TabBar />
      {sheet && (
        <Modal title="账号" onClose={() => setSheet(false)} className="account-sheet">
          <AccountSheetBody />
        </Modal>
      )}
    </AccountSheetCtx.Provider>
  );
}
