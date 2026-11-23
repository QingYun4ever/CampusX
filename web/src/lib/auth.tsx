import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError, getToken, setToken, type User } from './api';
import { setUnreachable } from './site';
import { stopPush, syncPush } from './push';

interface AuthCtx {
  user: User | null;
  loading: boolean;
  signIn: (token: string, user: User) => void;
  signOut: () => Promise<void>;
  setUser: (u: User) => void;
  /** 重新取自己的信息（连不上服务器 / 维护结束后重试） */
  reload: () => Promise<void>;
}

const Ctx = createContext<AuthCtx>(null!);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(!!getToken());
  const qc = useQueryClient();

  const reload = useCallback(async () => {
    if (!getToken()) return;
    try {
      setUser(await api<User>('/auth/me'));
      setUnreachable(false);
    } catch (e) {
      // 在维护时（503）先当作没登录，显示维护页；解除后（site:recovered）再取一次
      // 网络不通时别把人踢回登录页，显示「连不上服务器」，等恢复了再进来
      if (e instanceof ApiError && e.status === 0 && getToken()) setUnreachable(true);
      else setUnreachable(false);
      setUser(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
    const onRecovered = () => {
      if (!getToken()) return;
      setLoading(true);
      void reload();
    };
    window.addEventListener('site:recovered', onRecovered);
    return () => window.removeEventListener('site:recovered', onRecovered);
  }, [reload]);

  useEffect(() => {
    const onExpired = () => {
      stopPush();
      setUser(null);
      qc.clear();
    };
    window.addEventListener('auth:expired', onExpired);
    return () => window.removeEventListener('auth:expired', onExpired);
  }, [qc]);

  const signIn = useCallback(
    (token: string, u: User) => {
      setToken(token);
      void syncPush();
      qc.clear();
      setUser(u);
      // 登录接口返回的是公开资料，再取一次自己的完整信息（比如要不要确认用户协议）
      api<User>('/auth/me').then(setUser).catch(() => {});
    },
    [qc],
  );

  const signOut = useCallback(async () => {
    stopPush();
    setUnreachable(false);
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    setToken(null);
    qc.clear();
    setUser(null);
    setLoading(false);
  }, [qc]);

  return <Ctx.Provider value={{ user, loading, signIn, signOut, setUser, reload }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);

/** 页面里一定已登录时使用 */
export const useMe = () => useContext(Ctx).user!;
