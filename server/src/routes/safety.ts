/**
 * 拉黑、举报、自定义表情。
 * - 拉黑：单向；拉黑时双方互相取关。效果见 db.ts 里 blocks 表的说明
 * - 举报：帖子或用户，由站点管理员在后台处理
 * - 自定义表情：每人最多 MAX_EMOJIS 个，服务器压成 160px 的 WebP（动图保留动画），存在 site_uploads 里
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { all, get, now, run, tx } from '../db.ts';
import { readUploadedImage } from '../image-upload.ts';
import { unnotify } from '../serialize.ts';
import { storeSiteUpload } from '../site-uploads.ts';
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

const handleSchema = z.object({
  targetType: z.enum(['post', 'user']),
  targetId: z.number().int().positive(),
  status: z.enum(['resolved', 'dismissed']),
});

function userByName(username: string) {
  const r = get(`SELECT ${USER_COLS} FROM users u WHERE u.username = $n`, { n: username });
  if (!r) throw new HttpError(404, '用户不存在');
  return userPublic(r);
}

type EmojiRow = { id: number; file: string; name: string; animated: number; created_at: number };
const emojiDTO = (r: EmojiRow) => ({
  id: r.id,
  file: r.file,
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
    if (body.targetType === 'post') {
      const p = get<{ author_id: number; deleted: number }>('SELECT author_id, deleted FROM posts WHERE id = $id', { id: body.targetId });
      if (!p || p.deleted) throw new HttpError(404, '帖子不存在');
      if (p.author_id === user.id) throw new HttpError(400, '不能举报自己的帖子');
    } else {
      if (!get('SELECT 1 FROM users WHERE id = $id', { id: body.targetId })) throw new HttpError(404, '用户不存在');
      if (body.targetId === user.id) throw new HttpError(400, '不能举报自己');
    }
    const r = run(
      `INSERT OR IGNORE INTO reports (reporter_id, target_type, target_id, reason, note, created_at)
       VALUES ($u, $type, $id, $reason, $note, $t)`,
      { u: user.id, type: body.targetType, id: body.targetId, reason: body.reason, note: body.note, t: now() },
    );
    // 已经举报过、还没处理：当作成功，不重复记录
    return { ok: true, duplicate: !r.changes };
  });

  /* ---------- 举报处理（站点管理员） ---------- */
  app.register(async (admin) => {
    admin.addHook('preHandler', async (req) => {
      if (me(req).role !== 'admin') throw new HttpError(403, '需要管理员权限');
    });

    admin.get('/admin/reports/count', async () => ({
      count: get<{ n: number }>(`SELECT COUNT(DISTINCT target_type || ':' || target_id) AS n FROM reports WHERE status = 'open'`)!.n,
    }));

    /** 按目标聚合：同一条帖子被多人举报只显示一行 */
    admin.get('/admin/reports', async (req) => {
      const status = (req.query as { status?: string }).status === 'closed' ? 'closed' : 'open';
      const groups = all<{ target_type: string; target_id: number; n: number; first_at: number; last_at: number; status: string; handled_at: number | null }>(
        `SELECT target_type, target_id, COUNT(*) AS n, MIN(created_at) AS first_at, MAX(created_at) AS last_at,
                MAX(status) AS status, MAX(handled_at) AS handled_at
         FROM reports WHERE ${status === 'open' ? "status = 'open'" : "status <> 'open'"}
         GROUP BY target_type, target_id ${status === 'open' ? '' : ', handled_at'}
         ORDER BY ${status === 'open' ? 'n DESC, last_at DESC' : 'handled_at DESC'} LIMIT 100`,
      );
      return groups.map((g) => {
        const reports = all<{ reason: string; note: string; created_at: number; username: string; display_name: string }>(
          `SELECT r.reason, r.note, r.created_at, u.username, u.display_name FROM reports r JOIN users u ON u.id = r.reporter_id
           WHERE r.target_type = $type AND r.target_id = $id AND ${status === 'open' ? "r.status = 'open'" : 'r.handled_at = $h'}
           ORDER BY r.id DESC LIMIT 20`,
          { type: g.target_type, id: g.target_id, h: g.handled_at },
        );
        let target: Record<string, unknown> | null = null;
        if (g.target_type === 'post') {
          const p = get(
            `SELECT p.id, p.content, p.images, p.deleted, p.status, p.parent_id, p.root_id, ${USER_COLS}
             FROM posts p JOIN users u ON u.id = p.author_id WHERE p.id = $id`,
            { id: g.target_id },
          );
          if (p) {
            target = {
              id: p.id,
              excerpt: excerpt(p.content as string, p.images as string),
              images: JSON.parse(p.images as string),
              deleted: !!p.deleted,
              isReply: p.parent_id != null,
              author: userPublic(p),
            };
          }
        } else {
          const u = get(`SELECT ${USER_COLS} FROM users u WHERE u.id = $id`, { id: g.target_id });
          if (u) target = { user: userPublic(u) };
        }
        return {
          targetType: g.target_type,
          targetId: g.target_id,
          count: g.n,
          firstAt: g.first_at,
          lastAt: g.last_at,
          status: status === 'open' ? 'open' : g.status,
          handledAt: g.handled_at,
          target,
          reports: reports.map((r) => ({
            reason: r.reason,
            reasonText: REPORT_REASONS[r.reason as ReasonKey] ?? r.reason,
            note: r.note,
            createdAt: r.created_at,
            reporter: { username: r.username, displayName: r.display_name },
          })),
        };
      });
    });

    /** 处理（resolved）或驳回（dismissed）这个目标的全部待处理举报；处理时通知举报人 */
    admin.post('/admin/reports/handle', async (req) => {
      const user = me(req);
      const body = parse(handleSchema, req.body);
      const t = now();
      const reporters = tx(() => {
        const ids = all<{ reporter_id: number }>(
          `SELECT reporter_id FROM reports WHERE target_type = $type AND target_id = $id AND status = 'open'`,
          { type: body.targetType, id: body.targetId },
        ).map((r) => r.reporter_id);
        run(
          `UPDATE reports SET status = $s, handled_by = $by, handled_at = $t
           WHERE target_type = $type AND target_id = $id AND status = 'open'`,
          { s: body.status, by: user.id, t, type: body.targetType, id: body.targetId },
        );
        if (body.status === 'resolved') {
          const extra = JSON.stringify({ targetType: body.targetType });
          // 不走 notify() 的去重：同一个人可能多次举报、多次被处理
          for (const id of ids) {
            run(`INSERT INTO notifications (user_id, actor_id, type, post_id, extra, created_at) VALUES ($u, $a, 'report', NULL, $extra, $t)`, {
              u: id, a: user.id, extra, t,
            });
          }
        }
        return ids;
      });
      return { ok: true, count: reporters.length };
    });
  });

  /* ---------- 自定义表情 ---------- */
  app.get('/me/emojis', async (req) => {
    const rows = all<EmojiRow>(
      'SELECT id, file, name, animated, created_at FROM custom_emojis WHERE owner_id = $me AND removed = 0 ORDER BY id DESC',
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
    return emojiDTO(get<EmojiRow>('SELECT id, file, name, animated, created_at FROM custom_emojis WHERE id = $id', { id })!);
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
