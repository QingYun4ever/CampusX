import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { all, get, now, run, tx } from '../db.ts';
import { approveEntry, currentEvents, EVENT_POSTS, eventById, eventDTO, rejectEntry, type EventRow } from '../events.ts';
import { hydrate, normalizeTag, postById, postSelect } from '../serialize.ts';
import { userById } from './users-common.ts';
import { cursorNum, HttpError, me, parse } from '../util.ts';

const PAGE = 20;
const DAY = 86_400_000;

const eventSchema = z
  .object({
    title: z.string().trim().min(1, '请填写活动名称').max(30, '活动名称最多 30 字'),
    body: z.string().trim().max(1000, '介绍最多 1000 字').default(''),
    tag: z
      .string()
      .transform(normalizeTag)
      .refine((v) => /^[^\s#@，。！？、；：,.!?;:()（）「」[\]]{1,20}$/.test(v), '话题只能是一个词，不能有空格和标点'),
    postReward: z.number().int().min(0).max(50, '发帖奖励最多 50 颗').default(10),
    checkinBonus: z.number().int().min(1).max(3, '签到最多 3 倍').default(1),
    startsAt: z.number().int().positive(),
    endsAt: z.number().int().positive(),
  })
  .refine((v) => v.endsAt > v.startsAt, { message: '结束时间要晚于开始时间' })
  .refine((v) => v.endsAt - v.startsAt <= 31 * DAY, { message: '活动最长 31 天' });

export async function eventRoutes(app: FastifyInstance) {
  /** 正在进行和快开始的（首页卡片） */
  app.get('/events/current', async (req) => currentEvents(me(req).id));

  /** 活动列表：进行中、即将开始、最近结束的 */
  app.get('/events', async (req) => {
    const user = me(req);
    return all<EventRow>(
      'SELECT * FROM events WHERE ends_at > $since ORDER BY (ended = 0 AND ends_at > $t) DESC, starts_at DESC LIMIT 30',
      { since: now() - 60 * DAY, t: now() },
    ).map((e) => eventDTO(e, user.id));
  });

  app.get('/events/:id', async (req) => {
    const e = eventById(Number((req.params as { id: string }).id));
    if (!e) throw new HttpError(404, '活动不存在');
    return eventDTO(e, me(req).id);
  });

  app.get('/events/:id/posts', async (req) => {
    const user = me(req);
    const e = eventById(Number((req.params as { id: string }).id));
    if (!e) throw new HttpError(404, '活动不存在');
    const rows = all(
      `${postSelect()} WHERE ${EVENT_POSTS} AND ($cursor IS NULL OR p.id < $cursor) ORDER BY p.id DESC LIMIT $limit`,
      { me: user.id, start: e.starts_at, end: e.ends_at, tag: e.tag, cursor: cursorNum((req.query as { cursor?: string }).cursor), limit: PAGE },
    );
    const items = hydrate(rows, user.id);
    return { items, nextCursor: rows.length >= PAGE ? String(rows[rows.length - 1].id) : null };
  });

  app.register(async (admin) => {
    admin.addHook('preHandler', async (req) => {
      if (me(req).role !== 'admin') throw new HttpError(403, '需要管理员权限');
    });

    admin.get('/admin/events', async (req) =>
      all<EventRow>('SELECT * FROM events ORDER BY id DESC LIMIT 50').map((e) => eventDTO(e, me(req).id)),
    );

    admin.post('/admin/events', async (req) => {
      const body = parse(eventSchema, req.body);
      const t = now();
      if (body.endsAt <= t) throw new HttpError(400, '结束时间已经过了');
      if (body.startsAt > t + 90 * DAY) throw new HttpError(400, '只能提前 90 天建活动');
      // 开始时间填了过去的就从现在开始：推送按开始时间发，不能漏
      const start = Math.max(body.startsAt, t);
      const { lastId } = run(
        `INSERT INTO events (title, body, tag, post_reward, checkin_bonus, starts_at, ends_at, created_by, created_at)
         VALUES ($title, $body, $tag, $reward, $bonus, $start, $end, $by, $t)`,
        { title: body.title, body: body.body, tag: body.tag, reward: body.postReward, bonus: body.checkinBonus, start, end: body.endsAt, by: me(req).id, t },
      );
      return eventDTO(eventById(lastId)!, me(req).id);
    });

    /* ---------- 审核参与 ---------- */
    admin.get('/admin/event-entries/count', async () =>
      get<{ n: number }>("SELECT COUNT(*) AS n FROM event_entries WHERE status = 'pending'")!,
    );

    admin.get('/admin/event-entries', async (req) => {
      const q = req.query as { status?: string; cursor?: string };
      const status = q.status === 'done' ? 'done' : 'pending';
      const rows = all<{ id: number; event_id: number; user_id: number; post_id: number; reward: number; status: string; note: string; created_at: number; reviewed_at: number | null; title: string; tag: string }>(
        `SELECT x.*, e.title, e.tag FROM event_entries x JOIN events e ON e.id = x.event_id
         WHERE ${status === 'pending' ? "x.status = 'pending'" : "x.status <> 'pending'"}
           AND ($cursor IS NULL OR x.id ${status === 'pending' ? '>' : '<'} $cursor)
         ORDER BY x.id ${status === 'pending' ? 'ASC' : 'DESC'} LIMIT $limit`,
        { cursor: cursorNum(q.cursor), limit: PAGE },
      );
      const meId = me(req).id;
      const items = rows.map((r) => ({
        id: r.id,
        status: r.status,
        reward: r.reward,
        note: r.note,
        createdAt: r.created_at,
        reviewedAt: r.reviewed_at,
        event: { id: r.event_id, title: r.title, tag: r.tag },
        user: userById(r.user_id) ?? null,
        post: postById(r.post_id, meId) ?? null,
      }));
      return { items, nextCursor: rows.length >= PAGE ? String(rows[rows.length - 1].id) : null };
    });

    admin.post('/admin/event-entries/:id/approve', async (req) => {
      const gained = tx(() => approveEntry(Number((req.params as { id: string }).id), me(req).id));
      return { gained };
    });

    admin.post('/admin/event-entries/:id/reject', async (req) => {
      const { note } = parse(z.object({ note: z.string().trim().max(100, '理由最多 100 字').default('') }), req.body ?? {});
      tx(() => rejectEntry(Number((req.params as { id: string }).id), me(req).id, note));
      return { ok: true };
    });

    /** 提前结束。已经发出去的奖励不收回 */
    admin.post<{ Params: { id: string } }>('/admin/events/:id/end', async (req) => {
      const r = run('UPDATE events SET ended = 1, ends_at = MIN(ends_at, $t) WHERE id = $id', {
        id: Number(req.params.id), t: now(),
      });
      if (!r.changes) throw new HttpError(404, '活动不存在');
      return { ok: true };
    });

    /** 还没开始的活动可以删掉；开始了的只能结束（明细里还要显示活动名） */
    admin.delete('/admin/events/:id', async (req) => {
      const id = Number((req.params as { id: string }).id);
      const e = eventById(id);
      if (!e) throw new HttpError(404, '活动不存在');
      if (e.starts_at <= now() || get("SELECT 1 FROM crystal_log WHERE kind = 'event' AND ref = $r", { r: String(id) })) {
        throw new HttpError(400, '活动已经开始，只能结束不能删除');
      }
      run('DELETE FROM events WHERE id = $id', { id });
      return { ok: true };
    });
  });
}
