import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.ts';
import { all, get, now, run, tx } from '../db.ts';
import { enqueue, moderationOn } from '../moderation.ts';
import { boardRole, extractTags, hydrate, normalizeTag, notify, postById, postSelect, publishEffects, REACTIONS, unnotify } from '../serialize.ts';
import { USER_COLS, userPublic } from './users-common.ts';
import { cursorNum, HttpError, me, parse } from '../util.ts';

const PAGE = 20;

const createSchema = z.object({
  content: z.string().max(config.maxPostLength, `内容最多 ${config.maxPostLength} 字`).default(''),
  images: z
    .array(z.string().regex(/^\/uploads\/[\w-]+\.(jpg|png|webp|gif)$/, '图片地址无效'))
    .max(4, '最多 4 张图片')
    .default([]),
  boardSlug: z.string().nullish(),
  parentId: z.number().int().positive().nullish(),
  tags: z.array(z.string().max(30)).max(5, '最多 5 个标签').default([]),
});

function page<T extends { id: number }>(items: T[], cursorOf: (x: T) => string = (x) => String(x.id)) {
  return { items, nextCursor: items.length >= PAGE ? cursorOf(items[items.length - 1]) : null };
}

/** 如果是转发行，取它的原帖 id。审核中/未通过的帖子对别人来说不存在 */
function resolveTarget(id: number, meId: number) {
  const p = get<{ id: number; author_id: number; repost_of: number | null; deleted: number }>(
    "SELECT id, author_id, repost_of, deleted FROM posts WHERE id = $id AND (status = 'ok' OR author_id = $me)",
    { id, me: meId },
  );
  if (!p) throw new HttpError(404, '帖子不存在');
  if (p.repost_of) return resolveTarget(p.repost_of, meId);
  if (p.deleted) throw new HttpError(404, '帖子已删除');
  return p;
}

