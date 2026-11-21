import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createInvite, formatInvite, hashPassword, normalizeInvite } from '../auth.ts';
import { uploadsDir } from '../config.ts';
import { all, get, now, run } from '../db.ts';
import { configSchema, describeError, getConfig, manualDecision, publicConfig, review, saveConfig, type ModConfig } from '../moderation.ts';
import { postsByIds } from '../serialize.ts';
import { cursorNum, HttpError, me, parse } from '../util.ts';
import { USER_COLS, userById, userPublic } from './users-common.ts';

const MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

function magicOk(buf: Buffer, ext: string) {
  switch (ext) {
    case 'jpg':
      return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    case 'png':
      return buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    case 'gif':
      return buf.subarray(0, 4).toString('latin1') === 'GIF8';
    case 'webp':
      return buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP';
  }
  return false;
}

export async function miscRoutes(app: FastifyInstance) {
  /* ---------- 图片上传 ---------- */
  app.post('/upload', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    me(req);
    const file = await req.file();
    if (!file) throw new HttpError(400, '没有收到文件');
    const ext = MIME[file.mimetype];
    if (!ext) throw new HttpError(400, '只支持 JPG / PNG / WebP / GIF 图片');
    const buf = await file.toBuffer();
    if (!magicOk(buf, ext)) throw new HttpError(400, '文件内容不是有效的图片');
    const name = `${randomBytes(12).toString('base64url')}.${ext}`;
    await fs.writeFile(path.join(uploadsDir, name), buf);
    return { url: `/uploads/${name}` };
  });

  /* ---------- 通知 ---------- */
  app.get('/notifications', async (req) => {
    const user = me(req);
    const q = req.query as { cursor?: string };
    const rows = all(
      `SELECT n.id AS nid, n.type, n.post_id, n.read, n.extra, n.created_at AS n_created_at, ${USER_COLS}
       FROM notifications n JOIN users u ON u.id = n.actor_id
       WHERE n.user_id = $me AND ($cursor IS NULL OR n.id < $cursor)
       ORDER BY n.id DESC LIMIT 30`,
      { me: user.id, cursor: cursorNum(q.cursor) },
    );
    const posts = new Map(
      postsByIds([...new Set(rows.map((r) => r.post_id).filter(Boolean))], user.id).map((p) => [p.id, p]),
    );
    const items = rows
      .map((r) => ({
        id: r.nid as number,
        type: r.type as string,
        read: !!r.read,
        extra: (r.extra as string) ?? '',
        createdAt: r.n_created_at as number,
        actor: userPublic(r),
        post: r.post_id ? (posts.get(r.post_id) ?? null) : null,
      }))
      .filter((n) => !n.post?.deleted && (n.type === 'follow' || n.post));
    return { items, nextCursor: rows.length >= 30 ? String(rows[rows.length - 1].nid) : null };
  });

  /* ---------- 站点概况（右栏：在线、总人数） ---------- */
  const ONLINE_WINDOW = 5 * 60_000;
  app.get('/stats/site', async () => {
    const since = now() - ONLINE_WINDOW;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const n = (sql: string, params: Record<string, number> = {}) => get<{ n: number }>(sql, params)!.n;
    return {
      online: n('SELECT COUNT(*) AS n FROM users WHERE last_seen_at > $s', { s: since }),
      onlineUsers: all(
        `SELECT ${USER_COLS} FROM users u WHERE u.last_seen_at > $s ORDER BY u.last_seen_at DESC LIMIT 10`,
        { s: since },
      ).map(userPublic),
      users: n('SELECT COUNT(*) AS n FROM users'),
      posts: n("SELECT COUNT(*) AS n FROM posts WHERE deleted = 0 AND repost_of IS NULL AND status = 'ok'"),
      postsToday: n(
        "SELECT COUNT(*) AS n FROM posts WHERE deleted = 0 AND repost_of IS NULL AND status = 'ok' AND created_at >= $t",
        { t: today.getTime() },
      ),
      boards: n('SELECT COUNT(*) AS n FROM boards'),
    };
  });

  app.get('/notifications/unread-count', async (req) => {
    const r = get<{ c: number }>('SELECT COUNT(*) AS c FROM notifications WHERE user_id = $me AND read = 0', {
      me: me(req).id,
    });
    return { count: r?.c ?? 0 };
  });

  app.post('/notifications/read-all', async (req) => {
    run('UPDATE notifications SET read = 1 WHERE user_id = $me AND read = 0', { me: me(req).id });
    return { ok: true };
  });

  /* ---------- 管理后台 ---------- */
  app.register(async (admin) => {
    admin.addHook('preHandler', async (req) => {
      if (me(req).role !== 'admin') throw new HttpError(403, '需要管理员权限');
    });

    admin.get('/admin/invites', async () => {
      const rows = all(
        `SELECT i.*, u.username AS creator FROM invites i LEFT JOIN users u ON u.id = i.created_by
         ORDER BY i.created_at DESC LIMIT 200`,
      );
      return rows.map((r) => ({
        code: formatInvite(r.code),
        note: r.note,
        maxUses: r.max_uses,
        usedCount: r.used_count,
        expiresAt: r.expires_at,
        createdAt: r.created_at,
        creator: r.creator ?? null,
      }));
    });

    admin.post('/admin/invites', async (req) => {
      const body = parse(
        z.object({
          maxUses: z.number().int().min(1).max(1000).default(1),
          note: z.string().trim().max(40).default(''),
          expiresDays: z.number().int().min(1).max(365).nullish(),
        }),
        req.body,
      );
      const code = createInvite({ ...body, createdBy: me(req).id });
      return { code: formatInvite(code) };
    });

    admin.delete('/admin/invites/:code', async (req) => {
      run('DELETE FROM invites WHERE code = $c', { c: normalizeInvite((req.params as { code: string }).code) });
      return { ok: true };
    });

    admin.get('/admin/users', async () => {
      const rows = all(`SELECT ${USER_COLS} FROM users u ORDER BY u.id ASC`);
      return rows.map(userPublic);
    });

    admin.patch('/admin/users/:id', async (req) => {
      const id = Number((req.params as { id: string }).id);
      const body = parse(
        z.object({
          role: z.enum(['user', 'admin']).optional(),
          verified: z.boolean().optional(),
          verifiedNote: z.string().trim().max(30, '认证说明最多 30 字').optional(),
        }),
        req.body,
      );
      if (!get('SELECT 1 FROM users WHERE id = $id', { id })) throw new HttpError(404, '用户不存在');
      if (body.role !== undefined) {
        if (id === me(req).id) throw new HttpError(400, '不能修改自己的角色');
        run('UPDATE users SET role = $role WHERE id = $id', { role: body.role, id });
      }
      // 蓝标认证：由管理员手动指定，可以附一句说明（例如「高三(2)班班长」）
      if (body.verified !== undefined) {
        run('UPDATE users SET verified = $v, verified_note = $n WHERE id = $id', {
          v: body.verified,
          n: body.verified ? (body.verifiedNote ?? '') : '',
          id,
        });
      } else if (body.verifiedNote !== undefined) {
        run('UPDATE users SET verified_note = $n WHERE id = $id', { n: body.verifiedNote, id });
      }
      return userById(id);
    });

    /* ---------- AI 审核 ---------- */
    admin.get('/admin/moderation/config', async () => publicConfig());

    admin.put('/admin/moderation/config', async (req) => {
      const raw = (req.body ?? {}) as { apiKey?: unknown; clearKey?: unknown };
      const body = parse(configSchema, req.body);
      const prev = getConfig();
      const next: ModConfig = { ...prev, ...body };
      if (typeof raw.apiKey === 'string' && raw.apiKey.trim()) next.apiKey = raw.apiKey.trim().slice(0, 300);
      if (raw.clearKey === true) next.apiKey = '';
      // 换了接口类型，旧密钥多半不能用
      if (body.provider !== prev.provider && !(typeof raw.apiKey === 'string' && raw.apiKey.trim())) next.apiKey = '';
      saveConfig(next);
      return publicConfig();
    });

    /** 用当前（或表单里还没保存的）配置试审一段文字，不影响任何帖子 */
    admin.post('/admin/moderation/test', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
      const raw = (req.body ?? {}) as { config?: unknown; apiKey?: unknown; text?: unknown };
      const text = typeof raw.text === 'string' ? raw.text.slice(0, 2000) : '';
      const c: ModConfig = { ...getConfig(), ...(raw.config ? parse(configSchema, raw.config) : {}) };
      if (typeof raw.apiKey === 'string' && raw.apiKey.trim()) c.apiKey = raw.apiKey.trim();
      try {
        return { ok: true, result: await review(text || '大家周末有空吗？想约几个老同学一起吃个饭。', [], '', c) };
      } catch (e) {
        return { ok: false, error: describeError(e) };
      }
    });

    admin.get('/admin/moderation/logs', async (req) => {
      const q = req.query as { filter?: string; cursor?: string };
      const filters: Record<string, string> = {
        all: '1',
        block: "l.verdict IN ('block', 'manual_block')",
        error: "l.verdict = 'error'",
        manual: "l.verdict IN ('manual_pass', 'manual_block')",
      };
      if (q.filter === 'pending') {
        // 审核中：直接列帖子（可能还没有任何记录）
        const rows = all(
          `SELECT p.id AS post_id, p.content, p.images, p.status, p.created_at AS post_created_at, ${USER_COLS}
           FROM posts p JOIN users u ON u.id = p.author_id
           WHERE p.status = 'pending' AND p.deleted = 0 AND ($cursor IS NULL OR p.id < $cursor)
           ORDER BY p.id DESC LIMIT 30`,
          { cursor: cursorNum(q.cursor) },
        );
        return {
          items: rows.map((r) => ({
            id: -r.post_id,
            verdict: 'pending',
            category: '',
            reason: '',
            provider: '',
            model: '',
            latencyMs: 0,
            inputTokens: 0,
            outputTokens: 0,
            createdAt: r.post_created_at,
            actor: null,
            post: { id: r.post_id, content: r.content, images: JSON.parse(r.images), status: r.status, author: userPublic(r) },
          })),
          nextCursor: rows.length >= 30 ? String(rows[rows.length - 1].post_id) : null,
        };
      }
      const where = filters[q.filter ?? 'all'] ?? '1';
      const rows = all(
        `SELECT l.*, p.content, p.images, p.status, p.deleted, a.username AS actor_username, ${USER_COLS}
         FROM moderation_logs l
         JOIN posts p ON p.id = l.post_id
         JOIN users u ON u.id = p.author_id
         LEFT JOIN users a ON a.id = l.actor_id
         WHERE ${where} AND ($cursor IS NULL OR l.id < $cursor)
         ORDER BY l.id DESC LIMIT 30`,
        { cursor: cursorNum(q.cursor) },
      );
      return {
        items: rows.map((r) => ({
          id: r.id as number,
          verdict: r.verdict as string,
          category: r.category as string,
          reason: r.reason as string,
          provider: r.provider as string,
          model: r.model as string,
          latencyMs: r.latency_ms as number,
          inputTokens: r.input_tokens as number,
          outputTokens: r.output_tokens as number,
          createdAt: r.created_at as number,
          actor: r.actor_username ?? null,
          post: {
            id: r.post_id as number,
            content: r.content as string,
            images: JSON.parse(r.images) as string[],
            status: r.deleted ? 'deleted' : (r.status as string),
            author: userPublic(r),
          },
        })),
        nextCursor: rows.length >= 30 ? String(rows[rows.length - 1].id) : null,
      };
    });

    admin.post('/admin/posts/:id/moderate', async (req) => {
      const id = Number((req.params as { id: string }).id);
      const body = parse(z.object({ action: z.enum(['approve', 'reject']), note: z.string().max(100).default('') }), req.body);
      const p = get<{ deleted: number }>('SELECT deleted FROM posts WHERE id = $id AND repost_of IS NULL', { id });
      if (!p) throw new HttpError(404, '帖子不存在');
      if (p.deleted) throw new HttpError(400, '帖子已被删除');
      manualDecision(id, body.action, me(req).id, body.note);
      return { ok: true };
    });

    admin.get('/admin/stats', async () => {
      const dayAgo = now() - 86_400_000;
      const n = (sql: string, p = {}) => (get<{ n: number }>(sql, p)?.n ?? 0);
      return {
        users: n('SELECT count(*) AS n FROM users'),
        newUsers: n('SELECT count(*) AS n FROM users WHERE created_at > $t', { t: dayAgo }),
        posts: n("SELECT count(*) AS n FROM posts WHERE deleted = 0 AND repost_of IS NULL AND status = 'ok'"),
        newPosts: n("SELECT count(*) AS n FROM posts WHERE deleted = 0 AND repost_of IS NULL AND status = 'ok' AND created_at > $t", { t: dayAgo }),
        boards: n('SELECT count(*) AS n FROM boards'),
        verified: n('SELECT count(*) AS n FROM users WHERE verified = 1'),
        pending: n("SELECT count(*) AS n FROM posts WHERE status = 'pending' AND deleted = 0"),
        blocked: n("SELECT count(*) AS n FROM moderation_logs WHERE verdict = 'block' AND created_at > $t", { t: dayAgo }),
        moderation: getConfig().enabled,
        invitesLeft: n(
          'SELECT coalesce(sum(max_uses - used_count), 0) AS n FROM invites WHERE used_count < max_uses AND (expires_at IS NULL OR expires_at > $t)',
          { t: now() },
        ),
      };
    });

    // 同学忘记密码时，管理员生成一个临时密码发给他，并让他的所有设备下线
    admin.post('/admin/users/:id/reset-password', async (req) => {
      const id = Number((req.params as { id: string }).id);
      if (id === me(req).id) throw new HttpError(400, '请在设置里修改自己的密码');
      if (!get('SELECT 1 FROM users WHERE id = $id', { id })) throw new HttpError(404, '用户不存在');
      const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
      const password = [...randomBytes(10)].map((b) => alphabet[b % alphabet.length]).join('');
      run('UPDATE users SET password_hash = $h WHERE id = $id', { h: await hashPassword(password), id });
      run('DELETE FROM sessions WHERE user_id = $id', { id });
      return { password };
    });
  });
}
