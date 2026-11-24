/**
 * 活动（比如校运会、迎新）：管理员设好时间、话题和奖励。
 * - 活动期间带 #话题 发一条公开的主帖：记一条待审核的参与，管理员通过后作者 +post_reward 颗紫水晶，
 *   每个活动每人一次。被驳回的可以再发一条重新提交
 * - checkin_bonus > 1 时，活动期间每日签到的紫水晶翻倍
 * - 开始时 App 推送一次，首页顶部显示活动卡片，活动页能看到所有参与的帖子
 * - 参与的帖子因违规被删，奖励会扣回（crystals.ts 的 revokeCrystalsForPost），而且不能再领
 *
 * 函数都不开事务，调用方负责。
 */
import { all, get, now, run } from './db.ts';
import { record } from './crystals.ts';
import { HttpError } from './util.ts';

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
  const last = get<{ status: string; note: string }>(
    'SELECT status, note FROM event_entries WHERE event_id = $e AND user_id = $me ORDER BY id DESC LIMIT 1', { e: e.id, me: meId },
  );
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
    me: {
      posted,
      rewarded,
      /** 最近一次提交的审核状态：pending 审核中，rejected 被驳回（note 是理由） */
      review: last && !rewarded ? { status: last.status, note: last.note } : null,
    },
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

/** 帖子发布（或者内容审核通过）时调用：带了活动话题就记一条待审核的参与。返回提交了哪些活动 */
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
  const out: { id: number; title: string; reward: number }[] = [];
  for (const e of events) {
    // 已经领过（或者领过又因违规被扣回）、还有一条在审核中的，都不再提交
    if (get("SELECT 1 FROM crystal_log WHERE user_id = $u AND kind = 'event' AND ref = $r", { u: p.author_id, r: String(e.id) })) continue;
    // 审核中的那条帖子自己删掉了：作废，这条新的顶上
    run(
      `UPDATE event_entries SET status = 'rejected', note = '帖子已删除', reviewed_at = $t
       WHERE event_id = $e AND user_id = $u AND status = 'pending'
         AND post_id IN (SELECT id FROM posts WHERE deleted = 1 OR status <> 'ok')`,
      { e: e.id, u: p.author_id, t: now() },
    );
    if (get("SELECT 1 FROM event_entries WHERE event_id = $e AND user_id = $u AND status = 'pending'", { e: e.id, u: p.author_id })) continue;
    run(
      `INSERT OR IGNORE INTO event_entries (event_id, user_id, post_id, reward, created_at)
       VALUES ($e, $u, $p, $r, $t)`,
      { e: e.id, u: p.author_id, p: p.id, r: e.post_reward, t: now() },
    );
    out.push({ id: e.id, title: e.title, reward: e.post_reward });
  }
  return out;
}

/* ---------------- 审核参与 ---------------- */

type EntryRow = { id: number; event_id: number; user_id: number; post_id: number; reward: number; status: string; title: string };

function entryById(id: number) {
  return get<EntryRow>(
    'SELECT x.*, e.title FROM event_entries x JOIN events e ON e.id = x.event_id WHERE x.id = $id', { id },
  );
}

function notifyEntry(x: EntryRow, adminId: number, extra: object) {
  // 不挂在帖子上：帖子被删了通知也要能看到；点开去活动页
  run(`INSERT INTO notifications (user_id, actor_id, type, extra, created_at) VALUES ($u, $a, 'event', $x, $t)`, {
    u: x.user_id, a: adminId, x: JSON.stringify({ title: x.title, eventId: x.event_id, ...extra }), t: now(),
  });
}

/** 通过：发紫水晶、通知参与者。帖子已经被删或者不公开了就不能通过 */
export function approveEntry(id: number, adminId: number) {
  const x = entryById(id);
  if (!x) throw new HttpError(404, '没有这条参与');
  if (x.status !== 'pending') throw new HttpError(409, '这条已经审核过了');
  const ok = get(
    `SELECT 1 FROM posts p WHERE p.id = $id AND p.deleted = 0 AND p.status = 'ok'
       AND (p.board_id IS NULL OR EXISTS (SELECT 1 FROM boards eb WHERE eb.id = p.board_id AND eb.visibility = 'public'))`,
    { id: x.post_id },
  );
  if (!ok) throw new HttpError(400, '这条帖子已经删除或者不公开了，只能驳回');
  const gained = record(x.user_id, 'event', String(x.event_id), x.reward, x.post_id) ?? 0;
  run("UPDATE event_entries SET status = 'approved', reviewed_at = $t, reviewed_by = $a WHERE id = $id", { t: now(), a: adminId, id });
  if (gained) notifyEntry(x, adminId, { gained });
  return gained;
}

/** 驳回：不发紫水晶，告诉参与者理由；他可以再发一条重新提交 */
export function rejectEntry(id: number, adminId: number, note: string) {
  const x = entryById(id);
  if (!x) throw new HttpError(404, '没有这条参与');
  if (x.status !== 'pending') throw new HttpError(409, '这条已经审核过了');
  run("UPDATE event_entries SET status = 'rejected', note = $n, reviewed_at = $t, reviewed_by = $a WHERE id = $id", {
    n: note, t: now(), a: adminId, id,
  });
  notifyEntry(x, adminId, { rejected: true, note });
}
