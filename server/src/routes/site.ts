/**
 * 站点级：维护模式、公告。
 * - 维护模式：管理员开启后，除管理员以外的人调用接口都拿到 503 + 维护说明，前端显示维护页直到解除。
 *   登录接口照常开放，管理员才能登进来解除。
 * - 公告：比如学生会活动。启动时显示在首页顶部（可关闭，不是置顶帖），App 会推送一次。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { all, db, get, now, run } from '../db.ts';
import { HttpError, me, parse } from '../util.ts';

/* ---------------- 维护模式 ---------------- */

export interface Maintenance {
  enabled: boolean;
  message: string;
  /** 预计结束时间（只用来显示），可以不填 */
  until: number | null;
  since: number | null;
}

const DEFAULT_MESSAGE = '校墙正在维护，暂时不能使用。很快回来，请稍后再试。';
let cache: Maintenance | null = null;

export function getMaintenance(): Maintenance {
  if (cache) return cache;
  const row = get<{ value: string }>("SELECT value FROM settings WHERE key = 'maintenance'");
  let m: Maintenance = { enabled: false, message: DEFAULT_MESSAGE, until: null, since: null };
  try {
    if (row) m = { ...m, ...JSON.parse(row.value) };
  } catch {
    /* 用默认值 */
  }
  cache = m;
  return m;
}

function saveMaintenance(m: Maintenance) {
  run("INSERT INTO settings (key, value) VALUES ('maintenance', $v) ON CONFLICT(key) DO UPDATE SET value = $v", { v: JSON.stringify(m) });
  cache = m;
}

export const publicMaintenance = (m = getMaintenance()) =>
  m.enabled ? { message: m.message || DEFAULT_MESSAGE, until: m.until, since: m.since } : null;

/** 维护期间仍然开放的接口：看状态、登录（管理员要能登进来） */
const MAINTENANCE_OPEN = new Set([
  '/api/status',
  '/api/health',
  '/api/captcha',
  '/api/auth/login',
  '/api/auth/login/2fa',
  '/api/auth/logout',
  '/api/app/latest',
]);

/** 在 preHandler 里调用：维护中、不是管理员，就拒绝 */
export function checkMaintenance(req: FastifyRequest) {
  const m = getMaintenance();
  if (!m.enabled) return;
  const url = req.url.split('?')[0];
  if (!url.startsWith('/api/') || MAINTENANCE_OPEN.has(url)) return;
  if (req.user?.role === 'admin') return;
  throw new HttpError(503, m.message || DEFAULT_MESSAGE, { maintenance: publicMaintenance(m) });
}

/* ---------------- 公告 ---------------- */

db.exec(`
CREATE TABLE IF NOT EXISTS announcements (
  id         INTEGER PRIMARY KEY,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  link       TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  ended      INTEGER NOT NULL DEFAULT 0
);
`);

const announcementSchema = z.object({
  title: z.string().trim().min(1, '请填写标题').max(40, '标题最多 40 字'),
  body: z.string().trim().max(500, '内容最多 500 字').default(''),
  // 站内路径（/post/123、/b/xxx）或 http(s) 链接
  link: z
    .string()
    .trim()
    .max(300)
    .refine((v) => !v || /^\/[^/]/.test(v) || /^https?:\/\//.test(v), '链接要以 / 或 http(s):// 开头')
    .default(''),
  days: z.number().int().min(1).max(60).default(7),
});

type AnnRow = { id: number; title: string; body: string; link: string; created_at: number; expires_at: number | null; ended: number; author: string | null };
const annDTO = (r: AnnRow) => ({
  id: r.id,
  title: r.title,
  body: r.body,
  link: r.link,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  active: !r.ended && (r.expires_at === null || r.expires_at > now()),
  author: r.author,
});

const ANN_SELECT = `SELECT a.*, u.display_name AS author FROM announcements a LEFT JOIN users u ON u.id = a.created_by`;

export function activeAnnouncements(limit = 3) {
  return all<AnnRow>(
    `${ANN_SELECT} WHERE a.ended = 0 AND (a.expires_at IS NULL OR a.expires_at > $t) ORDER BY a.id DESC LIMIT $limit`,
    { t: now(), limit },
  ).map(annDTO);
}

/** 推送用：这段时间里新发的公告 */
export function announcementsSince(from: number) {
  return all<AnnRow>(
    `${ANN_SELECT} WHERE a.ended = 0 AND a.created_at > $from AND (a.expires_at IS NULL OR a.expires_at > $t) ORDER BY a.id DESC LIMIT 3`,
    { from, t: now() },
  ).map(annDTO);
}

export async function siteRoutes(app: FastifyInstance) {
  /** 不用登录：维护状态。前端在维护页上轮询它，解除后自动恢复 */
  app.get('/status', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { maintenance: publicMaintenance(), now: now() };
  });

  app.get('/announcements', async () => activeAnnouncements());

  app.register(async (admin) => {
    admin.addHook('preHandler', async (req) => {
      if (me(req).role !== 'admin') throw new HttpError(403, '需要管理员权限');
    });

    admin.get('/admin/maintenance', async () => getMaintenance());

    admin.put('/admin/maintenance', async (req) => {
      const body = parse(
        z.object({
          enabled: z.boolean(),
          message: z.string().trim().max(500, '维护说明最多 500 字'),
          until: z.number().int().positive().nullable().default(null),
        }),
        req.body,
      );
      const prev = getMaintenance();
      saveMaintenance({
        enabled: body.enabled,
        message: body.message || DEFAULT_MESSAGE,
        until: body.enabled ? body.until : null,
        since: body.enabled ? (prev.enabled ? prev.since : now()) : null,
      });
      return getMaintenance();
    });

    admin.get('/admin/announcements', async () =>
      all<AnnRow>(`${ANN_SELECT} ORDER BY a.id DESC LIMIT 50`).map(annDTO),
    );

    admin.post('/admin/announcements', async (req) => {
      const body = parse(announcementSchema, req.body);
      const t = now();
      const { lastId } = run(
        `INSERT INTO announcements (title, body, link, created_by, created_at, expires_at)
         VALUES ($title, $body, $link, $by, $t, $exp)`,
        { title: body.title, body: body.body, link: body.link, by: me(req).id, t, exp: t + body.days * 86_400_000 },
      );
      return annDTO(get<AnnRow>(`${ANN_SELECT} WHERE a.id = $id`, { id: lastId })!);
    });

    /** 提前结束（不删除，留个记录） */
    admin.post('/admin/announcements/:id/end', async (req) => {
      const r = run('UPDATE announcements SET ended = 1 WHERE id = $id', { id: Number((req.params as { id: string }).id) });
      if (!r.changes) throw new HttpError(404, '公告不存在');
      return { ok: true };
    });

    admin.delete('/admin/announcements/:id', async (req) => {
      run('DELETE FROM announcements WHERE id = $id', { id: Number((req.params as { id: string }).id) });
      return { ok: true };
    });
  });
}
