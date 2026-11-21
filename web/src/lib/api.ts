// 后端地址：Web 同域部署留空；原生 App 打包时通过 VITE_API_BASE 指定
export const API_BASE = ((import.meta.env.VITE_API_BASE as string | undefined) ?? '').replace(/\/$/, '');

/** 用于生成分享链接：原生 App 里 location 是 capacitor://localhost，要用服务器地址 */
export const WEB_ORIGIN = API_BASE || window.location.origin;

const TOKEN_KEY = 'txq_token';
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

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

type Opts = { method?: string; body?: unknown; form?: FormData };

export async function api<T = unknown>(path: string, opts: Opts = {}): Promise<T> {
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
    throw new ApiError('网络连接失败，请检查网络', 0);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && token) {
      setToken(null);
      window.dispatchEvent(new Event('auth:expired'));
    }
    throw new ApiError(data?.error ?? `请求失败 (${res.status})`, res.status);
  }
  return data as T;
}

export function media(p?: string | null) {
  if (!p) return undefined;
  return /^(https?:|data:|blob:)/.test(p) ? p : API_BASE + p;
}

export async function uploadImage(file: File): Promise<string> {
  const form = new FormData();
  form.append('file', file);
  const r = await api<{ url: string }>('/upload', { form });
  return r.url;
}

/* ---------------- 类型 ---------------- */

export interface UserLite {
  id: number;
  username: string;
  displayName: string;
  avatar: string | null;
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
  memberCount: number;
  postCount: number;
  joined: boolean;
}

/** 吧详情页：吧主、吧务、公告、我的身份 */
export interface BoardDetail extends Board {
  owner: User | null;
  mods: User[];
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
  deleted: boolean;
  createdAt: number;
  tags: string[];
  reactions: Reaction[];
  pinned: boolean;
  /** 我是这条帖子所在吧的吧主 / 吧务 */
  canModerate: boolean;
  repostOf: Post | null;
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
  type: 'like' | 'reply' | 'repost' | 'follow' | 'mention' | 'reaction';
  read: boolean;
  /** reaction：用的哪个表情 */
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
