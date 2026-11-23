import { all, get, now, run, tx } from './db.ts';

/**
 * 吧内等级（贴吧式）。1–10 级门槛和贴吧一样；10 级以上按校园的时间尺度压缩，
 * 每天都活跃（约 12 经验/天）的人大概半年到一学年拿到 10 级黄牌，三年左右到 16 级橙牌。
 */
export const LEVEL_EXP = [
  0, 5, 15, 30, 50, 100, 200, 500, 1000, // 1–9
  2000, 3000, 4500, 6000, 8000, 10000, // 10–15
  13000, 18000, 25000, // 16–18
] as const;
export const MAX_LEVEL = LEVEL_EXP.length;

export const DEFAULT_TITLES = [
  '新来的', '路过', '冒个泡', '常来', '混个脸熟', '熟面孔', '活跃分子', '中坚力量', '骨干',
  '老东西', '老油条', '老江湖', '镇吧之宝', '活化石', '吧中传说',
  '元老', '吧魂', '校墙传奇',
];

/** 经验规则 */
export const EXP = {
  checkinBase: 6,
  /** 每连续签到 7 天多 1 点，最多多 4 点（签到最多 +10） */
  checkinStreakMax: 4,
  topic: 4,
  reply: 2,
  /** 发帖 + 回复每吧每天上限 */
  postDailyCap: 40,
  /** 少于这么多字、又没带图的回复不给经验 */
  replyMinChars: 5,
  liked: 1,
  likedDailyCap: 10,
};

export function levelOf(exp: number) {
  let lv = 1;
  while (lv < MAX_LEVEL && exp >= LEVEL_EXP[lv]) lv++;
  return lv;
}

export function parseTitles(raw: string | null | undefined): string[] {
  try {
    const v = JSON.parse(raw ?? '[]');
    return Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : '')).slice(0, MAX_LEVEL) : [];
  } catch {
    return [];
  }
}
export function titleOf(level: number, titles: string[]) {
  return titles[level - 1]?.trim() || DEFAULT_TITLES[level - 1];
}

export interface LevelInfo {
  level: number;
  title: string;
}
export function levelInfo(exp: number, titlesRaw: string | null | undefined): LevelInfo {
  const level = levelOf(exp);
  return { level, title: titleOf(level, parseTitles(titlesRaw)) };
}

/** 我在某个吧的完整等级信息（吧首页用） */
export function myLevel(boardId: number, userId: number, titlesRaw: string) {
  const r = get<{ exp: number; checkin_day: string | null; streak: number; checkin_total: number }>(
    'SELECT exp, checkin_day, streak, checkin_total FROM board_exp WHERE board_id = $b AND user_id = $u',
    { b: boardId, u: userId },
  );
  const exp = r?.exp ?? 0;
  const { level, title } = levelInfo(exp, titlesRaw);
  const today = dayOf(now());
  // 昨天也没签，连签就断了
  const streak = r && (r.checkin_day === today || r.checkin_day === dayOf(now() - 86400_000)) ? r.streak : 0;
  return {
    exp,
    level,
    title,
    levelExp: LEVEL_EXP[level - 1],
    nextExp: level < MAX_LEVEL ? LEVEL_EXP[level] : null,
    checkedIn: r?.checkin_day === today,
    streak,
    checkinTotal: r?.checkin_total ?? 0,
    /** 下一次签到能拿多少（今天签过就是明天的） */
    nextCheckinExp: checkinExp(streak + 1),
  };
}

/** 北京时间的日期，零点换天 */
export function dayOf(t: number) {
  return new Date(t + 8 * 3600_000).toISOString().slice(0, 10);
}

export function checkinExp(streak: number) {
  return EXP.checkinBase + Math.min(EXP.checkinStreakMax, Math.floor(streak / 7));
}

const isMember = (boardId: number, userId: number) =>
  !!get('SELECT 1 FROM board_members WHERE board_id = $b AND user_id = $u', { b: boardId, u: userId });

const sumToday = (boardId: number, userId: number, day: string, kinds: string[]) =>
  get<{ n: number }>(
    `SELECT COALESCE(SUM(delta), 0) AS n FROM exp_log
     WHERE board_id = $b AND user_id = $u AND day = $d AND kind IN (SELECT value FROM json_each($k))`,
    { b: boardId, u: userId, d: day, k: JSON.stringify(kinds) },
  )!.n;

