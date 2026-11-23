import type { FastifyInstance } from 'fastify';
import { config } from '../config.ts';
import { all, get, now } from '../db.ts';
import { HIDDEN_BOARDS, visibleNotification } from '../serialize.ts';
import { me } from '../util.ts';
import { announcementsSince } from './site.ts';

/* ---------------- App 更新 ---------------- */

interface Latest {
  version: string;
  notes: string;
  publishedAt: string | null;
  size: number | null;
  /** 安装包的 SHA-256（十六进制）。App 下载后核对它和官方签名证书，所以走加速镜像也安全 */
  sha256: string | null;
  /** 第一个是推荐线路 */
  downloads: { label: string; url: string }[];
  page: string;
}

let cached: { at: number; value: Latest | null } | null = null;
const HEX64 = /^[a-f0-9]{64}$/i;

async function fetchLatest(): Promise<Latest | null> {
  const repo = config.releaseRepo;
  const signal = AbortSignal.timeout(8000);
  let tag: string | undefined;
  let notes = '';
  let publishedAt: string | null = null;
  let size: number | null = null;
  let sha256: string | null = null;
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'campus-forum-server' },
      signal,
    });
    if (r.ok) {
      const d = (await r.json()) as {
        tag_name: string;
        body?: string;
        published_at?: string;
        assets?: { name: string; size: number; digest?: string | null }[];
      };
      tag = d.tag_name;
      notes = (d.body ?? '').trim();
      publishedAt = d.published_at ?? null;
      const v = tag?.replace(/^v/, '');
      const a = d.assets?.find((x) => x.name === `campusx-android-${v}.apk`);
      if (a) {
        size = a.size;
        const digest = a.digest?.replace(/^sha256:/, '');
        if (digest && HEX64.test(digest)) sha256 = digest.toLowerCase();
      }
    }
  } catch {
    /* 下面用网页跳转再试一次 */
  }
  if (!tag) {
    // API 有频率限制，被限了就看 releases/latest 跳到哪个标签
    const r = await fetch(`https://github.com/${repo}/releases/latest`, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
    tag = r.headers.get('location')?.match(/\/releases\/tag\/([^/?#]+)$/)?.[1];
  }
  const version = tag?.replace(/^v/, '');
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) return null;
  const apk = `https://github.com/${repo}/releases/download/v${version}/campusx-android-${version}.apk`;
  if (!sha256) {
    // 发布流程会附带 .sha256 文件
    const r = await fetch(`${apk}.sha256`, { signal: AbortSignal.timeout(8000) }).catch(() => null);
    const hex = r?.ok ? (await r.text()).trim().split(/\s+/)[0] : '';
    if (HEX64.test(hex)) sha256 = hex.toLowerCase();
  }
  return {
    version,
    notes,
    publishedAt,
    size,
    sha256,
    downloads: [
      ...config.downloadMirrors.map((m) => ({ label: new URL(m).host, url: m.replace(/\/?$/, '/') + apk })),
      { label: 'GitHub 直连', url: apk },
    ],
    page: `https://github.com/${repo}/releases/tag/v${version}`,
  };
}

/* ---------------- 后台推送（App 定时来取） ---------------- */

const clip = (s: string, n = 80) => {
  const t = s.replace(/\[e:[\w-]+\.webp\]/g, '[表情]').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
};

const NOTIF_TEXT: Record<string, string> = {
  reply: '回复了你',
  mention: '提到了你',
  quote: '引用了你的帖子',
  follow: '关注了你',
  repost: '转发了你的帖子',
  like: '赞了你的帖子',
  reaction: '回应了你的帖子',
};

export async function appRoutes(app: FastifyInstance) {
  // 旧版 App（0.11、0.12）也靠这个接口提示更新，不能去掉
  app.get('/app/latest', async (_req, reply) => {
    const t = now();
    // 成功缓存 30 分钟，失败 5 分钟内不再重试；学校同一出口 IP 的人再多也不会撞上 GitHub 的频率限制
    if (!cached || t - cached.at > (cached.value ? 30 : 5) * 60_000) {
      cached = { at: t, value: await fetchLatest().catch(() => null) };
    }
    reply.header('Cache-Control', 'public, max-age=300');
    return cached.value ?? { version: null };
  });

  /**
   * App 在后台每隔一段时间来取一次，有新东西就发系统通知。
   * since 是上次返回的 now；第一次不传，只返回游标，避免把旧消息全推一遍。
   */
  app.get('/push/poll', async (req, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const user = me(req);
    const q = req.query as { since?: string; dm?: string; posts?: string; interactions?: string; notice?: string };
    const t = now();
    const since = Number(q.since);
    if (!Number.isFinite(since) || since <= 0) return { now: t, items: [] };
    // 太久没来（关机好几天）也只看最近一天
    const from = Math.max(since, t - 86_400_000);
    const items: { id: string; kind: 'dm' | 'posts' | 'interactions' | 'notice'; title: string; body: string; path: string }[] = [];

    // 公告：0.15 起的 App 有单独的「公告」通知渠道（带 notice=1）；旧版没有这个渠道，借用「关注的人发帖」
    if (q.notice === '1' || q.posts !== '0') {
      for (const a of announcementsSince(from)) {
        items.push({
          id: `ann-${a.id}`,
          kind: q.notice === '1' ? 'notice' : 'posts',
          title: `📢 ${a.title}`,
          body: a.body.replace(/\s+/g, ' ').slice(0, 120),
          path: a.link.startsWith('/') ? a.link : '/',
        });
      }
    }

    if (q.dm !== '0') {
      const rows = all<{ sender_id: number; username: string; display_name: string; n: number; content: string; images: number }>(
        `SELECT m.sender_id, u.username, u.display_name, COUNT(*) AS n,
                (SELECT m2.content FROM dm_messages m2 WHERE m2.sender_id = m.sender_id AND m2.recipient_id = $me
                   AND m2.deleted = 0 ORDER BY m2.id DESC LIMIT 1) AS content,
                (SELECT COUNT(*) FROM dm_message_images i WHERE i.message_id = MAX(m.id)) AS images
         FROM dm_messages m JOIN users u ON u.id = m.sender_id
         WHERE m.recipient_id = $me AND m.deleted = 0 AND m.read_at IS NULL AND m.created_at > $from
         GROUP BY m.sender_id ORDER BY MAX(m.id) DESC LIMIT 10`,
        { me: user.id, from },
      );
      for (const r of rows) {
        const text = clip(r.content) || (r.images ? '[图片]' : '');
        items.push({
          id: `dm-${r.sender_id}`,
          kind: 'dm',
          title: r.display_name,
          body: r.n > 1 ? `[${r.n} 条] ${text}` : text,
          path: `/messages/${r.username}`,
        });
      }
    }

    if (q.posts !== '0') {
      const rows = all<{ id: number; content: string; display_name: string; images: number }>(
        `SELECT p.id, p.content, u.display_name,
                (p.images <> '[]') AS images
         FROM posts p JOIN users u ON u.id = p.author_id
         WHERE p.author_id IN (SELECT followee_id FROM follows WHERE follower_id = $me)
           AND p.parent_id IS NULL AND p.repost_of IS NULL AND p.deleted = 0 AND p.status = 'ok'
           AND p.created_at > $from
           AND (p.board_id IS NULL OR p.board_id NOT IN ${HIDDEN_BOARDS})
         ORDER BY p.id DESC LIMIT 20`,
        { me: user.id, from },
      );
      if (rows.length > 3) {
        const names = [...new Set(rows.map((r) => r.display_name))];
        items.push({
          id: 'posts',
          kind: 'posts',
          title: '关注的人有新帖子',
          body: `${names.slice(0, 3).join('、')}${names.length > 3 ? ` 等 ${names.length} 人` : ''}发了 ${rows.length} 条新帖`,
          path: '/?tab=following',
        });
      } else {
        for (const r of rows) {
          items.push({
            id: `post-${r.id}`,
            kind: 'posts',
            title: `${r.display_name} 发了新帖`,
            body: clip(r.content) || (r.images ? '[图片]' : ''),
            path: `/post/${r.id}`,
          });
        }
      }
    }

    if (q.interactions !== '0') {
      const rows = all<{ id: number; type: string; post_id: number | null; display_name: string; content: string | null; extra: string | null }>(
        `SELECT n.id, n.type, n.post_id, u.display_name, p.content, n.extra
         FROM notifications n JOIN users u ON u.id = n.actor_id LEFT JOIN posts p ON p.id = n.post_id
         WHERE n.user_id = $me AND n.read = 0 AND n.created_at > $from AND ${visibleNotification}
         ORDER BY n.id DESC LIMIT 30`,
        { me: user.id, from },
      );
      // 赞和回应可能很多，合成一条；其它逐条推
      const quiet = rows.filter((r) => r.type === 'like' || r.type === 'reaction');
      for (const r of rows.filter((r) => !quiet.includes(r)).slice(0, 5)) {
        const moderation = r.type === 'moderation';
        const dismissed = r.type === 'report' && (r.extra ?? '').includes('"dismissed"');
        const text = r.type === 'reply' || r.type === 'mention' || r.type === 'quote' ? clip(r.content ?? '') : '';
        items.push({
          id: `n-${r.id}`,
          kind: 'interactions',
          title: moderation ? '内容警告' : r.type === 'report' ? (dismissed ? '举报结果' : '举报已处理') : `${r.display_name} ${NOTIF_TEXT[r.type] ?? '有新动态'}`,
          body: moderation ? '你的帖子没有通过审核，没有发布' : r.type === 'report' ? (dismissed ? '管理员看过了，暂时没有发现违规' : '感谢你的举报，管理员已经处理') : text,
          path: r.post_id && !moderation ? `/post/${r.post_id}` : '/notifications',
        });
      }
      if (quiet.length) {
        const names = [...new Set(quiet.map((r) => r.display_name))];
        items.push({
          id: 'likes',
          kind: 'interactions',
          title: `${names.slice(0, 2).join('、')}${names.length > 2 ? ` 等 ${names.length} 人` : ''} ${
            quiet.every((r) => r.type === 'like') ? '赞了' : quiet.every((r) => r.type === 'reaction') ? '回应了' : '赞了或回应了'
          }你的帖子`,
          body: '',
          path: '/notifications',
        });
      }
    }

    const unread = get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM notifications n WHERE n.user_id = $me AND n.read = 0 AND ${visibleNotification}`,
      { me: user.id },
    )!.n;
    return { now: t, items, unread };
  });
}
