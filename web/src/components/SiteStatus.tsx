/**
 * 维护页、连不上服务器页、管理员的维护提示条、首页公告。
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Megaphone, RefreshCw, WifiOff, Wrench, X } from 'lucide-react';
import { api, IS_APP_BUILD, type Announcement } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fullTime } from '../lib/format';
import { refreshStatus, setUnreachable, useSite } from '../lib/site';
import { ContentLink } from './ContentLink';
import { Logo } from './Logo';
import { Spinner } from './ui';
import './site.css';

const POLL_MS = 15_000;


function formatUntil(ts: number) {
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? `今天 ${d.toTimeString().slice(0, 5)}` : fullTime(ts);
}

export function MaintenanceScreen({ onAdminLogin }: { onAdminLogin?: () => void }) {
  const { maintenance } = useSite();
  const [checking, setChecking] = useState(false);

  const check = async () => {
    setChecking(true);
    await refreshStatus();
    setChecking(false);
  };

  // 后台定时看一眼，解除了自动进去
  useEffect(() => {
    const t = setInterval(() => void refreshStatus(), POLL_MS);
    const onVisible = () => document.visibilityState === 'visible' && void refreshStatus();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  if (!maintenance) return null;
  return (
    <main className="site-screen">
      <div className="site-card">
        <div className="site-icon">
          <Wrench size={26} />
        </div>
        <h1>正在维护</h1>
        <p className="site-message">{maintenance.message}</p>
        {maintenance.until && <p className="site-meta">预计 {formatUntil(maintenance.until)} 恢复</p>}
        <button className="btn btn-light" onClick={check} disabled={checking}>
          {checking ? <Spinner size={16} inline /> : <RefreshCw size={16} />}
          重新检查
        </button>
        <p className="site-hint">维护结束后会自动恢复，不用一直刷新。</p>
      </div>
      <footer className="site-foot">
        <Logo size={20} />
        {onAdminLogin && (
          <button type="button" onClick={onAdminLogin}>
            管理员登录
          </button>
        )}
      </footer>
    </main>
  );
}

export function UnreachableScreen() {
  const { reload, signOut } = useAuth();
  const [checking, setChecking] = useState(false);
  const retry = async () => {
    setChecking(true);
    await refreshStatus();
    await reload();
    setChecking(false);
  };
  useEffect(() => {
    const t = setInterval(() => void reload(), POLL_MS);
    const onOnline = () => void reload();
    window.addEventListener('online', onOnline);
    return () => {
      clearInterval(t);
      window.removeEventListener('online', onOnline);
    };
  }, [reload]);

  return (
    <main className="site-screen">
      <div className="site-card">
        <div className="site-icon muted">
          <WifiOff size={26} />
        </div>
        <h1>连不上服务器</h1>
        <p className="site-message">
          {navigator.onLine === false ? '手机好像没有联网，检查一下 Wi-Fi 或移动数据。' : '可能是网络不稳定，也可能是服务器暂时出了问题。'}
        </p>
        <button className="btn btn-primary" onClick={retry} disabled={checking}>
          {checking ? <Spinner size={16} inline /> : <RefreshCw size={16} />}
          重试
        </button>
        <p className="site-hint">恢复连接后会自动进入。</p>
      </div>
      <footer className="site-foot">
        <Logo size={20} />
        {IS_APP_BUILD && (
          <button
            type="button"
            onClick={() => {
              setUnreachable(false);
              void signOut();
            }}
          >
            退出登录 / 换服务器
          </button>
        )}
      </footer>
    </main>
  );
}

/** 管理员在维护期间照常使用，顶部提示一下别忘了解除 */
export function MaintenanceBanner() {
  const { maintenance } = useSite();
  if (!maintenance) return null;
  return (
    <div className="maint-banner" role="status">
      <Wrench size={14} />
      <span>维护模式开启中，普通用户暂时无法使用</span>
      <Link to="/admin/site">去解除</Link>
    </div>
  );
}

/* ---------------- 公告 ---------------- */

const DISMISS_KEY = 'txq_ann_dismissed';
function readDismissed(): number[] {
  try {
    return JSON.parse(localStorage.getItem(DISMISS_KEY) || '[]');
  } catch {
    return [];
  }
}

/** 首页顶部的公告卡片：可以关掉，不是置顶帖 */
export function Announcements() {
  const [dismissed, setDismissed] = useState(readDismissed);
  const q = useQuery({
    queryKey: ['announcements'],
    queryFn: () => api<Announcement[]>('/announcements'),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const list = (q.data ?? []).filter((a) => !dismissed.includes(a.id));
  if (!list.length) return null;

  const dismiss = (id: number) => {
    // 只留最近的，免得越存越多
    const next = [id, ...dismissed].slice(0, 30);
    setDismissed(next);
    try {
      localStorage.setItem(DISMISS_KEY, JSON.stringify(next));
    } catch {
      /* 存不了就只在这次关掉 */
    }
  };

  return (
    <div className="ann-list">
      {list.map((a) => (
        <section key={a.id} className="ann">
          <div className="ann-icon">
            <Megaphone size={16} />
          </div>
          <div className="ann-main">
            <div className="ann-head">
              <span className="ann-label">公告</span>
              <h2>{a.title}</h2>
            </div>
            {a.body && <p>{a.body}</p>}
            {a.link && (
              <ContentLink href={a.link}>
                <span className="ann-link">
                  查看详情 <ArrowRight size={14} />
                </span>
              </ContentLink>
            )}
          </div>
          <button type="button" className="ann-close" aria-label="关闭公告" onClick={() => dismiss(a.id)}>
            <X size={16} />
          </button>
        </section>
      ))}
    </div>
  );
}
