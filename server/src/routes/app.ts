import type { FastifyInstance } from 'fastify';
import { all, get, now } from '../db.ts';
import { HIDDEN_BOARDS, visibleNotification } from '../serialize.ts';
import { me } from '../util.ts';

/* ---------------- 后台推送（App 定时来取） ---------------- */

const clip = (s: string, n = 80) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
};

const NOTIF_TEXT: Record<string, string> = {
  reply: '回复了你',
  mention: '提到了你',
  quote: '引用了你的帖子',
  follow: '关注了你',
  repost: '转发了你的帖子',
  like: '赞了你的帖子',
  reaction: '回应了你的帖子',
};

export async function appRoutes(app: FastifyInstance) {
  /**
   * App 在后台每隔一段时间来取一次，有新东西就发系统通知。
   * since 是上次返回的 now；第一次不传，只返回游标，避免把旧消息全推一遍。
   */
  app.get('/push/poll', async (req, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const user = me(req);
    const q = req.query as { since?: string; dm?: string; posts?: string; interactions?: string };
    const t = now();
    const since = Number(q.since);
    if (!Number.isFinite(since) || since <= 0) return { now: t, items: [] };
    // 太久没来（关机好几天）也只看最近一天
    const from = Math.max(since, t - 86_400_000);
    const items: { id: string; kind: 'dm' | 'posts' | 'interactions'; title: string; body: string; path: string }[] = [];

    if (q.dm !== '0') {
      const rows = all<{ sender_id: number; username: string; display_name: string; n: number; content: string; images: number }>(
        `SELECT m.sender_id, u.username, u.display_name, COUNT(*) AS n,
                (SELECT m2.content FROM dm_messages m2 WHERE m2.sender_id = m.sender_id AND m2.recipient_id = $me
                   AND m2.deleted = 0 ORDER BY m2.id DESC LIMIT 1) AS content,
                (SELECT COUNT(*) FROM dm_message_images i WHERE i.message_id = MAX(m.id)) AS images
         FROM dm_messages m JOIN users u ON u.id = m.sender_id
         WHERE m.recipient_id = $me AND m.deleted = 0 AND m.read_at IS NULL AND m.created_at > $from
         GROUP BY m.sender_id ORDER BY MAX(m.id) DESC LIMIT 10`,
        { me: user.id, from },
      );
      for (const r of rows) {
        const text = clip(r.content) || (r.images ? '[图片]' : '');
        items.push({
          id: `dm-${r.sender_id}`,
          kind: 'dm',
          title: r.display_name,
          body: r.n > 1 ? `[${r.n} 条] ${text}` : text,
          path: `/messages/${r.username}`,
        });
      }
    }

    if (q.posts !== '0') {
      const rows = all<{ id: number; content: string; display_name: string; images: number }>(
        `SELECT p.id, p.content, u.display_name,
                (p.images <> '[]') AS images
         FROM posts p JOIN users u ON u.id = p.author_id
         WHERE p.author_id IN (SELECT followee_id FROM follows WHERE follower_id = $me)
           AND p.parent_id IS NULL AND p.repost_of IS NULL AND p.deleted = 0 AND p.status = 'ok'
           AND p.created_at > $from
           AND (p.board_id IS NULL OR p.board_id NOT IN ${HIDDEN_BOARDS})
         ORDER BY p.id DESC LIMIT 20`,
        { me: user.id, from },
      );
      if (rows.length > 3) {
        const names = [...new Set(rows.map((r) => r.display_name))];
        items.push({
          id: 'posts',
          kind: 'posts',
          title: '关注的人有新帖子',
          body: `${names.slice(0, 3).join('、')}${names.length > 3 ? ` 等 ${names.length} 人` : ''}发了 ${rows.length} 条新帖`,
          path: '/?tab=following',
        });
      } else {
        for (const r of rows) {
          items.push({
            id: `post-${r.id}`,
            kind: 'posts',
            title: `${r.display_name} 发了新帖`,
            body: clip(r.content) || (r.images ? '[图片]' : ''),
            path: `/post/${r.id}`,
          });
        }
      }
    }

    if (q.interactions !== '0') {
      const rows = all<{ id: number; type: string; post_id: number | null; display_name: string; content: string | null }>(
        `SELECT n.id, n.type, n.post_id, u.display_name, p.content
         FROM notifications n JOIN users u ON u.id = n.actor_id LEFT JOIN posts p ON p.id = n.post_id
         WHERE n.user_id = $me AND n.read = 0 AND n.created_at > $from AND ${visibleNotification}
         ORDER BY n.id DESC LIMIT 30`,
        { me: user.id, from },
      );
      // 赞和回应可能很多，合成一条；其它逐条推
      const quiet = rows.filter((r) => r.type === 'like' || r.type === 'reaction');
      for (const r of rows.filter((r) => !quiet.includes(r)).slice(0, 5)) {
        const moderation = r.type === 'moderation';
        const text = r.type === 'reply' || r.type === 'mention' || r.type === 'quote' ? clip(r.content ?? '') : '';
        items.push({
          id: `n-${r.id}`,
          kind: 'interactions',
          title: moderation ? '内容警告' : `${r.display_name} ${NOTIF_TEXT[r.type] ?? '有新动态'}`,
          body: moderation ? '你的帖子没有通过审核，没有发布' : text,
          path: r.post_id && !moderation ? `/post/${r.post_id}` : '/notifications',
        });
      }
      if (quiet.length) {
        const names = [...new Set(quiet.map((r) => r.display_name))];
        items.push({
          id: 'likes',
          kind: 'interactions',
          title: `${names.slice(0, 2).join('、')}${names.length > 2 ? ` 等 ${names.length} 人` : ''} ${
            quiet.every((r) => r.type === 'like') ? '赞了' : quiet.every((r) => r.type === 'reaction') ? '回应了' : '赞了或回应了'
          }你的帖子`,
          body: '',
          path: '/notifications',
        });
      }
    }

    const unread = get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM notifications n WHERE n.user_id = $me AND n.read = 0 AND ${visibleNotification}`,
      { me: user.id },
    )!.n;
    return { now: t, items, unread };
  });
}
