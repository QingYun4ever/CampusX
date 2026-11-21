import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { all, get, now, run, tx } from '../db.ts';
import { hydrate, notify, postSelect, unnotify, visibleTo } from '../serialize.ts';
import { cursorNum, escapeLike, HttpError, me, parse } from '../util.ts';
import { USER_COLS, userById, userPublic } from './users-common.ts';

const PAGE = 20;
const imagePath = z
  .string()
  .regex(/^\/uploads\/[\w-]+\.(jpg|png|webp|gif)$/, '图片地址无效')
  .nullable();

const profileSchema = z.object({
  displayName: z.string().trim().min(1, '请填写昵称').max(20, '昵称最多 20 字').optional(),
  bio: z.string().trim().max(160, '简介最多 160 字').optional(),
  className: z.string().trim().max(20, '班级最多 20 字').optional(),
  gradYear: z.number().int().min(1950).max(2100).nullable().optional(),
  avatar: imagePath.optional(),
  avatarDecoration: z.enum(['', 'halo', 'aurora', 'rose'], { error: '头像装扮无效' }).optional(),
  banner: imagePath.optional(),
});

function findUser(username: string) {
  const r = get(`SELECT ${USER_COLS} FROM users u WHERE u.username = $n`, { n: username });
  if (!r) throw new HttpError(404, '用户不存在');
  return userPublic(r);
}

function withRelation(rows: Record<string, unknown>[]) {
  return rows.map((r) => ({ ...userPublic(r), isFollowing: !!r.is_following }));
}

const REL = `EXISTS(SELECT 1 FROM follows f2 WHERE f2.follower_id = $me AND f2.followee_id = u.id) AS is_following`;

