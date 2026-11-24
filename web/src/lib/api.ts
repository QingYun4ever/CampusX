const mode = import.meta.env.MODE;
export const IS_APP_BUILD = mode === 'app' || mode === 'app-debug';
export const ALLOWS_HTTP_SERVER = mode === 'app-debug';
const SERVER_KEY = 'txq_app_server';

function serverOrigin(value?: string | null) {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && !(ALLOWS_HTTP_SERVER && url.protocol === 'http:')) return null;
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
  return url.origin;
}

/** App 默认连接的服务器；打包时可以用 VITE_API_BASE 换成别的站点，用户也能在登录页自己改 */
export const DEFAULT_APP_SERVER = 'https://www.cjlwall.cc';
const defaultBase = import.meta.env.VITE_API_BASE;
export let API_BASE = IS_APP_BUILD
  ? serverOrigin(safeGet(SERVER_KEY)) ?? serverOrigin(defaultBase) ?? DEFAULT_APP_SERVER
  : (defaultBase ?? '').replace(/\/$/, '');

/** 分享链接指向站点，而不是 App 内 WebView 的地址。 */
export let WEB_ORIGIN = API_BASE || window.location.origin;

// 不把一个站点签发的 token 发给另一个站点。
const TOKEN_KEY = IS_APP_BUILD ? `txq_token:${API_BASE}` : 'txq_token';
let token: string | null = safeGet(TOKEN_KEY);
let mediaSession = new AbortController();

function safeGet(k: string) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}

export function getToken() {
  return token;
}

export function setToken(t: string | null) {
  const changed = token !== t;
  token = t;
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
  if (changed) {
    const previous = mediaSession;
    mediaSession = new AbortController();
    previous.abort();
    window.dispatchEvent(new Event('auth:media-session'));
  }
}

const NOT_CAMPUS = '这个地址不是校墙服务器，请检查服务器地址或反向代理配置';

function parseServer(value: string) {
  const origin = serverOrigin(value);
  if (!origin) {
    throw new Error(ALLOWS_HTTP_SERVER ? '请输入完整的 HTTP 或 HTTPS 地址，不带路径' : '请输入完整的 HTTPS 地址，不带路径');
  }
  return origin;
}

/** 保存前先确认这个地址真的是校墙：/api/health 要返回 { ok: true } */
export async function probeServer(value: string) {
  const origin = parseServer(value);
  let res: Response;
  try {
    res = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(8000) });
  } catch {
    // 别的网站一般不带校墙的跨域头，在 App 里同样表现为请求失败
    throw new Error('连不上这个地址，或者它不是校墙服务器');
  }
  const data = await res.json().catch(() => null);
  if (data?.ok !== true) throw new Error(res.status >= 500 ? `服务器暂时不可用（${res.status}）` : NOT_CAMPUS);
  return origin;
}

export function setAppServerAddress(value: string) {
  const origin = parseServer(value);
  if (origin === API_BASE) return false;
  try {
    localStorage.setItem(SERVER_KEY, origin);
  } catch {
    throw new Error('无法保存服务器地址');
  }
  setToken(null);
  API_BASE = WEB_ORIGIN = origin;
  return true;
}

