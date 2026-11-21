import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import nodemailer from 'nodemailer';
import { z } from 'zod';
import {
  accountSecurity, attemptLimit, base32, consumeSecondFactor, emailCodeHash,
  matchingTotpStep, newRecoveryCodes, sealTotp,
} from '../account-security.ts';
import { sessionTokenHash, verifyPassword } from '../auth.ts';
import { config } from '../config.ts';
import { get, now, run, tx } from '../db.ts';
import { HttpError, me, parse } from '../util.ts';

const strict = { config: { rateLimit: { max: 15, timeWindow: '1 minute' } } };
const password = z.string().min(1).max(64);
const otp = z.string().trim().min(1).max(64);
const passwordAndCode = z.object({ password, code: otp.optional() });
const email = z.string().trim().max(254).email('请输入有效的邮箱地址');
const pendingTtl = 10 * 60_000;
const emailResendDelay = 60_000;
const smtp = config.smtp;
const mailer = smtp && nodemailer.createTransport({
  host: smtp.host, port: smtp.port, secure: smtp.secure, requireTLS: smtp.requireTLS, auth: smtp.auth,
  connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 30_000,
});

interface PasswordProof {
  uid: number;
  sessionHash: string;
  passwordHash: string;
}

function securityStatus(uid: number) {
  const row = accountSecurity(uid);
  return { email: row?.email ?? null, emailAvailable: !!mailer, twoFactorEnabled: !!row?.totp_secret };
}

function session(req: FastifyRequest) {
  const uid = me(req).id;
  const sessionHash = sessionTokenHash(req.headers.authorization!.slice(7));
  assertSession(uid, sessionHash);
  return { uid, sessionHash };
}

function assertSession(uid: number, sessionHash: string) {
  if (!get('SELECT 1 FROM sessions WHERE token_hash = $sessionHash AND user_id = $uid AND expires_at > $time',
    { sessionHash, uid, time: now() })) throw new HttpError(401, '请先登录');
}

async function passwordProof(req: FastifyRequest, supplied: string): Promise<PasswordProof> {
  const { uid, sessionHash } = session(req);
  const row = get<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $uid', { uid });
  if (!row || !(await verifyPassword(supplied, row.password_hash))) throw new HttpError(400, '密码不正确');
  return { uid, sessionHash, passwordHash: row.password_hash };
}

function assertPasswordProof({ uid, sessionHash, passwordHash }: PasswordProof) {
  assertSession(uid, sessionHash);
  if (!get('SELECT 1 FROM users WHERE id = $uid AND password_hash = $passwordHash', { uid, passwordHash })) {
    throw new HttpError(400, '密码已变更，请重试');
  }
}

function verifyEmailSecondFactor(uid: number, code: string | undefined) {
  if (accountSecurity(uid)?.totp_secret && (!code || !consumeSecondFactor(uid, code))) {
    throw new HttpError(400, '请输入有效的两步验证码或恢复码');
  }
}

function invalidateLogin(uid: number) {
  run('DELETE FROM account_login_challenges WHERE user_id = $uid', { uid });
}

function finishTotpChange(uid: number, sessionHash: string) {
  invalidateLogin(uid);
  run('DELETE FROM account_totp_setup WHERE user_id = $uid', { uid });
  run('DELETE FROM account_email_pending WHERE user_id = $uid', { uid });
  run('DELETE FROM sessions WHERE user_id = $uid AND token_hash <> $sessionHash', { uid, sessionHash });
}

