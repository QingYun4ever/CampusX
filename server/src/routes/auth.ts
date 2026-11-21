import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { accountSecurity, completeLoginChallenge, newLoginChallenge } from '../account-security.ts';
import {
  checkCaptcha,
  createSession,
  destroySession,
  hashPassword,
  newCaptcha,
  normalizeInvite,
  sessionTokenHash,
  verifyPassword,
} from '../auth.ts';
import { get, now, run, tx } from '../db.ts';
import { HttpError, me, parse } from '../util.ts';
import { userById } from './users-common.ts';

const strict = { config: { rateLimit: { max: 15, timeWindow: '1 minute' } } };

const captchaFields = {
  captchaId: z.string().min(1, '请获取验证码'),
  captchaText: z.string().min(1, '请输入验证码'),
};

export const usernameSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_]{3,20}$/, '用户名为 3-20 位字母、数字或下划线');
export const passwordSchema = z.string().min(8, '密码至少 8 位').max(64, '密码最多 64 位');

const registerSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  displayName: z.string().trim().min(1, '请填写昵称').max(20, '昵称最多 20 字'),
  className: z.string().trim().max(20, '班级最多 20 字').optional().default(''),
  inviteCode: z.string().trim().min(1, '请填写邀请码'),
  ...captchaFields,
});

const loginSchema = z.object({
  username: z.string().trim().min(1, '请输入用户名'),
  password: z.string().min(1, '请输入密码'),
  ...captchaFields,
});

function findInvite(raw: string) {
  const code = normalizeInvite(raw);
  const invite = get<{ max_uses: number; used_count: number; expires_at: number | null; note: string }>(
    'SELECT max_uses, used_count, expires_at, note FROM invites WHERE code = $code',
    { code },
  );
  if (!invite || invite.used_count >= invite.max_uses || (invite.expires_at && invite.expires_at < now())) {
    throw new HttpError(400, '邀请码无效、已过期或已用完');
  }
  return { code, invite };
}

export async function authRoutes(app: FastifyInstance) {
  app.get('/captcha', { config: { rateLimit: { max: 40, timeWindow: '1 minute' } } }, async () => newCaptcha());

  // 分步注册：先单独校验邀请码和用户名，最后一步再提交（提交时会重新校验）
  app.post('/auth/invite/check', strict, async (req) => {
    const body = parse(z.object({ inviteCode: z.string().trim().min(1, '请输入邀请码') }), req.body);
    const { invite } = findInvite(body.inviteCode);
    return { ok: true, note: invite.note };
  });

  app.post('/auth/username/check', strict, async (req) => {
    const body = parse(z.object({ username: usernameSchema }), req.body);
    if (get('SELECT 1 FROM users WHERE username = $u', { u: body.username })) {
      throw new HttpError(409, '这个用户名已被占用，换一个试试');
    }
    return { ok: true };
  });

  app.post('/auth/register', strict, async (req) => {
    const raw = req.body as Record<string, unknown> | undefined;
    // 先校验验证码，再看其它字段
    if (!checkCaptcha(String(raw?.captchaId ?? ''), String(raw?.captchaText ?? ''))) {
      throw new HttpError(400, '验证码错误或已过期');
    }
    const body = parse(registerSchema, raw);
    const { code } = findInvite(body.inviteCode);
    if (get('SELECT 1 FROM users WHERE username = $u', { u: body.username })) {
      throw new HttpError(409, '用户名已被占用');
    }
    const passwordHash = await hashPassword(body.password);

    const userId = tx(() => {
      // 第一个注册的人自动成为管理员
      const isFirst = !get('SELECT 1 FROM users LIMIT 1');
      const { lastId } = run(
        `INSERT INTO users (username, password_hash, display_name, class_name, role, created_at)
         VALUES ($u, $h, $d, $c, $role, $t)`,
        {
          u: body.username,
          h: passwordHash,
          d: body.displayName,
          c: body.className,
          role: isFirst ? 'admin' : 'user',
          t: now(),
        },
      );
      const used = run(
        'UPDATE invites SET used_count = used_count + 1 WHERE code = $code AND used_count < max_uses',
        { code },
      );
      if (!used.changes) throw new HttpError(400, '邀请码无效或已用完');
      // 默认加入所有初始的吧
      run(
        `INSERT INTO board_members (board_id, user_id, created_at)
         SELECT id, $uid, $t FROM boards WHERE created_by IS NULL`,
        { uid: lastId, t: now() },
      );
      return lastId;
    });

    return { token: createSession(userId), user: userById(userId) };
  });

  app.post('/auth/login', strict, async (req) => {
    const body = parse(loginSchema, req.body);
    if (!checkCaptcha(body.captchaId, body.captchaText)) throw new HttpError(400, '验证码错误或已过期');
    const row = get<{ id: number; password_hash: string }>(
      'SELECT id, password_hash FROM users WHERE username = $u',
      { u: body.username },
    );
    if (!row || !(await verifyPassword(body.password, row.password_hash))) {
      throw new HttpError(400, '用户名或密码错误');
    }
    return tx(() => {
      if (!get('SELECT 1 FROM users WHERE id = $id AND password_hash = $hash', { id: row.id, hash: row.password_hash })) {
        throw new HttpError(400, '用户名或密码错误');
      }
      if (accountSecurity(row.id)?.totp_secret) {
        return { twoFactorRequired: true, challenge: newLoginChallenge(row.id) };
      }
      return { token: createSession(row.id), user: userById(row.id) };
    });
  });

  app.post('/auth/login/2fa', strict, async (req) => {
    const { challenge, code } = parse(z.object({
      challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      code: z.string().trim().min(1).max(64),
    }), req.body);
    const result = completeLoginChallenge(challenge, code, (uid) => ({ token: createSession(uid), user: userById(uid) }));
    if (!result) throw new HttpError(400, '两步验证码或恢复码错误，或登录验证已过期，请重试');
    return result;
  });

  app.post('/auth/logout', async (req) => {
    const h = req.headers.authorization;
    if (h?.startsWith('Bearer ')) destroySession(h.slice(7));
    return { ok: true };
  });

  app.get('/auth/me', async (req) => {
    const u = userById(me(req).id);
    if (!u) throw new HttpError(401, '请先登录');
    return u;
  });

  app.post('/me/password', strict, async (req) => {
    const user = me(req);
    const body = parse(z.object({ oldPassword: z.string(), newPassword: passwordSchema }), req.body);
    const row = get<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $id', { id: user.id });
    if (!row || !(await verifyPassword(body.oldPassword, row.password_hash))) {
      throw new HttpError(400, '原密码不正确');
    }
    const h = await hashPassword(body.newPassword);
    return tx(() => {
      const id = user.id;
      const sessionHash = sessionTokenHash(req.headers.authorization!.slice(7));
      if (!get('SELECT 1 FROM sessions WHERE user_id = $id AND token_hash = $sessionHash AND expires_at > $time',
        { id, sessionHash, time: now() })) throw new HttpError(401, '请先登录');
      const changed = run('UPDATE users SET password_hash = $h WHERE id = $id AND password_hash = $old',
        { h, id, old: row.password_hash });
      if (!changed.changes) throw new HttpError(400, '原密码不正确');
      // 修改密码后，其他设备全部下线，本设备重新签发会话。
      run('DELETE FROM sessions WHERE user_id = $id', { id });
      return { ok: true, token: createSession(id) };
    });
  });
}
