/**
 * 活动（比如校运会、迎新）：管理员设好时间、话题和奖励。
 * - 活动期间带 #话题 发一条公开的主帖：作者 +post_reward 颗紫水晶，每个活动每人一次
 * - checkin_bonus > 1 时，活动期间每日签到的紫水晶翻倍
 * - 开始时 App 推送一次，首页顶部显示活动卡片，活动页能看到所有参与的帖子
 * - 参与的帖子因违规被删，奖励会扣回（crystals.ts 的 revokeCrystalsForPost），而且不能再领
 *
 * 函数都不开事务，调用方负责。
 */
import { all, get, now } from './db.ts';
import { record } from './crystals.ts';

export interface EventRow {
  id: number;
  title: string;
  body: string;
  tag: string;
  post_reward: number;
  checkin_bonus: number;
  starts_at: number;
  ends_at: number;
  created_at: number;
  ended: number;
}

/** 算参与的帖子：活动期间发的、带这个话题的、公开的主帖 */
export const EVENT_POSTS = `p.parent_id IS NULL AND p.repost_of IS NULL AND p.deleted = 0 AND p.status = 'ok'
  AND (p.board_id IS NULL OR EXISTS (SELECT 1 FROM boards eb WHERE eb.id = p.board_id AND eb.visibility = 'public'))
  AND p.created_at >= $start AND p.created_at < $end
  AND p.id IN (SELECT post_id FROM post_tags WHERE tag = $tag)`;

export function eventStatus(e: Pick<EventRow, 'starts_at' | 'ends_at' | 'ended'>, t = now()) {
  return e.ended || e.ends_at <= t ? 'ended' : e.starts_at > t ? 'upcoming' : 'active';
}

export function eventDTO(e: EventRow, meId: number) {
  const params = { start: e.starts_at, end: e.ends_at, tag: e.tag };
  const stats = get<{ posts: number; people: number }>(
    `SELECT COUNT(*) AS posts, COUNT(DISTINCT p.author_id) AS people FROM posts p WHERE ${EVENT_POSTS}`, params,
  )!;
  const posted = !!get(`SELECT 1 FROM posts p WHERE p.author_id = $me AND ${EVENT_POSTS}`, { ...params, me: meId });
  const rewarded = get<{ d: number }>(
    "SELECT delta AS d FROM crystal_log WHERE user_id = $me AND kind = 'event' AND ref = $ref", { me: meId, ref: String(e.id) },
  )?.d ?? 0;
  return {
    id: e.id,
    title: e.title,
    body: e.body,
    tag: e.tag,
    postReward: e.post_reward,
    checkinBonus: e.checkin_bonus,
    startsAt: e.starts_at,
    endsAt: e.ends_at,
    status: eventStatus(e),
    posts: stats.posts,
    people: stats.people,
    me: { posted, rewarded },
  };
}
export type EventDTO = ReturnType<typeof eventDTO>;

export const eventById = (id: number) => get<EventRow>('SELECT * FROM events WHERE id = $id', { id });

/** 首页、紫水晶页用：正在进行的和 7 天内要开始的 */
export function currentEvents(meId: number) {
  const t = now();
  return all<EventRow>(
    'SELECT * FROM events WHERE ended = 0 AND ends_at > $t AND starts_at < $soon ORDER BY starts_at, id LIMIT 5',
    { t, soon: t + 7 * 86_400_000 },
  ).map((e) => eventDTO(e, meId));
}

/** 推送用：这段时间里开始的活动 */
export function eventsStartedSince(from: number) {
  const t = now();
  return all<EventRow>(
    'SELECT * FROM events WHERE ended = 0 AND starts_at > $from AND starts_at <= $t AND ends_at > $t ORDER BY id DESC LIMIT 3',
    { from, t },
  );
}

/** 帖子发布（或者审核通过）时调用：带了活动话题就发奖励。返回发了哪些 */
export function eventRewardForPost(postId: number) {
  const p = get<{ id: number; author_id: number; created_at: number; role: string; ok: number }>(
    `SELECT p.id, p.author_id, p.created_at, u.role,
       (p.parent_id IS NULL AND p.repost_of IS NULL AND p.deleted = 0 AND p.status = 'ok'
        AND (p.board_id IS NULL OR EXISTS (SELECT 1 FROM boards eb WHERE eb.id = p.board_id AND eb.visibility = 'public'))) AS ok
     FROM posts p JOIN users u ON u.id = p.author_id WHERE p.id = $id`,
    { id: postId },
  );
  if (!p || !p.ok || p.role === 'bot') return [];
  const events = all<{ id: number; title: string; post_reward: number }>(
    `SELECT id, title, post_reward FROM events
     WHERE ended = 0 AND post_reward > 0 AND starts_at <= $t AND ends_at > $t
       AND tag IN (SELECT tag FROM post_tags WHERE post_id = $p)`,
    { t: p.created_at, p: p.id },
  );
  const out: { id: number; title: string; gained: number }[] = [];
  for (const e of events) {
    const gained = record(p.author_id, 'event', String(e.id), e.post_reward, p.id);
    if (gained) out.push({ id: e.id, title: e.title, gained });
  }
  return out;
}
