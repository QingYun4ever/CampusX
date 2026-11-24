import type { CampusEvent } from './api';

/** 「还剩 3 天」「6 小时后开始」 */
export function eventWhen(e: CampusEvent, t = Date.now()) {
  const span = (ms: number) => {
    const h = Math.ceil(ms / 3_600_000);
    if (h < 24) return `${h} 小时`;
    return `${Math.ceil(h / 24)} 天`;
  };
  if (e.status === 'ended') return '已结束';
  if (e.status === 'upcoming') return `${span(e.startsAt - t)}后开始`;
  return `还剩 ${span(e.endsAt - t)}`;
}

/** 活动奖励的一句话说明 */
export function eventPerks(e: CampusEvent) {
  const out = [e.postReward ? `带 #${e.tag} 发帖 +${e.postReward} 紫水晶` : `带 #${e.tag} 发帖参加`];
  if (e.checkinBonus > 1) out.push(`签到 ×${e.checkinBonus}`);
  return out;
}

export function eventRange(e: CampusEvent) {
  const f = (ts: number) => {
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  return `${f(e.startsAt)} – ${f(e.endsAt)}`;
}
