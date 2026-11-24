/**
 * 注册防小号 + 用户自己的邀请码（拉人得紫水晶）。
 *
 * 同一网络注册上限：注册时记下 IP 的哈希（users.register_ip，不存明文），同一个 IP 最多注册 signup.ipLimit 个账号
 * （0 是不限）。IPv6 按 /64 前缀算，因为同一台设备换个后缀很容易。这个功能上线前注册的账号没有记录，不算进去。
 *
 * 用户邀请码：注册满 3 天的人可以生成一个自己的邀请码（invites.personal = 1），别人用它注册，users.invited_by 记下是谁邀请的。
 * 被邀请的人签到满 INVITE.activeDays 天，邀请人得 INVITE.reward 颗紫水晶，每人最多拿 INVITE.maxRewarded 个人的奖励；
 * 一个人最多邀请 INVITE.maxInvites 个人。和邀请人同一网络注册的不给奖励。
 *
 * 函数都不开事务，调用方负责。
 */
import { createHash } from 'node:crypto';
import { createInvite, formatInvite } from './auth.ts';
import { all, get, now, run } from './db.ts';
import { isNewAccount, record } from './crystals.ts';
import { HttpError } from './util.ts';

export const INVITE = {
  reward: 20,
  /** 被邀请的人签到满几天才算数 */
  activeDays: 3,
  /** 最多拿几个人的奖励 */
  maxRewarded: 10,
  /** 一个人最多邀请多少人 */
  maxInvites: 30,
};

/* ---------------- 设置 ---------------- */

export interface Signup {
  /** 同一网络最多注册几个账号，0 不限 */
  ipLimit: number;
  /** 允许用户生成自己的邀请码 */
  userInvites: boolean;
}
const DEFAULT_SIGNUP: Signup = { ipLimit: 2, userInvites: true };
let cache: Signup | null = null;

export function getSignup(): Signup {
  if (cache) return cache;
  const row = get<{ value: string }>("SELECT value FROM settings WHERE key = 'signup'");
  let s = DEFAULT_SIGNUP;
  try {
    if (row) s = { ...s, ...JSON.parse(row.value) };
  } catch {
    /* 用默认值 */
  }
  return (cache = s);
}

export function saveSignup(s: Signup) {
  run("INSERT INTO settings (key, value) VALUES ('signup', $v) ON CONFLICT(key) DO UPDATE SET value = $v", { v: JSON.stringify(s) });
  cache = s;
}

/* ---------------- 同一网络注册上限 ---------------- */

/** IP 归一化后取哈希：IPv4 原样，IPv6 取前 64 位 */
export function ipKey(ip: string | undefined) {
  if (!ip) return null;
  let s = ip.trim().toLowerCase();
  if (s.startsWith('::ffff:') && s.includes('.')) s = s.slice(7);
  if (s.includes(':')) {
    const [head, tail = ''] = s.split('::');
    const a = head ? head.split(':') : [];
    const b = tail ? tail.split(':') : [];
    const full = s.includes('::') ? [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b] : a;
    s = full.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, '')).join(':') + '::/64';
  }
  return createHash('sha256').update('txq-register:' + s).digest('hex').slice(0, 32);
}

/** 注册前检查：这个网络还能不能注册。第一个账号（管理员初始化）不限 */
export function assertIpRoom(key: string | null) {
  const limit = getSignup().ipLimit;
  if (!limit || !key || !get('SELECT 1 FROM users LIMIT 1')) return;
  const n = get<{ n: number }>('SELECT COUNT(*) AS n FROM users WHERE register_ip = $k', { k: key })!.n;
  if (n >= limit) {
    throw new HttpError(
      429,
      `这个网络已经注册过 ${n} 个账号了，每个网络最多注册 ${limit} 个。如果你在用学校或者公共 Wi-Fi，换成手机流量再试试，还不行就找管理员。`,
    );
  }
}

/* ---------------- 用户邀请码 ---------------- */

/** 注册时：邀请码是谁的（只认个人邀请码，管理员发的返回 null） */
export function inviterOf(code: string) {
  const r = get<{ created_by: number | null }>('SELECT created_by FROM invites WHERE code = $c AND personal = 1', { c: code });
  if (!r?.created_by) return null;
  const n = get<{ n: number }>('SELECT COUNT(*) AS n FROM users WHERE invited_by = $u', { u: r.created_by })!.n;
  if (n >= INVITE.maxInvites) throw new HttpError(400, '这个邀请码已用完');
  return r.created_by;
}

/** 新用户注册成功后：告诉邀请人一声 */
export function noteInvited(inviterId: number, userId: number) {
  run(`INSERT INTO notifications (user_id, actor_id, type, extra, created_at) VALUES ($u, $a, 'invite', $x, $t)`, {
    u: inviterId, a: userId, x: JSON.stringify({ joined: true }), t: now(),
  });
}