export async function postRoutes(app: FastifyInstance) {
  /* ---------- 首页时间线 ---------- */
  app.get('/feed', async (req) => {
    const user = me(req);
    const q = req.query as { tab?: string; cursor?: string };
    const following = q.tab === 'following';
    const rows = all(
      `${postSelect()}
       WHERE p.parent_id IS NULL AND p.deleted = 0
         AND ($cursor IS NULL OR p.id < $cursor)
         ${
           following
             ? `AND (p.author_id = $me
                  OR p.author_id IN (SELECT followee_id FROM follows WHERE follower_id = $me)
                  OR p.board_id IN (SELECT board_id FROM board_members WHERE user_id = $me))`
             : ''
         }
       ORDER BY p.id DESC LIMIT $limit`,
      { me: user.id, cursor: cursorNum(q.cursor), limit: PAGE },
    );
    return page(hydrate(rows, user.id));
  });

  /* ---------- 发帖 / 回复 ---------- */
  app.post('/posts', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const user = me(req);
    const body = parse(createSchema, req.body);
    const content = body.content.trim();
    if (!content && !body.images.length) throw new HttpError(400, '写点什么吧');

    let boardId: number | null = null;
    let parent: { id: number; author_id: number; root_id: number | null; board_id: number | null } | undefined;
    if (body.parentId) {
      const target = resolveTarget(body.parentId, user.id);
      parent = get('SELECT id, author_id, root_id, board_id FROM posts WHERE id = $id', { id: target.id }) as typeof parent;
      boardId = parent!.board_id;
    } else if (body.boardSlug) {
      const b = get<{ id: number }>('SELECT id FROM boards WHERE slug = $s', { s: body.boardSlug });
      if (!b) throw new HttpError(404, '吧不存在');
      boardId = b.id;
    }

    const t = now();
    // 开启审核时先存为 pending：作者自己能看到，别人要等审核通过
    const status = moderationOn() ? 'pending' : 'ok';
    const tags = extractTags(content, body.tags);
    const id = tx(() => {
      const { lastId } = run(
        `INSERT INTO posts (author_id, board_id, parent_id, root_id, content, images, status, last_activity_at, created_at)
         VALUES ($a, $b, $parent, $root, $c, $img, $status, $t, $t)`,
        {
          a: user.id,
          b: boardId,
          parent: parent?.id ?? null,
          root: parent ? (parent.root_id ?? parent.id) : null,
          c: content,
          img: JSON.stringify(body.images),
          status,
          t,
        },
      );
      for (const tag of tags) run('INSERT OR IGNORE INTO post_tags (post_id, tag) VALUES ($p, $tag)', { p: lastId, tag });
      if (status === 'ok') publishEffects(lastId);
      return lastId;
    });
    if (status === 'pending') enqueue(id);
    return postById(id, user.id);
  });

  /* ---------- 帖子详情：祖先链 + 本帖 ---------- */
  app.get('/posts/:id', async (req) => {
    const user = me(req);
    const id = Number((req.params as { id: string }).id);
    const post = postById(id, user.id);
    if (!post) throw new HttpError(404, '帖子不存在');
    const ancestors = [];
    let pid = post.parentId;
    for (let i = 0; pid && i < 30; i++) {
      const a = postById(pid, user.id);
      if (!a) break;
      ancestors.unshift(a);
      pid = a.parentId;
    }
    return { post, ancestors };
  });

  /* ---------- 回复列表（正序，楼层） ---------- */
  app.get('/posts/:id/replies', async (req) => {
    const user = me(req);
    const id = Number((req.params as { id: string }).id);
    const q = req.query as { cursor?: string };
    const rows = all(
      `${postSelect()}
       WHERE p.parent_id = $id AND (p.deleted = 0 OR p.reply_count > 0)
         AND ($cursor IS NULL OR p.id > $cursor)
       ORDER BY p.id ASC LIMIT $limit`,
      { me: user.id, id, cursor: cursorNum(q.cursor), limit: PAGE },
    );
    return page(hydrate(rows, user.id));
  });

  /* ---------- 删除 ---------- */
  app.delete('/posts/:id', async (req) => {
    const user = me(req);
    const id = Number((req.params as { id: string }).id);
    const p = get<{ author_id: number; repost_of: number | null; parent_id: number | null; board_id: number | null; deleted: number; status: string }>(
      'SELECT author_id, repost_of, parent_id, board_id, deleted, status FROM posts WHERE id = $id',
      { id },
    );
    if (!p || p.deleted) throw new HttpError(404, '帖子不存在');
    // 作者本人、站点管理员、这个吧的吧主 / 吧务可以删除（转发行只有本人能删）
    const allowed =
      p.author_id === user.id || (!p.repost_of && (user.role === 'admin' || !!boardRole(p.board_id, user)));
    if (!allowed) throw new HttpError(403, '没有权限');
    tx(() => {
      if (p.repost_of) {
        run('DELETE FROM posts WHERE id = $id', { id });
        run('UPDATE posts SET repost_count = MAX(repost_count - 1, 0) WHERE id = $o', { o: p.repost_of });
        return;
      }
      // 软删除，保留楼中楼结构
      run(`UPDATE posts SET deleted = 1, content = '', images = '[]', pinned_at = NULL WHERE id = $id`, { id });
      run('DELETE FROM posts WHERE repost_of = $id', { id });
      run('DELETE FROM notifications WHERE post_id = $id', { id });
      if (p.parent_id && p.status === 'ok') {
        run('UPDATE posts SET reply_count = MAX(reply_count - 1, 0) WHERE id = $pid', { pid: p.parent_id });
      }
    });
    return { ok: true };
  });

  /* ---------- 点赞 ---------- */
  app.post('/posts/:id/like', async (req) => {
    const user = me(req);
    const target = resolveTarget(Number((req.params as { id: string }).id), user.id);
    tx(() => {
      const r = run('INSERT OR IGNORE INTO likes (user_id, post_id, created_at) VALUES ($u, $p, $t)', {
        u: user.id,
        p: target.id,
        t: now(),
      });
      if (r.changes) {
        run('UPDATE posts SET like_count = like_count + 1 WHERE id = $p', { p: target.id });
        notify(target.author_id, user.id, 'like', target.id);
      }
    });
    return { ok: true };
  });

  app.delete('/posts/:id/like', async (req) => {
    const user = me(req);
    const target = resolveTarget(Number((req.params as { id: string }).id), user.id);
    tx(() => {
      const r = run('DELETE FROM likes WHERE user_id = $u AND post_id = $p', { u: user.id, p: target.id });
      if (r.changes) {
        run('UPDATE posts SET like_count = MAX(like_count - 1, 0) WHERE id = $p', { p: target.id });
        unnotify(target.author_id, user.id, 'like', target.id);
      }
    });
    return { ok: true };
  });

  /* ---------- 转发 ---------- */
  app.post('/posts/:id/repost', async (req) => {
    const user = me(req);
    const target = resolveTarget(Number((req.params as { id: string }).id), user.id);
    tx(() => {
      if (get('SELECT 1 FROM posts WHERE repost_of = $p AND author_id = $u', { p: target.id, u: user.id })) return;
      const t = now();
      run(
        `INSERT INTO posts (author_id, repost_of, last_activity_at, created_at) VALUES ($u, $p, $t, $t)`,
        { u: user.id, p: target.id, t },
      );
      run('UPDATE posts SET repost_count = repost_count + 1 WHERE id = $p', { p: target.id });
      notify(target.author_id, user.id, 'repost', target.id);
    });
    return { ok: true };
  });

  app.delete('/posts/:id/repost', async (req) => {
    const user = me(req);
    const target = resolveTarget(Number((req.params as { id: string }).id), user.id);
    tx(() => {
      const r = run('DELETE FROM posts WHERE repost_of = $p AND author_id = $u', { p: target.id, u: user.id });
      if (r.changes) {
        run('UPDATE posts SET repost_count = MAX(repost_count - 1, 0) WHERE id = $p', { p: target.id });
        unnotify(target.author_id, user.id, 'repost', target.id);
      }
    });
    return { ok: true };
  });

  /* ---------- 表情回应（Telegram 式：每人每帖一个，选别的会替换） ---------- */
  const reactionKey = (raw: string) => {
    if (!(REACTIONS as readonly string[]).includes(raw)) throw new HttpError(400, '不支持这个表情');
    return raw;
  };
  app.put('/posts/:id/reactions/:key', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const user = me(req);
    const params = req.params as { id: string; key: string };
    const emoji = reactionKey(params.key);
    const target = resolveTarget(Number(params.id), user.id);
    tx(() => {
      run('DELETE FROM reactions WHERE post_id = $p AND user_id = $u', { p: target.id, u: user.id });
      run('INSERT INTO reactions (post_id, user_id, emoji, created_at) VALUES ($p, $u, $e, $t)', {
        p: target.id,
        u: user.id,
        e: emoji,
        t: now(),
      });
      unnotify(target.author_id, user.id, 'reaction', target.id);
      notify(target.author_id, user.id, 'reaction', target.id, emoji);
    });
    return postById(target.id, user.id)?.reactions ?? [];
  });
  app.delete('/posts/:id/reactions/:key', async (req) => {
    const user = me(req);
    const params = req.params as { id: string; key: string };
    const target = resolveTarget(Number(params.id), user.id);
    tx(() => {
      const r = run('DELETE FROM reactions WHERE post_id = $p AND user_id = $u AND emoji = $e', {
        p: target.id,
        u: user.id,
        e: reactionKey(params.key),
      });
      if (r.changes) unnotify(target.author_id, user.id, 'reaction', target.id);
    });
    return postById(target.id, user.id)?.reactions ?? [];
  });
  /** 谁回应了（按时间倒序） */
  app.get('/posts/:id/reactions', async (req) => {
    const user = me(req);
    const target = resolveTarget(Number((req.params as { id: string }).id), user.id);
    const rows = all(
      `SELECT r.emoji, r.created_at AS reacted_at, ${USER_COLS} FROM reactions r JOIN users u ON u.id = r.user_id
       WHERE r.post_id = $p ORDER BY r.created_at DESC LIMIT 500`,
      { p: target.id },
    );
    return rows.map((r) => ({ emoji: r.emoji as string, createdAt: r.reacted_at as number, user: userPublic(r) }));
  });

  /* ---------- 浏览数：前端把看到的帖子批量报上来，每人每帖只算一次，作者自己不算 ---------- */
  app.post('/posts/views', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const user = me(req);
    const { ids } = parse(z.object({ ids: z.array(z.number().int().positive()).max(50) }), req.body);
    const t = now();
    tx(() => {
      for (const id of new Set(ids)) {
        const p = get<{ author_id: number }>(
          "SELECT author_id FROM posts WHERE id = $id AND status = 'ok' AND deleted = 0 AND repost_of IS NULL",
          { id },
        );
        if (!p || p.author_id === user.id) continue;
        const r = run('INSERT OR IGNORE INTO post_views (post_id, user_id, created_at) VALUES ($p, $u, $t)', { p: id, u: user.id, t });
        if (r.changes) run('UPDATE posts SET view_count = view_count + 1 WHERE id = $id', { id });
      }
    });
    return { ok: true };
  });

  /* ---------- 吧内置顶（吧主 / 吧务 / 管理员） ---------- */
  const MAX_PINNED = 3;
  const pinTarget = (req: { params: unknown }, user: { id: number; role: string }) => {
    const id = Number((req.params as { id: string }).id);
    const p = get<{ id: number; board_id: number | null; parent_id: number | null; repost_of: number | null; deleted: number; status: string; pinned_at: number | null }>(
      'SELECT id, board_id, parent_id, repost_of, deleted, status, pinned_at FROM posts WHERE id = $id',
      { id },
    );
    if (!p || p.deleted || p.status !== 'ok') throw new HttpError(404, '帖子不存在');
    if (!p.board_id || p.parent_id || p.repost_of) throw new HttpError(400, '只能置顶吧里的主楼');
    if (!boardRole(p.board_id, user)) throw new HttpError(403, '只有吧主和吧务可以置顶');
    return p;
  };
  app.post('/posts/:id/pin', async (req) => {
    const user = me(req);
    const p = pinTarget(req, user);
    if (!p.pinned_at) {
      const n = get<{ n: number }>('SELECT COUNT(*) AS n FROM posts WHERE board_id = $b AND pinned_at IS NOT NULL', { b: p.board_id })!.n;
      if (n >= MAX_PINNED) throw new HttpError(400, `每个吧最多置顶 ${MAX_PINNED} 条，先取消一条吧`);
      run('UPDATE posts SET pinned_at = $t WHERE id = $id', { t: now(), id: p.id });
    }
    return { ok: true };
  });
  app.delete('/posts/:id/pin', async (req) => {
    const user = me(req);
    const p = pinTarget(req, user);
    run('UPDATE posts SET pinned_at = NULL WHERE id = $id', { id: p.id });
    return { ok: true };
  });

  /* ---------- 标签 ---------- */
  app.get('/tags/trending', async () => {
    return all<{ tag: string; count: number }>(
      `SELECT t.tag, COUNT(*) AS count FROM post_tags t JOIN posts p ON p.id = t.post_id
       WHERE p.status = 'ok' AND p.deleted = 0 AND p.created_at > $since
       GROUP BY t.tag ORDER BY count DESC, MAX(p.id) DESC LIMIT 10`,
      { since: now() - 30 * 86_400_000 },
    );
  });

  app.get('/tags/:tag/posts', async (req) => {
    const user = me(req);
    const tag = normalizeTag(decodeURIComponent((req.params as { tag: string }).tag));
    const q = req.query as { cursor?: string };
    const rows = all(
      `${postSelect()}
       WHERE p.deleted = 0 AND p.id IN (SELECT post_id FROM post_tags WHERE tag = $tag)
         AND ($cursor IS NULL OR p.id < $cursor)
       ORDER BY p.id DESC LIMIT $limit`,
      { me: user.id, tag, cursor: cursorNum(q.cursor), limit: PAGE },
    );
    const count =
      get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM post_tags t JOIN posts p ON p.id = t.post_id
         WHERE t.tag = $tag AND p.deleted = 0 AND p.status = 'ok'`,
        { tag },
      )?.n ?? 0;
    return { ...page(hydrate(rows, user.id)), tag, count };
  });
}
