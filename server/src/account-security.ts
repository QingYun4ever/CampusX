import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { accountSecurityKeyPath, config } from './config.ts';
import { get, now, run, tx } from './db.ts';

export const attemptLimit = 5;
const stepLength = 30_000;
const loginTtl = 5 * 60_000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
let key: Buffer | undefined;

function readKey() {
  const fd = fs.openSync(accountSecurityKeyPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size !== 32) {
      throw new Error('账号安全密钥文件无效或权限不安全');
    }
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function securityKey() {
  if (key) return key;
  try {
    return key = readKey();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (get('SELECT 1 FROM account_security WHERE totp_secret IS NOT NULL LIMIT 1')
      || get('SELECT 1 FROM account_totp_setup LIMIT 1')
      || get('SELECT 1 FROM account_email_pending LIMIT 1')) {
    throw new Error('账号安全密钥缺失，请从备份恢复');
  }
  const dir = fs.mkdtempSync(path.join(config.dataDir, '.account-key-'));
  try {
    const temp = path.join(dir, 'key');
    fs.writeFileSync(temp, randomBytes(32), { mode: 0o600, flush: true });
    try {
      fs.linkSync(temp, accountSecurityKeyPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    return key = readKey();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function emailCodeHash(uid: number, email: string, code: string) {
  return createHmac('sha256', securityKey()).update(`email-v1\0${uid}\0${email}\0${code}`).digest('hex');
}

export function sealTotp(uid: number, secret: Buffer) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', securityKey(), nonce);
  cipher.setAAD(Buffer.from(`totp-v1:${uid}`));
  return Buffer.concat([nonce, cipher.update(secret), cipher.final(), cipher.getAuthTag()]).toString('base64url');
}

function openTotp(uid: number, value: string) {
  const sealed = Buffer.from(value, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', securityKey(), sealed.subarray(0, 12));
  decipher.setAAD(Buffer.from(`totp-v1:${uid}`));
  decipher.setAuthTag(sealed.subarray(-16));
  return Buffer.concat([decipher.update(sealed.subarray(12, -16)), decipher.final()]);
}

export function base32(bytes: Buffer) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let result = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) result += alphabet[(value >>> (bits -= 5)) & 31];
  }
  if (bits) result += alphabet[(value << (5 - bits)) & 31];
  return result;
}

export function matchingTotpStep(uid: number, sealed: string, code: string, lastStep = -1) {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = openTotp(uid, sealed);
  const current = Math.floor(now() / stepLength);
  const counter = Buffer.alloc(8);
  const supplied = Buffer.from(code);
  for (const step of [current + 1, current, current - 1]) {
    if (step <= lastStep || step < 0) continue;
    counter.writeBigUInt64BE(BigInt(step));
    const digest = createHmac('sha1', secret).update(counter).digest();
    const offset = digest[digest.length - 1] & 15;
    const number = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
    if (timingSafeEqual(Buffer.from(String(number).padStart(6, '0')), supplied)) return step;
  }
  return null;
}

export function newRecoveryCodes(uid: number) {
  const codes: string[] = [];
  for (let i = 0; i < 10; i++) {
    const raw = randomBytes(10).toString('hex').toUpperCase();
    run('INSERT INTO account_recovery_codes (user_id, code_hash) VALUES ($uid, $hash)', { uid, hash: hash(raw) });
    codes.push(raw.match(/.{5}/g)!.join('-'));
  }
  return codes;
}

export function accountSecurity(uid: number) {
  return get<{ email: string | null; totp_secret: string | null; last_totp_step: number | null }>(
    'SELECT email, totp_secret, last_totp_step FROM account_security WHERE user_id = $uid', { uid },
  );
}

// 调用者应在同一事务内消费验证码并执行受保护的操作。
export function consumeSecondFactor(uid: number, code: string) {
  const security = accountSecurity(uid);
  if (!security?.totp_secret) return false;
  const raw = code.replaceAll('-', '').toUpperCase();
  if (/^[A-F0-9]{20}$/.test(raw)) {
    return !!run('DELETE FROM account_recovery_codes WHERE user_id = $uid AND code_hash = $hash', { uid, hash: hash(raw) }).changes;
  }
  const step = matchingTotpStep(uid, security.totp_secret, code, security.last_totp_step ?? -1);
  if (step === null) return false;
  run('UPDATE account_security SET last_totp_step = $step WHERE user_id = $uid', { step, uid });
  return true;
}

export function newLoginChallenge(uid: number) {
  const challenge = randomBytes(32).toString('base64url');
  run(`INSERT INTO account_login_challenges (user_id, challenge_hash, expires_at) VALUES ($uid, $hash, $expires)
       ON CONFLICT (user_id) DO UPDATE SET challenge_hash = excluded.challenge_hash,
         expires_at = excluded.expires_at, attempts = 0`, { uid, hash: hash(challenge), expires: now() + loginTtl });
  return challenge;
}

export function completeLoginChallenge<T>(challenge: string, code: string, login: (uid: number) => T) {
  return tx(() => {
    const params = { hash: hash(challenge) };
    const row = get<{ user_id: number; expires_at: number; attempts: number }>(
      'SELECT user_id, expires_at, attempts FROM account_login_challenges WHERE challenge_hash = $hash', params,
    );
    if (!row || row.expires_at <= now() || row.attempts >= attemptLimit) return null;
    if (!consumeSecondFactor(row.user_id, code)) {
      run('UPDATE account_login_challenges SET attempts = attempts + 1 WHERE challenge_hash = $hash', params);
      return null;
    }
    run('DELETE FROM account_login_challenges WHERE challenge_hash = $hash', params);
    return login(row.user_id);
  });
}
