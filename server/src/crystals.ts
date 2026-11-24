/**
 * 紫水晶：全站通用、可以花的点数。和吧内等级经验分开——经验只涨不花，表示在某个吧的资历；
 * 紫水晶奖励「被别人认可」，用来解锁头像装扮、给好帖子打赏。
 *
 * - 每一笔都写进 crystal_log（只追加），users.crystals 是余额，两者在同一个事务里更新
 * - 赚：每日签到、被不同的人赞或回应（每天有上限）、新手任务
 * - 花：解锁头像装扮、打赏
 * - 帖子因违规被删时，扣回这条帖子被赞赚到的紫水晶（余额不够就扣到 0）
 *
 * 这里的函数都不开事务，调用方负责。
 */
import { all, get, now, run } from './db.ts';
import { dayOf } from './levels.ts';
import { HttpError } from './util.ts';

export const CRYSTAL = {
  checkinBase: 5,
  /** 每连续签到 7 天多 1 颗，最多多 3 颗（签到最多 +8） */
  checkinStreakMax: 3,
  liked: 1,
  likedDailyCap: 20,
  /** 注册不满这么多天的账号：赞别人不给对方加，也不能打赏 */
  newAccountDays: 3,
  tipAmounts: [1, 5, 10, 20, 50] as const,
  tipDailyCap: 100,
};

/** 头像装扮的价格；'' 是不戴，免费 */
export const DECORATION_PRICES: Record<string, number> = {
  halo: 30,
  rose: 30,
  aurora: 40,
  neon: 100,
  stars: 100,
  sakura: 120,
  snow: 120,
  prism: 150,
  neko: 150,
};

export const balanceOf = (userId: number) =>
  get<{ n: number }>('SELECT crystals AS n FROM users WHERE id = $u', { u: userId })?.n ?? 0;

/** 记一笔。同一笔（kind + ref）只记一次；返回实际记的数，没记返回 null */
function record(userId: number, kind: string, ref: string, delta: number, postId: number | null = null, t = now()) {
  const r = run(
    `INSERT OR IGNORE INTO crystal_log (user_id, kind, ref, delta, post_id, day, created_at)
     VALUES ($u, $k, $ref, $d, $p, $day, $t)`,
    { u: userId, k: kind, ref, d: delta, p: postId, day: dayOf(t), t },
  );
  if (!r.changes) return null;
  if (delta) run('UPDATE users SET crystals = crystals + $d WHERE id = $u', { d: delta, u: userId });
  return delta;
}

/** 花紫水晶：余额不够直接报错 */
function spend(userId: number, kind: string, ref: string, amount: number, postId: number | null = null) {
  if (balanceOf(userId) < amount) throw new HttpError(400, `紫水晶不够（需要 ${amount} 颗）`);
  if (record(userId, kind, ref, -amount, postId) === null) throw new HttpError(409, '这笔已经处理过了');
}

const sumToday = (userId: number, kind: string, day: string) =>
  get<{ n: number }>('SELECT COALESCE(SUM(delta), 0) AS n FROM crystal_log WHERE user_id = $u AND kind = $k AND day = $d', {
    u: userId, k: kind, d: day,
  })!.n;

const isNewAccount = (u: { created_at: number }) => now() - u.created_at < CRYSTAL.newAccountDays * 86_400_000;

/* ---------------- 签到 ---------------- */

export const checkinReward = (streak: number) => CRYSTAL.checkinBase + Math.min(CRYSTAL.checkinStreakMax, Math.floor(streak / 7));

function streakState(userId: number, t = now()) {
  const u = get<{ crystal_day: string | null; crystal_streak: number }>(
    'SELECT crystal_day, crystal_streak FROM users WHERE id = $u', { u: userId },
  );
  const today = dayOf(t);
  const checkedIn = u?.crystal_day === today;
  const alive = checkedIn || u?.crystal_day === dayOf(t - 86_400_000);
  return { today, checkedIn, streak: alive ? (u?.crystal_streak ?? 0) : 0 };
}

