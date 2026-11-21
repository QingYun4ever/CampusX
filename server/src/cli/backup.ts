// 在线备份数据库（网站不用停）：npm run backup -w server -- --keep 14
// 备份文件放在 DATA_DIR/backups/forum-时间.db，默认保留最近 14 份。图片在 DATA_DIR/uploads，另行复制。
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { backup, DatabaseSync } from 'node:sqlite';
import { config } from '../config.ts';

const { values } = parseArgs({ options: { keep: { type: 'string', default: '14' } } });
const src = path.join(config.dataDir, 'forum.db');
if (!fs.existsSync(src)) {
  console.error(`找不到数据库：${src}`);
  process.exit(1);
}
const dir = path.join(config.dataDir, 'backups');
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const out = path.join(dir, `forum-${stamp}.db`);

const db = new DatabaseSync(src, { readOnly: true });
await backup(db, out);
db.close();
console.log(`已备份到 ${out}（${(fs.statSync(out).size / 1024).toFixed(0)} KB）`);

const keep = Math.max(1, Number(values.keep) || 14);
const old = fs
  .readdirSync(dir)
  .filter((f) => /^forum-\d{8}-\d{6}\.db$/.test(f))
  .sort()
  .reverse()
  .slice(keep);
for (const f of old) fs.rmSync(path.join(dir, f));
if (old.length) console.log(`删除了 ${old.length} 份旧备份`);
