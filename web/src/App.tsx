import { App as AndroidApp } from '@capacitor/app';
import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ComposeProvider } from './components/compose';
import { Layout } from './components/Layout';
import { Logo } from './components/Logo';
import { Empty, Overlays } from './components/ui';
import { isAndroid } from './lib/android';
import { useAuth } from './lib/auth';
import { dismissTopOverlay } from './lib/escape';
import { Admin } from './pages/Admin';
import { Login, Register } from './pages/Auth';
import { BoardPage, Boards } from './pages/Boards';
import { Home } from './pages/Home';
import { Notifications } from './pages/Notifications';
import { PostDetail } from './pages/PostDetail';
import { FollowList, Profile } from './pages/Profile';
import { Search } from './pages/Search';
import { Settings } from './pages/Settings';
import { Changelog } from './pages/Changelog';
import { Messages } from './pages/Messages';
import { TagPage } from './pages/Tag';

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
  const { user, loading } = useAuth();
  const loc = useLocation();

  if (loading) {
    return (
      <div className="splash" aria-label="加载中">
        <Logo size={56} />
      </div>
    );
  }

  if (!user) {
    return (
      <>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="*" element={<Navigate to="/login" replace state={{ from: loc.pathname }} />} />
        </Routes>
        <Overlays />
      </>
    );
  }

  return (
    <ComposeProvider>
      <Routes>
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route path="/register" element={<Navigate to="/" replace />} />
        {/* 管理后台是独立页面，不套用主站的三栏布局 */}
        <Route path="/admin/*" element={<Admin />} />
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
