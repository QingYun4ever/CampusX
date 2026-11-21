import { App } from '@capacitor/app';
import { api } from './api';

export interface Latest {
  version: string;
  notes: string;
  size: number | null;
  publishedAt: string | null;
  downloads: { label: string; url: string }[];
  page: string;
}

export interface UpdateInfo {
  current: string;
  latest: Latest;
}

const SKIP_KEY = 'txq_update_skip';
const LATER_KEY = 'txq_update_later';

function cmp(a: string, b: string) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

/** 有新版返回信息，没有返回 null；出错会抛异常 */
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

/**
 * 加速镜像时好时坏：同时探一下，谁先响应用谁；都不行就按服务器给的顺序。
 * no-cors 拿不到内容，但能知道连不连得上。
 */
export async function fastestDownload(downloads: Latest['downloads']): Promise<string> {
  if (downloads.length < 2) return downloads[0].url;
  const ctrl = new AbortController();
  const probe = (url: string) =>
    fetch(url, { method: 'HEAD', mode: 'no-cors', cache: 'no-store', signal: ctrl.signal }).then(() => url);
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000));
  try {
    return await Promise.race([Promise.any(downloads.map((d) => probe(d.url))), timeout]);
  } catch {
    return downloads[0].url;
  } finally {
    ctrl.abort();
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
