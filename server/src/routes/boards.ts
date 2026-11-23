import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { all, get, now, run, tx, type Row } from '../db.ts';
import type { SessionUser } from '../auth.ts';
import { boardRole, HIDDEN_BOARDS, hydrate, postSelect } from '../serialize.ts';
import { consumeDraftUploads, siteUploadUrl } from '../site-uploads.ts';
import { HttpError, me, parse } from '../util.ts';
import { checkin, dayOf, DEFAULT_TITLES, LEVEL_EXP, levelInfo, MAX_LEVEL, myLevel, parseTitles, rankOf, ranking, titleOf } from '../levels.ts';
import { USER_COLS, userPublic } from './users-common.ts';

const PAGE = 20;

const BOARD_SELECT = `
SELECT b.id, b.slug, b.name, b.description, b.icon, b.avatar, b.created_by, b.created_at, b.owner_id, b.visibility,
  b.announcement, b.announcement_at, b.announcement_by,
  (SELECT COUNT(*) FROM board_viewers v WHERE v.board_id = b.id) AS viewer_count,
  (b.id IN ${HIDDEN_BOARDS}) AS hidden,
  (SELECT COUNT(*) FROM board_members m WHERE m.board_id = b.id) AS member_count,
  (SELECT COUNT(*) FROM posts p WHERE p.board_id = b.id AND p.parent_id IS NULL AND p.deleted = 0 AND p.status = 'ok') AS post_count,
  EXISTS(SELECT 1 FROM board_members m WHERE m.board_id = b.id AND m.user_id = $me) AS joined,
  b.level_titles, me_exp.exp AS my_exp, me_exp.checkin_day AS my_checkin_day
FROM boards b
LEFT JOIN board_exp me_exp ON me_exp.board_id = b.id AND me_exp.user_id = $me`;

function boardDTO(r: Row) {
  return {
    id: r.id as number,
    slug: r.slug as string,
    name: r.name as string,
    description: r.description as string,
    icon: r.icon as string,
    avatar: r.avatar as string | null,
    createdBy: (r.created_by as number | null) ?? null,
    ownerId: (r.owner_id as number | null) ?? null,
    visibility: (r.visibility === 'private' ? 'private' : 'public') as 'public' | 'private',
    memberCount: r.member_count as number,
    postCount: r.post_count as number,
    joined: !!r.joined,
    /** 我在这个吧的等级（加入了才有）和今天签没签 */
    myLevel: r.joined ? { ...levelInfo((r.my_exp as number | null) ?? 0, r.level_titles as string), checkedIn: r.my_checkin_day === dayOf(now()) } : null,
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
  const myRole = boardRole(base.id, user);
  return {
    ...base,
    owner: userRow(base.ownerId),
    mods,
    announcement: (r.announcement as string)
      ? { text: r.announcement as string, updatedAt: r.announcement_at as number, by: userRow(r.announcement_by as number | null) }
      : null,
    myRole,
    /** 18 个等级的门槛和头衔；custom 是吧主改过的（空字符串表示用默认） */
    levels: {
      exp: LEVEL_EXP,
      titles: Array.from({ length: MAX_LEVEL }, (_, i) => titleOf(i + 1, parseTitles(r.level_titles as string))),
      defaults: DEFAULT_TITLES,
      custom: Array.from({ length: MAX_LEVEL }, (_, i) => parseTitles(r.level_titles as string)[i] ?? ''),
    },
    /** 我在这个吧的经验、签到；没加入时为 null */
    me: base.joined ? myLevel(base.id, user.id, r.level_titles as string) : null,
    /** 私密吧里吧主指定的可见成员人数 */
    viewerCount: r.viewer_count as number,
    deletePostCount: myRole === 'owner' || user.role === 'admin'
      ? get<{ n: number }>('SELECT COUNT(*) AS n FROM posts WHERE board_id = $b', { b: base.id })!.n
      : null,
  };
}

const boardFields = {
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]{2,24}$/, '地址为 2-24 位小写字母、数字或 -'),
  name: z.string().trim().min(1, '请填写名称').max(16, '名称最多 16 字'),
  description: z.string().trim().max(100, '简介最多 100 字'),
  icon: z.string().trim().min(1).max(8),
  avatar: z.string().regex(siteUploadUrl, '图片地址无效').nullable(),
  visibility: z.enum(['public', 'private']),
};
/** 每人最多创建几个吧（管理员不限）。自己建的、或者转给自己的都算；吧删掉之后名额就空出来 */
export const MAX_BOARDS_PER_USER = 2;
function boardQuota(userId: number) {
  const used = get<{ n: number }>('SELECT COUNT(*) AS n FROM boards WHERE created_by = $u OR owner_id = $u', { u: userId })!.n;
  return { used, max: MAX_BOARDS_PER_USER };
}

