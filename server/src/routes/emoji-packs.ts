/**
 * 表情包（像 Telegram 的贴纸包）：一组图片表情，装上以后出现在表情面板里，发出去还是 [e:文件名]。
 *
 * - 官方包：管理员建、管理员维护（增删表情、改名、下架），上传即算审核过。随代码带的几个包见 ../emoji-packs.ts
 * - 同学的包：自己建、自己传图，提交给管理员审核，通过了才在商场上架。
 *   上架以后再加的表情要再提交审核，审核前只有自己看得到；已经上架的表情不受影响。
 *   上架以后不能自己改名字和介绍（名字是公开的，改了要重新审），想改找管理员。
 * - 安装记录存在服务器上，换手机也在。
 * - 删包、删表情都不真删文件：发出去过的表情还要能显示。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { all, get, now, run, tx } from '../db.ts';
import { readUploadedImage } from '../image-upload.ts';
import { storeSiteUpload } from '../site-uploads.ts';
import { makeEmojiImage } from '../thumbs.ts';
import { HttpError, me, parse } from '../util.ts';
import { userById } from './users-common.ts';

/** 每人最多做几个包（不算删掉的） */
export const MAX_PACKS_PER_USER = 5;
/** 同学的包最多多少个表情；官方包放宽 */
export const MAX_PACK_ITEMS = 120;
const MAX_OFFICIAL_ITEMS = 1000;
/** 至少几个表情才能提交审核 */
export const MIN_PACK_ITEMS = 4;
/** 每人最多装几个包 */
export const MAX_INSTALLS = 30;
const PREVIEW = 8;

export type PackRow = {
  id: number; slug: string | null; owner_id: number | null; official: number; name: string; description: string; credit: string;
  status: 'draft' | 'pending' | 'rejected' | 'ok' | 'deleted' | 'seeding'; listed: number; note: string; cover: string | null;
  installs: number; created_at: number; submitted_at: number | null; reviewed_at: number | null;
};
type ItemRow = { id: number; pack_id: number; file: string; grp: string; animated: number; reviewed: number; created_at: number };
type Viewer = { id: number; role: string };

const packById = (id: number) => get<PackRow>('SELECT * FROM emoji_packs WHERE id = $id', { id });

const canEdit = (p: PackRow, u: Viewer) => u.role === 'admin' || (!p.official && p.owner_id === u.id);
const isPublic = (p: PackRow) => !!p.listed && p.status !== 'deleted' && p.status !== 'seeding';

/** 能看到这个包吗：上架的谁都能看；没上架的只有作者和管理员 */
function viewablePack(id: number, u: Viewer) {
  const p = packById(id);
  if (!p || p.status === 'deleted' || p.status === 'seeding' || (!isPublic(p) && !canEdit(p, u))) throw new HttpError(404, '表情包不存在');
  return p;
}

function editablePack(id: number, u: Viewer) {
  const p = packById(id);
  if (!p || p.status === 'deleted' || p.status === 'seeding' || !canEdit(p, u)) throw new HttpError(404, '表情包不存在');
  return p;
}

/** 上架后公开的表情：审核过的；作者和管理员看全部（没审的标出来） */
function packItems(packId: number, everything: boolean) {
  return all<ItemRow>(
    `SELECT id, pack_id, file, grp, animated, reviewed, created_at FROM emoji_pack_items
     WHERE pack_id = $p AND removed = 0 ${everything ? '' : 'AND reviewed = 1'} ORDER BY id`,
    { p: packId },
  );
}

const itemDTO = (r: ItemRow) => ({ id: r.id, file: r.file, group: r.grp, animated: !!r.animated, reviewed: !!r.reviewed });

