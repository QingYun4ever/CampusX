import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { accountSecurity, completeLoginChallenge, newLoginChallenge } from '../account-security.ts';
import {
  bootstrapInviteHash,
  checkCaptcha,
  createSession,
  destroySession,
  hashPassword,
  newCaptcha,
  normalizeInvite,
  sessionTokenHash,
  verifyPassword,
} from '../auth.ts';
import { TERMS_VERSION } from '../config.ts';
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
const inviteCodeSchema = z.string().trim().min(1, '请填写邀请码').max(38, '邀请码格式无效');

const registerSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  displayName: z.string().trim().min(1, '请填写昵称').max(20, '昵称最多 20 字'),
  className: z.string().trim().max(20, '班级最多 20 字').optional().default(''),
  inviteCode: inviteCodeSchema,
  agreeTerms: z.literal(true, '请先阅读并同意用户协议'),
  ...captchaFields,
});

const loginSchema = z.object({
  username: z.string().trim().min(1, '请输入用户名'),
  password: z.string().min(1, '请输入密码'),
  ...captchaFields,
});

function findInvite(raw: string, time = now()) {
  if (!get('SELECT 1 FROM users LIMIT 1')) {
    const code = bootstrapInviteHash(raw);
    if (code && get('SELECT 1 FROM bootstrap_admin_invite WHERE code_hash = $code AND expires_at > $time', { code, time })) {
      return { code, role: 'admin' as const, note: '管理员初始化' };
    }
    throw new HttpError(400, '站点尚未初始化，需要管理员初始化邀请码');
  }

  const code = normalizeInvite(raw);
  const invite = get<{ note: string }>(
    'SELECT note FROM invites WHERE code = $code AND used_count < max_uses AND (expires_at IS NULL OR expires_at > $time)',
    { code, time },
  );
  if (!invite) throw new HttpError(400, '邀请码无效、已过期或已用完');
  return { code, role: 'user' as const, note: invite.note };
}

export async function authRoutes(app: FastifyInstance) {
  app.get('/captcha', { config: { rateLimit: { max: 40, timeWindow: '1 minute' } } }, async () => newCaptcha());

  // 分步注册：先单独校验邀请码和用户名，最后一步再提交（提交时会重新校验）
  app.post('/auth/invite/check', strict, async (req) => {
    const body = parse(z.object({ inviteCode: inviteCodeSchema }), req.body);
    const { note } = findInvite(body.inviteCode);
    return { ok: true, note };
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
    findInvite(body.inviteCode);
    if (get('SELECT 1 FROM users WHERE username = $u', { u: body.username })) {
      throw new HttpError(409, '用户名已被占用');
    }
    const passwordHash = await hashPassword(body.password);

    const userId = tx(() => {
      const t = now();
      const { code, role } = findInvite(body.inviteCode, t);
      const used = role === 'admin'
        ? run('DELETE FROM bootstrap_admin_invite WHERE code_hash = $code AND expires_at > $t', { code, t })
        : run(
            `UPDATE invites SET used_count = used_count + 1
             WHERE code = $code AND used_count < max_uses AND (expires_at IS NULL OR expires_at > $t)`,
            { code, t },
          );
      if (!used.changes) throw new HttpError(400, '邀请码无效、已过期或已用完');
      const { lastId } = run(
        `INSERT INTO users (username, password_hash, display_name, class_name, role, created_at, terms_version, terms_accepted_at)
         VALUES ($u, $h, $d, $c, $role, $t, $tv, $t)`,
        {
          u: body.username,
          h: passwordHash,
          d: body.displayName,
          c: body.className,
          role,
          t,
          tv: TERMS_VERSION,
        },
      );
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
    const t = get<{ terms_version: number }>('SELECT terms_version FROM users WHERE id = $id', { id: u.id })!;
    // 协议更新过、或者老用户还没同意过：前端会弹窗请他确认
    return { ...u, termsPending: t.terms_version < TERMS_VERSION };
  });

  app.post('/me/terms', async (req) => {
    const user = me(req);
    run('UPDATE users SET terms_version = $v, terms_accepted_at = $t WHERE id = $id', {
      v: TERMS_VERSION,
      t: now(),
      id: user.id,
    });
    return { ok: true };
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
