import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, getToken, setToken, type User } from './api';
import { stopPush, syncPush } from './push';

interface AuthCtx {
  user: User | null;
  loading: boolean;
  signIn: (token: string, user: User) => void;
  signOut: () => Promise<void>;
  setUser: (u: User) => void;
}

const Ctx = createContext<AuthCtx>(null!);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(!!getToken());
  const qc = useQueryClient();

  useEffect(() => {
    if (!getToken()) return;
    api<User>('/auth/me')
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

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
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    setToken(null);
    qc.clear();
    setUser(null);
  }, [qc]);

  return <Ctx.Provider value={{ user, loading, signIn, signOut, setUser }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);

/** 页面里一定已登录时使用 */
export const useMe = () => useContext(Ctx).user!;