/** 记一笔经验；同一笔（kind + ref）只记一次。返回实际加了多少。不开事务，调用方负责 */
function grant(boardId: number, userId: number, kind: string, ref: string, delta: number, t = now(), day = dayOf(t)) {
  if (delta <= 0) return 0;
  const r = run(
    `INSERT OR IGNORE INTO exp_log (board_id, user_id, kind, ref, delta, day, created_at)
     VALUES ($b, $u, $k, $ref, $d, $day, $t)`,
    { b: boardId, u: userId, k: kind, ref, d: delta, day, t },
  );
  if (!r.changes) return 0;
  run(
    `INSERT INTO board_exp (board_id, user_id, exp) VALUES ($b, $u, $d)
     ON CONFLICT(board_id, user_id) DO UPDATE SET exp = exp + excluded.exp`,
    { b: boardId, u: userId, d: delta },
  );
  return delta;
}

function revoke(boardId: number, userId: number, kind: string, ref: string) {
  const r = get<{ id: number; delta: number }>(
    'SELECT id, delta FROM exp_log WHERE board_id = $b AND user_id = $u AND kind = $k AND ref = $ref',
    { b: boardId, u: userId, k: kind, ref },
  );
  if (!r) return;
  run('DELETE FROM exp_log WHERE id = $id', { id: r.id });
  run('UPDATE board_exp SET exp = MAX(exp - $d, 0) WHERE board_id = $b AND user_id = $u', { d: r.delta, b: boardId, u: userId });
}

function postGain(p: { parent_id: number | null; content: string; images: string }) {
  if (!p.parent_id) return EXP.topic;
  const chars = [...p.content.replace(/\s+/g, '')].length;
  const hasImages = p.images !== '[]' && p.images !== '';
  return chars >= EXP.replyMinChars || hasImages ? EXP.reply : 0;
}

/** 帖子公开（发出或审核通过）时给作者加经验。要已经加入这个吧 */
export function grantForPost(postId: number) {
  const p = get<{ author_id: number; board_id: number | null; parent_id: number | null; content: string; images: string; created_at: number }>(
    'SELECT author_id, board_id, parent_id, content, images, created_at FROM posts WHERE id = $id AND repost_of IS NULL',
    { id: postId },
  );
  if (!p?.board_id || !isMember(p.board_id, p.author_id)) return;
  const t = now();
  const day = dayOf(t);
  const room = EXP.postDailyCap - sumToday(p.board_id, p.author_id, day, ['topic', 'reply']);
  grant(p.board_id, p.author_id, p.parent_id ? 'reply' : 'topic', String(postId), Math.min(postGain(p), room), t, day);
}

/** 帖子被撤下（违规删除、审核改判）时扣回这条帖子给的经验 */
export function revokeForPost(postId: number) {
  const p = get<{ author_id: number; board_id: number | null; parent_id: number | null }>(
    'SELECT author_id, board_id, parent_id FROM posts WHERE id = $id',
    { id: postId },
  );
  if (!p?.board_id) return;
  revoke(p.board_id, p.author_id, p.parent_id ? 'reply' : 'topic', String(postId));
}

/** 被点赞 / 被回应：同一个人每天只给你算一次，每天最多 10 点 */
export function grantForLike(post: { id: number; author_id: number; board_id: number | null }, likerId: number) {
  if (!post.board_id || post.author_id === likerId || !isMember(post.board_id, post.author_id)) return;
  const t = now();
  const day = dayOf(t);
  const room = EXP.likedDailyCap - sumToday(post.board_id, post.author_id, day, ['liked']);
  grant(post.board_id, post.author_id, 'liked', `${likerId}@${day}`, Math.min(EXP.liked, room), t, day);
}

