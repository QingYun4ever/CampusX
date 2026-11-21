import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { all, get, now, run, tx, type Row } from '../db.ts';
import type { SessionUser } from '../auth.ts';
import { boardRole, hydrate, postSelect } from '../serialize.ts';
import { HttpError, me, parse } from '../util.ts';
import { USER_COLS, userPublic } from './users-common.ts';

const PAGE = 20;

const BOARD_SELECT = `
SELECT b.id, b.slug, b.name, b.description, b.icon, b.created_by, b.created_at, b.owner_id,
  b.announcement, b.announcement_at, b.announcement_by,
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
    ownerId: (r.owner_id as number | null) ?? null,
    memberCount: r.member_count as number,
    postCount: r.post_count as number,
    joined: !!r.joined,
  };
}

const MAX_MODS = 10;
const userRow = (id: number | null) => {
  if (!id) return null;
  const r = get(`SELECT ${USER_COLS} FROM users u WHERE u.id = $id`, { id });
  return r ? userPublic(r) : null;
};

/** 吧详情：在列表字段之外加上吧主、吧务、公告和我的身份 */
function boardDetail(r: Row, user: SessionUser) {
  const base = boardDTO(r);
  const mods = all(
    `SELECT ${USER_COLS} FROM board_mods m JOIN users u ON u.id = m.user_id WHERE m.board_id = $b ORDER BY m.created_at`,
    { b: base.id },
  ).map(userPublic);
  return {
    ...base,
    owner: userRow(base.ownerId),
    mods,
    announcement: (r.announcement as string)
      ? { text: r.announcement as string, updatedAt: r.announcement_at as number, by: userRow(r.announcement_by as number | null) }
      : null,
    myRole: boardRole(base.id, user) as 'owner' | 'mod' | 'admin' | null,
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

function findRow(slug: string, meId: number) {
  const r = get(`${BOARD_SELECT} WHERE b.slug = $slug`, { slug, me: meId });
  if (!r) throw new HttpError(404, '吧不存在');
  return r;
}
function findBoard(slug: string, meId: number) {
  return boardDTO(findRow(slug, meId));
}
function detail(slug: string, user: SessionUser) {
  return boardDetail(findRow(slug, user.id), user);
}
const slugOf = (req: { params: unknown }) => (req.params as { slug: string }).slug;

/** 吧主或站点管理员 */
function requireOwner(boardId: number, user: SessionUser) {
  const role = boardRole(boardId, user);
  if (role !== 'owner' && role !== 'admin') throw new HttpError(403, '只有吧主可以这样做');
}
/** 吧主、吧务或站点管理员 */
function requireManager(boardId: number, user: SessionUser) {
  if (!boardRole(boardId, user)) throw new HttpError(403, '只有吧主和吧务可以这样做');
}
const findUser = (username: string) => {
  const u = get<{ id: number }>('SELECT id FROM users WHERE username = $n', { n: username.trim().replace(/^@/, '') });
  if (!u) throw new HttpError(404, '没有这个用户');
  return u.id;
};
const follow = (b: number, u: number) =>
  run('INSERT OR IGNORE INTO board_members (board_id, user_id, created_at) VALUES ($b, $u, $t)', { b, u, t: now() });

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
        `INSERT INTO boards (slug, name, description, icon, created_by, owner_id, created_at)
         VALUES ($slug, $name, $description, $icon, $by, $by, $t)`,
        { ...body, by: user.id, t: now() },
      );
      run('INSERT INTO board_members (board_id, user_id, created_at) VALUES ($b, $u, $t)', {
        b: lastId,
        u: user.id,
        t: now(),
      });
    });
    return detail(body.slug, user);
  });

  app.get('/boards/:slug', async (req) => {
    return detail(slugOf(req), me(req));
  });

  app.patch('/boards/:slug', async (req) => {
    const user = me(req);
    const b = findBoard(slugOf(req), user.id);
    requireOwner(b.id, user);
    const body = parse(boardSchema.omit({ slug: true }).partial(), req.body);
    run(
      `UPDATE boards SET name = COALESCE($name, name), description = COALESCE($description, description),
       icon = COALESCE($icon, icon) WHERE id = $id`,
      { ...body, id: b.id },
    );
    return detail(b.slug, user);
  });

  /* ---------- 公告（吧主 / 吧务） ---------- */
  app.put('/boards/:slug/announcement', async (req) => {
    const user = me(req);
    const b = findBoard(slugOf(req), user.id);
    requireManager(b.id, user);
    const { text } = parse(z.object({ text: z.string().trim().max(1000, '公告最多 1000 字') }), req.body);
    run('UPDATE boards SET announcement = $text, announcement_at = $t, announcement_by = $u WHERE id = $id', {
      text,
      t: text ? now() : null,
      u: text ? user.id : null,
      id: b.id,
    });
    return detail(b.slug, user);
  });

  /* ---------- 吧务团队 ---------- */
  const nameSchema = z.object({ username: z.string().trim().min(1, '请输入用户名') });

  app.post('/boards/:slug/mods', async (req) => {
    const user = me(req);
    const b = findBoard(slugOf(req), user.id);
    requireOwner(b.id, user);
    const uid = findUser(parse(nameSchema, req.body).username);
    if (uid === b.ownerId) throw new HttpError(400, '这位已经是吧主了');
    if (get('SELECT 1 FROM board_mods WHERE board_id = $b AND user_id = $u', { b: b.id, u: uid })) {
      throw new HttpError(409, '这位已经是吧务了');
    }
    const n = get<{ n: number }>('SELECT COUNT(*) AS n FROM board_mods WHERE board_id = $b', { b: b.id })!.n;
    if (n >= MAX_MODS) throw new HttpError(400, `每个吧最多 ${MAX_MODS} 位吧务`);
    tx(() => {
      run('INSERT INTO board_mods (board_id, user_id, created_at) VALUES ($b, $u, $t)', { b: b.id, u: uid, t: now() });
      follow(b.id, uid);
    });
    return detail(b.slug, user);
  });

  /** 吧主移除吧务，或者吧务自己卸任 */
  app.delete('/boards/:slug/mods/:username', async (req) => {
    const user = me(req);
    const b = findBoard(slugOf(req), user.id);
    const uid = findUser((req.params as { username: string }).username);
    if (uid !== user.id) requireOwner(b.id, user);
    run('DELETE FROM board_mods WHERE board_id = $b AND user_id = $u', { b: b.id, u: uid });
    return detail(b.slug, user);
  });

  /** 转让吧主：原吧主变成吧务 */
  app.post('/boards/:slug/owner', async (req) => {
    const user = me(req);
    const b = findBoard(slugOf(req), user.id);
    requireOwner(b.id, user);
    const uid = findUser(parse(nameSchema, req.body).username);
    if (uid === b.ownerId) throw new HttpError(400, '这位已经是吧主了');
    tx(() => {
      run('DELETE FROM board_mods WHERE board_id = $b AND user_id = $u', { b: b.id, u: uid });
      if (b.ownerId) {
        run('INSERT OR IGNORE INTO board_mods (board_id, user_id, created_at) VALUES ($b, $u, $t)', {
          b: b.id,
          u: b.ownerId,
          t: now(),
        });
      }
      run('UPDATE boards SET owner_id = $u WHERE id = $b', { u: uid, b: b.id });
      follow(b.id, uid);
    });
    return detail(b.slug, user);
  });

  /* ---------- 置顶帖 ---------- */
  app.get('/boards/:slug/pinned', async (req) => {
    const user = me(req);
    const b = findBoard(slugOf(req), user.id);
    const rows = all(
      `${postSelect()} WHERE p.board_id = $b AND p.pinned_at IS NOT NULL AND p.deleted = 0 AND p.status = 'ok'
       ORDER BY p.pinned_at DESC`,
      { me: user.id, b: b.id },
    );
    return hydrate(rows, user.id);
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
             AND p.pinned_at IS NULL
             AND ($has = 0 OR p.last_activity_at < $ca OR (p.last_activity_at = $ca AND p.id < $cid))
           ORDER BY p.last_activity_at DESC, p.id DESC LIMIT $limit`,
          { me: user.id, b: b.id, has: hasCursor ? 1 : 0, ca, cid, limit: PAGE },
        )
      : all(
          `${postSelect()}
           WHERE p.board_id = $b AND p.parent_id IS NULL AND p.repost_of IS NULL AND p.deleted = 0
             AND p.pinned_at IS NULL
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
