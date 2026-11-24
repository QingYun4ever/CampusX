import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync, type SQLInputValue } from 'node:sqlite';
import { config, uploadsDir } from './config.ts';
import { recordQuery } from './metrics.ts';

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(uploadsDir, { recursive: true });

export const db = new DatabaseSync(path.join(config.dataDir, 'forum.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  bio           TEXT NOT NULL DEFAULT '',
  avatar        TEXT,
  banner        TEXT,
  class_name    TEXT NOT NULL DEFAULT '',
  grad_year     INTEGER,
  role          TEXT NOT NULL DEFAULT 'user',
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS invites (
  code       TEXT PRIMARY KEY,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  note       TEXT NOT NULL DEFAULT '',
  max_uses   INTEGER NOT NULL DEFAULT 1,
  used_count INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bootstrap_admin_invite (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  code_hash  TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Retire unused legacy bootstrap invites that were printed in server logs.
DELETE FROM invites WHERE created_by IS NULL AND note = '初始管理员' AND max_uses = 1 AND used_count = 0;

CREATE TABLE IF NOT EXISTS boards (
  id          INTEGER PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon        TEXT NOT NULL DEFAULT '💬',
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS board_members (
  board_id   INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (board_id, user_id)
);

CREATE TABLE IF NOT EXISTS posts (
  id               INTEGER PRIMARY KEY,
  author_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  board_id         INTEGER REFERENCES boards(id) ON DELETE SET NULL,
  parent_id        INTEGER REFERENCES posts(id) ON DELETE SET NULL,
  root_id          INTEGER REFERENCES posts(id) ON DELETE SET NULL,
  repost_of        INTEGER REFERENCES posts(id) ON DELETE CASCADE,
  content          TEXT NOT NULL DEFAULT '',
  images           TEXT NOT NULL DEFAULT '[]',
  like_count       INTEGER NOT NULL DEFAULT 0,
  reply_count      INTEGER NOT NULL DEFAULT 0,
  repost_count     INTEGER NOT NULL DEFAULT 0,
  deleted          INTEGER NOT NULL DEFAULT 0,
  last_activity_at INTEGER NOT NULL,
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_author   ON posts(author_id, id);
CREATE INDEX IF NOT EXISTS idx_posts_board    ON posts(board_id, last_activity_at, id);
CREATE INDEX IF NOT EXISTS idx_posts_parent   ON posts(parent_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_repost ON posts(repost_of, author_id) WHERE repost_of IS NOT NULL;

CREATE TABLE IF NOT EXISTS post_quotes (
  post_id   INTEGER PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
  quoted_id INTEGER REFERENCES posts(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_post_quotes_source ON post_quotes(quoted_id);

CREATE TABLE IF NOT EXISTS likes (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, post_id)
);
CREATE INDEX IF NOT EXISTS idx_likes_post ON likes(post_id);

CREATE TABLE IF NOT EXISTS follows (
  follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (follower_id, followee_id)
);
CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows(followee_id);

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,            -- like | reply | repost | quote | follow | mention | reaction
  post_id    INTEGER REFERENCES posts(id) ON DELETE CASCADE,
  read       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, id);
`);

type Params = Record<string, unknown>;

const cache = new Map<string, StatementSync>();
function stmt(sql: string): StatementSync {
  let s = cache.get(sql);
  if (!s) {
    s = db.prepare(sql);
    cache.set(sql, s);
  }
  return s;
}

/** node:sqlite 不接受多余的命名参数，这里只挑出 SQL 中出现的 $name。 */
function pick(sql: string, params: Params): Record<string, SQLInputValue> {
  const out: Record<string, SQLInputValue> = {};
  for (const m of sql.matchAll(/\$(\w+)/g)) {
    const k = m[1];
    if (k in out) continue;
    const v = params[k];
    out[k] = v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : (v as SQLInputValue);
  }
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;

/** 记下每条 SQL 花了多久（负载统计用） */
function timed<T>(sql: string, fn: () => T): T {
  const t = performance.now();
  try {
    return fn();
  } finally {
    recordQuery(sql, performance.now() - t);
  }
}

export function all<T = Row>(sql: string, params: Params = {}): T[] {
  return timed(sql, () => stmt(sql).all(pick(sql, params)) as T[]);
}
export function get<T = Row>(sql: string, params: Params = {}): T | undefined {
  return timed(sql, () => stmt(sql).get(pick(sql, params)) as T | undefined);
}
export function run(sql: string, params: Params = {}) {
  const r = timed(sql, () => stmt(sql).run(pick(sql, params)));
  return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
}

export function tx<T>(fn: () => T): T {
  // 等写锁的时间也记下来（别的连接，比如备份，占着锁时会卡在这里）
  timed('BEGIN IMMEDIATE', () => db.exec('BEGIN IMMEDIATE'));
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export const now = () => Date.now();

// 增量迁移：给老数据库补上后来加的列
function addColumn(table: string, col: string, def: string) {
  const cols = all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name);
  if (cols.includes(col)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  return true;
}
addColumn('users', 'verified', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'verified_note', "TEXT NOT NULL DEFAULT ''");
addColumn('users', 'avatar_decoration', "TEXT NOT NULL DEFAULT ''");
// 内容没通过审核的次数，每次都会给本人发警告通知
addColumn('users', 'mod_warnings', 'INTEGER NOT NULL DEFAULT 0');
// 同意的用户协议版本（0 = 还没同意过）和时间，见 TERMS_VERSION
addColumn('users', 'terms_version', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'terms_accepted_at', 'INTEGER');

// 书签：只有自己看得到，原帖删掉就跟着没了
db.exec(`
CREATE TABLE IF NOT EXISTS bookmarks (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, post_id)
);
CREATE INDEX IF NOT EXISTS idx_bookmarks_user ON bookmarks(user_id, created_at);
`);
// 审核状态：ok 公开；pending 审核中（只有作者看得到）；rejected 未通过（不发布，只留给管理员复核）
addColumn('posts', 'status', "TEXT NOT NULL DEFAULT 'ok'");
// 在线状态：最近一次请求的时间（每分钟最多写一次）
addColumn('users', 'last_seen_at', 'INTEGER');
// 吧主、公告、置顶
if (addColumn('boards', 'owner_id', 'INTEGER REFERENCES users(id) ON DELETE SET NULL')) {
  db.exec('UPDATE boards SET owner_id = created_by');
}
addColumn('boards', 'announcement', "TEXT NOT NULL DEFAULT ''");
addColumn('boards', 'announcement_at', 'INTEGER');
addColumn('boards', 'announcement_by', 'INTEGER REFERENCES users(id) ON DELETE SET NULL');
addColumn('boards', 'avatar', 'TEXT');
addColumn('posts', 'pinned_at', 'INTEGER');
// 通知的附加信息（例如表情回应用的哪个表情）
addColumn('notifications', 'extra', "TEXT NOT NULL DEFAULT ''");

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS moderation_logs (
  id            INTEGER PRIMARY KEY,
  post_id       INTEGER REFERENCES posts(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  verdict       TEXT NOT NULL,          -- pass / block / error / manual_pass / manual_block
  category      TEXT NOT NULL DEFAULT '',
  reason        TEXT NOT NULL DEFAULT '',
  latency_ms    INTEGER NOT NULL DEFAULT 0,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  actor_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_modlogs_post ON moderation_logs(post_id, id);
CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status) WHERE status != 'ok';

CREATE TABLE IF NOT EXISTS post_tags (
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  tag     TEXT NOT NULL,
  PRIMARY KEY (post_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_post_tags_tag ON post_tags(tag, post_id);

CREATE TABLE IF NOT EXISTS reactions (
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, user_id, emoji)
);

-- 吧务（小吧主）。吧主记在 boards.owner_id
CREATE TABLE IF NOT EXISTS board_mods (
  board_id   INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (board_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_board_mods_user ON board_mods(user_id);
CREATE INDEX IF NOT EXISTS idx_posts_pinned ON posts(board_id, pinned_at) WHERE pinned_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_seen ON users(last_seen_at);

-- 浏览：每人每帖记一次（作者自己也算）
CREATE TABLE IF NOT EXISTS post_views (
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, user_id)
) WITHOUT ROWID;

-- 私信
CREATE TABLE IF NOT EXISTS dm_messages (
  id           INTEGER PRIMARY KEY,
  sender_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content      TEXT NOT NULL,
  deleted      INTEGER NOT NULL DEFAULT 0,
  read_at      INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dm_pair ON dm_messages(sender_id, recipient_id, id);
CREATE INDEX IF NOT EXISTS idx_dm_pair2 ON dm_messages(recipient_id, sender_id, id);
CREATE TABLE IF NOT EXISTS dm_message_images (
  message_id INTEGER NOT NULL REFERENCES dm_messages(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL,
  filename   TEXT NOT NULL UNIQUE,
  PRIMARY KEY (message_id, position)
);
-- 私密吧：吧主指定的可见成员（吧主、吧务、站点管理员始终可见）
CREATE TABLE IF NOT EXISTS board_viewers (
  board_id   INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (board_id, user_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_board_viewers_user ON board_viewers(user_id);
CREATE INDEX IF NOT EXISTS idx_dm_unread ON dm_messages(recipient_id, read_at) WHERE read_at IS NULL;
`);
addColumn('posts', 'view_count', 'INTEGER NOT NULL DEFAULT 0');
addColumn('boards', 'visibility', "TEXT NOT NULL DEFAULT 'public'");

db.exec(`
CREATE TABLE IF NOT EXISTS account_security (
  user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email         TEXT,
  totp_secret   TEXT,
  last_totp_step INTEGER
);
CREATE TABLE IF NOT EXISTS account_recovery_codes (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  PRIMARY KEY (user_id, code_hash)
);
CREATE TABLE IF NOT EXISTS account_totp_setup (
  user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
  secret       TEXT NOT NULL,
  expires_at   INTEGER NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS account_email_pending (
  user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
  email        TEXT NOT NULL,
  code_hash    TEXT NOT NULL,
  expires_at   INTEGER NOT NULL,
  resend_at    INTEGER NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS account_login_challenges (
  user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  challenge_hash TEXT NOT NULL UNIQUE,
  expires_at    INTEGER NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0
);
CREATE TRIGGER IF NOT EXISTS account_password_changed AFTER UPDATE OF password_hash ON users
WHEN OLD.password_hash <> NEW.password_hash
BEGIN
  DELETE FROM account_login_challenges WHERE user_id = NEW.id;
  DELETE FROM account_totp_setup WHERE user_id = NEW.id;
  DELETE FROM account_email_pending WHERE user_id = NEW.id;
END;
`);

// 表情回应从 GitHub 式的 8 个英文 key 换成 Telegram 式的 emoji，并且每人每帖只保留一个
{
  const OLD: Record<string, string> = {
    '+1': '👍', '-1': '👎', laugh: '😁', hooray: '🎉', confused: '🤔', heart: '❤️', rocket: '🔥', eyes: '👀',
  };
  if (get(`SELECT 1 FROM reactions WHERE emoji IN (${Object.keys(OLD).map((k) => `'${k}'`).join(',')}) LIMIT 1`)) {
    tx(() => {
      for (const [k, v] of Object.entries(OLD)) {
        run('UPDATE OR IGNORE reactions SET emoji = $v WHERE emoji = $k', { k, v });
        run('DELETE FROM reactions WHERE emoji = $k', { k });
      }
      run(`DELETE FROM reactions WHERE rowid NOT IN (
             SELECT rowid FROM (SELECT rowid, ROW_NUMBER() OVER (PARTITION BY post_id, user_id ORDER BY created_at DESC) AS rn FROM reactions) WHERE rn = 1)`);
    });
  }
}

// 首次启动：建几个默认的吧
if (!get('SELECT 1 FROM boards LIMIT 1')) {
  const defaults = [
    ['chat', '灌水闲聊', '随便聊', '💬'],
    ['memories', '青春回忆', '老照片和以前的事', '📸'],
    ['news', '同学近况', '升学、工作、搬家，最近在忙什么', '🎓'],
    ['help', '互助求助', '找资料、问经验、内推、租房', '🤝'],
  ];
  for (const [slug, name, description, icon] of defaults) {
    run(
      'INSERT INTO boards (slug, name, description, icon, created_at) VALUES ($slug, $name, $description, $icon, $now)',
      { slug, name, description, icon, now: now() },
    );
  }
}

db.exec(`
CREATE TABLE IF NOT EXISTS site_uploads (
  name       TEXT PRIMARY KEY,
  owner_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  size       INTEGER NOT NULL,
  charge     INTEGER GENERATED ALWAYS AS (max(4096, 2 * size)) STORED,
  created_at INTEGER NOT NULL,
  hold_until INTEGER NOT NULL DEFAULT 0,
  used       INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_site_uploads_owner ON site_uploads(owner_id);

CREATE TABLE IF NOT EXISTS site_upload_usage (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  bytes INTEGER NOT NULL
);
INSERT OR IGNORE INTO site_upload_usage (id, bytes) VALUES (1, 0);
CREATE TRIGGER IF NOT EXISTS site_upload_charge_insert AFTER INSERT ON site_uploads BEGIN
  UPDATE site_upload_usage SET bytes = bytes + NEW.charge WHERE id = 1;
END;
CREATE TRIGGER IF NOT EXISTS site_upload_charge_update AFTER UPDATE OF size ON site_uploads BEGIN
  UPDATE site_upload_usage SET bytes = bytes + NEW.charge - OLD.charge WHERE id = 1;
END;
CREATE TRIGGER IF NOT EXISTS site_upload_charge_delete AFTER DELETE ON site_uploads BEGIN
  UPDATE site_upload_usage SET bytes = bytes - OLD.charge WHERE id = 1;
END;

CREATE INDEX IF NOT EXISTS idx_users_avatar ON users(avatar) WHERE avatar IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_banner ON users(banner) WHERE banner IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_boards_avatar ON boards(avatar) WHERE avatar IS NOT NULL;

CREATE TABLE IF NOT EXISTS post_upload_refs (
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  url     TEXT NOT NULL,
  PRIMARY KEY (post_id, url)
);
CREATE INDEX IF NOT EXISTS idx_post_upload_refs_url ON post_upload_refs(url);
CREATE TRIGGER IF NOT EXISTS post_upload_refs_insert AFTER INSERT ON posts BEGIN
  INSERT OR IGNORE INTO post_upload_refs (post_id, url)
    SELECT NEW.id, j.value FROM json_each(NEW.images) j WHERE j.type = 'text' AND j.value LIKE '/uploads/%';
END;
CREATE TRIGGER IF NOT EXISTS post_upload_refs_update AFTER UPDATE OF images ON posts BEGIN
  DELETE FROM post_upload_refs WHERE post_id = NEW.id;
  INSERT OR IGNORE INTO post_upload_refs (post_id, url)
    SELECT NEW.id, j.value FROM json_each(NEW.images) j WHERE j.type = 'text' AND j.value LIKE '/uploads/%';
END;
`);

tx(() => {
  if (get("SELECT 1 FROM settings WHERE key = 'post_upload_refs_indexed'")) return;
  run(`INSERT OR IGNORE INTO post_upload_refs (post_id, url)
       SELECT p.id, j.value FROM posts p, json_each(CASE WHEN json_valid(p.images) THEN p.images ELSE '[]' END) j
       WHERE j.type = 'text' AND j.value LIKE '/uploads/%'`);
  run("INSERT INTO settings (key, value) VALUES ('post_upload_refs_indexed', '1')");
});

/* ---------------- 吧内等级（贴吧式） ---------------- */
// 每人在每个吧的经验和签到；退出吧不清空，重新加入就恢复
db.exec(`
CREATE TABLE IF NOT EXISTS board_exp (
  board_id      INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  exp           INTEGER NOT NULL DEFAULT 0,
  checkin_day   TEXT,
  streak        INTEGER NOT NULL DEFAULT 0,
  checkin_total INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (board_id, user_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_board_exp_rank ON board_exp(board_id, exp DESC);
CREATE INDEX IF NOT EXISTS idx_board_exp_user ON board_exp(user_id, exp DESC);

-- 经验流水：算每天上限、删帖时扣回。day 是北京时间的日期
CREATE TABLE IF NOT EXISTS exp_log (
  id         INTEGER PRIMARY KEY,
  board_id   INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  ref        TEXT NOT NULL,
  delta      INTEGER NOT NULL,
  day        TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_exp_log_ref ON exp_log(board_id, user_id, kind, ref);
CREATE INDEX IF NOT EXISTS idx_exp_log_day ON exp_log(board_id, user_id, day, kind);
`);
// 吧主自定义的 18 个等级头衔（JSON 数组，空字符串的位置用默认头衔）
addColumn('boards', 'level_titles', "TEXT NOT NULL DEFAULT '[]'");

/* ---------------- 拉黑、举报、自定义表情 ---------------- */
db.exec(`
-- blocker 拉黑了 blocked：互相取关；blocked 不能回复、赞、转发 blocker 的帖子，不能关注、私信 blocker；
-- blocker 的时间线、吧、搜索里看不到 blocked 的帖子，也收不到 blocked 的通知
CREATE TABLE IF NOT EXISTS blocks (
  blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON blocks(blocked_id);

`);

/* ---------------- 举报 ---------------- */
tx(() => {
  const legacy = all<{ name: string }>('PRAGMA table_info(reports)').some((c) => c.name === 'target_type');
  if (legacy) db.exec('ALTER TABLE reports RENAME TO legacy_reports');

  db.exec(`
CREATE TABLE IF NOT EXISTS report_batches (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL,
  target_id   INTEGER NOT NULL,
  author_id   INTEGER, -- 原目标作者；硬删除后仍用来限制管理员权限。NULL 表示原目标无法确认
  detached    INTEGER NOT NULL DEFAULT 0,
  revision    INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'open',
  handled_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  handled_at  INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_report_batches_open
  ON report_batches(target_type, target_id) WHERE status = 'open' AND detached = 0;
CREATE INDEX IF NOT EXISTS idx_report_batches_target ON report_batches(target_type, target_id);

CREATE TABLE IF NOT EXISTS reports (
  id          INTEGER PRIMARY KEY,
  batch_id    INTEGER NOT NULL REFERENCES report_batches(id),
  reporter_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason      TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_batch_reporter ON reports(batch_id, reporter_id);
`);

  if (legacy) {
    // 老举报只保存了可复用的数字 ID，不能安全地关联到当前同 ID 的用户或帖子。
    db.exec(`
INSERT INTO report_batches (target_type, target_id, detached, status, handled_by, handled_at)
  SELECT target_type, target_id, 1, status, handled_by, handled_at FROM legacy_reports
  GROUP BY target_type, target_id, status, handled_by, handled_at;
INSERT INTO reports (id, batch_id, reporter_id, reason, note, created_at)
  SELECT r.id, b.id, r.reporter_id, r.reason, r.note, r.created_at
  FROM legacy_reports r JOIN report_batches b ON b.target_type = r.target_type AND b.target_id = r.target_id
    AND b.status = r.status AND b.handled_by IS r.handled_by AND b.handled_at IS r.handled_at;
DROP TABLE legacy_reports;
`);
  }

  db.exec(`
CREATE TRIGGER IF NOT EXISTS report_added AFTER INSERT ON reports BEGIN
  UPDATE report_batches SET revision = revision + 1 WHERE id = NEW.batch_id;
END;
CREATE TRIGGER IF NOT EXISTS report_removed AFTER DELETE ON reports BEGIN
  UPDATE report_batches SET revision = revision + 1 WHERE id = OLD.batch_id;
END;
CREATE TRIGGER IF NOT EXISTS report_reporter_removed AFTER UPDATE OF reporter_id ON reports BEGIN
  UPDATE report_batches SET revision = revision + 1 WHERE id = NEW.batch_id;
END;

-- 硬删不仅来自路由，也可能来自外键级联（例如原帖被硬删时的转发行）。
CREATE TRIGGER IF NOT EXISTS report_post_detached AFTER DELETE ON posts BEGIN
  UPDATE report_batches SET detached = 1, revision = revision + 1
    WHERE target_type = 'post' AND target_id = OLD.id AND detached = 0;
END;
CREATE TRIGGER IF NOT EXISTS report_post_soft_deleted AFTER UPDATE OF deleted ON posts WHEN NEW.deleted <> OLD.deleted BEGIN
  UPDATE report_batches SET revision = revision + 1
    WHERE target_type = 'post' AND target_id = OLD.id AND detached = 0 AND status = 'open';
END;
CREATE TRIGGER IF NOT EXISTS report_user_detached AFTER DELETE ON users BEGIN
  UPDATE report_batches SET detached = 1, revision = revision + 1
    WHERE target_type = 'user' AND target_id = OLD.id AND detached = 0;
END;

-- 转发行删除后，清掉它在原帖上的计数与通知；原帖若也被硬删，通知由外键清理。
CREATE TRIGGER IF NOT EXISTS repost_removed AFTER DELETE ON posts WHEN OLD.repost_of IS NOT NULL BEGIN
  UPDATE posts SET repost_count = MAX(repost_count - 1, 0) WHERE id = OLD.repost_of;
  DELETE FROM notifications WHERE type = 'repost' AND post_id = OLD.repost_of AND actor_id = OLD.author_id
    AND user_id = (SELECT author_id FROM posts WHERE id = OLD.repost_of);
END;
`);
});

db.exec(`
-- 自定义表情：图片存在 site_uploads 里（file 是不带 /uploads/ 的文件名）。
-- 删除只是从自己的表情里移除（removed = 1），文件保留，已经发出去的帖子和私信还能显示
CREATE TABLE IF NOT EXISTS custom_emojis (
  id         INTEGER PRIMARY KEY,
  owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL DEFAULT '',
  animated   INTEGER NOT NULL DEFAULT 0,
  removed    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_custom_emojis_owner ON custom_emojis(owner_id, removed, id);
`);
// sent = 1：发到过帖子或私信里。移除了又没发过的表情，文件可以清理掉，释放图片空间
if (addColumn('custom_emojis', 'sent', 'INTEGER NOT NULL DEFAULT 0')) {
  // 老数据不知道发没发过，保守地都当作发过
  run('UPDATE custom_emojis SET sent = 1');
}
// origin：从别人那里收藏来的表情，记下最初的文件，避免同一个表情重复收藏
addColumn('custom_emojis', 'origin', 'TEXT');

db.exec(`
-- 表情包：官方包（official = 1，管理员维护）和同学自己做的包（审核通过才上架）。
-- 不硬删：删包只是 status = 'deleted'、表情标成 removed，发出去过的表情文件还要留着显示。
-- AUTOINCREMENT：ID 不复用，免得旧的安装记录、通知指到新包上
CREATE TABLE IF NOT EXISTS emoji_packs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT UNIQUE,              -- 随代码分发的官方包的标识，导入过就不再导入
  owner_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  official    INTEGER NOT NULL DEFAULT 0,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  credit      TEXT NOT NULL DEFAULT '', -- 来源和版权说明
  status      TEXT NOT NULL DEFAULT 'draft', -- draft | pending | rejected | ok | deleted
  listed      INTEGER NOT NULL DEFAULT 0,    -- 在商场里公开（审核通过过一次就上架，之后改动再审不影响已上架的表情）
  note        TEXT NOT NULL DEFAULT '',      -- 驳回理由
  cover       TEXT,                          -- 封面：包里某个表情的文件名
  installs    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  submitted_at INTEGER,
  reviewed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_emoji_packs_owner ON emoji_packs(owner_id, status);
CREATE INDEX IF NOT EXISTS idx_emoji_packs_status ON emoji_packs(status, submitted_at);

-- 包里的表情。reviewed = 1：管理员看过（官方包上传即算），上架后只显示看过的；
-- sent = 1：发到过帖子或私信里，移除后文件也要留着
CREATE TABLE IF NOT EXISTS emoji_pack_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  pack_id    INTEGER NOT NULL REFERENCES emoji_packs(id) ON DELETE CASCADE,
  file       TEXT NOT NULL UNIQUE,
  grp        TEXT NOT NULL DEFAULT '',  -- 分组：开心、难过……
  animated   INTEGER NOT NULL DEFAULT 0,
  reviewed   INTEGER NOT NULL DEFAULT 0,
  removed    INTEGER NOT NULL DEFAULT 0,
  sent       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_emoji_pack_items_pack ON emoji_pack_items(pack_id, removed, id);

CREATE TABLE IF NOT EXISTS emoji_pack_installs (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pack_id    INTEGER NOT NULL REFERENCES emoji_packs(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, pack_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_emoji_pack_installs_pack ON emoji_pack_installs(pack_id);
`);


/* ---------------- 紫水晶（全站点数） ---------------- */
db.exec(`
-- 每一笔加减都记一行，只追加不修改；users.crystals 是余额，和流水在同一个事务里更新。
-- 同一笔（user + kind + ref）只记一次。post_id 不设外键：帖子删了流水还在，方便追查
CREATE TABLE IF NOT EXISTS crystal_log (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,            -- checkin | liked | task | buy | tip_in | tip_out | revoke | boost | boost_refund | event | invite | admin
  ref        TEXT NOT NULL,
  delta      INTEGER NOT NULL,
  post_id    INTEGER,
  day        TEXT NOT NULL,            -- 北京时间日期，算每天上限
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, kind, ref)
);
CREATE INDEX IF NOT EXISTS idx_crystal_log_user ON crystal_log(user_id, id);
CREATE INDEX IF NOT EXISTS idx_crystal_log_day ON crystal_log(user_id, kind, day);
CREATE INDEX IF NOT EXISTS idx_crystal_log_post ON crystal_log(post_id) WHERE post_id IS NOT NULL;
-- 帖子被硬删（删吧）后 id 可能被新帖复用：紫水晶流水不能再指向它，否则新帖被当违规删除时会扣到旧帖作者头上
CREATE TRIGGER IF NOT EXISTS crystal_log_post_detached AFTER DELETE ON posts BEGIN
  UPDATE crystal_log SET post_id = NULL WHERE post_id = OLD.id;
END;
-- 加触发器之前删吧留下的：帖子已经不在，或者流水比帖子还早（id 被新帖复用了）
UPDATE crystal_log SET post_id = NULL
  WHERE post_id IS NOT NULL
    AND (NOT EXISTS (SELECT 1 FROM posts p WHERE p.id = crystal_log.post_id)
         OR created_at < (SELECT p.created_at FROM posts p WHERE p.id = crystal_log.post_id));

-- 已解锁的头像装扮
CREATE TABLE IF NOT EXISTS user_decorations (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  decoration TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, decoration)
);

-- 打赏记录
CREATE TABLE IF NOT EXISTS tips (
  id         INTEGER PRIMARY KEY,
  post_id    INTEGER REFERENCES posts(id) ON DELETE SET NULL,
  from_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  to_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  amount     INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tips_post ON tips(post_id);
`);
db.exec(`
-- 推流：花紫水晶让一条帖子被更多人看到。reach 是买的人数，shown 是已经给多少人看过；
-- 结束（看满、到期或者帖子没了）时按没用完的人数退回紫水晶
CREATE TABLE IF NOT EXISTS boosts (
  id         INTEGER PRIMARY KEY,
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  buyer_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount     INTEGER NOT NULL,
  reach      INTEGER NOT NULL,
  shown      INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ended_at   INTEGER,
  refund     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_boosts_active ON boosts(ended_at, id);
CREATE INDEX IF NOT EXISTS idx_boosts_post ON boosts(post_id);
-- 一条帖子的推流，同一个人只看一次（不管叠了几笔）
CREATE TABLE IF NOT EXISTS boost_views (
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  boost_id   INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, user_id)
);
-- 已分发但还没收到浏览上报；结束订单时清理，不占曝光额度。
CREATE TABLE IF NOT EXISTS boost_pending_views (
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  boost_id   INTEGER NOT NULL REFERENCES boosts(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, user_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_boost_pending_order ON boost_pending_views(boost_id);
CREATE INDEX IF NOT EXISTS idx_posts_root_author ON posts(root_id, author_id) WHERE root_id IS NOT NULL;

-- 活动：管理员办，期间带指定话题发帖得紫水晶（每人一次），签到可以翻倍
CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL DEFAULT '',
  tag           TEXT NOT NULL,
  post_reward   INTEGER NOT NULL DEFAULT 0,
  checkin_bonus INTEGER NOT NULL DEFAULT 1,
  starts_at     INTEGER NOT NULL,
  ends_at       INTEGER NOT NULL,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  ended         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_events_time ON events(ends_at);
-- 活动参与：带话题发帖先记一条待审核，管理员通过后才发紫水晶。
-- 每个活动每人同时只有一条待审核；被驳回可以再发一条
CREATE TABLE IF NOT EXISTS event_entries (
  id          INTEGER PRIMARY KEY,
  event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id     INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  reward      INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected
  note        TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  reviewed_at INTEGER,
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (event_id, post_id)
);
CREATE INDEX IF NOT EXISTS idx_event_entries_status ON event_entries(status, id);
CREATE INDEX IF NOT EXISTS idx_event_entries_user ON event_entries(event_id, user_id);
`);
addColumn('users', 'crystals', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'crystal_day', 'TEXT');
addColumn('users', 'crystal_streak', 'INTEGER NOT NULL DEFAULT 0');
addColumn('posts', 'tip_total', 'INTEGER NOT NULL DEFAULT 0');
// 防小号：注册时的 IP 哈希（之前注册的是 NULL，不算）；用户自己的邀请码（invites.personal）和邀请人
addColumn('users', 'register_ip', 'TEXT');
addColumn('users', 'invited_by', 'INTEGER');
addColumn('invites', 'personal', 'INTEGER NOT NULL DEFAULT 0');
db.exec(`CREATE INDEX IF NOT EXISTS idx_users_register_ip ON users(register_ip) WHERE register_ip IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_invited_by ON users(invited_by) WHERE invited_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invites_personal ON invites(created_by) WHERE personal = 1;`);
// 装扮改成用紫水晶解锁之前，已经戴着的那一个直接算解锁
if (!get("SELECT 1 FROM settings WHERE key = 'decorations_grandfathered'")) {
  tx(() => {
    run(`INSERT OR IGNORE INTO user_decorations (user_id, decoration, created_at)
         SELECT id, avatar_decoration, $t FROM users WHERE avatar_decoration <> ''`, { t: now() });
    run("INSERT INTO settings (key, value) VALUES ('decorations_grandfathered', '1')");
  });
}

// 视频（videos.ts）：分片上传 → ffmpeg 处理 → 发帖时挂到 posts.video 上
db.exec(`
CREATE TABLE IF NOT EXISTS videos (
  id          TEXT PRIMARY KEY,
  owner_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status      TEXT NOT NULL DEFAULT 'uploading',
  error       TEXT NOT NULL DEFAULT '',
  upload_size INTEGER NOT NULL,
  received    INTEGER NOT NULL DEFAULT 0,
  size        INTEGER NOT NULL DEFAULT 0,
  width       INTEGER NOT NULL DEFAULT 0,
  height      INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  progress    REAL NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  used        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_videos_owner ON videos(owner_id, created_at);
`);
addColumn('posts', 'video', 'TEXT');
db.exec('CREATE INDEX IF NOT EXISTS idx_posts_video ON posts(video) WHERE video IS NOT NULL;');
