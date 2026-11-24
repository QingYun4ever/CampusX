/**
 * 推流：花紫水晶，让一条帖子被更多人看到。
 *
 * - 买的是「多少个人能看到」：1 颗 = BOOST.reachPer 人。可以推自己的帖子，也可以帮别人推好帖子
 * - 能买多少人有上限：最近两周上过线、还没看过这条的人（减去别的推流已经占下的）。人少，不能卖出推不完的量
 * - 只出现在首页「全部」里，每一页最多插 1 条，标「推流」。同一条帖子同一个人只给他看一次
 * - 不给作者本人、看过（浏览记录里有）、赞过或回复过的人、和作者互相拉黑的人看；只推公开的主帖，发出来不超过 7 天
 * - 看满、到期（72 小时）、帖子被删或者变成不公开，推流就结束，没用完的人数按比例退回紫水晶
 *
 * 函数都不开事务，调用方负责。
 */
import { all, get, now, run } from './db.ts';
import { dayOf } from './levels.ts';
import { BOOST, isNewAccount, record, spend, sumToday } from './crystals.ts';
import { publicPost } from './serialize.ts';
import { HttpError } from './util.ts';

/** 推流对象：公开、没删、是主帖不是转发 */
const BOOSTABLE = (alias: string) => `${publicPost(alias)} AND ${alias}.parent_id IS NULL AND ${alias}.repost_of IS NULL`;

export function boostPost(buyerId: number, postId: number, amount: number) {
  if (!(BOOST.amounts as readonly number[]).includes(amount)) throw new HttpError(400, '推流数量无效');
  const t = now();
  const p = get<{ id: number; author_id: number; created_at: number; role: string }>(
    `SELECT p.id, p.author_id, p.created_at, u.role FROM posts p JOIN users u ON u.id = p.author_id
     WHERE p.id = $id AND ${BOOSTABLE('p')}`,
    { id: postId },
  );
  if (!p) throw new HttpError(400, '只能推流公开的主帖（不在私密吧里，不是回复）');
  if (p.role === 'bot') throw new HttpError(400, 'AI 助手的帖子不能推流');
  if (t - p.created_at > BOOST.maxPostAgeDays * 86_400_000) throw new HttpError(400, `只能推流 ${BOOST.maxPostAgeDays} 天内发的帖子`);
  const buyer = get<{ created_at: number }>('SELECT created_at FROM users WHERE id = $u', { u: buyerId });
  if (!buyer) throw new HttpError(404, '用户不存在');
  if (isNewAccount(buyer)) throw new HttpError(403, '注册满 3 天后才能推流');
  const spent = -sumToday(buyerId, 'boost', dayOf(t));
  if (spent + amount > BOOST.dailyCap) {
    throw new HttpError(400, `每天最多花 ${BOOST.dailyCap} 颗推流，今天还能花 ${Math.max(0, BOOST.dailyCap - spent)} 颗`);
  }
  const reach = amount * BOOST.reachPer;
  const room = boostRoom(p.id, p.author_id);
  if (reach > room) {
    throw new HttpError(400, room < BOOST.amounts[0] * BOOST.reachPer
      ? `最近两周活跃的同学里，还没看过这条的只有 ${room} 人，不用推流啦`
      : `最近两周活跃的同学里，还没看过这条的只有 ${room} 人，选小一点的档位吧`);
  }
  const id = Number(
    run(
      `INSERT INTO boosts (post_id, buyer_id, amount, reach, created_at, expires_at)
       VALUES ($p, $b, $a, $r, $t, $exp)`,
      { p: p.id, b: buyerId, a: amount, r: reach, t, exp: t + BOOST.hours * 3_600_000 },
    ).lastId,
  );
  spend(buyerId, 'boost', String(id), amount, p.id);
  // 帮别人推：告诉作者一声（被作者拉黑了就不说）
  if (p.author_id !== buyerId && !get('SELECT 1 FROM blocks WHERE blocker_id = $u AND blocked_id = $a', { u: p.author_id, a: buyerId })) {
    run(`INSERT INTO notifications (user_id, actor_id, type, post_id, extra, created_at) VALUES ($u, $a, 'boost', $p, $x, $t)`, {
      u: p.author_id, a: buyerId, p: p.id, x: String(reach), t,
    });
  }
  return reach;
}

/** 不能看推流的人（SQL 条件，$me 是观看的人，p 是帖子） */
const CANT_SEE = `(EXISTS (SELECT 1 FROM boost_views v WHERE v.post_id = p.id AND v.user_id = $me)
  OR EXISTS (SELECT 1 FROM post_views pv WHERE pv.post_id = p.id AND pv.user_id = $me)
  OR EXISTS (SELECT 1 FROM blocks k WHERE (k.blocker_id = $me AND k.blocked_id = p.author_id)
                                     OR (k.blocker_id = p.author_id AND k.blocked_id = $me))
  OR EXISTS (SELECT 1 FROM likes l WHERE l.post_id = p.id AND l.user_id = $me)
  OR EXISTS (SELECT 1 FROM posts r WHERE r.parent_id = p.id AND r.author_id = $me))`;

