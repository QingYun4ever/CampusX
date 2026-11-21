import { AndroidShell, isAndroid } from './android';
import { API_BASE, getToken } from './api';

/** App 的系统通知设置，只存在这台手机上 */
export interface PushPrefs {
  enabled: boolean;
  dm: boolean;
  posts: boolean;
  interactions: boolean;
}

const KEY = 'txq_push';
const DEFAULTS: PushPrefs = { enabled: false, dm: true, posts: true, interactions: true };

export function getPushPrefs(): PushPrefs {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return DEFAULTS;
  }
}

export function savePushPrefs(p: PushPrefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
  void syncPush();
}

/** 把当前账号和设置交给原生端；退出登录时 token 为空，原生端会停掉后台轮询 */
export async function syncPush() {
  if (!isAndroid) return;
  const p = getPushPrefs();
  const token = getToken();
  try {
    await AndroidShell.configurePush({ ...p, enabled: p.enabled && !!token, apiBase: API_BASE, token: token ?? '' });
  } catch {
    /* 旧版安装包没有这个方法 */
  }
}

export function stopPush() {
  if (!isAndroid) return;
  AndroidShell.configurePush({ enabled: false, apiBase: '', token: '', dm: false, posts: false, interactions: false }).catch(() => {});
}

/** 打开推送：先要系统权限。返回 false 表示被拒绝了 */
export async function enablePush(): Promise<{ ok: boolean; canAsk: boolean }> {
  const r = await AndroidShell.requestNotifications();
  if (!r.granted) return { ok: false, canAsk: r.canAsk };
  savePushPrefs({ ...getPushPrefs(), enabled: true });
  return { ok: true, canAsk: true };
}
