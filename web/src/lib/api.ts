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
  memberCount: number;
  postCount: number;
  joined: boolean;
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
  liked: boolean;
  reposted: boolean;
  deleted: boolean;
  createdAt: number;
  tags: string[];
  reactions: Reaction[];
  repostOf: Post | null;
}

export interface Reaction {
  key: string;
  count: number;
  me: boolean;
}

/** 和 GitHub 一样的 8 个表情回应 */
export const REACTIONS: { key: string; emoji: string; name: string }[] = [
  { key: '+1', emoji: '👍', name: '赞同' },
  { key: '-1', emoji: '👎', name: '反对' },
  { key: 'laugh', emoji: '😄', name: '笑' },
  { key: 'hooray', emoji: '🎉', name: '庆祝' },
  { key: 'confused', emoji: '😕', name: '疑惑' },
  { key: 'heart', emoji: '❤️', name: '爱心' },
  { key: 'rocket', emoji: '🚀', name: '火箭' },
  { key: 'eyes', emoji: '👀', name: '围观' },
];

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface Notification {
  id: number;
  type: 'like' | 'reply' | 'repost' | 'follow' | 'mention';
  read: boolean;
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