/** 每天第一次签到（全站签到，或者任何一个吧的签到）。今天签过返回 null */
export function crystalCheckin(userId: number, t = now()) {
  const s = streakState(userId, t);
  if (s.checkedIn) return null;
  const streak = s.streak + 1;
  run('UPDATE users SET crystal_day = $d, crystal_streak = $s WHERE id = $u', { d: s.today, s: streak, u: userId });
  const gained = record(userId, 'checkin', s.today, checkinReward(streak), null, t);
  return gained === null ? null : { gained, streak };
}

/* ---------------- 被赞 ---------------- */

/** 被赞或被回应：同一个人每天只给你算一次，每天最多 20 颗；新账号和 AI 的赞不算 */
export function crystalForLike(post: { id: number; author_id: number }, likerId: number) {
  if (post.author_id === likerId) return;
  const [author, liker] = [post.author_id, likerId].map((id) =>
    get<{ role: string; created_at: number }>('SELECT role, created_at FROM users WHERE id = $id', { id }),
  );
  if (!author || !liker || author.role === 'bot' || liker.role === 'bot' || isNewAccount(liker)) return;
  const t = now();
  const day = dayOf(t);
  const room = CRYSTAL.likedDailyCap - sumToday(post.author_id, 'liked', day);
  if (room <= 0) return;
  record(post.author_id, 'liked', `${likerId}@${day}`, Math.min(CRYSTAL.liked, room), post.id, t);
}

/** 帖子因违规被撤下：扣回它被赞赚到的。余额不够就扣到 0；每笔只扣一次 */
export function revokeCrystalsForPost(postId: number) {
  const rows = all<{ id: number; user_id: number; delta: number }>(
    "SELECT id, user_id, delta FROM crystal_log WHERE post_id = $p AND kind = 'liked' AND delta > 0", { p: postId },
  );
  for (const r of rows) {
    const take = Math.min(r.delta, balanceOf(r.user_id));
    record(r.user_id, 'revoke', `liked:${r.id}`, -take, postId);
  }
}

/* ---------------- 新手任务 ---------------- */

type Task = { id: string; title: string; reward: number; done: (userId: number) => boolean };

export const TASKS: Task[] = [
  { id: 'avatar', title: '换一个头像', reward: 10, done: (u) => !!get("SELECT 1 FROM users WHERE id = $u AND avatar IS NOT NULL AND avatar <> ''", { u }) },
  { id: 'bio', title: '写一句个人简介', reward: 10, done: (u) => !!get("SELECT 1 FROM users WHERE id = $u AND bio <> ''", { u }) },
  {
    id: 'post', title: '发第一条帖子', reward: 20,
    done: (u) => !!get("SELECT 1 FROM posts WHERE author_id = $u AND parent_id IS NULL AND repost_of IS NULL AND deleted = 0 AND status = 'ok'", { u }),
  },
  { id: 'board', title: '加入一个吧', reward: 10, done: (u) => !!get('SELECT 1 FROM board_members WHERE user_id = $u', { u }) },
  { id: 'follow', title: '关注 3 个人', reward: 10, done: (u) => get<{ n: number }>('SELECT COUNT(*) AS n FROM follows WHERE follower_id = $u', { u })!.n >= 3 },
  { id: 'checkin', title: '签到一次', reward: 10, done: (u) => !!get("SELECT 1 FROM crystal_log WHERE user_id = $u AND kind = 'checkin'", { u }) },
];

export function taskList(userId: number) {
  const claimed = new Set(
    all<{ ref: string }>("SELECT ref FROM crystal_log WHERE user_id = $u AND kind = 'task'", { u: userId }).map((r) => r.ref),
  );
  return TASKS.map((t) => ({ id: t.id, title: t.title, reward: t.reward, claimed: claimed.has(t.id), done: claimed.has(t.id) || t.done(userId) }));
}

export function claimTask(userId: number, id: string) {
  const task = TASKS.find((t) => t.id === id);
  if (!task) throw new HttpError(404, '没有这个任务');
  if (!task.done(userId)) throw new HttpError(400, '这个任务还没完成');
  if (record(userId, 'task', id, task.reward) === null) throw new HttpError(409, '已经领过了');
  return task.reward;
}

/* ---------------- 头像装扮 ---------------- */

export const ownedDecorations = (userId: number) =>
  all<{ decoration: string }>('SELECT decoration FROM user_decorations WHERE user_id = $u', { u: userId }).map((r) => r.decoration);