function packDTO(p: PackRow, u: Viewer, opts: { items?: boolean } = {}) {
  const editor = canEdit(p, u);
  const counts = get<{ shown: number; unreviewed: number; total: number }>(
    `SELECT COALESCE(SUM(reviewed), 0) AS shown, COALESCE(SUM(1 - reviewed), 0) AS unreviewed, COUNT(*) AS total
     FROM emoji_pack_items WHERE pack_id = $p AND removed = 0`,
    { p: p.id },
  )!;
  // 封面：自己选的，没选就用第一个。没上架的包作者能看到没审过的表情
  const cover = p.cover && get('SELECT 1 FROM emoji_pack_items WHERE pack_id = $p AND file = $f AND removed = 0 AND (reviewed = 1 OR $all)', { p: p.id, f: p.cover, all: editor ? 1 : 0 })
    ? p.cover
    : get<{ file: string }>(
      `SELECT file FROM emoji_pack_items WHERE pack_id = $p AND removed = 0 ${editor ? '' : 'AND reviewed = 1'} ORDER BY id LIMIT 1`, { p: p.id },
    )?.file ?? null;
  const items = opts.items ? packItems(p.id, editor) : undefined;
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    credit: p.credit,
    official: !!p.official,
    owner: p.official || p.owner_id === null ? null : (userById(p.owner_id) ?? null),
    status: p.status,
    listed: !!p.listed,
    /** 驳回理由，只给作者看 */
    note: editor && p.status === 'rejected' ? p.note : '',
    cover,
    /** 公开的表情数 */
    count: counts.shown,
    /** 作者和管理员：一共多少、还有几个没审 */
    ...(editor ? { total: counts.total, unreviewed: counts.unreviewed, editable: true } : {}),
    installs: p.installs,
    installed: !!get('SELECT 1 FROM emoji_pack_installs WHERE user_id = $u AND pack_id = $p', { u: u.id, p: p.id }),
    preview: items
      ? items.filter((i) => editor || i.reviewed).slice(0, PREVIEW).map((i) => i.file)
      : all<{ file: string }>(
        `SELECT file FROM emoji_pack_items WHERE pack_id = $p AND removed = 0 ${editor ? '' : 'AND reviewed = 1'} ORDER BY id LIMIT ${PREVIEW}`,
        { p: p.id },
      ).map((r) => r.file),
    createdAt: p.created_at,
    submittedAt: p.submitted_at,
    reviewedAt: p.reviewed_at,
    ...(items ? { items: items.map(itemDTO) } : {}),
  };
}

const nameSchema = z.string().trim().min(1, '给表情包起个名字吧').max(20, '名字最多 20 个字');
const descSchema = z.string().trim().max(100, '介绍最多 100 个字');
const groupSchema = z.string().trim().max(10, '分组名最多 10 个字');

/** 包里还有没审过的表情：作者改过了，要重新提交 */
function afterEdit(p: PackRow) {
  if (p.official) return;
  const unreviewed = get('SELECT 1 FROM emoji_pack_items WHERE pack_id = $p AND removed = 0 AND reviewed = 0', { p: p.id });
  if (unreviewed) {
    // 审核中又改了：保持 pending，管理员看到的就是最新的
    if (p.status === 'ok') run("UPDATE emoji_packs SET status = 'draft' WHERE id = $id", { id: p.id });
  } else if (p.listed && p.status !== 'ok') {
    // 没审的都删掉了：回到已上架的状态
    run("UPDATE emoji_packs SET status = 'ok' WHERE id = $id", { id: p.id });
  }
}

function notifyOwner(p: PackRow, adminId: number, extra: object) {
  if (!p.owner_id || p.official) return;
  run(`INSERT INTO notifications (user_id, actor_id, type, extra, created_at) VALUES ($u, $a, 'pack', $x, $t)`, {
    u: p.owner_id, a: adminId, x: JSON.stringify({ packId: p.id, name: p.name, ...extra }), t: now(),
  });
}

/** 软删除：下架、表情标成移除（发出去过的文件留着）、卸载 */
function deletePack(id: number) {
  run("UPDATE emoji_packs SET status = 'deleted', listed = 0 WHERE id = $id", { id });
  run('UPDATE emoji_pack_items SET removed = 1 WHERE pack_id = $id', { id });
  run('DELETE FROM emoji_pack_installs WHERE pack_id = $id', { id });
  run('UPDATE emoji_packs SET installs = 0 WHERE id = $id', { id });
}

const idParam = (req: FastifyRequest, key = 'id') => {
  const n = Number((req.params as Record<string, string>)[key]);
  if (!Number.isSafeInteger(n) || n < 1) throw new HttpError(404, '表情包不存在');
  return n;
};

