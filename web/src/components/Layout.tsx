import {
  Suspense,
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
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
  Mail,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  Shield,
  Store,
  Bookmark,
  User as UserIcon,
} from 'lucide-react';
import { api, NOTIFICATION_QUERY, type Board, type SiteStats, type User } from '../lib/api';
import { CURRENT, hasUnseen } from '../lib/changelog';
import { useAuth, useMe } from '../lib/auth';
import { useEscape } from '../lib/escape';
import { getNavCollapsed, getNavWidth, NAV_W, setNavCollapsed, setNavWidth } from '../lib/theme';
import { useCompose } from './compose';
import { FollowButton } from './FollowButton';
import { CrystalIcon } from './Crystal';
import { Logo } from './Logo';
import { preloadMarkdown } from './PostCard';
import { Avatar, BoardMark, Modal, PostSkeleton, Rolling, useModalClose, Verified } from './ui';

function useDmUnread() {
  return useQuery({
    queryKey: ['dm-unread'],
    queryFn: () => api<{ count: number }>('/dm/unread-count'),
    refetchInterval: 15_000,
    select: (data) => data.count,
  });
}

function useUnread() {
  return useQuery({
    queryKey: ['unread'],
    queryFn: () => api<{ count: number }>(`/notifications/unread-count?${NOTIFICATION_QUERY}`),
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
        <Avatar src={me.avatar} name={me.displayName} size={44} decoration={me.avatarDecoration} />
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
      <Link to="/bookmarks" onClick={onDone} className="mobile-only">
        <Bookmark size={18} /> 书签
      </Link>
      <Link to="/market" onClick={onDone} className="mobile-only">
        <Store size={18} /> 商场
      </Link>
      <Link to="/crystals" onClick={onDone}>
        <CrystalIcon size={18} /> 紫水晶
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

/**
 * 左下角的账号菜单。渲染到 body 上（portal），不受左栏滚动区域的裁切，
 * 也不会被中间栏盖住。
 */
function useAccountMenu() {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<CSSProperties>({});
  const anchor = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEscape(() => {
    setOpen(false);
    anchor.current?.focus();
  }, open);
  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const r = anchor.current.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(r.left, window.innerWidth - 308)),
      bottom: window.innerHeight - r.top + 8,
    });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const inside = (t: EventTarget | null) =>
      !!t && (anchor.current?.contains(t as Node) || panel.current?.contains(t as Node));
    const down = (e: Event) => !inside(e.target) && setOpen(false);
    const away = () => setOpen(false);
    document.addEventListener('pointerdown', down);
    window.addEventListener('resize', away);
    return () => {
      document.removeEventListener('pointerdown', down);
      window.removeEventListener('resize', away);
    };
  }, [open]);
  return { open, setOpen, anchor, panel, pos };
}