export async function securityRoutes(app: FastifyInstance) {
  // 临时凭证定期清理，过期未验证的地址不长期保留。
  function prunePending() {
    const params = { time: now() };
    run('DELETE FROM account_email_pending WHERE expires_at <= $time AND resend_at <= $time', params);
    run('DELETE FROM account_totp_setup WHERE expires_at <= $time', params);
    run('DELETE FROM account_login_challenges WHERE expires_at <= $time', params);
  }
  prunePending();
  const prune = setInterval(prunePending, 60_000).unref();
  app.addHook('onClose', async () => clearInterval(prune));

  app.get('/me/security', async (req) => securityStatus(session(req).uid));

  app.post('/me/email/start', strict, async (req) => {
    if (!mailer || !smtp) throw new HttpError(503, '站点尚未配置邮箱验证');
    const body = parse(passwordAndCode.extend({ email }), req.body);
    const proof = await passwordProof(req, body.password);
    const { uid, sessionHash } = proof;
    const code = String(randomInt(1_000_000)).padStart(6, '0');
    const codeHash = tx(() => {
      assertPasswordProof(proof);
      const time = now();
      if (get('SELECT 1 FROM account_email_pending WHERE user_id = $uid AND resend_at > $time', { uid, time })) {
        throw new HttpError(429, '发送过于频繁，请稍后再试');
      }
      verifyEmailSecondFactor(uid, body.code);
      const hash = emailCodeHash(uid, body.email, code);
      run(`INSERT INTO account_email_pending (user_id, session_hash, email, code_hash, expires_at, resend_at)
           VALUES ($uid, $sessionHash, $email, $hash, $expires, $resend)
           ON CONFLICT (user_id) DO UPDATE SET session_hash = excluded.session_hash, email = excluded.email,
             code_hash = excluded.code_hash, expires_at = excluded.expires_at, resend_at = excluded.resend_at,
             attempts = 0`,
      { uid, sessionHash, email: body.email, hash, expires: time + pendingTtl, resend: time + emailResendDelay });
      return hash;
    });
    try {
      await mailer.sendMail({
        from: smtp.from, to: { name: '', address: body.email }, subject: '校墙邮箱验证码',
        text: `你的校墙邮箱验证码为 ${code}，10 分钟内有效。请勿向他人透露。若非本人操作，可忽略此邮件。`,
      });
    } catch {
      // SMTP 错误可能含收件地址、凭证或服务端原文，不写入日志。
      run('UPDATE account_email_pending SET expires_at = 0 WHERE user_id = $uid AND code_hash = $hash',
        { uid, hash: codeHash });
      throw new HttpError(503, '验证码发送失败，请稍后重试');
    }
    return { ok: true };
  });

  app.post('/me/email/confirm', strict, async (req) => {
    const { uid, sessionHash } = session(req);
    const { code } = parse(z.object({ code: z.string().trim().regex(/^\d{6}$/, '请输入 6 位邮箱验证码') }), req.body);
    const confirmed = tx(() => {
      const params = { uid, sessionHash, time: now(), limit: attemptLimit };
      const row = get<{ email: string; code_hash: string }>(
        `SELECT email, code_hash FROM account_email_pending WHERE user_id = $uid AND session_hash = $sessionHash
         AND expires_at > $time AND attempts < $limit`, params,
      );
      if (!row) return false;
      const actual = emailCodeHash(uid, row.email, code);
      if (!timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(row.code_hash, 'hex'))) {
        run('UPDATE account_email_pending SET attempts = attempts + 1 WHERE user_id = $uid', { uid });
        return false;
      }
      run(`INSERT INTO account_security (user_id, email) VALUES ($uid, $email)
           ON CONFLICT (user_id) DO UPDATE SET email = excluded.email`, { uid, email: row.email });
      run('DELETE FROM account_email_pending WHERE user_id = $uid', { uid });
      invalidateLogin(uid);
      return true;
    });
    if (!confirmed) throw new HttpError(400, '邮箱验证码错误、已过期或尝试次数已用完');
    return securityStatus(uid);
  });

  app.delete('/me/email', strict, async (req) => {
    const body = parse(passwordAndCode, req.body);
    const proof = await passwordProof(req, body.password);
    const { uid } = proof;
    return tx(() => {
      assertPasswordProof(proof);
      verifyEmailSecondFactor(uid, body.code);
      run('UPDATE account_security SET email = NULL WHERE user_id = $uid', { uid });
      run('UPDATE account_email_pending SET expires_at = 0 WHERE user_id = $uid', { uid });
      invalidateLogin(uid);
      return securityStatus(uid);
    });
  });

  app.post('/me/2fa/setup', strict, async (req) => {
    const { password: supplied } = parse(z.object({ password }), req.body);
    const proof = await passwordProof(req, supplied);
    const { uid, sessionHash } = proof;
    return tx(() => {
      assertPasswordProof(proof);
      if (accountSecurity(uid)?.totp_secret) throw new HttpError(409, '已开启两步验证');
      const bytes = randomBytes(20);
      const secret = base32(bytes);
      run(`INSERT INTO account_totp_setup (user_id, session_hash, secret, expires_at)
           VALUES ($uid, $sessionHash, $sealed, $expires)
           ON CONFLICT (user_id) DO UPDATE SET session_hash = excluded.session_hash, secret = excluded.secret,
             expires_at = excluded.expires_at, attempts = 0`,
      { uid, sessionHash, sealed: sealTotp(uid, bytes), expires: now() + pendingTtl });
      const issuer = encodeURIComponent('校墙');
      const username = encodeURIComponent(me(req).username);
      return { secret, uri: `otpauth://totp/${issuer}:${username}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30` };
    });
  });

  app.post('/me/2fa/confirm', strict, async (req) => {
    const { uid, sessionHash } = session(req);
    const { code } = parse(z.object({ code: z.string().trim().regex(/^\d{6}$/, '请输入 6 位两步验证码') }), req.body);
    const recoveryCodes = tx(() => {
      const row = get<{ secret: string }>(
        `SELECT secret FROM account_totp_setup WHERE user_id = $uid AND session_hash = $sessionHash
         AND expires_at > $time AND attempts < $limit`, { uid, sessionHash, time: now(), limit: attemptLimit },
      );
      if (!row || accountSecurity(uid)?.totp_secret) return null;
      const step = matchingTotpStep(uid, row.secret, code);
      if (step === null) {
        run('UPDATE account_totp_setup SET attempts = attempts + 1 WHERE user_id = $uid', { uid });
        return null;
      }
      run(`INSERT INTO account_security (user_id, totp_secret, last_totp_step) VALUES ($uid, $secret, $step)
           ON CONFLICT (user_id) DO UPDATE SET totp_secret = excluded.totp_secret, last_totp_step = excluded.last_totp_step`,
      { uid, secret: row.secret, step });
      const codes = newRecoveryCodes(uid);
      finishTotpChange(uid, sessionHash);
      return codes;
    });
    if (!recoveryCodes) throw new HttpError(400, '两步验证码错误，或设置已过期，请重新设置');
    return { recoveryCodes };
  });

  app.delete('/me/2fa', strict, async (req) => {
    const body = parse(z.object({ password, code: otp }), req.body);
    const proof = await passwordProof(req, body.password);
    const { uid, sessionHash } = proof;
    return tx(() => {
      assertPasswordProof(proof);
      if (!consumeSecondFactor(uid, body.code)) throw new HttpError(400, '两步验证码或恢复码无效');
      run('UPDATE account_security SET totp_secret = NULL, last_totp_step = NULL WHERE user_id = $uid', { uid });
      run('DELETE FROM account_recovery_codes WHERE user_id = $uid', { uid });
      finishTotpChange(uid, sessionHash);
      return { ok: true };
    });
  });
}