export async function emojiPackRoutes(app: FastifyInstance) {
  /* ---------- 商场 ---------- */
  app.get('/emoji-packs', async (req) => {
    const user = me(req);
    const rows = all<PackRow>(
      `SELECT * FROM emoji_packs WHERE listed = 1 AND status NOT IN ('deleted', 'seeding')
       ORDER BY official DESC, installs DESC, id LIMIT 200`,
    );
    return { items: rows.map((p) => packDTO(p, user)).filter((p) => p.count > 0) };
  });

  app.get('/emoji-packs/:id', async (req) => {
    const user = me(req);
    return packDTO(viewablePack(idParam(req), user), user, { items: true });
  });

  /* ---------- 装上的包（表情面板用） ---------- */
  app.get('/me/emoji-packs', async (req) => {
    const user = me(req);
    const packs = all<PackRow>(
      `SELECT p.* FROM emoji_pack_installs i JOIN emoji_packs p ON p.id = i.pack_id
       WHERE i.user_id = $u AND p.listed = 1 AND p.status NOT IN ('deleted', 'seeding') ORDER BY i.created_at`,
      { u: user.id },
    );
    return {
      limit: MAX_INSTALLS,
      items: packs.map((p) => {
        const items = packItems(p.id, false);
        const cover = p.cover && items.some((i) => i.file === p.cover) ? p.cover : items[0]?.file ?? null;
        return { id: p.id, name: p.name, official: !!p.official, cover, items: items.map((i) => ({ file: i.file, group: i.grp })) };
      }).filter((p) => p.items.length),
    };
  });

  app.post('/me/emoji-packs/:id/install', async (req) => {
    const user = me(req);
    const id = idParam(req);
    tx(() => {
      const p = packById(id);
      if (!p || !isPublic(p)) throw new HttpError(404, '表情包不存在');
      if (get('SELECT 1 FROM emoji_pack_installs WHERE user_id = $u AND pack_id = $p', { u: user.id, p: id })) return;
      const n = get<{ n: number }>('SELECT COUNT(*) AS n FROM emoji_pack_installs WHERE user_id = $u', { u: user.id })!.n;
      if (n >= MAX_INSTALLS) throw new HttpError(400, `最多装 ${MAX_INSTALLS} 个表情包，先移除一些吧`);
      run('INSERT INTO emoji_pack_installs (user_id, pack_id, created_at) VALUES ($u, $p, $t)', { u: user.id, p: id, t: now() });
      run('UPDATE emoji_packs SET installs = installs + 1 WHERE id = $p', { p: id });
    });
    return { ok: true };
  });

  app.delete('/me/emoji-packs/:id/install', async (req) => {
    const user = me(req);
    const id = idParam(req);
    tx(() => {
      if (run('DELETE FROM emoji_pack_installs WHERE user_id = $u AND pack_id = $p', { u: user.id, p: id }).changes) {
        run('UPDATE emoji_packs SET installs = MAX(0, installs - 1) WHERE id = $p', { p: id });
      }
    });
    return { ok: true };
  });

  /* ---------- 自己做的包 ---------- */
  app.get('/me/made-emoji-packs', async (req) => {
    const user = me(req);
    const rows = all<PackRow>(
      "SELECT * FROM emoji_packs WHERE owner_id = $u AND official = 0 AND status <> 'deleted' ORDER BY id DESC",
      { u: user.id },
    );
    return { items: rows.map((p) => packDTO(p, user)), limit: MAX_PACKS_PER_USER, maxItems: MAX_PACK_ITEMS, minItems: MIN_PACK_ITEMS };
  });

  app.post('/emoji-packs', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const user = me(req);
    const body = parse(z.object({
      name: nameSchema,
      description: descSchema.default(''),
      official: z.boolean().default(false),
      credit: z.string().trim().max(200).default(''),
    }), req.body);
    const official = body.official && user.role === 'admin';
    const id = tx(() => {
      if (!official) {
        const n = get<{ n: number }>("SELECT COUNT(*) AS n FROM emoji_packs WHERE owner_id = $u AND official = 0 AND status <> 'deleted'", { u: user.id })!.n;
        if (n >= MAX_PACKS_PER_USER) throw new HttpError(400, `每人最多做 ${MAX_PACKS_PER_USER} 个表情包`);
      }
      return Number(run(
        `INSERT INTO emoji_packs (owner_id, official, name, description, credit, status, listed, created_at)
         VALUES ($u, $o, $n, $d, $c, $s, 0, $t)`,
        {
          u: official ? null : user.id, o: official ? 1 : 0, n: body.name, d: body.description,
          c: user.role === 'admin' ? body.credit : '', s: official ? 'ok' : 'draft', t: now(),
        },
      ).lastId);
    });
    return packDTO(packById(id)!, user, { items: true });
  });

  app.patch('/emoji-packs/:id', async (req) => {
    const user = me(req);
    const body = parse(z.object({
      name: nameSchema.optional(),
      description: descSchema.optional(),
      credit: z.string().trim().max(200).optional(),
      cover: z.string().max(60).nullable().optional(),
    }), req.body);
    const id = idParam(req);
    tx(() => {
      const p = editablePack(id, user);
      const admin = user.role === 'admin';
      if ((body.name !== undefined && body.name !== p.name) || (body.description !== undefined && body.description !== p.description)) {
        // 上架后的名字和介绍是公开的，改了没人审：只让管理员改
        if (p.listed && !admin) throw new HttpError(400, '上架以后不能自己改名字和介绍，需要的话联系管理员');
      }
      if (body.cover) {
        const item = get<{ reviewed: number }>('SELECT reviewed FROM emoji_pack_items WHERE pack_id = $p AND file = $f AND removed = 0', { p: id, f: body.cover });
        if (!item) throw new HttpError(400, '封面要从包里的表情选');
        if (p.listed && !item.reviewed && !admin) throw new HttpError(400, '这个表情还没审核，审核通过后才能当封面');
      }
      run(
        `UPDATE emoji_packs SET name = COALESCE($n, name), description = COALESCE($d, description),
           credit = COALESCE($c, credit), cover = CASE WHEN $setCover THEN $cover ELSE cover END WHERE id = $id`,
        {
          id, n: body.name ?? null, d: body.description ?? null, c: admin ? body.credit ?? null : null,
          setCover: body.cover !== undefined ? 1 : 0, cover: body.cover ?? null,
        },
      );
    });
    return packDTO(packById(id)!, user, { items: true });
  });

  app.delete('/emoji-packs/:id', async (req) => {
    const user = me(req);
    const id = idParam(req);
    tx(() => {
      editablePack(id, user);
      deletePack(id);
    });
    return { ok: true };
  });

  /** 往包里传一个表情。?group=开心 可以顺便分组（管理员按文件夹导入时用） */
  app.post('/emoji-packs/:id/items', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const user = me(req);
    const id = idParam(req);
    const { group } = parse(z.object({ group: groupSchema.default('') }), req.query);
    const p = editablePack(id, user);
    const max = p.official ? MAX_OFFICIAL_ITEMS : MAX_PACK_ITEMS;
    const count = () => get<{ n: number }>('SELECT COUNT(*) AS n FROM emoji_pack_items WHERE pack_id = $p AND removed = 0', { p: id })!.n;
    if (count() >= max) throw new HttpError(400, `一个表情包最多 ${max} 个表情`);
    const file = await req.file();
    if (!file) throw new HttpError(400, '没有收到文件');
    const raw = await readUploadedImage(file);
    const { buffer, ext, animated } = await makeEmojiImage(raw.buffer, raw.ext);
    // 官方包的文件算站点的，不占管理员个人的图片额度
    const url = storeSiteUpload(p.official ? null : user.id, buffer, ext);
    const name = url.slice('/uploads/'.length);
    const itemId = tx(() => {
      const cur = packById(id);
      if (!cur || cur.status === 'deleted') throw new HttpError(404, '表情包不存在');
      if (count() >= max) throw new HttpError(400, `一个表情包最多 ${max} 个表情`);
      run('UPDATE site_uploads SET used = 1 WHERE name = $name', { name });
      const lastId = Number(run(
        `INSERT INTO emoji_pack_items (pack_id, file, grp, animated, reviewed, created_at) VALUES ($p, $f, $g, $a, $r, $t)`,
        // 管理员传的（包括官方包）不用再审
        { p: id, f: name, g: group, a: animated ? 1 : 0, r: user.role === 'admin' ? 1 : 0, t: now() },
      ).lastId);
      afterEdit(cur);
      return lastId;
    });
    // 没写进包（满了、包删了）的文件留在 site_uploads（used = 0），24 小时后回收
    return itemDTO(get<ItemRow>('SELECT * FROM emoji_pack_items WHERE id = $id', { id: itemId })!);
  });

  app.patch('/emoji-packs/:id/items/:item', async (req) => {
    const user = me(req);
    const id = idParam(req);
    const { group } = parse(z.object({ group: groupSchema }), req.body);
    editablePack(id, user);
    const r = run('UPDATE emoji_pack_items SET grp = $g WHERE id = $i AND pack_id = $p AND removed = 0', { g: group, i: idParam(req, 'item'), p: id });
    if (!r.changes) throw new HttpError(404, '表情不存在');
    return { ok: true };
  });

  app.delete('/emoji-packs/:id/items/:item', async (req) => {
    const user = me(req);
    const id = idParam(req);
    tx(() => {
      const p = editablePack(id, user);
      const item = get<{ file: string }>('SELECT file FROM emoji_pack_items WHERE id = $i AND pack_id = $p AND removed = 0', { i: idParam(req, 'item'), p: id });
      if (!item) throw new HttpError(404, '表情不存在');
      run('UPDATE emoji_pack_items SET removed = 1 WHERE id = $i', { i: idParam(req, 'item') });
      if (p.cover === item.file) run('UPDATE emoji_packs SET cover = NULL WHERE id = $id', { id });
      afterEdit(p);
    });
    return { ok: true };
  });

  /** 提交审核 */
  app.post('/emoji-packs/:id/submit', async (req) => {
    const user = me(req);
    const id = idParam(req);
    tx(() => {
      const p = editablePack(id, user);
      if (p.official) throw new HttpError(400, '官方表情包不用审核');
      if (p.status === 'pending') throw new HttpError(409, '已经在审核了');
      const c = get<{ total: number; unreviewed: number }>(
        'SELECT COUNT(*) AS total, COALESCE(SUM(1 - reviewed), 0) AS unreviewed FROM emoji_pack_items WHERE pack_id = $p AND removed = 0',
        { p: id },
      )!;
      if (c.total < MIN_PACK_ITEMS) throw new HttpError(400, `至少要有 ${MIN_PACK_ITEMS} 个表情才能提交`);
      if (!c.unreviewed && p.listed) throw new HttpError(400, '没有新的改动要审核');
      run("UPDATE emoji_packs SET status = 'pending', submitted_at = $t WHERE id = $id", { id, t: now() });
    });
    return packDTO(packById(id)!, user, { items: true });
  });

  /** 撤回审核（还想再改改） */
  app.post('/emoji-packs/:id/withdraw', async (req) => {
    const user = me(req);
    const id = idParam(req);
    tx(() => {
      const p = editablePack(id, user);
      if (p.status !== 'pending') throw new HttpError(409, '没有在审核');
      run("UPDATE emoji_packs SET status = 'draft' WHERE id = $id", { id });
    });
    return packDTO(packById(id)!, user, { items: true });
  });

  /* ---------- 管理员 ---------- */
  app.register(async (admin) => {
    admin.addHook('preHandler', async (req) => {
      if (me(req).role !== 'admin') throw new HttpError(403, '需要管理员权限');
    });

    admin.get('/admin/emoji-packs/count', async () =>
      get<{ n: number }>("SELECT COUNT(*) AS n FROM emoji_packs WHERE status = 'pending'")!,
    );

    admin.get('/admin/emoji-packs', async (req) => {
      const user = me(req);
      const status = (req.query as { status?: string }).status;
      const rows = status === 'pending'
        ? all<PackRow>("SELECT * FROM emoji_packs WHERE status = 'pending' ORDER BY submitted_at LIMIT 100")
        : all<PackRow>("SELECT * FROM emoji_packs WHERE status NOT IN ('deleted', 'seeding') ORDER BY official DESC, listed DESC, id DESC LIMIT 300");
      return { items: rows.map((p) => packDTO(p, user)) };
    });

    admin.post('/admin/emoji-packs/:id/approve', async (req) => {
      const user = me(req);
      const id = idParam(req);
      tx(() => {
        const p = packById(id);
        if (!p || p.status !== 'pending') throw new HttpError(409, '这个表情包不在审核中');
        run('UPDATE emoji_pack_items SET reviewed = 1 WHERE pack_id = $p AND removed = 0', { p: id });
        run("UPDATE emoji_packs SET status = 'ok', listed = 1, note = '', reviewed_at = $t WHERE id = $id", { id, t: now() });
        notifyOwner(p, user.id, { approved: true, first: !p.listed });
      });
      return { ok: true };
    });

    admin.post('/admin/emoji-packs/:id/reject', async (req) => {
      const user = me(req);
      const id = idParam(req);
      const { note } = parse(z.object({ note: z.string().trim().max(100, '理由最多 100 字').default('') }), req.body ?? {});
      tx(() => {
        const p = packById(id);
        if (!p || p.status !== 'pending') throw new HttpError(409, '这个表情包不在审核中');
        run("UPDATE emoji_packs SET status = 'rejected', note = $n, reviewed_at = $t WHERE id = $id", { id, n: note, t: now() });
        notifyOwner(p, user.id, { rejected: true, note, listed: !!p.listed });
      });
      return { ok: true };
    });

    /** 下架 / 重新上架（重新上架只给审核通过过的包） */
    admin.post('/admin/emoji-packs/:id/listed', async (req) => {
      const id = idParam(req);
      const { listed } = parse(z.object({ listed: z.boolean() }), req.body);
      tx(() => {
        const p = packById(id);
        if (!p || p.status === 'deleted' || p.status === 'seeding') throw new HttpError(404, '表情包不存在');
        if (listed && !p.official && !p.reviewed_at) throw new HttpError(400, '还没审核通过过，不能上架');
        run('UPDATE emoji_packs SET listed = $l WHERE id = $id', { id, l: listed ? 1 : 0 });
      });
      return { ok: true };
    });
  });
}