/** 这条帖子还能再推给多少人：最近两周上过线、能看到它的人，减去进行中的推流还没用完的 */
export function boostRoom(postId: number, authorId: number) {
  const audience = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM users u, posts p
     WHERE p.id = $p AND u.id <> $a AND u.role <> 'bot' AND u.last_seen_at > $since
       AND NOT ${CANT_SEE.replaceAll('$me', 'u.id')}`,
    { p: postId, a: authorId, since: now() - BOOST.activeDays * 86_400_000 },
  )!.n;
  const pending = get<{ n: number }>(
    'SELECT COALESCE(SUM(reach - shown), 0) AS n FROM boosts WHERE post_id = $p AND ended_at IS NULL', { p: postId },
  )!.n;
  return Math.max(0, audience - pending);
}

let lastSweep = 0;

/** 结束看满了、到期了、帖子没了的推流，退回没用完的。默认每分钟最多扫一次 */
export function endBoosts(force = false) {
  const t = now();
  if (!force && t - lastSweep < 60_000) return;
  lastSweep = t;
  const rows = all<{ id: number; post_id: number; buyer_id: number; reach: number; shown: number }>(
    `SELECT b.id, b.post_id, b.buyer_id, b.reach, b.shown FROM boosts b LEFT JOIN posts p ON p.id = b.post_id
     WHERE b.ended_at IS NULL AND (b.shown >= b.reach OR b.expires_at <= $t OR p.id IS NULL OR NOT (${BOOSTABLE('p')}))`,
    { t },
  );
  for (const b of rows) endBoost(b, t);
}

function endBoost(b: { id: number; post_id: number; buyer_id: number; reach: number; shown: number }, t: number) {
  const refund = Math.floor(Math.max(0, b.reach - b.shown) / BOOST.reachPer);
  const r = run('UPDATE boosts SET ended_at = $t, refund = $r WHERE id = $id AND ended_at IS NULL', { t, r: refund, id: b.id });
  if (r.changes && refund) record(b.buyer_id, 'boost_refund', String(b.id), refund, b.post_id, t);
}

/**
 * 给这个人挑一条推流帖子，并记一次曝光。
 * before：只挑比这一页最旧的帖子还旧的（更新的那些他往下翻的时候已经看过了）；exclude：这一页里已经有的
 */
export function takeBoost(viewerId: number, before: number, exclude: number[]) {
  const t = now();
  const b = get<{ id: number; post_id: number; buyer_id: number; reach: number; shown: number }>(
    `SELECT b.id, b.post_id, b.buyer_id, b.reach, b.shown FROM boosts b JOIN posts p ON p.id = b.post_id
     WHERE b.ended_at IS NULL AND b.shown < b.reach AND b.expires_at > $t
       AND p.id < $before AND p.id NOT IN (SELECT value FROM json_each($ex))
       AND p.author_id <> $me AND ${BOOSTABLE('p')} AND NOT ${CANT_SEE}
     ORDER BY CAST(b.shown AS REAL) / b.reach, b.id LIMIT 1`,
    { t, before, ex: JSON.stringify(exclude), me: viewerId },
  );
  if (!b) return null;
  run('INSERT INTO boost_views (post_id, user_id, boost_id, created_at) VALUES ($p, $u, $b, $t)', { p: b.post_id, u: viewerId, b: b.id, t });
  run('UPDATE boosts SET shown = shown + 1 WHERE id = $id', { id: b.id });
  if (b.shown + 1 >= b.reach) endBoost({ ...b, shown: b.shown + 1 }, t);
  return b.post_id;
}

/** 一条帖子的推流情况：所有人看到的总数，加上我自己买的每一笔 */
export function boostStatus(postId: number, meId: number) {
  const total = get<{ reach: number; shown: number; active: number }>(
    `SELECT COALESCE(SUM(reach), 0) AS reach, COALESCE(SUM(shown), 0) AS shown,
            COALESCE(SUM(ended_at IS NULL), 0) AS active FROM boosts WHERE post_id = $p`,
    { p: postId },
  )!;
  const mine = all<{ id: number; amount: number; reach: number; shown: number; created_at: number; expires_at: number; ended_at: number | null; refund: number }>(
    'SELECT id, amount, reach, shown, created_at, expires_at, ended_at, refund FROM boosts WHERE post_id = $p AND buyer_id = $u ORDER BY id DESC LIMIT 20',
    { p: postId, u: meId },
  ).map((r) => ({
    id: r.id, amount: r.amount, reach: r.reach, shown: r.shown, createdAt: r.created_at,
    expiresAt: r.expires_at, endedAt: r.ended_at, refund: r.refund,
  }));
  const author = get<{ a: number }>('SELECT author_id AS a FROM posts WHERE id = $p', { p: postId })?.a;
  /** 还能买多少人 */
  const room = author === undefined ? 0 : boostRoom(postId, author);
  return { reach: total.reach, shown: total.shown, active: total.active > 0, room, mine };
}