export async function userRoutes(app: FastifyInstance) {
  app.patch('/me', async (req) => {
    const user = me(req);
    const body = parse(profileSchema, req.body);
    const map: Record<string, string> = {
      displayName: 'display_name',
      bio: 'bio',
      className: 'class_name',
      gradYear: 'grad_year',
      avatar: 'avatar',
      avatarDecoration: 'avatar_decoration',
      banner: 'banner',
    };
    const sets: string[] = [];
    const params: Record<string, unknown> = { id: user.id };
    for (const [k, col] of Object.entries(map)) {
      const v = body[k as keyof typeof body];
      if (v !== undefined) {
        sets.push(`${col} = $${k}`);
        params[k] = v;
      }
    }
    if (sets.length) run(`UPDATE users SET ${sets.join(', ')} WHERE id = $id`, params);
    return userById(user.id);
  });

  /** 右侧栏「可能认识的同学」 */
  app.get('/users/suggested', async (req) => {
    const user = me(req);
    const rows = all(
      `SELECT ${USER_COLS}, 0 AS is_following FROM users u
       WHERE u.id != $me AND u.id NOT IN (SELECT followee_id FROM follows WHERE follower_id = $me)
       ORDER BY random() LIMIT 5`,
      { me: user.id },
    );
    return withRelation(rows);
  });

  app.get('/users/:username', async (req) => {
    const user = me(req);
    const u = findUser((req.params as { username: string }).username);
    const stats = get<{ followers: number; following: number; posts: number; follows_you: number; is_following: number }>(
      `SELECT
        (SELECT COUNT(*) FROM follows WHERE followee_id = $id) AS followers,
        (SELECT COUNT(*) FROM follows WHERE follower_id = $id) AS following,
        (SELECT COUNT(*) FROM posts WHERE author_id = $id AND deleted = 0 AND repost_of IS NULL AND (status = 'ok' OR (status = 'pending' AND author_id = $me))
           AND ${visibleTo()}) AS posts,
        EXISTS(SELECT 1 FROM follows WHERE follower_id = $id AND followee_id = $me) AS follows_you,
        EXISTS(SELECT 1 FROM follows WHERE follower_id = $me AND followee_id = $id) AS is_following`,
      { id: u.id, me: user.id },
    )!;
    return {
      ...u,
      followers: stats.followers,
      following: stats.following,
      postsCount: stats.posts,
      followsYou: !!stats.follows_you,
      isFollowing: !!stats.is_following,
    };
  });

  app.get('/users/:username/posts', async (req) => {
    const user = me(req);
    const u = findUser((req.params as { username: string }).username);
    const q = req.query as { tab?: string; cursor?: string };
    const cursor = cursorNum(q.cursor);

    if (q.tab === 'likes') {
      const rows = all(
        `${postSelect(', lk.rowid AS like_rowid')} JOIN likes lk ON lk.post_id = p.id
         WHERE lk.user_id = $uid AND p.deleted = 0 AND ($cursor IS NULL OR lk.rowid < $cursor)
         ORDER BY lk.rowid DESC LIMIT $limit`,
        { me: user.id, uid: u.id, cursor, limit: PAGE },
      );
      const items = hydrate(rows, user.id);
      return {
        items,
        nextCursor: rows.length >= PAGE ? String(rows[rows.length - 1].like_rowid) : null,
      };
    }

    const replies = q.tab === 'replies';
    const rows = all(
      `${postSelect()}
       WHERE p.author_id = $uid AND p.deleted = 0 AND p.parent_id IS ${replies ? 'NOT NULL' : 'NULL'}
         AND ($cursor IS NULL OR p.id < $cursor)
       ORDER BY p.id DESC LIMIT $limit`,
      { me: user.id, uid: u.id, cursor, limit: PAGE },
    );
    const items = hydrate(rows, user.id);
    return { items, nextCursor: rows.length >= PAGE ? String(rows[rows.length - 1].id) : null };
  });

  for (const list of ['followers', 'following'] as const) {
    app.get(`/users/:username/${list}`, async (req) => {
      const user = me(req);
      const u = findUser((req.params as { username: string }).username);
      const [join, where] =
        list === 'followers' ? ['f.follower_id', 'f.followee_id'] : ['f.followee_id', 'f.follower_id'];
      const rows = all(
        `SELECT ${USER_COLS}, ${REL} FROM follows f JOIN users u ON u.id = ${join}
         WHERE ${where} = $id ORDER BY f.created_at DESC LIMIT 500`,
        { id: u.id, me: user.id },
      );
      return withRelation(rows);
    });
  }

  app.post('/users/:username/follow', async (req) => {
    const user = me(req);
    const u = findUser((req.params as { username: string }).username);
    if (u.id === user.id) throw new HttpError(400, '不能关注自己');
    tx(() => {
      const r = run('INSERT OR IGNORE INTO follows (follower_id, followee_id, created_at) VALUES ($a, $b, $t)', {
        a: user.id,
        b: u.id,
        t: now(),
      });
      if (r.changes) notify(u.id, user.id, 'follow');
    });
    return { ok: true };
  });

  app.delete('/users/:username/follow', async (req) => {
    const user = me(req);
    const u = findUser((req.params as { username: string }).username);
    run('DELETE FROM follows WHERE follower_id = $a AND followee_id = $b', { a: user.id, b: u.id });
    unnotify(u.id, user.id, 'follow');
    return { ok: true };
  });

  /* ---------- 搜索 ---------- */
  app.get('/search', async (req) => {
    const user = me(req);
    const q = req.query as { q?: string; type?: string; cursor?: string };
    const kw = (q.q ?? '').trim().slice(0, 50);
    if (!kw) return { items: [], nextCursor: null };
    const like = `%${escapeLike(kw)}%`;
    if (q.type === 'users') {
      const rows = all(
        `SELECT ${USER_COLS}, ${REL} FROM users u
         WHERE u.username LIKE $like ESCAPE '\\' OR u.display_name LIKE $like ESCAPE '\\' OR u.class_name LIKE $like ESCAPE '\\'
         ORDER BY u.id LIMIT 50`,
        { like, me: user.id },
      );
      return { items: withRelation(rows), nextCursor: null };
    }
    const rows = all(
      `${postSelect()}
       WHERE p.deleted = 0 AND p.repost_of IS NULL AND p.content LIKE $like ESCAPE '\\'
         AND ($cursor IS NULL OR p.id < $cursor)
       ORDER BY p.id DESC LIMIT $limit`,
      { me: user.id, like, cursor: cursorNum(q.cursor), limit: PAGE },
    );
    const items = hydrate(rows, user.id);
    return { items, nextCursor: rows.length >= PAGE ? String(rows[rows.length - 1].id) : null };
  });
}
