import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import svgCaptcha from 'svg-captcha';
import { config } from './config.ts';
import { get, now, run, tx } from './db.ts';

/* ---------------- 密码 ---------------- */

function scryptHash(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptHash(password, salt);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, saltB64, hashB64] = stored.split('$');
  if (algo !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scryptHash(password, Buffer.from(saltB64, 'base64'));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/* ---------------- 会话（Bearer token，Web 和原生 App 通用） ---------------- */

export const sessionTokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

export function createSession(userId: number): string {
  const token = randomBytes(32).toString('base64url');
  const t = now();
  run(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ($h, $uid, $t, $exp)',
    { h: sessionTokenHash(token), uid: userId, t, exp: t + config.sessionDays * 86400_000 },
  );
  return token;
}

export function destroySession(token: string) {
  run('DELETE FROM sessions WHERE token_hash = $h', { h: sessionTokenHash(token) });
}

export interface SessionUser {
  id: number;
  username: string;
  role: 'user' | 'admin';
}

export function userFromToken(token: string): SessionUser | null {
  const row = get<SessionUser & { expires_at: number }>(
    `SELECT u.id, u.username, u.role, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $h`,
    { h: sessionTokenHash(token) },
  );
  if (!row) return null;
  if (row.expires_at < now()) {
    destroySession(token);
    return null;
  }
  return { id: row.id, username: row.username, role: row.role };
}

/* ---------------- 在线状态 ---------------- */

const lastTouch = new Map<number, number>();
/** 记录用户最近一次活动；同一个人每分钟最多写一次数据库 */
export function touchSeen(id: number) {
  const t = now();
  if ((lastTouch.get(id) ?? 0) > t - 60_000) return;
  lastTouch.set(id, t);
  run('UPDATE users SET last_seen_at = $t WHERE id = $id', { t, id });
}

/* ---------------- 图形验证码（内存存储，一次性） ---------------- */

const captchas = new Map<string, { text: string; expires: number }>();
const CAPTCHA_TTL = 5 * 60_000;
const CAPTCHA_DEBUG = process.env.CAPTCHA_DEBUG === '1' && process.env.NODE_ENV !== 'production';

export function newCaptcha() {
  const t = now();
  if (captchas.size > 5000) {
    for (const [k, v] of captchas) if (v.expires < t) captchas.delete(k);
    // 仍然过多时丢弃最早的一批
    if (captchas.size > 5000) {
      let n = captchas.size - 4000;
      for (const k of captchas.keys()) {
        if (n-- <= 0) break;
        captchas.delete(k);
      }
    }
  }
  const c = svgCaptcha.create({
    size: 4,
    ignoreChars: '0oO1iIlLqg9',
    noise: 3,
    color: true,
    background: '#eef2f8',
    width: 132,
    height: 48,
    fontSize: 52,
  });
  const id = randomBytes(12).toString('base64url');
  captchas.set(id, { text: c.text.toLowerCase(), expires: t + CAPTCHA_TTL });
  // 仅用于自动化测试：非生产环境且显式开启时返回明文
  if (CAPTCHA_DEBUG) return { id, svg: c.data, text: c.text };
  return { id, svg: c.data };
}

/** 校验后立即作废，失败需刷新验证码，防止暴力尝试。 */
export function checkCaptcha(id: string, text: string): boolean {
  const c = captchas.get(id);
  captchas.delete(id);
  return !!c && c.expires > now() && c.text === text.trim().toLowerCase();
}

/* ---------------- 邀请码 ---------------- */

const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function normalizeInvite(code: string) {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function formatInvite(code: string) {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

export function bootstrapInviteHash(code: string): string | null {
  const normalized = code.trim().toUpperCase();
  return /^ADMIN-[0-9A-F]{32}$/.test(normalized) ? sessionTokenHash(normalized) : null;
}

export function createBootstrapInvite() {
  const code = `ADMIN-${randomBytes(16).toString('hex').toUpperCase()}`;
  tx(() => {
    if (get('SELECT 1 FROM users LIMIT 1')) throw new Error('已有账号，不能再生成管理员初始化邀请码');
    run(
      `INSERT INTO bootstrap_admin_invite (id, code_hash, expires_at) VALUES (1, $hash, $expires)
       ON CONFLICT(id) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at`,
      { hash: sessionTokenHash(code), expires: now() + 60 * 60_000 },
    );
  });
  return code;
}

export function createInvite(opts: { createdBy?: number | null; maxUses?: number; note?: string; expiresDays?: number | null }) {
  let code = '';
  for (let i = 0; i < 8; i++) code += INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)];
  const t = now();
  run(
    `INSERT INTO invites (code, created_by, note, max_uses, expires_at, created_at)
     VALUES ($code, $by, $note, $max, $exp, $t)`,
    {
      code,
      by: opts.createdBy ?? null,
      note: opts.note ?? '',
      max: opts.maxUses ?? 1,
      exp: opts.expiresDays ? t + opts.expiresDays * 86400_000 : null,
      t,
    },
  );
  return code;
}
