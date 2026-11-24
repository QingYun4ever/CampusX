import { all, get, now, run, type Row } from './db.ts';
import { grantForPost, levelInfo, revokeForPost, type LevelInfo } from './levels.ts';
import { revokeCrystalsForPost } from './crystals.ts';
import { eventRewardForPost } from './events.ts';
import { HttpError } from './util.ts';

/** 表情回应（Telegram 式）：每人每帖一个，换一个会替换掉之前的。前端的列表要和这里一致 */
export const REACTIONS = [
  '👍', '👎', '❤️', '🔥', '🥰', '👏', '😁', '🤔', '🤯', '😱', '😢', '🎉', '🤩', '🙏', '👌', '😍',
  '🤣', '💯', '⚡', '🏆', '💔', '🤨', '😐', '😭', '🤓', '👻', '👀', '🙈', '😇', '😨', '🤝', '✍️',
  '🤗', '🫡', '💅', '🤪', '🗿', '🆒', '💘', '🦄', '😘', '😎', '🤷', '😡', '🥱', '🥴', '🌚', '🐳',
  '🍓', '🍾', '🎃', '❤️‍🔥',
] as const;

/**
 * 当前用户（$me）看不到的私密吧（SQL 子查询，使用前要绑定 $me）。
 * 私密吧只对吧主、吧务、吧主指定的可见成员和站点管理员可见。
 */
export const HIDDEN_BOARDS = `(SELECT hb.id FROM boards hb WHERE hb.visibility = 'private'
  AND hb.owner_id IS NOT $me
  AND NOT EXISTS (SELECT 1 FROM users ha WHERE ha.id = $me AND ha.role = 'admin')
  AND NOT EXISTS (SELECT 1 FROM board_mods hm WHERE hm.board_id = hb.id AND hm.user_id = $me)
  AND NOT EXISTS (SELECT 1 FROM board_viewers hv WHERE hv.board_id = hb.id AND hv.user_id = $me))`;

/** 帖子对 $me 可见（不在看不到的私密吧里）。alias 是表别名前缀，如 'p.' */
export const visibleTo = (alias = '') => `(${alias}board_id IS NULL OR ${alias}board_id NOT IN ${HIDDEN_BOARDS})`;

/** 引用源和引用通知都必须对所有人公开，而不仅对当前用户可见。 */
export const publicPost = (alias: string) => `(${alias}.status = 'ok' AND ${alias}.deleted = 0
  AND (${alias}.board_id IS NULL OR EXISTS(
    SELECT 1 FROM boards qb WHERE qb.id = ${alias}.board_id AND qb.visibility = 'public'
  )))`;

/** 通知列表、推送和未读数都以收件人当前的帖子权限为准。 */
export const visibleNotification = `(
  -- 举报结果、活动审核结果是系统通知，不因为拉黑了处理的管理员就收不到
  (n.type IN ('report', 'event', 'invite') OR NOT EXISTS (SELECT 1 FROM blocks nb WHERE nb.blocker_id = $me AND nb.blocked_id = n.actor_id))
  AND (n.post_id IS NULL OR EXISTS (
    SELECT 1 FROM posts vp WHERE vp.id = n.post_id AND vp.deleted = 0
      AND (vp.status = 'ok' OR (vp.status = 'pending' AND vp.author_id = $me)) AND ${visibleTo('vp.')}
  ))
  AND (n.type <> 'quote' OR EXISTS (
    SELECT 1 FROM post_quotes nq JOIN posts np ON np.id = nq.post_id JOIN posts ns ON ns.id = nq.quoted_id
    WHERE nq.post_id = n.post_id AND ${publicPost('np')} AND ${publicPost('ns')}
  ))
)`;

/** 我拉黑的人发的帖子、以及转发了他们帖子的转发行（SQL 条件，作用在 posts 表上，要绑定 $me） */
const NOT_BLOCKED = `author_id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = $me)
  AND (repost_of IS NULL OR repost_of NOT IN (
    SELECT bp.id FROM posts bp JOIN blocks bb ON bb.blocked_id = bp.author_id AND bb.blocker_id = $me))`;

/**
 * 帖子查询的公共 SELECT。$me 为当前用户 id，用于计算 liked / reposted。
 * 审核中、未通过的帖子只对作者本人可见（作者看起来和正常发出一样）。
 * 私密吧里的帖子只对能看到这个吧的人可见；转发了这种帖子的转发行会在 hydrate 里被丢掉。
 * 列表默认不出现我拉黑的人；showBlocked 时照样返回（楼层里显示成折叠的占位，按 id 取帖子也一样）。
 */