export class ApiError extends Error {
  status: number;
  /** 服务端随错误返回的其他字段 */
  data: Record<string, unknown>;
  constructor(message: string, status: number, data: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

type Opts = { method?: string; body?: unknown; form?: FormData };

export async function api<T = unknown>(path: string, opts: Opts = {}): Promise<T> {
  if (IS_APP_BUILD && !API_BASE) throw new ApiError('请先在登录页设置服务器地址', 0);
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api${path}`, { method: opts.method ?? (body ? 'POST' : 'GET'), headers, body });
  } catch {
    // App 里连到别的网站（没有校墙的跨域头）也会落到这里，所以一并提示检查地址
    throw new ApiError(IS_APP_BUILD ? '连不上服务器，请检查网络和服务器地址' : '网络连接失败，请检查网络', 0);
  }
  const text = await res.text().catch(() => '');
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // 拿到的不是 JSON（常见是一整页 HTML）：地址指到了别的网站，或者反向代理把 /api 转错了地方
    throw new ApiError(res.status >= 500 ? `服务器暂时不可用（${res.status}）` : NOT_CAMPUS, res.status);
  }
  if (!res.ok) {
    if (res.status === 401 && token) {
      setToken(null);
      window.dispatchEvent(new Event('auth:expired'));
    }
    // 服务器在维护：App 换成维护页，直到解除
    if (res.status === 503 && data?.maintenance) {
      window.dispatchEvent(new CustomEvent('site:maintenance', { detail: data.maintenance }));
    }
    throw new ApiError(data?.error ?? `请求失败 (${res.status})`, res.status, data ?? {});
  }
  return data as T;
}

export function getMediaSession() {
  return mediaSession.signal;
}

export function subscribeMediaSession(listener: () => void) {
  window.addEventListener('auth:media-session', listener);
  return () => window.removeEventListener('auth:media-session', listener);
}

/** 本站上传的图片地址；App 内的相对路径指向所选站点。 */
export function siteMediaUrl(source?: string | null) {
  if (!source) return undefined;
  try {
    const { origin } = new URL(API_BASE || window.location.origin, window.location.href);
    const url = new URL(source, `${origin}/`);
    if (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      (url.origin === origin || url.origin === window.location.origin) &&
      !url.username && !url.password && url.pathname.startsWith('/uploads/')
    ) {
      return origin + url.pathname + (url.pathname.startsWith('/uploads/s/') ? url.search : '');
    }
  } catch {
    return undefined;
  }
}

/** 站内图片按需生成缩略图；正文 GIF 保留动画，头像 GIF 可用静态预览。 */
export function thumb(source: string, kind: 'post' | 'avatar' = 'post') {
  const match = siteMediaUrl(source)?.match(/\/uploads\/([\w-]+\.(jpg|png|webp|gif))$/);
  if (!match) return source;
  if (kind === 'avatar') return `/uploads/a/${match[1]}`;
  // 旧地址可能已经把并发时退回的原图缓存一年。
  return match[2] === 'gif' ? source : `/uploads/s/${match[1]}?v=2`;
}

export async function uploadImage(file: File): Promise<string> {
  const { prepareImage } = await import('./image');
  const form = new FormData();
  form.append('file', await prepareImage(file));
  const r = await api<{ url: string }>('/upload', { form });
  return r.url;
}

/* ---------------- 类型 ---------------- */

export type AvatarDecoration =
  | '' | 'halo' | 'aurora' | 'rose' | 'prism' | 'neon' | 'stars' | 'sakura' | 'neko' | 'snow'
  | 'maple' | 'bubble' | 'orbit' | 'hearts' | 'flame' | 'thunder' | 'crown';

export interface UserLite {
  id: number;
  username: string;
  displayName: string;
  avatar: string | null;
  avatarDecoration: AvatarDecoration;
  role: 'user' | 'admin' | string;
  className: string;
  verified?: boolean;
  verifiedNote?: string;
  /** 作者在帖子所在吧的身份（只在帖子里有） */
  boardRole?: 'owner' | 'mod' | null;
  /** 作者在帖子所在吧的等级（只在帖子里有；退出了吧或不在吧里时为 null） */
  level?: LevelInfo | null;
  /** 我拉黑了作者（只在帖子里有） */
  blocked?: boolean;
}

export interface LevelInfo {
  level: number;
  title: string;
}

/** 我在某个吧的经验和签到 */
export interface MyLevel extends LevelInfo {
  exp: number;
  /** 当前等级的起点和下一级门槛（满级时 nextExp 为 null） */
  levelExp: number;
  nextExp: number | null;
  checkedIn: boolean;
  streak: number;
  checkinTotal: number;
  nextCheckinExp: number;
}

export interface User extends UserLite {
  bio: string;
  banner: string | null;
  gradYear: number | null;
  createdAt: number;
  isFollowing?: boolean;
  /** 只有 /auth/me 返回：还没同意最新的用户协议 */
  termsPending?: boolean;
}

export interface Profile extends User {
  followers: number;
  following: number;
  postsCount: number;
  followsYou: boolean;
  isFollowing: boolean;
  /** 我拉黑了他 */
  blocked: boolean;
  /** 等级最高的几个吧 */
  boardLevels: (LevelInfo & { slug: string; name: string; icon: string; avatar: string | null; exp: number })[];
}

export interface BoardRef {
  slug: string;
  name: string;
  icon: string;
}

export interface Board extends BoardRef {
  id: number;
  description: string;
  avatar: string | null;
  createdBy: number | null;
  ownerId: number | null;
  visibility: 'public' | 'private';
  memberCount: number;
  postCount: number;
  joined: boolean;
  /** 加入了才有 */
  myLevel: (LevelInfo & { checkedIn: boolean }) | null;
}

/** 吧详情页：吧主、吧务、公告、我的身份 */
export interface BoardDetail extends Board {
  owner: User | null;
  mods: User[];
  viewerCount: number;
  /** 包括回复和未公开的帖子，仅删除人可见 */
  deletePostCount: number | null;
  announcement: { text: string; updatedAt: number; by: User | null } | null;
  /** owner 吧主 / mod 吧务 / admin 站点管理员 / null 普通成员 */
  myRole: 'owner' | 'mod' | 'admin' | null;
  /** 18 个等级的经验门槛和头衔；custom 是吧主改过的（空字符串 = 默认） */
  levels: { exp: number[]; titles: string[]; defaults: string[]; custom: string[] };
  /** 没加入时为 null */
  me: MyLevel | null;
}

export interface RankingItem extends LevelInfo {
  rank: number;
  user: User;
  exp: number;
}

export interface SiteStats {
  online: number;
  onlineUsers: User[];
  users: number;
  posts: number;
  postsToday: number;
  boards: number;
}

export interface QuotePreview {
  id: number;
  content: string;
  images: string[];
  createdAt: number;
  author: Pick<UserLite, 'id' | 'username' | 'displayName' | 'avatar' | 'avatarDecoration' | 'role' | 'verified' | 'verifiedNote'>;
  /** 原帖作者被我拉黑了 */
  blocked?: boolean;
}

export interface Post {
  id: number;
  author: UserLite;
  board: BoardRef | null;
  parentId: number | null;
  rootId: number | null;
  parentUsername: string | null;
  content: string;
  images: string[];
  likeCount: number;
  replyCount: number;
  /** 详情页回复列表里：楼主（和 AI 助手）在这条评论下的回复，最多 2 条 */
  opReplies?: Post[];
  repostCount: number;
  viewCount: number;
  /** 收到的紫水晶打赏（老服务器没有） */
  tipTotal?: number;
  liked: boolean;
  reposted: boolean;
  /** 自己加了书签 */
  bookmarked: boolean;
  deleted: boolean;
  createdAt: number;
  tags: string[];
  reactions: Reaction[];
  pinned: boolean;
  /** 首页里插进来的推流帖子 */
  boosted?: boolean;
  /** 刚发的帖子参加了活动（已提交审核），审核通过后能拿到的紫水晶 */
  eventEntries?: { title: string; reward: number }[];
  /** 我是这条帖子所在吧的吧主 / 吧务 */
  canModerate: boolean;
  repostOf: Post | null;
  canQuote: boolean;
  quote: { post: QuotePreview | null } | null;
}

export interface Reaction {
  /** emoji 本身 */
  key: string;
  count: number;
  me: boolean;
  /** 最近回应的几个人 */
  users: { username: string; displayName: string; avatar: string | null }[];
}

/**
 * Telegram 式表情回应：每人每帖一个，换一个会替换。顺序就是选择面板里的顺序，前 7 个是快捷栏。
 * 服务端 serialize.ts 里有同样的列表。
 */
export const REACTIONS = [
  '👍', '👎', '❤️', '🔥', '🥰', '👏', '😁', '🤔', '🤯', '😱', '😢', '🎉', '🤩', '🙏', '👌', '😍',
  '🤣', '💯', '⚡', '🏆', '💔', '🤨', '😐', '😭', '🤓', '👻', '👀', '🙈', '😇', '😨', '🤝', '✍️',
  '🤗', '🫡', '💅', '🤪', '🗿', '🆒', '💘', '🦄', '😘', '😎', '🤷', '😡', '🥱', '🥴', '🌚', '🐳',
  '🍓', '🍾', '🎃', '❤️‍🔥',
];
export const QUICK_REACTIONS = REACTIONS.slice(0, 7);

/* ---------- 私信 ---------- */
export interface DmUser extends User {
  lastSeenAt: number | null;
}
export interface DmMessage {
  id: number;
  senderId: number;
  content: string;
  images: string[];
  deleted: boolean;
  createdAt: number;
  /** 前端发送中 / 发送失败 */
  pending?: boolean;
  failed?: boolean;
}
export interface Conversation {
  peer: DmUser;
  unread: number;
  last: DmMessage & { read: boolean };
}
export interface ChatPage {
  peer: DmUser;
  messages: DmMessage[];
  hasMore: boolean;
  peerReadUpTo: number;
  deletedIds: number[];
  block: { iBlocked: boolean; blockedMe: boolean };
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface Notification {
  id: number;
  type: 'like' | 'reply' | 'repost' | 'quote' | 'follow' | 'mention' | 'reaction' | 'moderation' | 'report' | 'tip' | 'boost' | 'event' | 'invite';
  read: boolean;
  /** reaction：用的哪个表情；moderation：JSON { reason, excerpt, warnings } */
  extra?: string;
  createdAt: number;
  actor: User;
  post: Post | null;
}

export interface Invite {
  code: string;
  note: string;
  maxUses: number;
  usedCount: number;
  expiresAt: number | null;
  createdAt: number;
  creator: string | null;
}

/* ---------- 拉黑、举报、自定义表情 ---------- */

export interface BlockedUser extends User {
  blockedAt: number;
}

/** 紫水晶钱包 */
export interface Wallet {
  balance: number;
  checkedIn: boolean;
  streak: number;
  checkinReward: number;
  likedToday: number;
  rules: {
    checkinBase: number;
    checkinStreakMax: number;
    liked: number;
    likedDailyCap: number;
    newAccountDays: number;
    tipAmounts: number[];
    tipDailyCap: number;
    boostAmounts?: number[];
    boostReachPer?: number;
    boostDailyCap?: number;
  };
  /** 活动期间签到的倍数（老服务器没有） */
  checkinBonus?: number;
  tasks: { id: string; title: string; reward: number; done: boolean; claimed: boolean }[];
  decorations: { prices: Record<string, number>; owned: string[] };
}

export interface CrystalEntry {
  id: number;
  kind: 'checkin' | 'liked' | 'task' | 'buy' | 'tip_in' | 'tip_out' | 'revoke' | 'boost' | 'boost_refund' | 'event' | 'invite' | 'admin';
  ref: string;
  /** 活动名 */
  note?: string | null;
  delta: number;
  postId: number | null;
  createdAt: number;
}

/** 一条帖子的推流情况 */
/** 我的邀请码和邀请来的人 */
export interface InviteInfo {
  enabled: boolean;
  canCreate: boolean;
  code: string | null;
  rules: { reward: number; activeDays: number; maxRewarded: number; maxInvites: number };
  earned: number;
  rewardedCount: number;
  people: {
    id: number;
    username: string;
    displayName: string;
    avatar: string | null;
    avatarDecoration: AvatarDecoration;
    joinedAt: number;
    checkinDays: number;
    status: 'waiting' | 'rewarded' | 'none';
    reward: number;
  }[];
}

export interface BoostStatus {
  reach: number;
  shown: number;
  active: boolean;
  /** 还能再推给多少人（最近两周活跃、还没看过的；老服务器没有） */
  room?: number;
  mine: { id: number; amount: number; reach: number; shown: number; createdAt: number; expiresAt: number; endedAt: number | null; refund: number }[];
}

/** 管理员办的活动 */
export interface CampusEvent {
  id: number;
  title: string;
  body: string;
  tag: string;
  postReward: number;
  checkinBonus: number;
  startsAt: number;
  endsAt: number;
  status: 'upcoming' | 'active' | 'ended';
  posts: number;
  people: number;
  me: {
    posted: boolean;
    rewarded: number;
    /** 最近一次提交的审核状态（已经拿到奖励时为 null） */
    review: { status: 'pending' | 'approved' | 'rejected'; note: string } | null;
  };
}

/** 后台：一条待审核的活动参与 */
export interface EventEntry {
  id: number;
  status: 'pending' | 'approved' | 'rejected';
  reward: number;
  note: string;
  createdAt: number;
  reviewedAt: number | null;
  event: { id: number; title: string; tag: string };
  user: User | null;
  post: Post | null;
}

export interface CustomEmoji {
  id: number;
  /** 文件名，正文里写成 [e:文件名] */
  file: string;
  /** 从别人那里收藏来的：最初那个表情的文件名 */
  origin?: string | null;
  url: string;
  name: string;
  animated: boolean;
  createdAt: number;
}

export interface ReportGroup {
  /** 老服务器不提供批次版本，不能从后台处理。 */
  batchId?: number;
  revision?: number;
  targetType: 'post' | 'user';
  targetId: number;
  count: number;
  firstAt: number;
  lastAt: number;
  status: 'open' | 'resolved' | 'dismissed';
  handledAt: number | null;
  target:
    | { id: number; excerpt: string; images: string[]; deleted: boolean; isReply: boolean; isRepost?: boolean; author: User }
    | { user: User }
    | null;
  /** 当前管理员无权查看举报人、说明或处理这批举报。 */
  involvesMe?: boolean;
  identityUnknown?: boolean;
  reports: { reason: string; reasonText: string; note: string; createdAt: number; reporter: { username: string; displayName: string } | null }[];
}

/* ---------- 维护、公告、AI 助手 ---------- */

export interface Announcement {
  id: number;
  title: string;
  body: string;
  link: string;
  createdAt: number;
  expiresAt: number | null;
  active: boolean;
  author: string | null;
}

export interface MaintenanceConfig {
  enabled: boolean;
  message: string;
  until: number | null;
  since: number | null;
}

export interface AssistantConfig {
  enabled: boolean;
  username: string;
  displayName: string;
  model: string;
  persona: string;
  dailyLimit: number;
  botId: number | null;
  provider: 'anthropic' | 'openai';
  defaultModel: string;
  hasKey: boolean;
}
