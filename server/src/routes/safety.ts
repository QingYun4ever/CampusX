/**
 * 拉黑、举报、自定义表情。
 * - 拉黑：单向；拉黑时双方互相取关。效果见 db.ts 里 blocks 表的说明
 * - 举报：帖子或用户，由站点管理员在后台处理
 * - 自定义表情：每人最多 MAX_EMOJIS 个，服务器压成 160px 的 WebP（动图保留动画），存在 site_uploads 里
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sessionTokenHash } from '../auth.ts';
import { all, get, now, run, tx } from '../db.ts';
import { readUploadedImage } from '../image-upload.ts';
import { postById, unnotify } from '../serialize.ts';
import { removePost } from './posts.ts';
import { EMOJI_TOKEN_ONE, emojiSrc, emojiToken } from '../emoji-tokens.ts';
import { MAX_REVIEW_IMAGE_BYTES, readStoredUpload, storeSiteUpload } from '../site-uploads.ts';
import { makeEmojiImage } from '../thumbs.ts';
import { HttpError, me, parse } from '../util.ts';
import { USER_COLS, userPublic } from './users-common.ts';

export const MAX_EMOJIS = 60;
const MAX_BLOCKS = 500;

export const REPORT_REASONS = {
  spam: '垃圾广告',
  harass: '辱骂骚扰',
  porn: '色情低俗',
  illegal: '违法违规',
  privacy: '泄露隐私',
  fake: '冒充他人',
  other: '其他',
} as const;
type ReasonKey = keyof typeof REPORT_REASONS;
const reasonKeys = Object.keys(REPORT_REASONS) as [ReasonKey, ...ReasonKey[]];

const reportSchema = z.object({
  targetType: z.enum(['post', 'user']),
  targetId: z.number().int().positive(),
  reason: z.enum(reasonKeys, { error: '请选择举报原因' }),
  note: z.string().trim().max(300, '补充说明最多 300 字').default(''),
});

const reportStatus = z.enum(['resolved', 'dismissed']);

const handleSchema = z.object({
  targetType: z.enum(['post', 'user']),
  targetId: z.number().int().positive(),
  status: reportStatus,
  deletePost: z.boolean().default(false),
});

const settleSchema = z.object({
  batchId: z.number().int().positive(),
  revision: z.number().int().nonnegative(),
  status: reportStatus,
  deletePost: z.boolean().default(false),
});

type ReportBatch = {
  id: number;
  target_type: 'post' | 'user';
  target_id: number;
  author_id: number | null;
  detached: number;
  revision: number;
  status: 'open' | 'resolved' | 'dismissed';
  handled_at: number | null;
};

const reportConflict = () => new HttpError(409, '举报内容或目标已变化，请刷新后重新确认');

/** 在调用者的事务中处理同一批举报，并通知仍有账号的举报人。 */
function settleBatch(batch: ReportBatch, adminId: number, status: z.infer<typeof reportStatus>, deletePost: boolean) {
  if (batch.author_id === null) throw new HttpError(403, '无法确认原举报对象');
  if (batch.author_id === adminId) throw new HttpError(403, '这条举报涉及你本人，请交给其他管理员处理');

  const count = get<{ n: number }>('SELECT COUNT(*) AS n FROM reports WHERE batch_id = $id', { id: batch.id })!.n;
  if (!count) throw reportConflict();
  if (deletePost) {
    if (batch.target_type !== 'post' || status !== 'resolved') throw new HttpError(400, '只能在处理帖子举报时删除帖子');
    if (batch.detached || !get('SELECT 1 FROM posts WHERE id = $id AND author_id = $a', { id: batch.target_id, a: batch.author_id })
      || !removePost(batch.target_id, true)) throw reportConflict();
  }

  const t = now();
  run('UPDATE report_batches SET status = $s, handled_by = $by, handled_at = $t WHERE id = $id', {
    s: status, by: adminId, t, id: batch.id,
  });
  // 不走 notify() 的去重：同一个人可能多次举报、多次被处理。
  run(`INSERT INTO notifications (user_id, actor_id, type, post_id, extra, created_at)
       SELECT reporter_id, $by, 'report', NULL, $extra, $t FROM reports WHERE batch_id = $id AND reporter_id IS NOT NULL`, {
    by: adminId, extra: JSON.stringify({ targetType: batch.target_type, status }), t, id: batch.id,
  });
  return { ok: true, count };
}

