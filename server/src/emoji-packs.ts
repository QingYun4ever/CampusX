/**
 * 随代码带的官方表情包（server/emoji-packs/<slug>/pack.json + 压好的 WebP）。
 *
 * 启动时把还没导入过的包导进来：文件存进 site_uploads（不算谁的额度），表情直接算审核过，导完上架。
 * 导入过（按 slug 认）就不再管：管理员之后增删表情、下架、删除都以数据库为准，不会被重新导回来。
 * 导到一半服务器重启了：包还是 seeding 状态，下次启动删掉重导。
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { get, now, run, tx } from './db.ts';
import { storeSiteUpload } from './site-uploads.ts';

export const seedDir = path.join(import.meta.dirname, '..', 'emoji-packs');

const manifestSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]{2,40}$/),
  name: z.string().min(1).max(20),
  description: z.string().max(100).default(''),
  credit: z.string().max(200).default(''),
  cover: z.string().optional(),
  items: z.array(z.object({
    file: z.string().regex(/^[\w-]{1,40}\.webp$/),
    group: z.string().max(10).default(''),
    animated: z.boolean().default(false),
  })).min(1).max(1000),
});

async function importPack(dir: string) {
  const m = manifestSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, 'pack.json'), 'utf8')));
  const old = get<{ id: number; status: string }>('SELECT id, status FROM emoji_packs WHERE slug = $s', { s: m.slug });
  if (old && old.status !== 'seeding') return false;
  if (old) {
    // 上次没导完：表情和包一起删掉（文件没被用过，会被定时清理回收）
    run('DELETE FROM emoji_packs WHERE id = $id', { id: old.id });
  }
  const t = now();
  const packId = Number(run(
    `INSERT INTO emoji_packs (slug, owner_id, official, name, description, credit, status, listed, created_at, reviewed_at)
     VALUES ($slug, NULL, 1, $name, $desc, $credit, 'seeding', 0, $t, $t)`,
    { slug: m.slug, name: m.name, desc: m.description, credit: m.credit, t },
  ).lastId);
  let cover: string | null = null;
  for (const [i, item] of m.items.entries()) {
    // 让出事件循环：导入大包时别卡住请求
    if (i % 20 === 19) await new Promise((r) => setImmediate(r));
    const buffer = fs.readFileSync(path.join(dir, item.file));
    const name = storeSiteUpload(null, buffer, 'webp').slice('/uploads/'.length);
    tx(() => {
      run('UPDATE site_uploads SET used = 1 WHERE name = $name', { name });
      run(
        `INSERT INTO emoji_pack_items (pack_id, file, grp, animated, reviewed, created_at) VALUES ($p, $f, $g, $a, 1, $t)`,
        { p: packId, f: name, g: item.group, a: item.animated ? 1 : 0, t: now() },
      );
    });
    if (item.file === m.cover) cover = name;
  }
  run("UPDATE emoji_packs SET status = 'ok', listed = 1, cover = $c WHERE id = $id", { id: packId, c: cover });
  return true;
}

export async function seedEmojiPacks() {
  if (!fs.existsSync(seedDir)) return;
  for (const name of fs.readdirSync(seedDir).sort()) {
    const dir = path.join(seedDir, name);
    if (!fs.existsSync(path.join(dir, 'pack.json'))) continue;
    try {
      if (await importPack(dir)) console.log(`[表情包] 已导入官方表情包 ${name}`);
    } catch (e) {
      console.error(`[表情包] 导入 ${name} 失败`, e);
    }
  }
}