export function postSelect(extraCols = '', { showBlocked = false } = {}) {
  return `
SELECT p.id, p.author_id, p.board_id, p.parent_id, p.root_id, p.repost_of, p.content, p.images,
  p.like_count, p.reply_count, p.repost_count, p.view_count, p.tip_total, p.deleted, p.created_at, p.last_activity_at,
  u.username, u.display_name, u.avatar, u.avatar_decoration, u.role, u.class_name, u.verified, u.verified_note,
  b.slug AS board_slug, b.name AS board_name, b.icon AS board_icon, b.level_titles AS board_level_titles,
  be.exp AS author_exp,
  EXISTS(SELECT 1 FROM board_members am WHERE am.board_id = p.board_id AND am.user_id = p.author_id) AS author_member,
  pu.username AS parent_username,
  EXISTS(SELECT 1 FROM likes l WHERE l.post_id = p.id AND l.user_id = $me) AS liked,
  EXISTS(SELECT 1 FROM posts r WHERE r.repost_of = p.id AND r.author_id = $me) AS reposted,
  EXISTS(SELECT 1 FROM bookmarks bk0 WHERE bk0.post_id = p.id AND bk0.user_id = $me) AS bookmarked,
  (SELECT json_group_array(tag) FROM post_tags WHERE post_id = p.id) AS tags,
  (SELECT json_group_array(json_object('key', emoji, 'count', n, 'me', mine, 'users', json(us))) FROM (
     SELECT r.emoji, COUNT(*) AS n, MAX(r.user_id = $me) AS mine, MIN(r.created_at) AS first,
       (SELECT json_group_array(json_object('username', ru.username, 'displayName', ru.display_name, 'avatar', ru.avatar))
          FROM (SELECT r2.user_id FROM reactions r2 WHERE r2.post_id = p.id AND r2.emoji = r.emoji
                ORDER BY r2.created_at DESC LIMIT 3) x
          JOIN users ru ON ru.id = x.user_id) AS us
     FROM reactions r WHERE r.post_id = p.id GROUP BY r.emoji ORDER BY n DESC, first
  )) AS reactions,
  p.pinned_at,
  q.post_id AS quote_post_id, q.quoted_id,
  ${publicPost('p')} AS can_quote,
  CASE WHEN p.board_id IS NULL THEN NULL
       WHEN b.owner_id = p.author_id THEN 'owner'
       WHEN EXISTS(SELECT 1 FROM board_mods bm WHERE bm.board_id = p.board_id AND bm.user_id = p.author_id) THEN 'mod'
  END AS author_board_role,
  (p.board_id IS NOT NULL AND (b.owner_id = $me
     OR EXISTS(SELECT 1 FROM board_mods bm WHERE bm.board_id = p.board_id AND bm.user_id = $me))) AS board_manager,
  EXISTS(SELECT 1 FROM blocks ab WHERE ab.blocker_id = $me AND ab.blocked_id = p.author_id) AS author_blocked
  ${extraCols}
FROM (SELECT * FROM posts WHERE (status = 'ok' OR (status = 'pending' AND author_id = $me)) AND ${visibleTo()}
  ${showBlocked ? '' : `AND ${NOT_BLOCKED}`}) p
JOIN users u ON u.id = p.author_id
LEFT JOIN boards b ON b.id = p.board_id
LEFT JOIN board_exp be ON be.board_id = p.board_id AND be.user_id = p.author_id
LEFT JOIN post_quotes q ON q.post_id = p.id
LEFT JOIN posts pp ON pp.id = p.parent_id
LEFT JOIN users pu ON pu.id = pp.author_id`;
}

export interface PostDTO {
  id: number;
  author: {
    id: number;
    username: string;
    displayName: string;
    avatar: string | null;
    avatarDecoration: string;
    role: string;
    className: string;
    verified: boolean;
    verifiedNote: string;
    /** 作者在这条帖子所在吧里的身份 */
    boardRole: 'owner' | 'mod' | null;
    /** 作者在这条帖子所在吧里的等级；不在吧里的帖子、或者作者已经退出这个吧时为 null */
    level: LevelInfo | null;
    /** 我拉黑了作者（楼层里折叠显示） */
    blocked: boolean;
  };
  board: { slug: string; name: string; icon: string } | null;
  parentId: number | null;
  rootId: number | null;
  parentUsername: string | null;
  content: string;
  images: string[];
  likeCount: number;
  replyCount: number;
  repostCount: number;
  viewCount: number;
  /** 收到的紫水晶打赏 */
  tipTotal: number;
  liked: boolean;
  reposted: boolean;
  /** 当前用户加了书签（只有自己知道） */
  bookmarked: boolean;
  deleted: boolean;
  createdAt: number;
  tags: string[];
  reactions: Reaction[];
  /** 在吧里置顶 */
  pinned: boolean;
  /** 首页里插进来的推流帖子 */
  boosted?: boolean;
  /** 当前用户是这条帖子所在吧的吧主 / 吧务（可以置顶、删除） */
  canModerate: boolean;
  repostOf: PostDTO | null;
  canQuote: boolean;
  quote: { post: QuotePreview | null } | null;
}

