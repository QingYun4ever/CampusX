import { App } from '@capacitor/app';
import { AndroidUpdates, type Latest, type UpdateInfo } from './android';
import { api } from './api';

const SKIP_KEY = 'txq_update_skip';
const LATER_KEY = 'txq_update_later';

function cmp(a: string, b: string) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

/**
 * 有新版返回信息，没有返回 null；出错会抛异常。
 * 版本信息由自己的服务器从 GitHub 取来并缓存，学校里很多人同时检查也不会被 GitHub 限流。
 */
export async function checkUpdate(): Promise<UpdateInfo | null> {
  const [{ version: current }, latest] = await Promise.all([App.getInfo(), api<Latest | { version: null }>('/app/latest')]);
  if (!latest.version) throw new Error('暂时查不到最新版本，稍后再试');
  return cmp(latest.version, current) > 0 ? { current, latest: latest as Latest } : null;
}

/** 启动时自动弹的提示：跳过的版本不再提醒，「以后再说」一天内不再提醒 */
export function shouldPrompt(version: string) {
  try {
    if (localStorage.getItem(SKIP_KEY) === version) return false;
    return Number(localStorage.getItem(LATER_KEY) ?? 0) < Date.now();
  } catch {
    return true;
  }
}

export function skipVersion(version: string) {
  try {
    localStorage.setItem(SKIP_KEY, version);
  } catch {
    /* ignore */
  }
}

export function remindLater() {
  try {
    localStorage.setItem(LATER_KEY, String(Date.now() + 86_400_000));
  } catch {
    /* ignore */
  }
}

/** GitHub release 正文：去掉固定的提示句，剩下按行显示 */
export function releaseNotes(notes: string) {
  return notes
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.includes('仅支持 HTTPS') && l !== '已签名的 Android 安装包。')
    .map((l) => l.replace(/^[-*•]\s*/, ''));
}

/** 测一条真实下载线路；旧版原生壳不支持测速时，只检查能否连通。 */
export async function probeLine(url: string, signal: AbortSignal): Promise<number> {
  try {
    const { results } = await AndroidUpdates.probeMirrors({ urls: [url], bytes: 256 * 1024, timeoutMs: 8000 });
    return results[0]?.speed ?? -1;
  } catch {
    if (signal.aborted) return -1;
    try {
      const res = await fetch(url, {
        method: 'HEAD', mode: 'no-cors', cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(6000)]),
      });
      return res.ok || res.type === 'opaque' ? 0 : -1;
    } catch {
      return -1;
    }
  }
}

export function formatSpeed(bps: number) {
  if (bps <= 0) return '可连接';
  if (bps >= 1024 * 1024) return `${(bps / 1048576).toFixed(1)} MB/s`;
  return `${Math.max(1, Math.round(bps / 1024))} KB/s`;
}
