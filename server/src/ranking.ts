/**
 * 首页「推荐」的排序。站点人不多（一两百人），帖子量小，所以每次直接把最近 30 天的主帖都拿出来算分：
 *
 *   热度 = 1 + 赞 + 回应 + 2×回复的人数 + 2×转发 + 2×引用 + 打赏/5
 *   分数 = 热度 / (发帖后的小时数 + 2)^1.5        （Hacker News 那种随时间衰减）
 *
 * 再按「我」调整：关注的人 ×1.6，加入的吧 ×1.2，自己刚发的（1 小时内）×3 让自己能马上看到，
 * 已经看过或赞过的 ×0.35，往下沉，刷新时先看到没看过的。
 *
 * 新帖子分母小，几个小时内天然排在前面，没人互动也能被看到；有人互动的能留得久一些。
 * 翻页时用第一页算好的顺序（每人缓存 30 分钟），不会因为分数变化重复或漏掉；
 * 推荐的排完了，接着按时间往更早的翻。
 */
import { all, now } from './db.ts';
import { visibleTo } from './serialize.ts';

const DAY = 86_400_000;
const WINDOW_DAYS = 30;
const MAX_CANDIDATES = 500;
const TTL = 30 * 60_000;

type Ranked = { ids: number[]; oldest: number | null; newest: number | null; at: number };
const cache = new Map<number, Ranked>();

export const score = (r: {
  created_at: number; like_count: number; rx: number; repliers: number; repost_count: number; quotes: number; tip_total: number;
  author_id: number; followed: number; member: number; seen: number; liked: number;
}, me: number, t: number) => {
  const heat = 1 + r.like_count + r.rx + 2 * r.repliers + 2 * r.repost_count + 2 * r.quotes + r.tip_total / 5;
  const hours = Math.max(0, t - r.created_at) / 3_600_000;
  let s = heat / Math.pow(hours + 2, 1.5);
  if (r.followed) s *= 1.6;
  if (r.member) s *= 1.2;
  if (r.author_id === me && hours < 1) s *= 3;
  if (r.seen || r.liked) s *= 0.35;
  return s;
};

function compute(me: number): Ranked {
  const t = now();
  const rows = all<Parameters<typeof score>[0] & { id: number }>(
    `SELECT p.id, p.author_id, p.created_at, p.like_count, p.repost_count, p.tip_total,
       (SELECT COUNT(*) FROM reactions r WHERE r.post_id = p.id) AS rx,
       (SELECT COUNT(DISTINCT c.author_id) FROM posts c
          WHERE c.root_id = p.id AND c.author_id <> p.author_id AND c.deleted = 0 AND c.status = 'ok') AS repliers,
       (SELECT COUNT(*) FROM post_quotes q WHERE q.quoted_id = p.id) AS quotes,
       EXISTS(SELECT 1 FROM follows f WHERE f.follower_id = $me AND f.followee_id = p.author_id) AS followed,
       EXISTS(SELECT 1 FROM board_members m WHERE m.board_id = p.board_id AND m.user_id = $me) AS member,
       EXISTS(SELECT 1 FROM post_views v WHERE v.post_id = p.id AND v.user_id = $me) AS seen,
       EXISTS(SELECT 1 FROM likes l WHERE l.post_id = p.id AND l.user_id = $me) AS liked
     FROM posts p
     WHERE p.parent_id IS NULL AND p.repost_of IS NULL AND p.deleted = 0
       AND (p.status = 'ok' OR (p.status = 'pending' AND p.author_id = $me))
       AND p.created_at > $since AND ${visibleTo('p.')}
       AND p.author_id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = $me)
     ORDER BY p.id DESC LIMIT $limit`,
    { me, since: t - WINDOW_DAYS * DAY, limit: MAX_CANDIDATES },
  );
  const ids = rows
    .map((r) => ({ id: r.id, s: score(r, me, t) }))
    .sort((a, b) => b.s - a.s || b.id - a.id)
    .map((x) => x.id);
  return {
    ids,
    oldest: rows.length ? rows[rows.length - 1].id : null,
    newest: rows.length ? rows[0].id : null,
    at: t,
  };
}

/** 推荐顺序。fresh：第一页，重新算；翻页时用缓存（过期了也重新算） */
export function rankedFeed(me: number, fresh: boolean): Ranked {
  const hit = cache.get(me);
  if (!fresh && hit && now() - hit.at < TTL) return hit;
  const r = compute(me);
  cache.delete(me);
  cache.set(me, r);
  // 只留最近用过的 1000 个人
  if (cache.size > 1000) cache.delete(cache.keys().next().value!);
  return r;
}
