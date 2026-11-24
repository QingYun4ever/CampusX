// 负载统计：同学端上报请求耗时；管理后台查看
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { all, get } from '../db.ts';
import { config } from '../config.ts';
import { loadSnapshot, recordClient } from '../metrics.ts';
import { HttpError, me, parse } from '../util.ts';
import { videoQueueStats } from '../videos.ts';

const ms = z.number().finite().min(0).max(120_000);
const reportSchema = z.object({
  app: z.boolean(),
  conn: z.string().max(24).regex(/^[\w./ -]*$/).default(''),
  samples: z.array(z.object({ d: ms, s: ms.nullable() })).max(60),
  fail: z.number().int().min(0).max(60).default(0),
  page: ms.optional(),
});

function fileSize(file: string) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

export async function loadRoutes(app: FastifyInstance) {
  app.post('/metrics/client', { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async (req) => {
    const r = parse(reportSchema, req.body);
    recordClient(me(req).id, r);
    return { ok: true };
  });

  app.get('/admin/load', async (req) => {
    if (me(req).role !== 'admin') throw new HttpError(403, '需要管理员权限');
    const { range } = parse(z.object({ range: z.coerce.number().int().pipe(z.union([z.literal(60), z.literal(360)])).default(60) }), req.query);
    const snap = loadSnapshot(range);
    const ids = snap.users.map((u) => u.id);
    const names = new Map(
      ids.length
        ? all<{ id: number; username: string; display_name: string }>(
            `SELECT id, username, display_name FROM users WHERE id IN (${ids.map((_, i) => `$u${i}`).join(',')})`,
            Object.fromEntries(ids.map((id, i) => [`u${i}`, id])),
          ).map((u) => [u.id, u])
        : [],
    );
    const dbFile = path.join(config.dataDir, 'forum.db');
    return {
      ...snap,
      users: snap.users.map((u) => ({ ...u, username: names.get(u.id)?.username ?? '', displayName: names.get(u.id)?.display_name ?? '' })),
      queues: {
        ...videoQueueStats(),
        moderation: get<{ n: number }>("SELECT COUNT(*) AS n FROM posts WHERE status = 'pending' AND deleted = 0")!.n,
      },
      dbBytes: fileSize(dbFile) + fileSize(`${dbFile}-wal`),
    };
  });
}
