import { App as AndroidApp } from '@capacitor/app';
import { lazy, Suspense, useEffect, useLayoutEffect, useState } from 'react';
import { matchPath, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ComposeProvider } from './components/compose';
import { AppServices } from './components/AppServices';
import { Layout } from './components/Layout';
import { Logo } from './components/Logo';
import { Empty, Overlays } from './components/ui';
import { isAndroid } from './lib/android';
import { useAuth } from './lib/auth';
import { getToken } from './lib/api';
import { dismissTopOverlay } from './lib/escape';
import { Home } from './pages/Home';
import { Login, Register } from './pages/Auth';
import { InstallPage } from './pages/Install';
import { PrivacyPage } from './pages/Privacy';
import { TermsGate, TermsPage } from './pages/Terms';
import { HelpPage } from './pages/Help';
import { MaintenanceBanner, MaintenanceScreen, UnreachableScreen } from './components/SiteStatus';
import { refreshStatus, useSite } from './lib/site';

const Admin = lazy(() => import('./pages/Admin').then(({ Admin }) => ({ default: Admin })));
const Boards = lazy(() => import('./pages/Boards').then(({ Boards }) => ({ default: Boards })));
const BoardPage = lazy(() => import('./pages/Boards').then(({ BoardPage }) => ({ default: BoardPage })));
const Notifications = lazy(() => import('./pages/Notifications').then(({ Notifications }) => ({ default: Notifications })));
const PostDetail = lazy(() => import('./pages/PostDetail').then(({ PostDetail }) => ({ default: PostDetail })));
const Profile = lazy(() => import('./pages/Profile').then(({ Profile }) => ({ default: Profile })));
const FollowList = lazy(() => import('./pages/Profile').then(({ FollowList }) => ({ default: FollowList })));
const Search = lazy(() => import('./pages/Search').then(({ Search }) => ({ default: Search })));
const Settings = lazy(() => import('./pages/Settings').then(({ Settings }) => ({ default: Settings })));
const Bookmarks = lazy(() => import('./pages/Bookmarks').then(({ Bookmarks }) => ({ default: Bookmarks })));
const Market = lazy(() => import('./pages/Market').then(({ Market }) => ({ default: Market })));
const Crystals = lazy(() => import('./pages/Crystals').then(({ Crystals }) => ({ default: Crystals })));
const InvitePage = lazy(() => import('./pages/Invite').then(({ InvitePage }) => ({ default: InvitePage })));
const EventPage = lazy(() => import('./pages/Events').then(({ EventPage }) => ({ default: EventPage })));
const EventsPage = lazy(() => import('./pages/Events').then(({ EventsPage }) => ({ default: EventsPage })));
const Changelog = lazy(() => import('./pages/Changelog').then(({ Changelog }) => ({ default: Changelog })));
const Messages = lazy(() => import('./pages/Messages').then(({ Messages }) => ({ default: Messages })));
const TagPage = lazy(() => import('./pages/Tag').then(({ TagPage }) => ({ default: TagPage })));

/** BrowserRouter 在 history.state.idx 里记录应用内历史位置。 */
function useAndroidBack() {
  useEffect(() => {
    if (!isAndroid) return;
    let active = true;
    const listener = AndroidApp.addListener('backButton', () => {
      if (!active || dismissTopOverlay()) return;
      if (window.history.state?.idx > 0) window.history.back();
      else void AndroidApp.exitApp();
    });
    return () => {
      active = false;
      void listener.then((handle) => handle.remove());
    };
  }, []);
}

export function App() {
  useAndroidBack();
  const { user, loading, signOut } = useAuth();
  const loc = useLocation();
  const site = useSite();
  // 维护页上点了「管理员登录」：先放行到登录页
  const [adminLogin, setAdminLogin] = useState(false);
  useEffect(() => {
    void refreshStatus();
  }, []);
  const PublicPage = matchPath('/privacy', loc.pathname) ? PrivacyPage
    : matchPath('/help', loc.pathname) ? HelpPage
    : matchPath('/install', loc.pathname) ? InstallPage
    : null;
  useLayoutEffect(() => {
    if (PublicPage) window.scrollTo(0, 0);
  }, [PublicPage]);

  if (PublicPage) return <><PublicPage /><Overlays /></>;

  if (loading) {
    return (
      <div className="splash" aria-label="加载中">
        <Logo size={56} />
      </div>
    );
  }

  if (site.maintenance && user?.role !== 'admin' && !(adminLogin && !user)) {
    return (
      <>
        <MaintenanceScreen
          onAdminLogin={async () => {
            if (user || getToken()) await signOut();
            setAdminLogin(true);
          }}
        />
        <Overlays />
      </>
    );
  }

  if (!user && site.unreachable) {
    return (
      <>
        <UnreachableScreen />
        <Overlays />
      </>
    );
  }

  if (!user) {
    return (
      <>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/terms" element={<TermsPage />} />
          <Route path="*" element={<Navigate to="/login" replace state={{ from: loc.pathname }} />} />
        </Routes>
        <Overlays />
      </>
    );
  }

  if (user.termsPending && loc.pathname !== '/terms') {
    return (
      <>
        <TermsGate />
        <Overlays />
      </>
    );
  }

  return (
    <ComposeProvider>
      <AppServices />
      {user.role === 'admin' && <MaintenanceBanner />}
      <Routes>
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route path="/register" element={<Navigate to="/" replace />} />
        <Route path="/terms" element={<TermsPage />} />
        {/* 管理后台是独立页面，不套用主站的三栏布局 */}
        <Route path="/admin/*" element={<Suspense fallback={<div className="splash" aria-label="加载中"><Logo size={56} /></div>}><Admin /></Suspense>} />
        <Route element={<Layout />}>
          <Route path="/" element={<Home />} />
          <Route path="/boards" element={<Boards />} />
          <Route path="/b/:slug" element={<BoardPage />} />
          <Route path="/post/:id" element={<PostDetail />} />
          <Route path="/u/:username" element={<Profile />} />
          <Route path="/u/:username/:list" element={<FollowList />} />
          <Route path="/notifications" element={<Notifications />} />
          <Route path="/search" element={<Search />} />
          <Route path="/t/:tag" element={<TagPage />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/market" element={<Market />} />
          <Route path="/crystals" element={<Crystals />} />
          <Route path="/invite" element={<InvitePage />} />
          <Route path="/events" element={<EventsPage />} />
          <Route path="/events/:id" element={<EventPage />} />
          <Route path="/bookmarks" element={<Bookmarks />} />
          <Route path="/changelog" element={<Changelog />} />
          <Route path="/messages" element={<Messages />} />
          <Route path="/messages/:username" element={<Messages />} />
          <Route path="*" element={<Empty title="页面不存在">链接可能有误，或者页面已被删除。</Empty>} />
        </Route>
      </Routes>
      <Overlays />
    </ComposeProvider>
  );
}