interface QuotePreview {
  id: number;
  content: string;
  images: string[];
  createdAt: number;
  author: Pick<PostDTO['author'], 'id' | 'username' | 'displayName' | 'avatar' | 'avatarDecoration' | 'role' | 'verified' | 'verifiedNote'>;
  /** 原帖作者被我拉黑了：不带正文和图片 */
  blocked?: boolean;
}

export interface Reaction {
  key: string;
  count: number;
  me: boolean;
  /** 最近回应的几个人（Telegram 在人少时显示头像） */
  users: { username: string; displayName: string; avatar: string | null }[];
}

function serializeRow(r: Row, quotes: Map<number, QuotePreview>): PostDTO {
  const deleted = !!r.deleted;
  return {
    id: r.id,
    author: {
      id: r.author_id,
      username: r.username,
      displayName: r.display_name,
      avatar: r.avatar ?? null,
      avatarDecoration: r.avatar_decoration,
      role: r.role,
      className: r.class_name ?? '',
      verified: !!r.verified,
      verifiedNote: r.verified_note ?? '',
      boardRole: (r.author_board_role as 'owner' | 'mod' | null) ?? null,
      level: r.board_id && r.author_member ? levelInfo(r.author_exp ?? 0, r.board_level_titles) : null,
      blocked: !!r.author_blocked,
    },
    board: r.board_slug ? { slug: r.board_slug, name: r.board_name, icon: r.board_icon } : null,
    parentId: r.parent_id ?? null,
    rootId: r.root_id ?? null,
    parentUsername: r.parent_username ?? null,
    content: deleted ? '' : r.content,
    images: deleted ? [] : (JSON.parse(r.images) as string[]),
    likeCount: r.like_count,
    replyCount: r.reply_count,
    repostCount: r.repost_count,
    viewCount: r.view_count ?? 0,
    tipTotal: deleted ? 0 : (r.tip_total ?? 0),
    liked: !!r.liked,
    reposted: !!r.reposted,
    bookmarked: !!r.bookmarked,
    deleted,
    createdAt: r.created_at,
    tags: deleted ? [] : (JSON.parse(r.tags ?? '[]') as string[]),
    reactions: deleted
      ? []
      : (JSON.parse(r.reactions ?? '[]') as (Omit<Reaction, 'me'> & { me: number })[]).map((x) => ({
          key: x.key,
          count: x.count,
          me: !!x.me,
          users: x.users ?? [],
        })),
    pinned: !!r.pinned_at,
    canModerate: !!r.board_manager,
    repostOf: null,
    canQuote: !!r.can_quote,
    quote: r.quote_post_id != null ? { post: deleted ? null : (quotes.get(r.quoted_id) ?? null) } : null,
  };
}

/** 原帖和引用预览各按一批读取；引用预览不再展开其引用。 */
export function hydrate(rows: Row[], me: number): PostDTO[] {
  const repostIds = [...new Set(rows.filter((r) => r.repost_of).map((r) => r.repost_of as number))];
  const originalRows = loadPostRows(repostIds, me);
  const quoteIds = new Set<number>();
  for (const batch of [rows, originalRows]) {
    for (const r of batch) if (!r.deleted && r.quoted_id != null) quoteIds.add(r.quoted_id);
  }
  const quotes = new Map<number, QuotePreview>();
  if (quoteIds.size) {
    for (const r of all(
      `SELECT s.id, s.content, s.images, s.created_at, s.author_id,
         u.username, u.display_name, u.avatar, u.avatar_decoration, u.role, u.verified, u.verified_note,
         EXISTS(SELECT 1 FROM blocks bq WHERE bq.blocker_id = $me AND bq.blocked_id = s.author_id) AS blocked
       FROM posts s JOIN users u ON u.id = s.author_id
       WHERE s.id IN (SELECT value FROM json_each($ids)) AND s.repost_of IS NULL AND ${publicPost('s')}`,
      { ids: JSON.stringify([...quoteIds]), me },
    )) {
      quotes.set(r.id, {
        id: r.id,
        content: r.blocked ? '' : r.content,
        images: r.blocked ? [] : (JSON.parse(r.images) as string[]),
        ...(r.blocked ? { blocked: true } : {}),
        createdAt: r.created_at,
        author: {
          id: r.author_id,
          username: r.username,
          displayName: r.display_name,
          avatar: r.avatar ?? null,
          avatarDecoration: r.avatar_decoration,
          role: r.role,
          verified: !!r.verified,
          verifiedNote: r.verified_note ?? '',
        },
      });
    }
  }
  const originals = new Map<number, PostDTO>();
  for (const r of originalRows) {
    if (!r.deleted && !r.repost_of) originals.set(r.id, serializeRow(r, quotes));
  }
  const out: PostDTO[] = [];
  for (const r of rows) {
    const p = serializeRow(r, quotes);
    if (r.repost_of) {
      const o = originals.get(r.repost_of);
      if (!o) continue;
      p.repostOf = o;
      p.canQuote &&= o.canQuote;
    }
    out.push(p);
  }
  return out;
}

