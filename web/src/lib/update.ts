import { AndroidUpdates, type UpdateInfo } from './android';

const SKIP_KEY = 'txq_update_skip';
const LATER_KEY = 'txq_update_later';

/** 有新版返回信息，没有返回 null；出错会抛异常 */
export async function checkUpdate(): Promise<UpdateInfo | null> {
  const { update } = await AndroidUpdates.checkUpdate();
  return update ?? null;
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
