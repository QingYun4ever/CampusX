import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ownsDecoration } from '../crystals.ts';
import { all, get, now, run, tx } from '../db.ts';
import { assertCanInteract, blockState, HIDDEN_BOARDS, hydrate, notify, postSelect, unnotify, visibleTo } from '../serialize.ts';
import { levelInfo } from '../levels.ts';
import { consumeDraftUploads, siteUploadUrl } from '../site-uploads.ts';
import { cursorNum, escapeLike, HttpError, me, parse } from '../util.ts';
import { USER_COLS, userById, userPublic } from './users-common.ts';
import { getAssistantConfig } from '../assistant.ts';

const PAGE = 20;
const imagePath = z
  .string()
  .regex(siteUploadUrl, '图片地址无效')
  .nullable();

const profileSchema = z.object({
  displayName: z.string().trim().min(1, '请填写昵称').max(20, '昵称最多 20 字').optional(),
  bio: z.string().trim().max(160, '简介最多 160 字').optional(),
  className: z.string().trim().max(20, '班级最多 20 字').optional(),
  gradYear: z.number().int().min(1950).max(2100).nullable().optional(),
  avatar: imagePath.optional(),
  avatarDecoration: z.enum(['', 'halo', 'aurora', 'rose', 'prism', 'neon', 'stars', 'sakura', 'neko', 'snow'], { error: '头像装扮无效' }).optional(),
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
    if (body.avatarDecoration && !ownsDecoration(user.id, body.avatarDecoration)) {
      throw new HttpError(403, '这个装扮还没解锁，去商场用紫水晶解锁吧');
    }
    tx(() => {
      const previous = body.avatar !== undefined || body.banner !== undefined
        ? get<{ avatar: string | null; banner: string | null }>('SELECT avatar, banner FROM users WHERE id = $id', { id: user.id })
        : undefined;
      const images: string[] = [];
      const sets: string[] = [];
      const params: Record<string, unknown> = { id: user.id };
      for (const [k, col] of Object.entries(map)) {
        const v = body[k as keyof typeof body];
        if (v === undefined) continue;
        if (k === 'avatar' || k === 'banner') {
          if (v === previous?.[k]) continue; // 旧资料保留原地址，不视为重新附加
          if (typeof v === 'string') images.push(v);
        }
        sets.push(`${col} = $${k}`);
        params[k] = v;
      }
      consumeDraftUploads(images, user.id);
      if (sets.length) run(`UPDATE users SET ${sets.join(', ')} WHERE id = $id`, params);
    });
    return userById(user.id);
  });

  /**
   * 输入 @ 时的候选人。
   * q 为空：当前楼里说过话的人、我关注的人、关注我的人；有 q：按用户名前缀、昵称、用户名包含来搜。
   * 排序：用户名前缀匹配 > 楼里的人 > 互相关注 > 我关注的 > 关注我的 > 最近活跃。
   * 不列出自己、拉黑关系里的人；AI 助手只在开启时出现。
   */
  app.get('/mentions/suggest', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    const user = me(req);
    const query = req.query as { q?: string; postId?: string };
    const q = String(query.q ?? '').trim().replace(/^@/, '').slice(0, 20).toLowerCase();
    const postId = Number(query.postId) || 0;

    // 当前楼里的人：主帖作者 + 最近在这串里发言的人（按最近发言排）
    let thread: number[] = [];
    if (postId) {
      const p = get<{ id: number; root_id: number | null }>(
        `SELECT p.id, p.root_id FROM posts p WHERE p.id = $id AND p.deleted = 0 AND ${visibleTo('p.')}`,
        { id: postId, me: user.id },
      );
      if (p) {
        const root = p.root_id ?? p.id;
        thread = all<{ author_id: number }>(
          `SELECT author_id FROM posts
           WHERE (id = $root OR root_id = $root OR id = $id) AND deleted = 0 AND status = 'ok'
           GROUP BY author_id ORDER BY MAX(id = $id) DESC, MAX(id = $root) DESC, MAX(created_at) DESC LIMIT 20`,
          { root, id: p.id },
        ).map((r) => r.author_id);
      }
    }
    const bot = getAssistantConfig();
    const like = `%${escapeLike(q)}%`;
    const prefix = `${escapeLike(q)}%`;
    const rows = all(
      `SELECT ${USER_COLS},
         COALESCE((SELECT 30 - key FROM json_each($thread) WHERE value = u.id), 0) AS in_thread,
         EXISTS(SELECT 1 FROM follows WHERE follower_id = $me AND followee_id = u.id) AS i_follow,
         EXISTS(SELECT 1 FROM follows WHERE follower_id = u.id AND followee_id = $me) AS follows_me,
         ($q <> '' AND u.username LIKE $prefix ESCAPE '\\') AS prefix_hit
       FROM users u
       WHERE u.id <> $me
         AND (u.role <> 'bot' OR u.id = $bot)
         AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = $me AND b.blocked_id = u.id) OR (b.blocker_id = u.id AND b.blocked_id = $me))
         AND (
           ($q = '' AND (u.id IN (SELECT value FROM json_each($thread))
                         OR EXISTS(SELECT 1 FROM follows WHERE follower_id = $me AND followee_id = u.id)
                         OR EXISTS(SELECT 1 FROM follows WHERE follower_id = u.id AND followee_id = $me)
                         OR u.id = $bot))
           OR ($q <> '' AND (u.username LIKE $like ESCAPE '\\' OR u.display_name LIKE $like ESCAPE '\\'))
         )
       ORDER BY prefix_hit DESC, in_thread DESC, (i_follow AND follows_me) DESC, i_follow DESC, follows_me DESC,
         u.id = $bot DESC, COALESCE(u.last_seen_at, 0) DESC, u.id
       LIMIT 8`,
      { me: user.id, q, like, prefix, thread: JSON.stringify(thread), bot: bot.enabled && bot.botId ? bot.botId : -1 },
    );
    return rows.map((r) => ({ ...userPublic(r), inThread: !!r.in_thread, following: !!r.i_follow }));
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
      /** 我拉黑了他 */
      blocked: blockState(user.id, u.id).iBlocked,
      // 等级最高的几个吧（只列加入了、而且看的人看得到的吧）
      boardLevels: all<{ slug: string; name: string; icon: string; avatar: string | null; exp: number; level_titles: string }>(
        `SELECT b.slug, b.name, b.icon, b.avatar, e.exp, b.level_titles FROM board_exp e
         JOIN boards b ON b.id = e.board_id
         JOIN board_members m ON m.board_id = e.board_id AND m.user_id = e.user_id
         WHERE e.user_id = $id AND e.exp > 0 AND b.id NOT IN ${HIDDEN_BOARDS}
         ORDER BY e.exp DESC LIMIT 6`,
        { id: u.id, me: user.id },
      ).map((b) => ({ slug: b.slug, name: b.name, icon: b.icon, avatar: b.avatar, exp: b.exp, ...levelInfo(b.exp, b.level_titles) })),
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
    // 拉黑了这个人还想看他的主页时，带上 blocked=1
    const rows = all(
      `${postSelect('', { showBlocked: (q as { blocked?: string }).blocked === '1' })}
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
    assertCanInteract(user.id, u.id);
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
