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

const defaultBase = import.meta.env.VITE_API_BASE;
export let API_BASE = IS_APP_BUILD
  ? serverOrigin(safeGet(SERVER_KEY)) ?? serverOrigin(defaultBase) ?? ''
  : (defaultBase ?? '').replace(/\/$/, '');

/** 分享链接指向站点，而不是 App 内 WebView 的地址。 */
export let WEB_ORIGIN = API_BASE || window.location.origin;

// 不把一个站点签发的 token 发给另一个站点。
const TOKEN_KEY = IS_APP_BUILD ? `txq_token:${API_BASE}` : 'txq_token';
let token: string | null = safeGet(TOKEN_KEY);

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
  token = t;
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
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
    throw new ApiError(data?.error ?? `请求失败 (${res.status})`, res.status, data ?? {});
  }
  return data as T;
}

export function media(p?: string | null) {
  if (!p) return undefined;
  return /^(https?:|data:|blob:)/.test(p) ? p : API_BASE + p;
}

export async function uploadImage(file: File): Promise<string> {
  const { prepareImage } = await import('./image');
  const form = new FormData();
  form.append('file', await prepareImage(file));
  const r = await api<{ url: string }>('/upload', { form });
  return r.url;
}

/* ---------------- 类型 ---------------- */

export type AvatarDecoration = '' | 'halo' | 'aurora' | 'rose';

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
}

export interface BoardRef {
  slug: string;
  name: string;
  icon: string;
}

export interface Board extends BoardRef {
  id: number;
  description: string;
  createdBy: number | null;
  ownerId: number | null;
  visibility: 'public' | 'private';
  memberCount: number;
  postCount: number;
  joined: boolean;
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
  repostCount: number;
  viewCount: number;
  liked: boolean;
  reposted: boolean;
  /** 自己加了书签 */
  bookmarked: boolean;
  deleted: boolean;
  createdAt: number;
  tags: string[];
  reactions: Reaction[];
  pinned: boolean;
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
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface Notification {
  id: number;
  type: 'like' | 'reply' | 'repost' | 'quote' | 'follow' | 'mention' | 'reaction' | 'moderation';
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