function userByName(username: string) {
  const r = get(`SELECT ${USER_COLS} FROM users u WHERE u.username = $n`, { n: username });
  if (!r) throw new HttpError(404, '用户不存在');
  return userPublic(r);
}

type EmojiRow = { id: number; file: string; name: string; animated: number; created_at: number; origin: string | null };
const EMOJI_COLS = 'id, file, name, animated, created_at, origin';
const emojiDTO = (r: EmojiRow) => ({
  id: r.id,
  file: r.file,
  /** 收藏来的表情：最初那个表情的文件名 */
  origin: r.origin ?? null,
  url: `/uploads/${r.file}`,
  name: r.name,
  animated: !!r.animated,
  createdAt: r.created_at,
});

const excerpt = (content: string, images: string) =>
  content.slice(0, 120) || ((JSON.parse(images) as string[]).length ? '[图片]' : '');

export async function safetyRoutes(app: FastifyInstance) {
  /* ---------- 拉黑 ---------- */
  app.get('/me/blocks', async (req) => {
    const rows = all(
      `SELECT ${USER_COLS}, bl.created_at AS blocked_at FROM blocks bl JOIN users u ON u.id = bl.blocked_id
       WHERE bl.blocker_id = $me ORDER BY bl.created_at DESC`,
      { me: me(req).id },
    );
    return rows.map((r) => ({ ...userPublic(r), blockedAt: r.blocked_at as number }));
  });

  app.post('/users/:username/block', async (req) => {
    const user = me(req);
    const u = userByName((req.params as { username: string }).username);
    if (u.id === user.id) throw new HttpError(400, '不能拉黑自己');
    tx(() => {
      const n = get<{ n: number }>('SELECT COUNT(*) AS n FROM blocks WHERE blocker_id = $me', { me: user.id })!.n;
      if (n >= MAX_BLOCKS) throw new HttpError(400, `最多拉黑 ${MAX_BLOCKS} 人`);
      run('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES ($a, $b, $t)', { a: user.id, b: u.id, t: now() });
      // 互相取关，并撤回对方的关注通知
      run('DELETE FROM follows WHERE (follower_id = $a AND followee_id = $b) OR (follower_id = $b AND followee_id = $a)', { a: user.id, b: u.id });
      unnotify(user.id, u.id, 'follow');
      unnotify(u.id, user.id, 'follow');
    });
    return { ok: true, blocked: true };
  });

  app.delete('/users/:username/block', async (req) => {
    const user = me(req);
    const u = userByName((req.params as { username: string }).username);
    run('DELETE FROM blocks WHERE blocker_id = $a AND blocked_id = $b', { a: user.id, b: u.id });
    return { ok: true, blocked: false };
  });

  /* ---------- 举报 ---------- */
  app.get('/reports/reasons', async () => REPORT_REASONS);

  app.post('/reports', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req) => {
    const user = me(req);
    const body = parse(reportSchema, req.body);
    return tx(() => {
      let authorId = body.targetId;
      if (body.targetType === 'post') {
        // 和按 ID 看帖相同：转发行和它的原帖都必须可见。
        const post = postById(body.targetId, user.id);
        if (!post || post.deleted) throw new HttpError(404, '帖子不存在');
        authorId = post.author.id;
        if (authorId === user.id) throw new HttpError(400, '不能举报自己的帖子');
      } else {
        if (!get('SELECT 1 FROM users WHERE id = $id', { id: body.targetId })) throw new HttpError(404, '用户不存在');
        if (authorId === user.id) throw new HttpError(400, '不能举报自己');
      }

      const target = { type: body.targetType, id: body.targetId };
      const batchId = get<{ id: number }>(
        "SELECT id FROM report_batches WHERE target_type = $type AND target_id = $id AND status = 'open' AND detached = 0", target,
      )?.id ?? run('INSERT INTO report_batches (target_type, target_id, author_id) VALUES ($type, $id, $author)', {
        ...target, author: authorId,
      }).lastId;
      const r = run(
        `INSERT INTO reports (batch_id, reporter_id, reason, note, created_at)
         SELECT $b, $u, $reason, $note, $t WHERE NOT EXISTS (SELECT 1 FROM reports WHERE batch_id = $b AND reporter_id = $u)`,
        { b: batchId, u: user.id, reason: body.reason, note: body.note, t: now() },
      );
      // 已经举报过、还没处理：当作成功，不重复记录。
      return { ok: true, duplicate: !r.changes };
    });
  });

  /* ---------- 举报处理（站点管理员） ---------- */
  app.register(async (admin) => {
    admin.addHook('preHandler', async (req) => {
      if (me(req).role !== 'admin') throw new HttpError(403, '需要管理员权限');
    });

    // 旧客户端不回传版本：只允许它结案看过的首批、单条且从未改变的举报。
    // 同一数字目标之后永远不会再进入这个集合，标签页间刷新也不会授权处理另一批。
    const legacyViews = new Map<number, { session: string; batches: Set<number> }>();

    admin.get('/admin/reports/count', async () => ({
      count: get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM report_batches b WHERE b.status = 'open' AND b.author_id IS NOT NULL AND EXISTS (SELECT 1 FROM reports WHERE batch_id = b.id)",
      )!.n,
    }));

    /** 按批次聚合；目标被删除后保留该批次，不与复用同一个 ID 的目标合并。 */
    admin.get('/admin/reports', async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      const adminId = me(req).id;
      const query = req.query as { status?: string; batch?: string };
      const status = query.status === 'archived' || query.status === 'closed' ? query.status : 'open';
      // 无法确认目标的旧举报只在归档显示，不占待处理队列的名额。
      const filter = status === 'archived' ? 'b.author_id IS NULL'
        : `b.author_id IS NOT NULL AND b.status ${status === 'open' ? '=' : '<>'} 'open'`;
      const groups = all<ReportBatch & { n: number; first_at: number; last_at: number; legacy_eligible: number }>(
        `SELECT b.*, COUNT(*) AS n, MIN(r.created_at) AS first_at, MAX(r.created_at) AS last_at,
                (b.revision = 1 AND b.detached = 0 AND NOT EXISTS (
                   SELECT 1 FROM report_batches old WHERE old.target_type = b.target_type AND old.target_id = b.target_id AND old.id < b.id
                 )) AS legacy_eligible
         FROM report_batches b JOIN reports r ON r.batch_id = b.id WHERE ${filter}
         GROUP BY b.id
         ORDER BY ${status === 'open' ? 'n DESC, last_at DESC' : status === 'closed' ? 'b.handled_at DESC' : 'last_at DESC'}, b.id DESC LIMIT 100`,
      );
      const result = groups.map((g) => {
        const unknown = g.author_id === null;
        const redact = unknown || g.author_id === adminId;
        const reports = all<{ reason: string; note: string; created_at: number; username: string | null; display_name: string | null }>(
          `SELECT r.reason, r.note, r.created_at, u.username, u.display_name FROM reports r LEFT JOIN users u ON u.id = r.reporter_id
           WHERE r.batch_id = $id ORDER BY r.id DESC LIMIT 20`,
          { id: g.id },
        );
        let target: Record<string, unknown> | null = null;
        if (!g.detached && !unknown && g.target_type === 'post') {
          // 注意：USER_COLS 里也有 u.id，帖子 id 单独取别名，不然会被作者 id 覆盖
          const p = get(
            `SELECT p.id AS post_id, p.content, p.images, p.deleted, p.parent_id, p.repost_of, ${USER_COLS}
             FROM posts p JOIN users u ON u.id = p.author_id WHERE p.id = $id AND p.author_id = $author`,
            { id: g.target_id, author: g.author_id },
          );
          if (p) {
            target = {
              id: p.post_id,
              excerpt: excerpt(p.content as string, p.images as string),
              images: JSON.parse(p.images as string),
              deleted: !!p.deleted,
              isReply: p.parent_id != null,
              isRepost: p.repost_of != null,
              author: userPublic(p),
            };
          }
        } else if (!g.detached && !unknown && g.target_type === 'user') {
          const u = get(`SELECT ${USER_COLS} FROM users u WHERE u.id = $id`, { id: g.target_id });
          if (u) target = { user: userPublic(u) };
        }
        return {
          batchId: g.id,
          revision: g.revision,
          targetType: g.target_type,
          targetId: g.target_id,
          count: g.n,
          firstAt: g.first_at,
          lastAt: g.last_at,
          status: g.status,
          handledAt: g.handled_at,
          target,
          involvesMe: redact,
          identityUnknown: unknown,
          reports: reports.map((r) => ({
            reason: r.reason,
            reasonText: REPORT_REASONS[r.reason as ReasonKey] ?? r.reason,
            note: redact ? '' : r.note,
            createdAt: r.created_at,
            reporter: redact
              ? { username: '', displayName: '已隐藏' }
              : { username: r.username ?? '', displayName: r.display_name ?? '账号已删除' },
          })),
        };
      });
      if (status === 'open' && query.batch !== '1') {
        legacyViews.set(adminId, {
          session: sessionTokenHash(req.headers.authorization?.slice(7) ?? ''),
          batches: new Set(groups.filter((g) => g.legacy_eligible).map((g) => g.id)),
        });
      }
      return result;
    });

    /** 旧客户端兼容：无版本请求绝不删帖，也不能结案无法确认的批次。 */
    admin.post('/admin/reports/handle', async (req) => {
      const user = me(req);
      const body = parse(handleSchema, req.body);
      if (body.deletePost) throw new HttpError(409, '请更新或刷新客户端后从举报后台删除帖子');
      return tx(() => {
        const batch = get<ReportBatch>(
          "SELECT * FROM report_batches WHERE target_type = $type AND target_id = $id AND status = 'open' AND detached = 0",
          { type: body.targetType, id: body.targetId },
        );
        const seen = legacyViews.get(user.id);
        if (!batch || batch.revision !== 1 || !seen?.batches.has(batch.id)
          || seen.session !== sessionTokenHash(req.headers.authorization?.slice(7) ?? '')) throw reportConflict();
        return settleBatch(batch, user.id, body.status, false);
      });
    });

    admin.post('/admin/reports/settle', async (req) => {
      const user = me(req);
      const body = parse(settleSchema, req.body);
      return tx(() => {
        const batch = get<ReportBatch>("SELECT * FROM report_batches WHERE id = $id AND status = 'open'", { id: body.batchId });
        if (!batch || batch.revision !== body.revision) throw reportConflict();
        return settleBatch(batch, user.id, body.status, body.deletePost);
      });
    });
  });

  /* ---------- 自定义表情 ---------- */
  app.get('/me/emojis', async (req) => {
    const rows = all<EmojiRow>(
      `SELECT ${EMOJI_COLS} FROM custom_emojis WHERE owner_id = $me AND removed = 0 ORDER BY id DESC`,
      { me: me(req).id },
    );
    return { items: rows.map(emojiDTO), limit: MAX_EMOJIS };
  });

  app.post('/me/emojis', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const user = me(req);
    const count = () => get<{ n: number }>('SELECT COUNT(*) AS n FROM custom_emojis WHERE owner_id = $me AND removed = 0', { me: user.id })!.n;
    if (count() >= MAX_EMOJIS) throw new HttpError(400, `每人最多 ${MAX_EMOJIS} 个自定义表情，先删掉一些吧`);
    const file = await req.file();
    if (!file) throw new HttpError(400, '没有收到文件');
    const raw = await readUploadedImage(file);
    const { buffer, ext, animated } = await makeEmojiImage(raw.buffer, raw.ext);
    const url = storeSiteUpload(user.id, buffer, ext);
    const name = url.slice('/uploads/'.length);
    const id = tx(() => {
      if (count() >= MAX_EMOJIS) throw new HttpError(400, `每人最多 ${MAX_EMOJIS} 个自定义表情，先删掉一些吧`);
      run('UPDATE site_uploads SET used = 1 WHERE name = $name', { name });
      return Number(
        run('INSERT INTO custom_emojis (owner_id, file, animated, created_at) VALUES ($me, $file, $a, $t)', {
          me: user.id, file: name, a: animated ? 1 : 0, t: now(),
        }).lastId,
      );
    });
    // 超出数量时文件留在 site_uploads（used = 0），24 小时后会被回收
    return emojiDTO(get<EmojiRow>(`SELECT ${EMOJI_COLS} FROM custom_emojis WHERE id = $id`, { id })!);
  });

  /**
   * 收藏别人发过的表情：复制一份到自己名下（原主删掉也不影响）。
   * 只能收藏已经发出来过的表情；同一个表情（包括别人收藏的副本）只收一次。
   */
  app.post('/me/emojis/collect', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const user = me(req);
    const { file } = parse(z.object({ file: z.string().max(60) }), req.body);
    if (!EMOJI_TOKEN_ONE.test(emojiToken(file))) throw new HttpError(400, '表情不存在');
    const source = get<{ animated: number; origin: string | null }>(
      'SELECT animated, origin FROM custom_emojis WHERE file = $f AND sent = 1', { f: file },
    );
    if (!source) throw new HttpError(404, '这个表情不能添加');
    const root = source.origin ?? file;
    const mine = () => get<EmojiRow>(
      `SELECT ${EMOJI_COLS} FROM custom_emojis WHERE owner_id = $me AND removed = 0
         AND (file IN ($f, $root) OR origin IN ($f, $root))`,
      { me: user.id, f: file, root },
    );
    const count = () => get<{ n: number }>('SELECT COUNT(*) AS n FROM custom_emojis WHERE owner_id = $me AND removed = 0', { me: user.id })!.n;
    const check = () => {
      if (mine()) throw new HttpError(409, '已经在你的表情里了');
      if (count() >= MAX_EMOJIS) throw new HttpError(400, `每人最多 ${MAX_EMOJIS} 个自定义表情，先删掉一些吧`);
    };
    check();
    const { buffer, ext } = await readStoredUpload(emojiSrc(file), MAX_REVIEW_IMAGE_BYTES);
    const url = storeSiteUpload(user.id, buffer, ext);
    const name = url.slice('/uploads/'.length);
    const id = tx(() => {
      check();
      run('UPDATE site_uploads SET used = 1 WHERE name = $name', { name });
      // 原表情已经发出来过，副本也算发过：不经过审核也不会被当成没用的文件清理
      return Number(
        run('INSERT INTO custom_emojis (owner_id, file, animated, sent, origin, created_at) VALUES ($me, $file, $a, 1, $o, $t)', {
          me: user.id, file: name, a: source.animated, o: root, t: now(),
        }).lastId,
      );
    });
    return emojiDTO(get<EmojiRow>(`SELECT ${EMOJI_COLS} FROM custom_emojis WHERE id = $id`, { id })!);
  });

  /** 只从「我的表情」里移除；文件保留，已经发出去的内容还能显示 */
  app.delete('/me/emojis/:id', async (req) => {
    const r = run('UPDATE custom_emojis SET removed = 1 WHERE id = $id AND owner_id = $me AND removed = 0', {
      id: Number((req.params as { id: string }).id),
      me: me(req).id,
    });
    if (!r.changes) throw new HttpError(404, '表情不存在');
    return { ok: true };
  });
}
