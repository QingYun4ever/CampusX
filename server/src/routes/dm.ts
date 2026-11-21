/**
 * 私信（Telegram 式一对一聊天）。
 * 前端轮询 /dm/with/:username?after=<最后一条 id> 拿新消息，同时返回对方读到了哪一条（显示 ✓✓）。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { all, get, now, run, type Row } from '../db.ts';
import { HttpError, me, parse } from '../util.ts';
import { USER_COLS, userPublic } from './users-common.ts';

const PAGE = 50;
const MAX_LEN = 2000;

function message(r: Row) {
  const deleted = !!r.deleted;
  return {
    id: r.id as number,
    senderId: r.sender_id as number,
    content: deleted ? '' : (r.content as string),
    deleted,
    createdAt: r.created_at as number,
  };
}

function peerOf(username: string, meId: number) {
  const r = get(`SELECT ${USER_COLS}, u.last_seen_at FROM users u WHERE u.username = $n`, { n: username });
  if (!r) throw new HttpError(404, '没有这个用户');
  if (r.id === meId) throw new HttpError(400, '不能给自己发私信');
  return { ...userPublic(r), lastSeenAt: (r.last_seen_at as number | null) ?? null };
}

/** 对方已经读到我发的哪一条 */
const peerReadUpTo = (meId: number, peerId: number) =>
  get<{ id: number | null }>(
    'SELECT MAX(id) AS id FROM dm_messages WHERE sender_id = $me AND recipient_id = $p AND read_at IS NOT NULL',
    { me: meId, p: peerId },
  )?.id ?? 0;

export async function dmRoutes(app: FastifyInstance) {
  /** 聊天列表：每个聊天对象的最后一条消息和未读数 */
  app.get('/dm/conversations', async (req) => {
    const user = me(req);
    const rows = all(
      `WITH mine AS (
         SELECT CASE WHEN sender_id = $me THEN recipient_id ELSE sender_id END AS peer, id,
                (recipient_id = $me AND read_at IS NULL) AS unread
         FROM dm_messages WHERE sender_id = $me OR recipient_id = $me
       ), conv AS (
         SELECT peer, MAX(id) AS last_id, SUM(unread) AS unread FROM mine GROUP BY peer
       )
       SELECT conv.unread, conv.last_id, m.sender_id, m.content, m.deleted, m.created_at AS m_created_at, m.read_at,
              ${USER_COLS}, u.last_seen_at
       FROM conv JOIN dm_messages m ON m.id = conv.last_id JOIN users u ON u.id = conv.peer
       ORDER BY conv.last_id DESC LIMIT 200`,
      { me: user.id },
    );
    return rows.map((r) => ({
      peer: { ...userPublic(r), lastSeenAt: (r.last_seen_at as number | null) ?? null },
      unread: r.unread as number,
      last: {
        id: r.last_id as number,
        senderId: r.sender_id as number,
        content: r.deleted ? '' : (r.content as string),
        deleted: !!r.deleted,
        createdAt: r.m_created_at as number,
        read: r.read_at != null,
      },
    }));
  });

  app.get('/dm/unread-count', async (req) => {
    const r = get<{ n: number }>('SELECT COUNT(*) AS n FROM dm_messages WHERE recipient_id = $me AND read_at IS NULL', {
      me: me(req).id,
    });
    return { count: r?.n ?? 0 };
  });

  /**
   * 和某人的消息。
   * - 不带参数：最近 50 条
   * - before=<id>：更早的 50 条（往上翻）
   * - after=<id>：这条之后的新消息（轮询）
   * 都按 id 正序返回
   */
  app.get('/dm/with/:username', async (req) => {
    const user = me(req);
    const peer = peerOf((req.params as { username: string }).username, user.id);
    const q = req.query as { before?: string; after?: string };
    const before = Number(q.before) || 0;
    const after = Number(q.after) || 0;
    const pair = `((sender_id = $me AND recipient_id = $p) OR (sender_id = $p AND recipient_id = $me))`;
    const rows = after
      ? all(`SELECT * FROM dm_messages WHERE ${pair} AND id > $after ORDER BY id ASC LIMIT 200`, { me: user.id, p: peer.id, after })
      : all(`SELECT * FROM dm_messages WHERE ${pair} AND ($before = 0 OR id < $before) ORDER BY id DESC LIMIT $limit`, {
          me: user.id,
          p: peer.id,
          before,
          limit: PAGE,
        }).reverse();
    // 轮询时也要知道对方删掉了哪些消息
    const deletedIds = after
      ? all<{ id: number }>(`SELECT id FROM dm_messages WHERE ${pair} AND deleted = 1 AND id <= $after ORDER BY id DESC LIMIT 100`, {
          me: user.id,
          p: peer.id,
          after,
        }).map((r) => r.id)
      : [];
    return {
      peer,
      messages: rows.map(message),
      hasMore: !after && rows.length >= PAGE,
      peerReadUpTo: peerReadUpTo(user.id, peer.id),
      deletedIds,
    };
  });

  app.post('/dm/with/:username', { config: { rateLimit: { max: 40, timeWindow: '1 minute' } } }, async (req) => {
    const user = me(req);
    const peer = peerOf((req.params as { username: string }).username, user.id);
    const { content } = parse(
      z.object({ content: z.string().trim().min(1, '消息不能为空').max(MAX_LEN, `一条消息最多 ${MAX_LEN} 字`) }),
      req.body,
    );
    const t = now();
    const { lastId } = run(
      'INSERT INTO dm_messages (sender_id, recipient_id, content, created_at) VALUES ($s, $r, $c, $t)',
      { s: user.id, r: peer.id, c: content, t },
    );
    return message(get('SELECT * FROM dm_messages WHERE id = $id', { id: lastId })!);
  });

  /** 打开聊天时把对方发来的标为已读 */
  app.post('/dm/with/:username/read', async (req) => {
    const user = me(req);
    const peer = peerOf((req.params as { username: string }).username, user.id);
    run('UPDATE dm_messages SET read_at = $t WHERE sender_id = $p AND recipient_id = $me AND read_at IS NULL', {
      t: now(),
      p: peer.id,
      me: user.id,
    });
    return { ok: true };
  });

  /** 撤回自己的消息（双方都看不到内容） */
  app.delete('/dm/messages/:id', async (req) => {
    const user = me(req);
    const id = Number((req.params as { id: string }).id);
    const r = run("UPDATE dm_messages SET deleted = 1, content = '' WHERE id = $id AND sender_id = $me", { id, me: user.id });
    if (!r.changes) throw new HttpError(404, '消息不存在');
    return { ok: true };
  });
}