function loadPostRows(ids: number[], me: number): Row[] {
  if (!ids.length) return [];
  return all(`${postSelect('', { showBlocked: true })} WHERE p.id IN (SELECT value FROM json_each($ids))`, {
    ids: JSON.stringify(ids),
    me,
  });
}

export function postsByIds(ids: number[], me: number): PostDTO[] {
  return hydrate(loadPostRows(ids, me), me);
}

export function postById(id: number, me: number): PostDTO | undefined {
  return postsByIds([id], me)[0];
}

/* ---------------- 通知 ---------------- */

export function notify(userId: number, actorId: number, type: string, postId: number | null = null, extra = '') {
  if (userId === actorId) return;
  // 被收件人拉黑的人不会给他发出通知（@、回复、赞……）
  if (get('SELECT 1 FROM blocks WHERE blocker_id = $u AND blocked_id = $a', { u: userId, a: actorId })) return;
  // 同一事件不重复通知
  if (
    get(
      `SELECT 1 FROM notifications WHERE user_id = $u AND actor_id = $a AND type = $type
       AND post_id IS $p LIMIT 1`,
      { u: userId, a: actorId, type, p: postId },
    )
  )
    return;
  run(
    `INSERT INTO notifications (user_id, actor_id, type, post_id, extra, created_at) VALUES ($u, $a, $type, $p, $extra, $t)`,
    { u: userId, a: actorId, type, p: postId, extra, t: now() },
  );
}

export function unnotify(userId: number, actorId: number, type: string, postId: number | null = null) {
  run(`DELETE FROM notifications WHERE user_id = $u AND actor_id = $a AND type = $type AND post_id IS $p`, {
    u: userId,
    a: actorId,
    type,
    p: postId,
  });
}

export function notifyMentions(content: string, actorId: number, postId: number, skip: Set<number>) {
  const names = new Set([...content.matchAll(/@([A-Za-z0-9_]{3,20})/g)].map((m) => m[1].toLowerCase()));
  for (const name of [...names].slice(0, 10)) {
    const u = get<{ id: number }>('SELECT id FROM users WHERE username = $n', { n: name });
    if (u && !skip.has(u.id)) notify(u.id, actorId, 'mention', postId);
  }
}

/* ---------------- 标签 ---------------- */

/** 正文里的 #话题 */
export const HASHTAG = /#([^\s#@，。！？、；：,.!?;:()（）「」[\]]{1,20})/g;

