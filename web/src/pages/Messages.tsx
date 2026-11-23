/**
 * 私信，仿 Telegram：左边聊天列表，右边对话。手机上一次只显示一边。
 * 新消息靠轮询（打开的对话 2.5 秒，列表 8 秒），对方读过的消息显示双勾。
 */
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, ArrowLeft, Check, CheckCheck, Clock, Copy, ImagePlus, MessageSquarePlus, Search, Send, Trash2, Undo2 } from 'lucide-react';
import { EmojiPicker } from '../components/EmojiPicker';
import { PlainText } from '../components/PostCard';
import { useBlockToggle } from '../components/Safety';
import { emojiText } from '../lib/customEmoji';
import { Avatar, Empty, Modal, Spinner, toast, Verified } from '../components/ui';
import { isAndroid } from '../lib/android';
import { api, type ChatPage, type Conversation, type DmMessage, type DmUser, type Page, type User } from '../lib/api';
import { useMe } from '../lib/auth';
import { useEscape } from '../lib/escape';
import { DmImage, DM_IMAGE_LIMIT, DM_IMAGE_MAX_BYTES, DM_IMAGE_TYPES } from './DmImage';
import './dm-media.css';

/* ---------- 时间显示 ---------- */
const pad = (n: number) => String(n).padStart(2, '0');
const hm = (ts: number) => {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const dayKey = (ts: number) => new Date(ts).toDateString();
function dayLabel(ts: number) {
  const d = new Date(ts);
  const today = new Date();
  const y = new Date(Date.now() - 86400_000);
  if (d.toDateString() === today.toDateString()) return '今天';
  if (d.toDateString() === y.toDateString()) return '昨天';
  return d.getFullYear() === today.getFullYear()
    ? `${d.getMonth() + 1}月${d.getDate()}日`
    : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}
function listTime(ts: number) {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return hm(ts);
  const days = (now.getTime() - ts) / 86400_000;
  if (days < 6) return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  return d.getFullYear() === now.getFullYear() ? `${d.getMonth() + 1}/${d.getDate()}` : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}
const ONLINE = 5 * 60_000;
const isOnline = (u: DmUser) => !!u.lastSeenAt && Date.now() - u.lastSeenAt < ONLINE;
function lastSeen(u: DmUser) {
  if (!u.lastSeenAt) return '很久没上线';
  const diff = Date.now() - u.lastSeenAt;
  if (diff < ONLINE) return '在线';
  const m = Math.floor(diff / 60000);
  if (m < 60) return `${m} 分钟前在线`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前在线`;
  return `${dayLabel(u.lastSeenAt)}在线`;
}

/* ---------- 聊天列表 ---------- */
function useConversations() {
  return useQuery({
    queryKey: ['dm-convs'],
    queryFn: () => api<Conversation[]>('/dm/conversations'),
    refetchInterval: 8000,
  });
}

function NewChat({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const me = useMe();
  const [q, setQ] = useState('');
  const kw = q.trim();
  const r = useQuery({
    queryKey: ['dm-user-search', kw],
    queryFn: () => api<Page<User>>(`/search?type=users&q=${encodeURIComponent(kw)}`),
    enabled: !!kw,
  });
  const users = (r.data?.items ?? []).filter((u) => u.id !== me.id);
  return (
    <Modal title="新的私信" onClose={onClose} className="new-chat">
      <div className="modal-body" style={{ paddingBottom: 8 }}>
        <label className="search-box">
          <Search size={18} />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索名字、用户名或班级" aria-label="搜索同学" />
        </label>
      </div>
      {!kw ? (
        <p className="muted center small" style={{ padding: '12px 16px 24px' }}>
          输入名字找到要私信的同学
        </p>
      ) : r.isPending ? (
        <Spinner />
      ) : !users.length ? (
        <Empty title="没找到" />
      ) : (
        users.map((u) => (
          <button
            key={u.id}
            className="user-row"
            style={{ width: '100%', textAlign: 'left' }}
            onClick={() => {
              onClose();
              nav(`/messages/${u.username}`);
            }}
          >
            <Avatar src={u.avatar} name={u.displayName} size={40} decoration={u.avatarDecoration} />
            <div style={{ minWidth: 0 }}>
              <div className="name">
                <span className="ellipsis" data-admin={u.role === 'admin' || undefined}>{u.displayName}</span>
                <Verified user={u} size={15} />
              </div>
              <div className="muted small ellipsis">
                @{u.username}
                {u.className && ` · ${u.className}`}
              </div>
            </div>
          </button>
        ))
      )}
    </Modal>
  );
}

function ChatList({ active }: { active?: string }) {
  const me = useMe();
  const q = useConversations();
  const [filter, setFilter] = useState('');
  const [picking, setPicking] = useState(false);
  const f = filter.trim().toLowerCase();
  const items = (q.data ?? []).filter(
    (c) => !f || c.peer.displayName.toLowerCase().includes(f) || c.peer.username.toLowerCase().includes(f),
  );
  return (
    <aside className="dm-list">
      <div className="dm-list-head">
        <h1>私信</h1>
        <button className="icon-btn" onClick={() => setPicking(true)} aria-label="新的私信" title="新的私信">
          <MessageSquarePlus size={20} />
        </button>
      </div>
      <div className="dm-search">
        <label className="search-box">
          <Search size={16} />
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="搜索" aria-label="搜索聊天" />
        </label>
      </div>
      <div className="dm-items">
        {q.isPending ? (
          <Spinner />
        ) : !items.length ? (
          f ? (
            <p className="muted center small" style={{ padding: 24 }}>
              没有匹配的聊天
            </p>
          ) : (
            <div className="dm-list-empty">
              <p>还没有私信</p>
              <button className="btn btn-primary sm" onClick={() => setPicking(true)}>
                给同学发一条
              </button>
            </div>
          )
        ) : (
          items.map((c, i) => {
            const mine = c.last.senderId === me.id;
            return (
              <Link
                key={c.peer.id}
                to={`/messages/${c.peer.username}`}
                className={`dm-item ${active === c.peer.username ? 'active' : ''}`}
                style={{ '--i': i } as CSSProperties}
              >
                <span className="dm-ava">
                  <Avatar src={c.peer.avatar} name={c.peer.displayName} size={50} decoration={c.peer.avatarDecoration} />
                  {isOnline(c.peer) && <i className="online-dot" />}
                </span>
                <span className="dm-item-main">
                  <span className="dm-item-top">
                    <span className="name">
                      <span className="ellipsis" data-admin={c.peer.role === 'admin' || undefined}>{c.peer.displayName}</span>
                      <Verified user={c.peer} size={15} />
                    </span>
                    <span className="dm-time">
                      {mine && !c.last.deleted && (c.last.read ? <CheckCheck size={15} className="tick read" /> : <Check size={15} className="tick" />)}
                      {listTime(c.last.createdAt)}
                    </span>
                  </span>
                  <span className="dm-item-bottom">
                    <span className="dm-preview">
                      {mine && <span className="dm-you">你：</span>}
                      {c.last.deleted ? <i>消息已撤回</i> : emojiText(c.last.content) || (c.last.images?.length ? '[图片]' : '')}
                    </span>
                    {c.unread > 0 && <span className="dm-unread">{c.unread > 99 ? '99+' : c.unread}</span>}
                  </span>
                </span>
              </Link>
            );
          })
        )}
      </div>
      {picking && <NewChat onClose={() => setPicking(false)} />}
    </aside>
  );
}

/* ---------- 对话 ---------- */

const MESSAGE_MAX_LENGTH = 2000;
type ChatMessage = DmMessage & { localImages?: File[] };

const recalled = (m: ChatMessage): ChatMessage => ({ ...m, deleted: true, content: '', images: [], localImages: undefined });

/** 已发出的按 id 排序，发送中 / 失败的放在最后 */
const normalize = (list: ChatMessage[]) => [
  ...list.filter((m) => !m.pending && !m.failed).sort((a, b) => a.id - b.id),
  ...list.filter((m) => m.pending || m.failed),
];
function merge(list: ChatMessage[], incoming: DmMessage[]) {
  const byId = new Map(list.map((m) => [m.id, m]));
  for (const m of incoming) {
    if (!byId.has(m.id) || m.deleted) byId.set(m.id, m.deleted ? recalled(m) : m);
  }
  return normalize([...byId.values()]);
}

type Ctx = { id: number; x: number; y: number } | null;

function ChatView({ username }: { username: string }) {
  const me = useMe();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [peer, setPeer] = useState<DmUser | null>(null);
  const [block, setBlock] = useState<ChatPage['block'] | null>(null);
  const toggleBlock = useBlockToggle();
  const [msgs, setMsgs] = useState<ChatMessage[]>([]);
  const [readUpTo, setReadUpTo] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [ctx, setCtx] = useState<Ctx>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const emojiRange = useRef<[number, number] | null>(null);
  const localId = useRef(0);
  const stick = useRef(true);
  const prepend = useRef<{ height: number; top: number } | null>(null);
  const loadingOlder = useRef(false);
  // 发送响应可能先收到更大的 id；轮询只推进自己读过的游标。
  const pollCursor = useRef(0);

  const markRead = useCallback(() => {
    api(`/dm/with/${username}/read`, { method: 'POST' })
      .then(() => {
        qc.invalidateQueries({ queryKey: ['dm-unread'] });
        qc.invalidateQueries({ queryKey: ['dm-convs'] });
      })
      .catch(() => {});
  }, [username, qc]);

  // 首次加载
  useEffect(() => {
    let alive = true;
    stick.current = true;
    api<ChatPage>(`/dm/with/${username}`)
      .then((r) => {
        if (!alive) return;
        pollCursor.current = r.messages.at(-1)?.id ?? 0;
        setPeer(r.peer);
        setBlock(r.block);
        setMsgs(r.messages);
        setHasMore(r.hasMore);
        setReadUpTo(r.peerReadUpTo);
        setLoading(false);
        markRead();
      })
      .catch((e) => alive && (setError((e as Error).message), setLoading(false)));
    return () => {
      alive = false;
    };
  }, [username, markRead]);

  // 轮询新消息
  useEffect(() => {
    if (loading || error) return;
    let alive = true;
    let polling = false;
    const tick = async () => {
      if (polling || document.visibilityState === 'hidden') return;
      polling = true;
      try {
        const r = await api<ChatPage>(`/dm/with/${username}?after=${pollCursor.current}`);
        if (!alive) return;
        pollCursor.current = r.messages.at(-1)?.id ?? pollCursor.current;
        setPeer(r.peer);
        setBlock(r.block);
        setReadUpTo(r.peerReadUpTo);
        if (r.messages.length) {
          setMsgs((m) => merge(m, r.messages));
          if (r.messages.some((x) => x.senderId !== me.id)) markRead();
        }
        if (r.deletedIds.length) {
          const del = new Set(r.deletedIds);
          setMsgs((m) => (m.some((x) => del.has(x.id) && !x.deleted) ? m.map((x) => (del.has(x.id) ? recalled(x) : x)) : m));
        }
      } catch {
        /* 网络抖动，下次再试 */
      } finally {
        polling = false;
      }
    };
    const t = setInterval(tick, 2500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [username, loading, error, me.id, markRead]);

  // 滚动：往上加载旧消息时保持位置；在底部时跟随新消息
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (prepend.current != null) {
      el.scrollTop = prepend.current.top + el.scrollHeight - prepend.current.height;
      prepend.current = null;
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [msgs, loading]);

  // 输入栏或键盘改变可见高度时，原本在底部的会话继续显示最新消息。
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !('ResizeObserver' in window)) return;
    const observer = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [error]);

  const onScroll = async () => {
    const el = scroller.current!;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 120 && hasMore && !loadingOlder.current && msgs.length) {
      loadingOlder.current = true;
      try {
        const first = msgs.find((m) => m.id > 0)?.id ?? 0;
        const r = await api<ChatPage>(`/dm/with/${username}?before=${first}`);
        prepend.current = { height: el.scrollHeight, top: el.scrollTop };
        setHasMore(r.hasMore);
        setMsgs((m) => merge(m, r.messages));
      } finally {
        loadingOlder.current = false;
      }
    }
  };

  const send = async (retry?: ChatMessage) => {
    const text = retry ? retry.content : draft.trim();
    const attachments = retry ? retry.localImages : files;
    if (!text && !attachments?.length) return;
    if (!retry) {
      setDraft('');
      setFiles([]);
      emojiRange.current = null;
    }
    const temp: ChatMessage = {
      id: retry?.id ?? --localId.current,
      senderId: me.id,
      content: text,
      images: [],
      localImages: attachments?.length ? attachments : undefined,
      deleted: false,
      createdAt: retry?.createdAt ?? Date.now(),
      pending: true,
    };
    stick.current = true;
    setMsgs((m) => normalize(retry ? m.map((x) => (x.id === retry.id ? temp : x)) : [...m, temp]));
    try {
      let form: FormData | undefined;
      if (attachments?.length) {
        form = new FormData();
        form.set('content', text);
        for (const file of attachments) form.append('images', file);
      }
      const real = await api<DmMessage>(`/dm/with/${username}`, form ? { form } : { body: { content: text } });
      setMsgs((m) => normalize(m.some((x) => x.id === real.id) ? m.filter((x) => x.id !== temp.id) : m.map((x) => (x.id === temp.id ? real : x))));
      qc.invalidateQueries({ queryKey: ['dm-convs'] });
    } catch (e) {
      setMsgs((m) => m.map((x) => (x.id === temp.id ? { ...x, pending: false, failed: true } : x)));
      toast((e as Error).message, 'error');
    }
  };

  const chooseImages = (e: ChangeEvent<HTMLInputElement>) => {
    const chosen = Array.from(e.currentTarget.files ?? []);
    e.currentTarget.value = '';
    const accepted = chosen.filter((file) => DM_IMAGE_TYPES.includes(file.type) && file.size > 0 && file.size <= DM_IMAGE_MAX_BYTES);
    const slots = DM_IMAGE_LIMIT - files.length;
    if (accepted.length) setFiles([...files, ...accepted.slice(0, slots)]);
    if (accepted.length < chosen.length) toast('请选择不超过 8 MiB 的 JPG、PNG、WebP 或 GIF 图片', 'error');
    if (accepted.length > slots) toast(`每条消息最多可发 ${DM_IMAGE_LIMIT} 张图片`, 'error');
  };

  const saveEmojiRange = () => {
    const el = input.current;
    if (el) emojiRange.current = [el.selectionStart, el.selectionEnd];
  };
  const insertEmoji = (emoji: string) => {
    const el = input.current;
    if (!el) return;
    const [start, end] = emojiRange.current ?? [el.selectionStart, el.selectionEnd];
    emojiRange.current = null;
    if (el.value.length - (end - start) + emoji.length > MESSAGE_MAX_LENGTH) return;
    // 保持表情面板或输入框当前的焦点，不主动弹出键盘。
    el.setRangeText(emoji, start, end, 'end');
    setDraft(el.value);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  // 输入框随内容长高
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft]);

  useEscape(() => setCtx(null), ctx !== null);
  useEffect(() => {
    if (!ctx) return;
    const close = () => setCtx(null);
    const otherKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') close();
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', otherKey);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', otherKey);
    };
  }, [ctx]);

  const recall = async (m: DmMessage) => {
    setCtx(null);
    if (!confirm('撤回这条消息？双方都将看不到内容。')) return;
    try {
      await api(`/dm/messages/${m.id}`, { method: 'DELETE' });
      setMsgs((l) => l.map((x) => (x.id === m.id ? recalled(x) : x)));
      qc.invalidateQueries({ queryKey: ['dm-convs'] });
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const openCtx = (e: MouseEvent, m: DmMessage) => {
    if (m.deleted || m.pending || m.failed || (!m.content && m.senderId !== me.id)) return;
    e.preventDefault();
    setCtx({ id: m.id, x: Math.min(e.clientX, window.innerWidth - 180), y: Math.min(e.clientY, window.innerHeight - 110) });
  };
  const contextMessage = ctx ? msgs.find((m) => m.id === ctx.id && !m.deleted) : undefined;
  const canSend = !loading && (!!draft.trim() || files.length > 0);

  if (error) {
    return (
      <section className="dm-chat">
        <header className="dm-chat-head">
          <button className="icon-btn dm-back" onClick={() => nav('/messages')} aria-label="返回">
            <ArrowLeft size={20} />
          </button>
        </header>
        <Empty title="打不开这个对话">{error}</Empty>
      </section>
    );
  }

  return (
    <section className="dm-chat">
      <header className="dm-chat-head">
        <button className="icon-btn dm-back" onClick={() => nav('/messages')} aria-label="返回聊天列表">
          <ArrowLeft size={20} />
        </button>
        {peer && (
          <Link to={`/u/${peer.username}`} className="dm-peer">
            <span className="dm-ava">
              <Avatar src={peer.avatar} name={peer.displayName} size={40} decoration={peer.avatarDecoration} />
              {isOnline(peer) && <i className="online-dot" />}
            </span>
            <span style={{ minWidth: 0 }}>
              <span className="name">
                <span className="ellipsis" data-admin={peer.role === 'admin' || undefined}>{peer.displayName}</span>
                <Verified user={peer} size={15} />
              </span>
              <span className={`dm-status ${isOnline(peer) ? 'on' : ''}`}>{lastSeen(peer)}</span>
            </span>
          </Link>
        )}
      </header>

      <div className="dm-scroll" ref={scroller} onScroll={onScroll}>
        {loading ? (
          <Spinner />
        ) : !msgs.length ? (
          <div className="dm-hello">
            <Avatar src={peer?.avatar} name={peer?.displayName ?? ''} size={72} decoration={peer?.avatarDecoration} />
            <b data-admin={peer?.role === 'admin' || undefined}>{peer?.displayName}</b>
            <span>还没有消息，打个招呼吧 👋</span>
          </div>
        ) : (
          <div className="dm-msgs">
            {hasMore && <Spinner size={22} />}
            {msgs.map((m, i) => {
              const prev = msgs[i - 1];
              const next = msgs[i + 1];
              const newDay = !prev || dayKey(prev.createdAt) !== dayKey(m.createdAt);
              const near = (a?: DmMessage) => !!a && a.senderId === m.senderId && Math.abs(a.createdAt - m.createdAt) < 5 * 60_000;
              const first = newDay || !near(prev);
              const last = !near(next) || (!!next && dayKey(next.createdAt) !== dayKey(m.createdAt));
              const mine = m.senderId === me.id;
              const images = m.localImages ?? m.images;
              return (
                <Fragment key={m.id}>
                  {newDay && (
                    <div className="dm-day">
                      <span>{dayLabel(m.createdAt)}</span>
                    </div>
                  )}
                  <div
                    className={`bubble ${mine ? 'mine' : 'theirs'} ${first ? 'first' : ''} ${last ? 'last' : ''} ${m.deleted ? 'deleted' : ''} ${m.pending ? 'pending' : ''}`}
                    onContextMenu={(e) => openCtx(e, m)}
                  >
                    {m.deleted ? (
                      <span className="dm-text">
                        <Undo2 size={14} /> 消息已撤回
                      </span>
                    ) : (
                      <>
                        {!!images?.length && (
                          <div className="dm-image-grid" data-single={images.length === 1 || undefined}>
                            {images.map((source, index) => (
                              <DmImage key={index} source={source} number={index + 1} />
                            ))}
                          </div>
                        )}
                        {m.content && <PlainText text={m.content} />}
                      </>
                    )}
                    <span className="dm-meta">
                      {hm(m.createdAt)}
                      {mine &&
                        (m.failed ? (
                          <button className="dm-retry" onClick={() => send(m)} title="发送失败，点击重试" aria-label="重试">
                            <AlertCircle size={14} />
                          </button>
                        ) : m.pending ? (
                          <Clock size={13} />
                        ) : readUpTo >= m.id ? (
                          <CheckCheck size={15} className="read" />
                        ) : (
                          <Check size={15} />
                        ))}
                      {mine && !m.deleted && !m.pending && !m.failed && !!images?.length && (
                        <button
                          type="button"
                          className="dm-image-recall"
                          onClick={() => recall(m)}
                          aria-label="撤回图片消息"
                          title="撤回消息"
                        >
                          <Undo2 size={15} />
                        </button>
                      )}
                    </span>
                  </div>
                </Fragment>
              );
            })}
          </div>
        )}
      </div>

      {block?.iBlocked || block?.blockedMe ? (
        <div className="dm-compose dm-blocked">
          {block.iBlocked ? (
            <>
              <span>你已拉黑对方，不能互发消息</span>
              <button
                type="button"
                className="btn btn-outline sm"
                onClick={async () => {
                  if (peer && (await toggleBlock(peer, true)) === false) setBlock({ iBlocked: false, blockedMe: block.blockedMe });
                }}
              >
                解除拉黑
              </button>
            </>
          ) : (
            <span>对方设置了不接受你的消息</span>
          )}
        </div>
      ) : (
      <form
        className="dm-compose"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSend) send();
        }}
      >
        {files.length > 0 && (
          <div className="dm-draft-images" aria-label="待发送图片">
            {files.map((file, index) => (
              <DmImage
                key={index}
                source={file}
                number={index + 1}
                onRemove={() => setFiles((list) => list.filter((_, i) => i !== index))}
              />
            ))}
          </div>
        )}
        <div className="dm-compose-row">
          <input ref={fileInput} type="file" accept={DM_IMAGE_TYPES.join(',')} multiple hidden onChange={chooseImages} />
          <button
            type="button"
            className="icon-btn accent"
            disabled={loading || files.length >= DM_IMAGE_LIMIT}
            onClick={() => fileInput.current?.click()}
            aria-label="添加图片"
            title="添加图片"
          >
            <ImagePlus size={20} />
          </button>
          <EmojiPicker className="icon-btn accent" disabled={loading} onOpen={saveEmojiRange} onPick={insertEmoji} />
          <textarea
            ref={input}
            rows={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            placeholder="发消息…"
            aria-label="消息"
            maxLength={MESSAGE_MAX_LENGTH}
            disabled={loading}
          />
          <button className={`dm-send ${canSend ? 'ready' : ''}`} disabled={!canSend} aria-label="发送" title="发送（Enter）">
            <Send size={20} />
          </button>
        </div>
      </form>
      )}

      {ctx && contextMessage && (
        <div className="menu dm-ctx" style={{ left: ctx.x, top: ctx.y }} onPointerDown={(e) => e.stopPropagation()} role="menu">
          {contextMessage.content && (
            <button
              onClick={() => {
                navigator.clipboard.writeText(contextMessage.content).then(() => toast('已复制'));
                setCtx(null);
              }}
            >
              <Copy size={17} /> 复制
            </button>
          )}
          {contextMessage.senderId === me.id && (
            <button className="danger" onClick={() => recall(contextMessage)}>
              <Trash2 size={17} /> 撤回
            </button>
          )}
        </div>
      )}
    </section>
  );
}

export function Messages() {
  const { username } = useParams();
  useLayoutEffect(() => {
    const root = document.documentElement;
    const viewport = window.visualViewport;
    if (!isAndroid || !viewport) return;
    // 一些 WebView 的 IME 只缩小 VisualViewport，100dvh 不会跟着变。
    const resize = () => {
      root.style.setProperty('--dm-viewport-height', `${viewport.height}px`);
    };
    resize();
    viewport.addEventListener('resize', resize);
    return () => {
      viewport.removeEventListener('resize', resize);
      root.style.removeProperty('--dm-viewport-height');
    };
  }, []);
  useEffect(() => {
    document.title = '私信 · 校墙';
    return () => {
      document.title = '校墙';
    };
  }, []);
  return (
    <div className={`dm ${username ? 'has-chat' : ''}`}>
      <ChatList active={username} />
      {username ? (
        <ChatView key={username} username={username} />
      ) : (
        <section className="dm-chat dm-placeholder">
          <span>选择一个聊天开始发消息</span>
        </section>
      )}
    </div>
  );
}
