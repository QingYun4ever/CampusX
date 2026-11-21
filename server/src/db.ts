import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync, type SQLInputValue } from 'node:sqlite';
import { config, uploadsDir } from './config.ts';

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
  type       TEXT NOT NULL,            -- like | reply | repost | follow | mention
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

export function all<T = Row>(sql: string, params: Params = {}): T[] {
  return stmt(sql).all(pick(sql, params)) as T[];
}
export function get<T = Row>(sql: string, params: Params = {}): T | undefined {
  return stmt(sql).get(pick(sql, params)) as T | undefined;
}
export function run(sql: string, params: Params = {}) {
  const r = stmt(sql).run(pick(sql, params));
  return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
}

export function tx<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
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
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addColumn('users', 'verified', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'verified_note', "TEXT NOT NULL DEFAULT ''");
// 审核状态：ok 公开；pending 审核中；rejected 未通过。后两种只有作者自己看得到
addColumn('posts', 'status', "TEXT NOT NULL DEFAULT 'ok'");

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
`);

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