export function normalizeTag(t: string) {
  return t.trim().replace(/^#+/, '').toLowerCase().slice(0, 20);
}

export function extractTags(content: string, extra: string[] = []) {
  const all = [...extra, ...[...content.matchAll(HASHTAG)].map((m) => m[1])].map(normalizeTag).filter(Boolean);
  return [...new Set(all)].slice(0, 8);
}

/* ---------------- 发布 ---------------- */

/**
 * 帖子通过审核（或无需审核）时执行：回复数 +1、顶帖、发通知。
 * 审核中的帖子不会触发这些，所以别人不会提前收到通知。
 */
export function publishEffects(postId: number) {
  const p = get<{
    author_id: number; parent_id: number | null; content: string;
    quote_author_id: number | null; can_notify_quote: number | null;
  }>(
    `SELECT p.author_id, p.parent_id, p.content, s.author_id AS quote_author_id,
       (${publicPost('p')} AND ${publicPost('s')}) AS can_notify_quote
     FROM posts p LEFT JOIN post_quotes q ON q.post_id = p.id LEFT JOIN posts s ON s.id = q.quoted_id
     WHERE p.id = $id`,
    { id: postId },
  );
  if (!p) return;
  let parentAuthor = 0;
  if (p.parent_id) {
    const parent = get<{ id: number; author_id: number; root_id: number | null }>(
      'SELECT id, author_id, root_id FROM posts WHERE id = $id',
      { id: p.parent_id },
    );
    if (parent) {
      parentAuthor = parent.author_id;
      run('UPDATE posts SET reply_count = reply_count + 1 WHERE id = $id', { id: parent.id });
      // 贴吧式「顶帖」：回复会把主楼顶上去
      run('UPDATE posts SET last_activity_at = $t WHERE id = $id', { t: now(), id: parent.root_id ?? parent.id });
      notify(parent.author_id, p.author_id, 'reply', postId);
    }
  }
  const skip = new Set([p.author_id, parentAuthor]);
  if (p.quote_author_id !== null) {
    skip.add(p.quote_author_id);
    if (p.can_notify_quote) notify(p.quote_author_id, p.author_id, 'quote', postId);
  }
  notifyMentions(p.content, p.author_id, postId, skip);
  grantForPost(postId);
  eventRewardForPost(postId);
  for (const hook of publishHooks) hook(postId, p.author_id, p.content, parentAuthor);
}

/** 帖子公开后要做的额外事情（AI 助手被 @ 了就去回复）。在事务里调用，钩子自己负责异步 */
export const publishHooks: ((postId: number, authorId: number, content: string, parentAuthorId: number) => void)[] = [];

/** 撤回已发布的效果（管理员把通过的帖子改判为不通过时） */
export function unpublishEffects(postId: number) {
  const p = get<{ parent_id: number | null }>('SELECT parent_id FROM posts WHERE id = $id', { id: postId });
  if (p?.parent_id) {
    run('UPDATE posts SET reply_count = MAX(reply_count - 1, 0) WHERE id = $id', { id: p.parent_id });
  }
  run("DELETE FROM notifications WHERE post_id = $id AND type IN ('reply', 'mention', 'quote')", { id: postId });
  revokeForPost(postId);
  revokeCrystalsForPost(postId);
}

/* ---------------- 拉黑 ---------------- */

export function blockState(meId: number, otherId: number) {
  const r = get<{ mine: number; theirs: number }>(
    `SELECT EXISTS(SELECT 1 FROM blocks WHERE blocker_id = $me AND blocked_id = $o) AS mine,
            EXISTS(SELECT 1 FROM blocks WHERE blocker_id = $o AND blocked_id = $me) AS theirs`,
    { me: meId, o: otherId },
  );
  return { iBlocked: !!r?.mine, blockedMe: !!r?.theirs };
}

/** 任何一方拉黑了另一方，就不能回复、赞、回应、转发、引用、关注、私信 */
export function assertCanInteract(meId: number, otherId: number) {
  if (meId === otherId) return;
  const s = blockState(meId, otherId);
  if (s.iBlocked) throw new HttpError(403, '你已拉黑这位同学，解除拉黑后才能互动');
  if (s.blockedMe) throw new HttpError(403, '对方设置了不接受你的互动');
}

/* ---------------- 吧务权限 ---------------- */

/** 'owner' 吧主 / 'mod' 吧务 / 'admin' 站点管理员（没有吧内身份时）/ null */
export function boardRole(boardId: number | null, user: { id: number; role: string }) {
  if (!boardId) return user.role === 'admin' ? 'admin' : null;
  const r = get<{ owner_id: number | null; is_mod: number }>(
    `SELECT owner_id, EXISTS(SELECT 1 FROM board_mods WHERE board_id = $b AND user_id = $u) AS is_mod FROM boards WHERE id = $b`,
    { b: boardId, u: user.id },
  );
  if (r?.owner_id === user.id) return 'owner';
  if (r?.is_mod) return 'mod';
  return user.role === 'admin' ? 'admin' : null;
}

/** 能不能看到这个吧：公开吧所有人；私密吧只有吧主、吧务、可见成员和站点管理员 */
export function canViewBoard(boardId: number, user: { id: number; role: string }) {
  const b = get<{ visibility: string }>('SELECT visibility FROM boards WHERE id = $b', { b: boardId });
  if (!b) return false;
  if (b.visibility !== 'private' || boardRole(boardId, user)) return true;
  return !!get('SELECT 1 FROM board_viewers WHERE board_id = $b AND user_id = $u', { b: boardId, u: user.id });
}
