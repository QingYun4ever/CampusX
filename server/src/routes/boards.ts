import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { all, get, now, run, tx, type Row } from '../db.ts';
import { hydrate, postSelect } from '../serialize.ts';
import { HttpError, me, parse } from '../util.ts';

const PAGE = 20;

const BOARD_SELECT = `
SELECT b.id, b.slug, b.name, b.description, b.icon, b.created_by, b.created_at,
  (SELECT COUNT(*) FROM board_members m WHERE m.board_id = b.id) AS member_count,
  (SELECT COUNT(*) FROM posts p WHERE p.board_id = b.id AND p.parent_id IS NULL AND p.deleted = 0 AND p.status = 'ok') AS post_count,
  EXISTS(SELECT 1 FROM board_members m WHERE m.board_id = b.id AND m.user_id = $me) AS joined
FROM boards b`;

function boardDTO(r: Row) {
  return {
    id: r.id as number,
    slug: r.slug as string,
    name: r.name as string,
    description: r.description as string,
    icon: r.icon as string,
    createdBy: (r.created_by as number | null) ?? null,
    memberCount: r.member_count as number,
    postCount: r.post_count as number,
    joined: !!r.joined,
  };
}

const boardSchema = z.object({
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]{2,24}$/, '地址为 2-24 位小写字母、数字或 -'),
  name: z.string().trim().min(1, '请填写名称').max(16, '名称最多 16 字'),
  description: z.string().trim().max(100, '简介最多 100 字').default(''),
  icon: z.string().trim().min(1).max(8).default('💬'),
});

function findBoard(slug: string, meId: number) {
  const r = get(`${BOARD_SELECT} WHERE b.slug = $slug`, { slug, me: meId });
  if (!r) throw new HttpError(404, '吧不存在');
  return boardDTO(r);
}

export async function boardRoutes(app: FastifyInstance) {
  app.get('/boards', async (req) => {
    const user = me(req);
    const rows = all(`${BOARD_SELECT} ORDER BY member_count DESC, b.id ASC`, { me: user.id });
    return rows.map(boardDTO);
  });

  app.post('/boards', async (req) => {
    const user = me(req);
    const body = parse(boardSchema, req.body);
    if (get('SELECT 1 FROM boards WHERE slug = $s', { s: body.slug })) throw new HttpError(409, '该地址已被使用');
    if (get('SELECT 1 FROM boards WHERE name = $n', { n: body.name })) throw new HttpError(409, '已有同名的吧');
    tx(() => {
      const { lastId } = run(
        `INSERT INTO boards (slug, name, description, icon, created_by, created_at)
         VALUES ($slug, $name, $description, $icon, $by, $t)`,
        { ...body, by: user.id, t: now() },
      );
      run('INSERT INTO board_members (board_id, user_id, created_at) VALUES ($b, $u, $t)', {
        b: lastId,
        u: user.id,
        t: now(),
      });
    });
    return findBoard(body.slug, user.id);
  });

  app.get('/boards/:slug', async (req) => {
    return findBoard((req.params as { slug: string }).slug, me(req).id);
  });

  app.patch('/boards/:slug', async (req) => {
    const user = me(req);
    const b = findBoard((req.params as { slug: string }).slug, user.id);
    if (b.createdBy !== user.id && user.role !== 'admin') throw new HttpError(403, '没有权限');
    const body = parse(boardSchema.omit({ slug: true }).partial(), req.body);
    run(
      `UPDATE boards SET name = COALESCE($name, name), description = COALESCE($description, description),
       icon = COALESCE($icon, icon) WHERE id = $id`,
      { ...body, id: b.id },
    );
    return findBoard(b.slug, user.id);
  });

  app.delete('/boards/:slug', async (req) => {
    const user = me(req);
    if (user.role !== 'admin') throw new HttpError(403, '只有管理员可以删除吧');
    const b = findBoard((req.params as { slug: string }).slug, user.id);
    run('DELETE FROM boards WHERE id = $id', { id: b.id });
    return { ok: true };
  });

  app.post('/boards/:slug/join', async (req) => {
    const user = me(req);
    const b = findBoard((req.params as { slug: string }).slug, user.id);
    run('INSERT OR IGNORE INTO board_members (board_id, user_id, created_at) VALUES ($b, $u, $t)', {
      b: b.id,
      u: user.id,
      t: now(),
    });
    return { ok: true };
  });

  app.delete('/boards/:slug/join', async (req) => {
    const user = me(req);
    const b = findBoard((req.params as { slug: string }).slug, user.id);
    run('DELETE FROM board_members WHERE board_id = $b AND user_id = $u', { b: b.id, u: user.id });
    return { ok: true };
  });

  /** sort=active：按最后回复（贴吧式）；sort=new：按发帖时间 */
  app.get('/boards/:slug/posts', async (req) => {
    const user = me(req);
    const b = findBoard((req.params as { slug: string }).slug, user.id);
    const q = req.query as { sort?: string; cursor?: string };
    const active = q.sort !== 'new';
    const [ca, cid] = (q.cursor ?? '').split('_').map(Number);
    const hasCursor = Number.isFinite(ca) && Number.isFinite(cid) && cid > 0;

    const rows = active
      ? all(
          `${postSelect()}
           WHERE p.board_id = $b AND p.parent_id IS NULL AND p.repost_of IS NULL AND p.deleted = 0
             AND ($has = 0 OR p.last_activity_at < $ca OR (p.last_activity_at = $ca AND p.id < $cid))
           ORDER BY p.last_activity_at DESC, p.id DESC LIMIT $limit`,
          { me: user.id, b: b.id, has: hasCursor ? 1 : 0, ca, cid, limit: PAGE },
        )
      : all(
          `${postSelect()}
           WHERE p.board_id = $b AND p.parent_id IS NULL AND p.repost_of IS NULL AND p.deleted = 0
             AND ($has = 0 OR p.id < $cid)
           ORDER BY p.id DESC LIMIT $limit`,
          { me: user.id, b: b.id, has: hasCursor ? 1 : 0, cid, limit: PAGE },
        );
    const last = rows[rows.length - 1];
    return {
      items: hydrate(rows, user.id),
      nextCursor: rows.length >= PAGE ? `${active ? last.last_activity_at : 0}_${last.id}` : null,
    };
  });
}