const boardSchema = z.object({
  ...boardFields,
  description: boardFields.description.default(''),
  icon: boardFields.icon.default('💬'),
  avatar: boardFields.avatar.default(null),
  visibility: boardFields.visibility.default('public'),
});
// 修改时不能带默认值，否则只改名字也会把简介、图标、可见范围重置掉（zod 4 的 partial 会保留 default）
const boardPatchSchema = z
  .object({
    ...boardFields,
    levelTitles: z.array(z.string().trim().max(8, '头衔最多 8 个字')).length(MAX_LEVEL),
  })
  .omit({ slug: true })
  .partial();

function findRow(slug: string, meId: number) {
  const r = get(`${BOARD_SELECT} WHERE b.slug = $slug`, { slug, me: meId });
  if (!r) throw new HttpError(404, '吧不存在');
  if (r.hidden) throw new HttpError(403, '这是私密吧，只有吧主邀请的同学可以查看');
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
  if (user.role !== 'admin' && boardRole(boardId, user) !== 'owner') throw new HttpError(403, '只有吧主可以这样做');
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
    const rows = all(`${BOARD_SELECT} WHERE b.id NOT IN ${HIDDEN_BOARDS} ORDER BY member_count DESC, b.id ASC`, {
      me: user.id,
    });
    return rows.map(boardDTO);
  });

  app.get('/boards/quota', async (req) => {
    const user = me(req);
    if (user.role === 'admin') return { used: 0, max: null };
    return boardQuota(user.id);
  });

  app.post('/boards', async (req) => {
    const user = me(req);
    const body = parse(boardSchema, req.body);
    if (user.role !== 'admin' && boardQuota(user.id).used >= MAX_BOARDS_PER_USER) {
      throw new HttpError(403, `每位同学最多创建 ${MAX_BOARDS_PER_USER} 个吧`);
    }
    if (get('SELECT 1 FROM boards WHERE slug = $s', { s: body.slug })) throw new HttpError(409, '该地址已被使用');
    if (get('SELECT 1 FROM boards WHERE name = $n', { n: body.name })) throw new HttpError(409, '已有同名的吧');
    tx(() => {
      if (body.avatar) consumeDraftUploads([body.avatar], user.id);
      const { lastId } = run(
        `INSERT INTO boards (slug, name, description, icon, avatar, visibility, created_by, owner_id, created_at)
         VALUES ($slug, $name, $description, $icon, $avatar, $visibility, $by, $by, $t)`,
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
    const body = parse(boardPatchSchema, req.body);
    if (body.name && get('SELECT 1 FROM boards WHERE name = $n AND id != $id', { n: body.name, id: b.id })) {
      throw new HttpError(409, '已有同名的吧');
    }
    tx(() => {
      if (body.avatar && body.avatar !== b.avatar) consumeDraftUploads([body.avatar], user.id);
      run(
        `UPDATE boards SET name = COALESCE($name, name), description = COALESCE($description, description),
         icon = COALESCE($icon, icon), avatar = CASE WHEN $setAvatar THEN $avatar ELSE avatar END,
         visibility = COALESCE($visibility, visibility), level_titles = COALESCE($titles, level_titles) WHERE id = $id`,
        {
          name: null, description: null, icon: null, visibility: null, avatar: null,
          ...body,
          levelTitles: undefined,
          // 和默认一样的头衔不存，以后改默认时跟着变
          titles: body.levelTitles ? JSON.stringify(body.levelTitles.map((x, i) => (x === DEFAULT_TITLES[i] ? '' : x))) : null,
          setAvatar: body.avatar === undefined ? 0 : 1,
          id: b.id,
        },
      );
    });
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

  /* ---------- 私密吧的可见成员（吧主设置；吧务可以查看名单） ---------- */
  app.get('/boards/:slug/viewers', async (req) => {
    const user = me(req);
    const b = findBoard(slugOf(req), user.id);
    const role = boardRole(b.id, user);
    if (role !== 'owner' && role !== 'mod') throw new HttpError(403, '只有吧主和吧务可以这样做');
    return all(
      `SELECT ${USER_COLS} FROM board_viewers v JOIN users u ON u.id = v.user_id WHERE v.board_id = $b
       ORDER BY u.class_name, u.display_name`,
      { b: b.id },
    ).map(userPublic);
  });

  /** 按用户名添加，或者把某个班的同学全部加进来 */
  app.post('/boards/:slug/viewers', async (req) => {
    const user = me(req);
    const b = findBoard(slugOf(req), user.id);
    if (b.ownerId !== user.id) throw new HttpError(403, '只有吧主可以这样做');
    const body = parse(
      z.object({
        usernames: z.array(z.string().trim().min(1)).max(200).default([]),
        className: z.string().trim().max(20).optional(),
      }),
      req.body,
    );
    const ids = body.usernames.map(findUser);
    if (body.className) {
      ids.push(...all<{ id: number }>('SELECT id FROM users WHERE class_name = $c', { c: body.className }).map((r) => r.id));
    }
    if (!ids.length) throw new HttpError(400, '请选择要添加的同学');
    let added = 0;
    tx(() => {
      for (const uid of new Set(ids)) {
        if (uid === b.ownerId) continue;
        added += run('INSERT OR IGNORE INTO board_viewers (board_id, user_id, created_at) VALUES ($b, $u, $t)', {
          b: b.id,
          u: uid,
          t: now(),
        }).changes as number;
      }
    });
    return { added, board: detail(b.slug, user) };
  });

  app.delete('/boards/:slug/viewers/:username', async (req) => {
    const user = me(req);
    const b = findBoard(slugOf(req), user.id);
    if (b.ownerId !== user.id) throw new HttpError(403, '只有吧主可以这样做');
    const uid = findUser((req.params as { username: string }).username);
    tx(() => {
      run('DELETE FROM board_viewers WHERE board_id = $b AND user_id = $u', { b: b.id, u: uid });
      // 不再能看到这个吧，顺便取消关注（吧务仍然可见，保留）
      if (!get('SELECT 1 FROM board_mods WHERE board_id = $b AND user_id = $u', { b: b.id, u: uid })) {
        run('DELETE FROM board_members WHERE board_id = $b AND user_id = $u', { b: b.id, u: uid });
      }
    });
    return detail(b.slug, user);
  });

  /** 全站的班级（添加可见成员时按班级批量添加） */
  app.get('/classes', async () => {
    return all<{ name: string; count: number }>(
      `SELECT class_name AS name, COUNT(*) AS count FROM users WHERE class_name != ''
       GROUP BY class_name ORDER BY count DESC, class_name LIMIT 100`,
    );
  });

  /**
   * 删除吧：吧主或站点管理员。吧里的帖子、回复和它们的转发、点赞、回应、通知一并删除，
   * 不会变成「不属于任何吧」的帖子出现在首页。
   */
  app.delete('/boards/:slug', async (req) => {
    const user = me(req);
    const b = findBoard(slugOf(req), user.id);
    requireOwner(b.id, user);
    const n = tx(() => {
      const r = run('DELETE FROM posts WHERE board_id = $b', { b: b.id });
      run('DELETE FROM boards WHERE id = $b', { b: b.id });
      return r.changes as number;
    });
    return { ok: true, deletedPosts: n };
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

  /* ---------- 签到与等级 ---------- */
  app.post('/boards/:slug/checkin', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const user = me(req);
    const r = findRow(slugOf(req), user.id);
    if (!r.joined) throw new HttpError(400, '先加入这个吧再签到');
    const res = tx(() => checkin(r.id as number, user.id));
    return { gained: res?.gained ?? 0, already: !res, me: myLevel(r.id as number, user.id, r.level_titles as string) };
  });

  /** 一键签到所有加入了的吧 */
  app.post('/checkin/all', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const user = me(req);
    const boards = all<{ id: number }>(
      `SELECT m.board_id AS id FROM board_members m WHERE m.user_id = $me AND m.board_id NOT IN ${HIDDEN_BOARDS}`,
      { me: user.id },
    );
    let count = 0;
    let gained = 0;
    const t = now();
    tx(() => {
      for (const b of boards) {
        const res = checkin(b.id, user.id, t);
        if (res) {
          count++;
          gained += res.gained;
        }
      }
    });
    return { count, gained };
  });

  app.get('/boards/:slug/ranking', async (req) => {
    const user = me(req);
    const r = findRow(slugOf(req), user.id);
    const titles = r.level_titles as string;
    const rows = ranking(r.id as number);
    const users = new Map(
      all(`SELECT ${USER_COLS} FROM users u WHERE u.id IN (SELECT value FROM json_each($ids))`, {
        ids: JSON.stringify(rows.map((x) => x.user_id)),
      }).map((u) => [u.id as number, userPublic(u)]),
    );
    return {
      items: rows.map((x, i) => ({ rank: i + 1, user: users.get(x.user_id)!, exp: x.exp, ...levelInfo(x.exp, titles) })),
      me: r.joined ? { rank: rankOf(r.id as number, user.id), ...myLevel(r.id as number, user.id, titles) } : null,
    };
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
