// 在线备份数据库及私信图片（网站不用停）：npm run backup -w server -- --keep 14
// DATA_DIR/backups 下同名的 .db、.key 和 .dm-uploads 要一同保存。普通上传仍需另行复制。
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { backup, DatabaseSync } from 'node:sqlite';
import { accountSecurityKeyPath, config } from '../config.ts';

const { values } = parseArgs({ options: { keep: { type: 'string', default: '14' } } });
const src = path.join(config.dataDir, 'forum.db');
if (!fs.existsSync(src)) {
  console.error(`找不到数据库：${src}`);
  process.exit(1);
}
const dir = path.join(config.dataDir, 'backups');
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').replace('.', '-').slice(0, 19);
const stem = `forum-${stamp}-${process.pid}`;
const out = path.join(dir, `${stem}.db`);
const stage = fs.mkdtempSync(path.join(dir, '.backup-'));
const snapshot = path.join(stage, `${stem}.db`);
const sidecars: string[] = [];
const published: string[] = [];
try {
  const db = new DatabaseSync(src, { readOnly: true });
  try {
    await backup(db, snapshot);
  } finally {
    db.close();
  }
  fs.chmodSync(snapshot, 0o600);

  const saved = new DatabaseSync(snapshot, { readOnly: true });
  try {
    const hasTable = saved.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?");
    const needsKey = hasTable.get('account_security') && (
      saved.prepare('SELECT 1 FROM account_security WHERE totp_secret IS NOT NULL LIMIT 1').get()
      || saved.prepare('SELECT 1 FROM account_totp_setup LIMIT 1').get()
      || saved.prepare('SELECT 1 FROM account_email_pending LIMIT 1').get()
    );
    if (fs.existsSync(accountSecurityKeyPath)) {
      const file = `${stem}.key`;
      const fd = fs.openSync(accountSecurityKeyPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size !== 32) {
          throw new Error('账号安全密钥文件无效或权限不安全，无法备份');
        }
        fs.writeFileSync(path.join(stage, file), fs.readFileSync(fd), { mode: 0o600, flush: true });
      } finally {
        fs.closeSync(fd);
      }
      sidecars.push(file);
    } else if (needsKey) {
      throw new Error('账号安全密钥缺失，无法完成备份');
    }

    if (hasTable.get('dm_message_images')) {
      const folder = `${stem}.dm-uploads`;
      const images = path.join(stage, folder);
      const source = path.join(config.dataDir, 'dm-uploads');
      for (const row of saved.prepare('SELECT filename FROM dm_message_images').iterate()) {
        const filename = row.filename;
        if (typeof filename !== 'string' || !filename || path.basename(filename) !== filename || ['.', '..'].includes(filename)) {
          throw new Error('私信图片文件名无效，无法完成备份');
        }
        if (!fs.existsSync(images)) {
          fs.mkdirSync(images, { mode: 0o700 });
          sidecars.push(folder);
        }
        const dest = path.join(images, filename);
        try {
          const sourceFile = path.join(source, filename);
          if (!fs.lstatSync(sourceFile).isFile()) throw new Error();
          fs.copyFileSync(sourceFile, dest);
          fs.chmodSync(dest, 0o600);
        } catch {
          throw new Error('私信图片缺失或无法读取，未发布不完整的备份');
        }
      }
    }
  } finally {
    saved.close();
  }

  // 先发布附属文件，最后发布数据库；可见的数据库备份都有配套文件。
  for (const file of sidecars) {
    const dest = path.join(dir, file);
    fs.renameSync(path.join(stage, file), dest);
    published.push(dest);
  }
  fs.renameSync(snapshot, out);
} catch (error) {
  for (const file of published) fs.rmSync(file, { recursive: true, force: true });
  throw error;
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
console.log(`已备份到 ${out}（${(fs.statSync(out).size / 1024).toFixed(0)} KB）`);

const keep = Math.max(1, Number(values.keep) || 14);
const old = fs
  .readdirSync(dir)
  .filter((f) => /^forum-\d{8}-\d{6}(?:-\d{3}-\d+)?\.db$/.test(f))
  .sort()
  .reverse()
  .slice(keep);
for (const f of old) {
  const stem = path.join(dir, f.slice(0, -3));
  fs.rmSync(path.join(dir, f));
  fs.rmSync(`${stem}.key`, { force: true });
  fs.rmSync(`${stem}.dm-uploads`, { recursive: true, force: true });
}
if (old.length) console.log(`删除了 ${old.length} 份旧备份`);