/** 签到后调用：被邀请的人签到满 activeDays 天，给邀请人发奖励（每个被邀请的人只发一次） */
export function inviteRewardAfterCheckin(userId: number) {
  const u = get<{ invited_by: number | null; register_ip: string | null }>(
    'SELECT invited_by, register_ip FROM users WHERE id = $u', { u: userId },
  );
  if (!u?.invited_by) return;
  const days = get<{ n: number }>("SELECT COUNT(*) AS n FROM crystal_log WHERE user_id = $u AND kind = 'checkin'", { u: userId })!.n;
  if (days < INVITE.activeDays) return;
  const inviter = get<{ id: number; register_ip: string | null; role: string }>(
    'SELECT id, register_ip, role FROM users WHERE id = $u', { u: u.invited_by },
  );
  if (!inviter || inviter.role === 'bot') return;
  if (get("SELECT 1 FROM crystal_log WHERE user_id = $u AND kind = 'invite' AND ref = $r", { u: inviter.id, r: String(userId) })) return;
  const sameNet = !!u.register_ip && u.register_ip === inviter.register_ip;
  const rewarded = get<{ n: number }>("SELECT COUNT(*) AS n FROM crystal_log WHERE user_id = $u AND kind = 'invite' AND delta > 0", { u: inviter.id })!.n;
  // 不给奖励也记一笔 0，表示这个人已经结算过，名单上显示原因
  const gained = record(inviter.id, 'invite', String(userId), sameNet || rewarded >= INVITE.maxRewarded ? 0 : INVITE.reward) ?? 0;
  if (gained) {
    run(`INSERT INTO notifications (user_id, actor_id, type, extra, created_at) VALUES ($u, $a, 'invite', $x, $t)`, {
      u: inviter.id, a: userId, x: JSON.stringify({ gained }), t: now(),
    });
  }
}

export function myInvites(userId: number) {
  const code = get<{ code: string }>(
    'SELECT code FROM invites WHERE created_by = $u AND personal = 1 ORDER BY created_at DESC LIMIT 1', { u: userId },
  )?.code;
  const people = all<{ id: number; username: string; display_name: string; avatar: string | null; avatar_decoration: string; created_at: number; days: number; delta: number | null }>(
    `SELECT u.id, u.username, u.display_name, u.avatar, u.avatar_decoration, u.created_at,
       (SELECT COUNT(*) FROM crystal_log c WHERE c.user_id = u.id AND c.kind = 'checkin') AS days,
       (SELECT delta FROM crystal_log c WHERE c.user_id = $me AND c.kind = 'invite' AND c.ref = CAST(u.id AS TEXT)) AS delta
     FROM users u WHERE u.invited_by = $me ORDER BY u.id DESC LIMIT 100`,
    { me: userId },
  );
  const self = get<{ created_at: number }>('SELECT created_at FROM users WHERE id = $u', { u: userId })!;
  return {
    enabled: getSignup().userInvites,
    /** 注册不满 3 天还不能生成 */
    canCreate: !isNewAccount(self),
    code: code ? formatInvite(code) : null,
    rules: INVITE,
    earned: people.reduce((s, p) => s + (p.delta ?? 0), 0),
    rewardedCount: people.filter((p) => (p.delta ?? 0) > 0).length,
    people: people.map((p) => ({
      id: p.id,
      username: p.username,
      displayName: p.display_name,
      avatar: p.avatar,
      avatarDecoration: p.avatar_decoration,
      joinedAt: p.created_at,
      checkinDays: Math.min(p.days, INVITE.activeDays),
      /** waiting：还没签到满；rewarded：拿到了；none：结算过但没给（同一网络或者超过上限） */
      status: p.delta === null ? 'waiting' : p.delta > 0 ? 'rewarded' : 'none',
      reward: p.delta ?? 0,
    })),
  };
}

/** 生成（或者换一个）自己的邀请码。换的时候旧的作废 */
export function createMyInvite(userId: number) {
  if (!getSignup().userInvites) throw new HttpError(403, '管理员暂时关闭了用户邀请');
  const self = get<{ created_at: number; role: string }>('SELECT created_at, role FROM users WHERE id = $u', { u: userId });
  if (!self || self.role === 'bot') throw new HttpError(403, '不能生成邀请码');
  if (isNewAccount(self)) throw new HttpError(403, '注册满 3 天后才能邀请同学');
  run('DELETE FROM invites WHERE created_by = $u AND personal = 1', { u: userId });
  const code = createInvite({ createdBy: userId, maxUses: INVITE.maxInvites, note: '' });
  run('UPDATE invites SET personal = 1 WHERE code = $c', { c: code });
  return formatInvite(code);
}
