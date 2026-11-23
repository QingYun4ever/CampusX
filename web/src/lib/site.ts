/**
 * 站点状态：维护模式、连不上服务器。
 * 接口返回 503 + maintenance 时 api() 会发出 site:maintenance 事件，这里接住，App 就换成维护页。
 */
import { useSyncExternalStore } from 'react';
import { api, ApiError } from './api';

export interface MaintenanceInfo {
  message: string;
  until: number | null;
  since: number | null;
}

interface SiteState {
  maintenance: MaintenanceInfo | null;
  /** 有登录信息但连不上服务器（启动时取不到自己的信息） */
  unreachable: boolean;
}

let state: SiteState = { maintenance: null, unreachable: false };
const subs = new Set<() => void>();

function set(patch: Partial<SiteState>) {
  const next = { ...state, ...patch };
  if (next.maintenance === state.maintenance && next.unreachable === state.unreachable) return;
  state = next;
  subs.forEach((f) => f());
}

export const setUnreachable = (v: boolean) => set({ unreachable: v });
export const setMaintenance = (m: MaintenanceInfo | null) => {
  // 内容一样就不换对象，免得重复渲染
  if (m && state.maintenance && m.message === state.maintenance.message && m.until === state.maintenance.until) return;
  // 维护结束：先通知重新取登录状态（同一轮里一起渲染，不会闪一下登录页），再换掉维护页
  if (state.maintenance && !m) window.dispatchEvent(new Event('site:recovered'));
  set({ maintenance: m });
};

window.addEventListener('site:maintenance', (e) => setMaintenance((e as CustomEvent<MaintenanceInfo>).detail));

export function useSite() {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => state,
  );
}

/** 查一次维护状态。返回 false 表示连不上 */
export async function refreshStatus(): Promise<boolean> {
  try {
    const r = await api<{ maintenance: MaintenanceInfo | null }>('/status');
    setMaintenance(r.maintenance);
    return true;
  } catch (e) {
    // 旧版服务器没有 /status：当作没在维护
    if (e instanceof ApiError && e.status === 404) {
      setMaintenance(null);
      return true;
    }
    return !(e instanceof ApiError && e.status === 0);
  }
}