/** 签到。返回这次加的经验；今天已经签过返回 null */
/** t：一键签到时整批用同一个时间，跨零点也不会一半算今天、一半算昨天 */
export function checkin(boardId: number, userId: number, t = now()) {
  const today = dayOf(t);
  const yesterday = dayOf(t - 86400_000);
  const r = get<{ checkin_day: string | null; streak: number }>(
    'SELECT checkin_day, streak FROM board_exp WHERE board_id = $b AND user_id = $u',
    { b: boardId, u: userId },
  );
  if (r?.checkin_day === today) return null;
  const streak = r?.checkin_day === yesterday ? r.streak + 1 : 1;
  const gained = checkinExp(streak);
  run(
    `INSERT INTO board_exp (board_id, user_id, exp, checkin_day, streak, checkin_total) VALUES ($b, $u, 0, $d, $s, 1)
     ON CONFLICT(board_id, user_id) DO UPDATE SET checkin_day = $d, streak = $s, checkin_total = checkin_total + 1`,
    { b: boardId, u: userId, d: today, s: streak },
  );
  grant(boardId, userId, 'checkin', today, gained, t, today);
  return { gained, streak };
}

/**
 * 第一次上线等级时，按历史发帖、回复和收到的赞补算经验（规则和每天上限都一样）。
 * 签到以前没有记录，补不了。只跑一次。
 */
export function backfillLevels() {
  tx(() => {
    if (get("SELECT 1 FROM settings WHERE key = 'levels_backfilled'")) return;
    const posts = all<{ id: number; author_id: number; board_id: number; parent_id: number | null; content: string; images: string; created_at: number }>(
      `SELECT id, author_id, board_id, parent_id, content, images, created_at FROM posts
       WHERE board_id IS NOT NULL AND repost_of IS NULL AND status = 'ok' AND deleted = 0 ORDER BY created_at, id`,
    );
    const used = new Map<string, number>();
    for (const p of posts) {
      const day = dayOf(p.created_at);
      const key = `${p.board_id}:${p.author_id}:${day}`;
      const room = EXP.postDailyCap - (used.get(key) ?? 0);
      const got = grant(p.board_id, p.author_id, p.parent_id ? 'reply' : 'topic', String(p.id), Math.min(postGain(p), room), p.created_at, day);
      used.set(key, (used.get(key) ?? 0) + got);
    }
    // 点赞和表情回应合在一起：同一个人每天只算一次
    const likes = all<{ board_id: number; author_id: number; liker: number; t: number }>(
      `SELECT p.board_id, p.author_id, x.user_id AS liker, x.created_at AS t
       FROM (SELECT post_id, user_id, created_at FROM likes UNION ALL SELECT post_id, user_id, created_at FROM reactions) x
       JOIN posts p ON p.id = x.post_id
       WHERE p.board_id IS NOT NULL AND p.status = 'ok' AND p.deleted = 0 AND p.author_id <> x.user_id
       ORDER BY x.created_at`,
    );
    const liked = new Map<string, number>();
    for (const l of likes) {
      const day = dayOf(l.t);
      const key = `${l.board_id}:${l.author_id}:${day}`;
      if ((liked.get(key) ?? 0) >= EXP.likedDailyCap) continue;
      const got = grant(l.board_id, l.author_id, 'liked', `${l.liker}@${day}`, EXP.liked, l.t, day);
      liked.set(key, (liked.get(key) ?? 0) + got);
    }
    run("INSERT INTO settings (key, value) VALUES ('levels_backfilled', '1')");
  });
}
backfillLevels();

/** 某个吧的等级排行 */
export function ranking(boardId: number, limit = 50) {
  return all<{ user_id: number; exp: number }>(
    `SELECT e.user_id, e.exp FROM board_exp e
     JOIN board_members m ON m.board_id = e.board_id AND m.user_id = e.user_id
     WHERE e.board_id = $b AND e.exp > 0 ORDER BY e.exp DESC, e.user_id LIMIT $limit`,
    { b: boardId, limit },
  );
}

/** 我在这个吧排第几（只算加入了的人） */
export function rankOf(boardId: number, userId: number) {
  const mine = get<{ exp: number }>('SELECT exp FROM board_exp WHERE board_id = $b AND user_id = $u', { b: boardId, u: userId });
  if (!mine || mine.exp <= 0) return null;
  return get<{ n: number }>(
    `SELECT COUNT(*) + 1 AS n FROM board_exp e JOIN board_members m ON m.board_id = e.board_id AND m.user_id = e.user_id
     WHERE e.board_id = $b AND (e.exp > $x OR (e.exp = $x AND e.user_id < $u))`,
    { b: boardId, x: mine.exp, u: userId },
  )!.n;
}