function Nav({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const me = useMe();
  const compose = useCompose();
  const unread = useUnread().data;
  const dmUnread = useDmUnread().data;
  const menu = useAccountMenu();
  const items: [string, string, typeof Home, number?][] = [
    ['/', '首页', Home],
    ['/boards', '吧', LayoutGrid],
    ['/search', '搜索', Search],
    ['/notifications', '通知', Bell, unread],
    ['/messages', '私信', Mail, dmUnread],
    ['/bookmarks', '书签', Bookmark],
    ['/market', '商场', Store],
  ];

  return (
    <nav className="nav">
      <div className="nav-top">
        <Link to="/" className="brand" aria-label="校墙首页">
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
      <div className="nav-user-wrap">
        {menu.open &&
          createPortal(
            <div className="menu account-menu floating" role="menu" ref={menu.panel} style={menu.pos}>
              <AccountMenuItems onDone={() => menu.setOpen(false)} />
            </div>,
            document.body,
          )}
        <button
          ref={menu.anchor}
          className={`nav-user ${menu.open ? 'open' : ''}`}
          onClick={() => menu.setOpen((m) => !m)}
          aria-expanded={menu.open}
          aria-haspopup="menu"
          aria-label="账号菜单"
        >
          <Avatar src={me.avatar} name={me.displayName} size={40} decoration={me.avatarDecoration} />
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

/** 右栏底部：在线同学和站点数据 */
function SiteCard() {
  const q = useQuery({
    queryKey: ['site-stats'],
    queryFn: () => api<SiteStats>('/stats/site'),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  if (!q.data) return null;
  const s = q.data;
  return (
    <section className="card site-card">
      <div className="online-head">
        <span className="live-dot" aria-hidden />
        <b>
          <Rolling value={s.online} />
        </b>
        <span>人在线</span>
      </div>
      {s.onlineUsers.length > 0 && (
        <div className="online-faces">
          {s.onlineUsers.map((u) => (
            <Link key={u.id} to={`/u/${u.username}`} title={u.displayName} className="online-face">
              <Avatar src={u.avatar} name={u.displayName} size={32} decoration={u.avatarDecoration} />
            </Link>
          ))}
          {s.online > s.onlineUsers.length && <span className="muted small">+{s.online - s.onlineUsers.length}</span>}
        </div>
      )}
      <div className="site-grid">
        <div>
          <b>{s.users}</b>
          <span>同学</span>
        </div>
        <div>
          <b>{s.posts}</b>
          <span>帖子</span>
        </div>
        <div>
          <b>{s.postsToday}</b>
          <span>今日新帖</span>
        </div>
        <div>
          <b>{s.boards}</b>
          <span>个吧</span>
        </div>
      </div>
    </section>
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
              <BoardMark name={b.name} slug={b.slug} avatar={b.avatar} size={36} />
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
                <Avatar src={u.avatar} name={u.displayName} size={40} decoration={u.avatarDecoration} />
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

      <SiteCard />

      <footer className="side-foot">
        <span>校墙 © {new Date().getFullYear()}</span>
        <Link to="/changelog" className={`changelog-link ${hasUnseen() ? 'unseen' : ''}`}>
          v{CURRENT} 更新日志
        </Link>
        <Link to="/privacy">隐私政策</Link>
        <Link to="/install">安装校墙</Link>
      </footer>
    </aside>
  );
}

function TabBar() {
  const me = useMe();
  const unread = useUnread().data;
  const dmUnread = useDmUnread().data;
  const openAccount = useAccountSheet();
  const loc = useLocation();
  const items: [string, string, typeof Home, number?][] = [
    ['/', '首页', Home],
    ['/boards', '吧', LayoutGrid],
    ['/search', '搜索', Search],
    ['/notifications', '通知', Bell, unread],
    ['/messages', '私信', Mail, dmUnread],
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
        <Avatar src={me.avatar} name={me.displayName} size={28} decoration={me.avatarDecoration} />
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
  const isDm = loc.pathname === '/messages' || loc.pathname.startsWith('/messages/');
  const inChat = loc.pathname.startsWith('/messages/');
  const [collapsed, setCollapsed] = useState(getNavCollapsed);
  const [navW, setNavW] = useState(getNavWidth);
  const [resizing, setResizing] = useState(false);
  const navCol = useRef<HTMLDivElement>(null);
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
  const applyCollapsed = (c: boolean) => {
    setCollapsed(c);
    setNavCollapsed(c);
  };

  /*
   * 拖动左栏右边缘调整宽度；拖得足够窄就收成只有图标，再往外拖又会展开。
   * 三栏是居中的，改宽度时边缘只移动一半，所以每次移动后量一下实际位置再修正几次，让边缘始终跟手。
   */
  const startResize = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !navCol.current) return;
    e.preventDefault();
    const el = navCol.current;
    const shell = el.parentElement!;
    e.currentTarget.setPointerCapture(e.pointerId);
    setResizing(true);
    let w = collapsed ? NAV_W.min : navW;
    let isCollapsed = collapsed;
    const move = (ev: globalThis.PointerEvent) => {
      const left = el.getBoundingClientRect().left;
      const want = ev.clientX - left;
      const nextCollapsed = isCollapsed ? want < NAV_W.min - 40 : want < NAV_W.snap;
      if (nextCollapsed !== isCollapsed) {
        isCollapsed = nextCollapsed;
        shell.classList.toggle('nav-collapsed', isCollapsed);
      }
      if (isCollapsed) return;
      for (let i = 0; i < 5; i++) {
        const r = el.getBoundingClientRect();
        w = Math.min(NAV_W.max, Math.max(NAV_W.min, w + (ev.clientX - r.right)));
        shell.style.setProperty('--nav-w', `${w}px`);
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      setResizing(false);
      applyCollapsed(isCollapsed);
      if (!isCollapsed) {
        setNavW(w);
        setNavWidth(w);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };
  const resizeKey = (e: KeyboardEvent) => {
    const d = e.key === 'ArrowLeft' ? -16 : e.key === 'ArrowRight' ? 16 : 0;
    if (!d) return;
    e.preventDefault();
    if (collapsed) return d > 0 && applyCollapsed(false);
    const n = navW + d;
    if (n < NAV_W.min) return applyCollapsed(true);
    const c = Math.min(NAV_W.max, n);
    setNavW(c);
    setNavWidth(c);
  };
  const resetWidth = () => {
    applyCollapsed(false);
    setNavW(NAV_W.def);
    setNavWidth(NAV_W.def);
  };
  return (
    <AccountSheetCtx.Provider value={() => setSheet(true)}>
      <div
        className={`shell ${collapsed ? 'nav-collapsed' : ''} ${resizing ? 'resizing' : ''} ${isDm ? 'wide' : ''} ${inChat ? 'in-chat' : ''}`}
        style={{ '--nav-w': `${navW}px` } as CSSProperties}
      >
        <div className="nav-col" ref={navCol}>
          <Nav collapsed={collapsed} onToggle={toggle} />
          <div
            className="nav-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="拖动调整侧边栏宽度，双击恢复默认"
            title="拖动调整宽度，双击恢复默认"
            tabIndex={0}
            aria-valuemin={NAV_W.min}
            aria-valuemax={NAV_W.max}
            aria-valuenow={collapsed ? 88 : navW}
            onPointerDown={startResize}
            onDoubleClick={resetWidth}
            onKeyDown={resizeKey}
          />
        </div>
        <main className="main-col">
          <div className="page" key={isDm ? '/messages' : loc.pathname.replace(/\/(followers|following)$/, '')}>
            <Suspense fallback={<PostSkeleton n={3} />}><Outlet /></Suspense>
          </div>
        </main>
        <div className="side-col">
          <Side />
        </div>
      </div>
      {!isDm && (
      <button
        className="fab mobile-only"
        onClick={() => compose({ boardSlug: /^\/b\/([^/]+)/.exec(loc.pathname)?.[1] })}
        aria-label="发帖"
      >
        <Feather size={24} />
      </button>
      )}
      {!inChat && <TabBar />}
      {sheet && (
        <Modal title="账号" onClose={() => setSheet(false)} className="account-sheet">
          <AccountSheetBody />
        </Modal>
      )}
    </AccountSheetCtx.Provider>
  );
}