export function ownsDecoration(userId: number, id: string) {
  return id === '' || !!get('SELECT 1 FROM user_decorations WHERE user_id = $u AND decoration = $d', { u: userId, d: id });
}

export function buyDecoration(userId: number, id: string) {
  const price = DECORATION_PRICES[id];
  if (price === undefined) throw new HttpError(404, '没有这个装扮');
  if (ownsDecoration(userId, id)) throw new HttpError(409, '已经解锁了');
  spend(userId, 'buy', `decoration:${id}`, price);
  run('INSERT INTO user_decorations (user_id, decoration, created_at) VALUES ($u, $d, $t)', { u: userId, d: id, t: now() });
  return price;
}

/* ---------------- 打赏 ---------------- */

export function tipPost(fromId: number, post: { id: number; author_id: number }, amount: number) {
  if (!(CRYSTAL.tipAmounts as readonly number[]).includes(amount)) throw new HttpError(400, '打赏数量无效');
  if (post.author_id === fromId) throw new HttpError(400, '不能打赏自己');
  const [from, to] = [fromId, post.author_id].map((id) =>
    get<{ role: string; created_at: number }>('SELECT role, created_at FROM users WHERE id = $id', { id }),
  );
  if (!from || !to) throw new HttpError(404, '用户不存在');
  if (to.role === 'bot') throw new HttpError(400, 'AI 助手不收紫水晶');
  if (isNewAccount(from)) throw new HttpError(403, `注册满 ${CRYSTAL.newAccountDays} 天后才能打赏`);
  const t = now();
  const sent = -sumToday(fromId, 'tip_out', dayOf(t));
  if (sent + amount > CRYSTAL.tipDailyCap) throw new HttpError(400, `每天最多打赏 ${CRYSTAL.tipDailyCap} 颗，今天还能打赏 ${Math.max(0, CRYSTAL.tipDailyCap - sent)} 颗`);
  const tipId = Number(
    run('INSERT INTO tips (post_id, from_id, to_id, amount, created_at) VALUES ($p, $f, $to, $a, $t)', {
      p: post.id, f: fromId, to: post.author_id, a: amount, t,
    }).lastId,
  );
  spend(fromId, 'tip_out', String(tipId), amount, post.id);
  record(post.author_id, 'tip_in', String(tipId), amount, post.id, t);
  run('UPDATE posts SET tip_total = tip_total + $a WHERE id = $p', { a: amount, p: post.id });
  // 不走 notify() 的去重：同一个人可以给同一条帖子打赏多次
  if (!get('SELECT 1 FROM blocks WHERE blocker_id = $u AND blocked_id = $a', { u: post.author_id, a: fromId })) {
    run(`INSERT INTO notifications (user_id, actor_id, type, post_id, extra, created_at) VALUES ($u, $a, 'tip', $p, $x, $t)`, {
      u: post.author_id, a: fromId, p: post.id, x: String(amount), t,
    });
  }
  return { balance: balanceOf(fromId) };
}

/* ---------------- 钱包 ---------------- */

export function wallet(userId: number) {
  const s = streakState(userId);
  return {
    balance: balanceOf(userId),
    checkedIn: s.checkedIn,
    streak: s.streak,
    /** 今天签到能拿多少（已签到时是今天拿到的） */
    checkinReward: checkinReward(s.checkedIn ? s.streak : s.streak + 1),
    likedToday: sumToday(userId, 'liked', dayOf(now())),
    rules: CRYSTAL,
    tasks: taskList(userId),
    decorations: { prices: DECORATION_PRICES, owned: ownedDecorations(userId) },
  };
}

export function history(userId: number, before: number | null) {
  return all<{ id: number; kind: string; ref: string; delta: number; post_id: number | null; created_at: number }>(
    `SELECT id, kind, ref, delta, post_id, created_at FROM crystal_log
     WHERE user_id = $u AND ($before IS NULL OR id < $before) AND delta <> 0 ORDER BY id DESC LIMIT 30`,
    { u: userId, before },
  ).map((r) => ({ id: r.id, kind: r.kind, ref: r.ref, delta: r.delta, postId: r.post_id, createdAt: r.created_at }));
}
