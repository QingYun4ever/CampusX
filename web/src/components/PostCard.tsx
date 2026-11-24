import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BarChart2, Bookmark, ChevronDown, Flag, Heart, Link2, MessageCircle, MoreHorizontal, Pin, PinOff, Quote, Repeat2, SmilePlus, Trash2, UserX } from 'lucide-react';
import { api, thumb, QUICK_REACTIONS, REACTIONS, WEB_ORIGIN, type Post, type Reaction, type User } from '../lib/api';
import { useMe } from '../lib/auth';
import { fullTime, timeAgo } from '../lib/format';
import { markViewed, useViewTracking } from '../lib/views';
import { useCompose } from './compose';
import { ContentLink } from './ContentLink';
import { MediaImage } from './MediaImage';
import { LevelBadge } from './Level';
import { QuoteCard } from './QuoteCard';
import { CustomEmojiImg } from './CustomEmoji';
import { CrystalIcon } from './Crystal';
import { TipDialog } from './TipDialog';
import { EMOJI_TOKEN_ONE, isPostSticker, onlyEmoji, PLAIN_TEXT_TOKEN } from '../../../server/src/emoji-tokens';
import { ReportDialog, useBlockToggle } from './Safety';
import { Avatar, Emoji, emojiUrl, Empty, Modal, openGallery, Rolling, Spinner, toast, toneFor, usePopover, Verified } from './ui';

/* ---------- 正文 ---------- */
// Markdown / LaTeX 渲染器比较大（KaTeX），只有正文里出现相应语法时才加载
const Markdown = lazy(() => import('./Markdown'));
export const preloadMarkdown = () => import('./Markdown');
const NEEDS_MD = /[*_`~$|>[\]]|^\s{0,3}(#{1,6}\s|[-+*]\s|\d+[.)]\s|-{3,}\s*$)/m;

export function RichText({ text }: { text: string }) {
  if (!NEEDS_MD.test(text) || isPostSticker(text)) return <PlainText text={text} />;
  return (
    <Suspense fallback={<div className="content">{text}</div>}>
      <Markdown text={text} />
    </Suspense>
  );
}

/**
 * 列表里的长文：超过大约 10 行就折叠，底部渐隐，加一个「展开」。
 * 点「展开」只展开，不进详情页；点正文其他地方照常进详情页。
 */
const CLAMP_PX = 230;
export function ClampedText({ text }: { text: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || open) return;
    // 超出不多（两行以内）就不折叠，免得只藏一行
    const check = () => setLong(el.scrollHeight > CLAMP_PX + 44);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, open]);
  return (
    <>
      <div ref={box} className={long && !open ? 'post-clamp is-clamped' : 'post-clamp'} style={{ '--clamp': `${CLAMP_PX}px` } as CSSProperties}>
        <RichText text={text} />
      </div>
      {long && !open && (
        <button
          type="button"
          className="clamp-more"
          onClick={(e) => {
            e.stopPropagation();
            setOpen(true);
          }}
        >
          展开
        </button>
      )}
    </>
  );
}

/* 纯文本：@提及、#话题、链接 */

export function PlainText({ text }: { text: string }) {
  const parts = text.split(PLAIN_TEXT_TOKEN);
  const stop = (e: MouseEvent) => e.stopPropagation();
  const big = onlyEmoji(text);
  return (
    <div className={big ? `content emoji-only n${big}` : 'content'}>
      {parts.map((p, i) => {
        if (i % 2 === 0) return big ? null : p;
        const emoji = EMOJI_TOKEN_ONE.exec(p);
        if (emoji) return <CustomEmojiImg key={i} file={emoji[1]} />;
        if (p.startsWith('@')) {
          return (
            <Link key={i} to={`/u/${p.slice(1)}`} onClick={stop}>
              {p}
            </Link>
          );
        }
        if (p.startsWith('#')) {
          return (
            <Link key={i} to={`/t/${encodeURIComponent(p.slice(1).toLowerCase())}`} onClick={stop}>
              {p}
            </Link>
          );
        }
        return (
          <ContentLink key={i} href={p}>
            {p.replace(/^https?:\/\//, '').slice(0, 40)}
            {p.length > 48 ? '…' : ''}
          </ContentLink>
        );
      })}
    </div>
  );
}

export function MediaGrid({ images }: { images: string[] }) {
  const grid = useRef<HTMLDivElement>(null);
  if (!images.length) return null;
  const shown = images.slice(0, 4);
  return (
    <div ref={grid} className={`media n${shown.length}`}>
      {shown.map((src, i) => (
        <MediaImage
          key={src}
          src={thumb(src)}
          alt=""
          loading="lazy"
          decoding="async"
          onClick={(e) => {
            e.stopPropagation();
            openGallery({
              images: shown,
              previews: shown.map((source) => thumb(source)),
              index: i,
              origin: (k) => grid.current?.children[k] as HTMLElement | undefined,
            });
          }}
        />
      ))}
    </div>
  );
}

/* ---------- 点赞 / 转发（本地乐观更新） ---------- */
function usePostActions(post: Post) {
  const [liked, setLiked] = useState(post.liked);
  const [likes, setLikes] = useState(post.likeCount);
  const [reposted, setReposted] = useState(post.reposted);
  const [reposts, setReposts] = useState(post.repostCount);
  const [repostPending, setRepostPending] = useState(false);
  // 只在用户亲手点的时候播放动画（key 变化会让动画元素重新挂载）
  const [fx, setFx] = useState<{ kind: 'like' | 'repost'; key: number } | null>(null);
  const qc = useQueryClient();

  useEffect(() => {
    setLiked(post.liked);
    setLikes(post.likeCount);
    setReposted(post.reposted);
    setReposts(post.repostCount);
  }, [post.id, post.liked, post.likeCount, post.reposted, post.repostCount]);

  const toggleLike = async () => {
    const next = !liked;
    setLiked(next);
    setLikes((n) => n + (next ? 1 : -1));
    if (next) setFx({ kind: 'like', key: Date.now() });
    try {
      await api(`/posts/${post.id}/like`, { method: next ? 'POST' : 'DELETE' });
    } catch (e) {
      setLiked(!next);
      setLikes((n) => n + (next ? -1 : 1));
      toast((e as Error).message, 'error');
    }
  };
  const toggleRepost = async () => {
    if (repostPending) return;
    setRepostPending(true);
    const next = !reposted;
    setReposted(next);
    setReposts((n) => n + (next ? 1 : -1));
    if (next) setFx({ kind: 'repost', key: Date.now() });
    try {
      await api(`/posts/${post.id}/repost`, { method: next ? 'POST' : 'DELETE' });
      toast(next ? '已转发' : '已取消转发');
      for (const key of ['feed', 'post', 'user-posts', 'board-posts', 'board-pinned', 'replies', 'tag-posts', 'search-posts', 'notifications']) {
        qc.invalidateQueries({ queryKey: [key] });
      }
    } catch (e) {
      setReposted(!next);
      setReposts((n) => n + (next ? -1 : 1));
      toast((e as Error).message, 'error');
    } finally {
      setRepostPending(false);
    }
  };
  const [bookmarked, setBookmarked] = useState(post.bookmarked);
  useEffect(() => setBookmarked(post.bookmarked), [post.id, post.bookmarked]);
  const toggleBookmark = async () => {
    const next = !bookmarked;
    setBookmarked(next);
    try {
      await api(`/posts/${post.id}/bookmark`, { method: next ? 'POST' : 'DELETE' });
      toast(next ? '已加入书签' : '已移出书签');
      qc.invalidateQueries({ queryKey: ['bookmarks'] });
    } catch (e) {
      setBookmarked(!next);
      toast((e as Error).message, 'error');
    }
  };
  const share = async () => {
    const url = `${WEB_ORIGIN}/post/${post.id}`;
    try {
      await navigator.clipboard.writeText(url);
      toast('链接已复制');
    } catch {
      toast(url);
    }
  };
  return { liked, likes, reposted, reposts, repostPending, fx, toggleLike, toggleRepost, share, bookmarked, toggleBookmark };
}

/* ---------- 表情回应（Telegram 式） ---------- */

/** 回应时的动效：表情在气泡上方放大弹出，周围散开几个小表情 */
function reactionBurst(emoji: string, el: Element | null) {
  if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const r = el.getBoundingClientRect();
  const layer = document.createElement('div');
  layer.className = 'rx-fx';
  layer.style.left = `${r.left + 18}px`;
  layer.style.top = `${r.top + r.height / 2}px`;
  const img = (cls: string) => {
    const i = document.createElement('img');
    i.className = cls;
    i.src = emojiUrl(emoji);
    i.alt = '';
    return i;
  };
  layer.appendChild(img('rx-fx-big'));
  for (let i = 0; i < 9; i++) {
    const p = img('rx-fx-p');
    const ang = (i / 9) * Math.PI * 2 + Math.random() * 0.5;
    const dist = 38 + Math.random() * 30;
    p.style.setProperty('--x', `${Math.cos(ang) * dist}px`);
    p.style.setProperty('--y', `${Math.sin(ang) * dist - 24}px`);
    p.style.setProperty('--r', `${Math.random() * 120 - 60}deg`);
    p.style.animationDelay = `${120 + Math.random() * 80}ms`;
    layer.appendChild(p);
  }
  document.body.appendChild(layer);
  setTimeout(() => layer.remove(), 1100);
}

function useReactions(post: Post) {
  const me = useMe();
  const [list, setList] = useState<Reaction[]>(post.reactions);
  const [pop, setPop] = useState<string | null>(null);
  const [whoOpen, setWhoOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => setList(post.reactions), [post.reactions]);
  const mine = list.find((r) => r.me)?.key ?? null;
  const self = { username: me.username, displayName: me.displayName, avatar: me.avatar };

  /** 点同一个取消；点别的替换（每人每帖一个） */
  const toggle = async (key: string) => {
    const on = mine !== key;
    setList((l) => {
      let next = l
        .map((r) =>
          r.me ? { ...r, count: r.count - 1, me: false, users: r.users.filter((u) => u.username !== me.username) } : r,
        )
        .filter((r) => r.count > 0);
      if (on) {
        const cur = next.find((r) => r.key === key);
        next = cur
          ? next.map((r) => (r.key === key ? { ...r, count: r.count + 1, me: true, users: [self, ...r.users].slice(0, 3) } : r))
          : [...next, { key, count: 1, me: true, users: [self] }];
      }
      return next;
    });
    if (on) {
      setPop(key + Date.now());
      requestAnimationFrame(() =>
        reactionBurst(key, root.current?.querySelector(`[data-rx="${CSS.escape(key)}"]`) ?? null),
      );
    }
    try {
      const next = await api<Reaction[]>(`/posts/${post.id}/reactions/${encodeURIComponent(key)}`, {
        method: on ? 'PUT' : 'DELETE',
      });
      setList(next);
    } catch (e) {
      setList(post.reactions);
      toast((e as Error).message, 'error');
    }
  };
  return { list, toggle, pop, mine, root, whoOpen, setWhoOpen, postId: post.id };
}
type Rx = ReturnType<typeof useReactions>;

/** 长按（手机）或右键（电脑）查看谁回应了 */
function useLongPress(fn: () => void) {
  const t = useRef<number>(0);
  const fired = useRef(false);
  const clear = () => clearTimeout(t.current);
  return {
    fired,
    handlers: {
      onPointerDown: (e: React.PointerEvent) => {
        if (e.pointerType === 'mouse') return;
        fired.current = false;
        t.current = window.setTimeout(() => {
          fired.current = true;
          navigator.vibrate?.(10);
          fn();
        }, 450);
      },
      onPointerUp: clear,
      onPointerLeave: clear,
      onPointerCancel: clear,
      onContextMenu: (e: MouseEvent) => {
        e.preventDefault();
        fn();
      },
    },
  };
}

function ReactionPills({ rx }: { rx: Rx }) {
  const press = useLongPress(() => rx.setWhoOpen(true));
  if (!rx.list.length) return null;
  // 和 Telegram 一样：总共没几个人回应时直接显示头像，多了显示数字
  const total = rx.list.reduce((n, r) => n + r.count, 0);
  const faces = total <= 3;
  return (
    <div className="reactions" ref={rx.root} onClick={(e) => e.stopPropagation()}>
      {rx.list.map((r) => (
        <button
          key={r.key}
          data-rx={r.key}
          className={`rx-pill ${r.me ? 'on' : ''}`}
          onClick={() => {
            if (press.fired.current) return;
            rx.toggle(r.key);
          }}
          {...press.handlers}
          aria-pressed={r.me}
          aria-label={`${r.key} ${r.count} 人${r.me ? '，包括你' : ''}`}
          title={`${r.users.map((u) => u.displayName).join('、')}${r.count > r.users.length ? ` 等 ${r.count} 人` : ''}（右键或长按查看全部）`}
        >
          <span className="rx-emoji" key={rx.pop?.startsWith(r.key) ? rx.pop : r.key}>
            <Emoji e={r.key} size={18} />
          </span>
          {faces ? (
            <span className="rx-faces">
              {r.users.slice(0, 3).map((u) => (
                <Avatar key={u.username} src={u.avatar} name={u.displayName} size={20} />
              ))}
            </span>
          ) : (
            <Rolling value={r.count} />
          )}
        </button>
      ))}
    </div>
  );
}

/** 选择表情：先是一排快捷表情，点右边的箭头展开全部 */
function ReactButton({ rx, size }: { rx: Rx; size: number }) {
  const pop = usePopover(true, 324);
  const [all, setAll] = useState(false);
  useEffect(() => {
    if (!pop.open) setAll(false);
  }, [pop.open]);
  const pick = (k: string) => {
    rx.toggle(k);
    pop.setOpen(false);
  };
  const item = (k: string, i: number) => (
    <button
      key={k}
      className={rx.mine === k ? 'on' : ''}
      style={{ '--i': i } as CSSProperties}
      aria-label={k}
      aria-pressed={rx.mine === k}
      onClick={() => pick(k)}
    >
      <Emoji e={k} size={26} />
    </button>
  );
  return (
    <div className="popover-anchor" ref={pop.ref} onClick={(e) => e.stopPropagation()}>
      <button
        className={`act react ${rx.mine ? 'on' : ''}`}
        onClick={() => pop.setOpen((o) => !o)}
        aria-label="表情回应"
        aria-expanded={pop.open}
        title="表情回应"
      >
        <span className="ico">
          {rx.mine ? <Emoji e={rx.mine} size={size + 1} /> : <SmilePlus size={size} />}
        </span>
      </button>
      {pop.open && (
        <div className={`menu rx-picker ${all ? 'expanded' : ''}`} style={pop.style} role="menu">
          {all ? (
            <div className="rx-grid">{REACTIONS.map(item)}</div>
          ) : (
            <div className="rx-quick">
              {QUICK_REACTIONS.map(item)}
              <button className="rx-more" onClick={() => setAll(true)} aria-label="更多表情" title="更多表情">
                <ChevronDown size={18} />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 谁回应了：上面一排表情筛选，和 Telegram 一样 */
function ReactorsModal({ postId, onClose }: { postId: number; onClose: () => void }) {
  const [tab, setTab] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['reactors', postId],
    queryFn: () => api<{ emoji: string; createdAt: number; user: User }[]>(`/posts/${postId}/reactions`),
  });
  const counts = new Map<string, number>();
  for (const r of q.data ?? []) counts.set(r.emoji, (counts.get(r.emoji) ?? 0) + 1);
  const rows = (q.data ?? []).filter((r) => !tab || r.emoji === tab);
  return (
    <Modal title="回应" onClose={onClose} className="reactors-modal">
      <div className="rx-tabs">
        <button className={!tab ? 'on' : ''} onClick={() => setTab(null)}>
          <SmilePlus size={16} /> {q.data?.length ?? ''}
        </button>
        {[...counts].map(([e, n]) => (
          <button key={e} className={tab === e ? 'on' : ''} onClick={() => setTab(e)}>
            <Emoji e={e} size={18} /> {n}
          </button>
        ))}
      </div>
      {q.isPending ? (
        <div className="center-pad">
          <Spinner />
        </div>
      ) : !rows.length ? (
        <Empty title="还没有人回应" />
      ) : (
        rows.map((r) => (
          <Link key={r.user.id + r.emoji} to={`/u/${r.user.username}`} className="user-row" onClick={onClose}>
            <Avatar src={r.user.avatar} name={r.user.displayName} size={40} decoration={r.user.avatarDecoration} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="name">
                <span className="ellipsis">{r.user.displayName}</span>
                <Verified user={r.user} size={15} />
              </div>
              <div className="muted small">
                @{r.user.username} · {timeAgo(r.createdAt)}
              </div>
            </div>
            <Emoji e={r.emoji} size={24} />
          </Link>
        ))
      )}
    </Modal>
  );
}

function Reactors({ rx }: { rx: Rx }) {
  if (!rx.whoOpen) return null;
  // 弹窗是 portal，React 事件仍会冒泡到帖子卡片上，这里拦住，避免点弹窗时跳转到帖子
  return (
    <div onClick={(e) => e.stopPropagation()}>
      <ReactorsModal postId={rx.postId} onClose={() => rx.setWhoOpen(false)} />
    </div>
  );
}

export function TagList({ tags }: { tags: string[] }) {
  if (!tags.length) return null;
  return (
    <div className="tag-list">
      {tags.map((t) => (
        <Link key={t} to={`/t/${encodeURIComponent(t)}`} className="tag-chip" onClick={(e) => e.stopPropagation()}>
          #{t}
        </Link>
      ))}
    </div>
  );
}

function ActionBar({ post: item, big, rx }: { post: Post; big?: boolean; rx: Rx }) {
  const post = item.repostOf ?? item;
  const canQuote = item.canQuote && post.canQuote;
  const a = usePostActions(post);
  const compose = useCompose();
  const repostMenu = usePopover(true, 200);
  const size = big ? 22 : 18;
  const stop = (fn: () => void) => (e: MouseEvent) => {
    e.stopPropagation();
    fn();
  };
  return (
    <>
      {big && (
        <div className="stats">
          <span>
            <b>{post.viewCount}</b> 次浏览
          </span>
          {a.reposts > 0 && (
            <span>
              <b>{a.reposts}</b> 次转发
            </span>
          )}
          {a.likes > 0 && (
            <span>
              <b>{a.likes}</b> 个喜欢
            </span>
          )}
          {!!post.tipTotal && (
            <span className="stat-tip">
              <CrystalIcon size={14} />
              <b>{post.tipTotal}</b> 紫水晶
            </span>
          )}
          {rx.list.length > 0 && (
            <button className="stat-link" onClick={() => rx.setWhoOpen(true)}>
              <b>{rx.list.reduce((n, r) => n + r.count, 0)}</b> 个回应
            </button>
          )}
        </div>
      )}
      <div className="actions">
        <button className="act reply" onClick={stop(() => compose({ replyTo: post }))} aria-label="回复">
          <span className="ico">
            <MessageCircle size={size} />
          </span>
          {!big && <Rolling value={post.replyCount} />}
        </button>
        <div className="popover-anchor" ref={repostMenu.ref} onClick={(e) => e.stopPropagation()}>
          <button
            className={`act repost ${a.reposted ? 'on' : ''}`}
            onClick={() => repostMenu.setOpen((open) => !open)}
            aria-label="转发与引用"
            aria-expanded={repostMenu.open}
            title="转发与引用"
          >
            <span className="ico">
              <Repeat2 size={size} key={a.fx?.kind === 'repost' ? a.fx.key : 0} className={a.fx?.kind === 'repost' ? 'spin-once' : ''} />
            </span>
            {!big && <Rolling value={a.reposts} />}
          </button>
          {repostMenu.open && (
            <div className="menu repost-menu" style={repostMenu.style} role="group" aria-label="转发与引用">
              <button disabled={a.repostPending} onClick={() => {
                repostMenu.setOpen(false);
                repostMenu.ref.current?.querySelector('button')?.focus();
                void a.toggleRepost();
              }}>
                <Repeat2 size={18} /> {a.reposted ? '撤销转发' : '转发'}
              </button>
              <button disabled={!canQuote} title={canQuote ? undefined : '这条帖子不能引用'} onClick={() => {
                if (!canQuote) return;
                repostMenu.setOpen(false);
                compose({ quoteOf: post });
              }}>
                <Quote size={18} /> 引用
              </button>
            </div>
          )}
        </div>
        <button
          className={`act like ${a.liked ? 'on' : ''}`}
          onClick={stop(a.toggleLike)}
          aria-label="喜欢"
          aria-pressed={a.liked}
        >
          <span className="ico">
            {a.fx?.kind === 'like' && a.liked && <i className="burst" key={a.fx.key} />}
            <Heart
              size={size}
              fill={a.liked ? 'currentColor' : 'none'}
              key={a.fx?.kind === 'like' ? a.fx.key : 0}
              className={a.fx?.kind === 'like' && a.liked ? 'pop' : ''}
            />
          </span>
          {!big && <Rolling value={a.likes} />}
        </button>
        {!big && (
          <span className="act views" title={`${post.viewCount} 次浏览`} aria-label={`${post.viewCount} 次浏览`}>
            <span className="ico">
              <BarChart2 size={size} />
            </span>
            <Rolling value={post.viewCount} />
          </span>
        )}
        <ReactButton rx={rx} size={size} />
        <button
          className={`act bookmark ${a.bookmarked ? 'on' : ''}`}
          onClick={stop(a.toggleBookmark)}
          aria-label={a.bookmarked ? '移出书签' : '加入书签'}
          aria-pressed={a.bookmarked}
          title={a.bookmarked ? '移出书签' : '书签'}
        >
          <span className="ico">
            <Bookmark size={size} fill={a.bookmarked ? 'currentColor' : 'none'} />
          </span>
        </button>
        <button className="act share" onClick={stop(a.share)} aria-label="复制链接">
          <span className="ico">
            <Link2 size={size} />
          </span>
        </button>
      </div>
    </>
  );
}

function PostMenu({ post, onDeleted }: { post: Post; onDeleted?: () => void }) {
  const me = useMe();
  const { open, setOpen, ref } = usePopover();
  const qc = useQueryClient();
  const mine = post.author.id === me.id;
  const admin = me.role === 'admin';
  const mod = post.canModerate || admin;
  const [reporting, setReporting] = useState(false);
  const [tipping, setTipping] = useState(false);
  const canTip = !mine && post.author.role !== 'bot' && !post.author.blocked && !post.deleted;
  const toggleBlock = useBlockToggle();
  const canPin = mod && !!post.board && !post.parentId;
  const canDelete = mine || mod;
  const del = async () => {
    setOpen(false);
    if (!confirm('删除这条帖子？删除后不能恢复。')) return;
    try {
      await api(`/posts/${post.id}`, { method: 'DELETE' });
      toast('已删除');
      qc.invalidateQueries();
      onDeleted?.();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const pin = async () => {
    setOpen(false);
    try {
      await api(`/posts/${post.id}/pin`, { method: post.pinned ? 'DELETE' : 'POST' });
      toast(post.pinned ? '已取消置顶' : '已置顶');
      qc.invalidateQueries();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <div ref={ref} onClick={(e) => e.stopPropagation()} className="post-menu">
      <button className="icon-btn more" onClick={() => setOpen((o) => !o)} aria-label="更多" aria-expanded={open}>
        <MoreHorizontal size={18} />
      </button>
      {open && (
        <div className="menu" role="menu">
          {canPin && (
            <button onClick={pin} role="menuitem">
              {post.pinned ? <PinOff size={18} /> : <Pin size={18} />}
              {post.pinned ? '取消置顶' : `在${post.board!.name}吧置顶`}
            </button>
          )}
          {canTip && (
            <button onClick={() => { setOpen(false); setTipping(true); }} role="menuitem">
              <CrystalIcon size={18} /> 打赏紫水晶
            </button>
          )}
          {!mine && (
            <>
              <button onClick={() => { setOpen(false); setReporting(true); }} role="menuitem">
                <Flag size={18} /> 举报帖子
              </button>
              <button
                onClick={() => { setOpen(false); void toggleBlock(post.author, !!post.author.blocked); }}
                role="menuitem"
              >
                <UserX size={18} /> {post.author.blocked ? '取消拉黑' : '拉黑'} @{post.author.username}
              </button>
            </>
          )}
          {canDelete && (
            <button className="danger" onClick={del} role="menuitem">
              <Trash2 size={18} /> 删除{mine ? '' : post.canModerate ? '（吧务）' : '（管理员）'}
            </button>
          )}
        </div>
      )}
      {reporting && <ReportDialog targetType="post" targetId={post.id} onClose={() => setReporting(false)} />}
      {tipping && <TipDialog post={post} onClose={() => setTipping(false)} />}
    </div>
  );
}

/** 吧里的身份：吧主 / 吧务（放在第二行，跟着吧名和等级） */
function BoardRoleTags({ author }: { author: Post['author'] }) {
  return (
    <>
      {author.boardRole === 'owner' && <span className="tag owner">吧主</span>}
      {author.boardRole === 'mod' && <span className="tag mod">吧务</span>}
    </>
  );
}

/** 全站身份：管理员 / AI（放在名字那一行） */
function SiteRoleTags({ author }: { author: Post['author'] }) {
  return (
    <>
      {author.role === 'admin' && <span className="tag">管理员</span>}
      {author.role === 'bot' && <span className="tag bot">AI</span>}
    </>
  );
}

/** 第二行：楼层 / 回复谁 / 所在的吧，后面跟作者在这个吧的等级和身份 */
function SubLine({ post, opId, floor, hideReplyTo }: { post: Post; opId?: number; floor?: number; hideReplyTo?: boolean }) {
  const replyTo = !hideReplyTo && post.parentUsername;
  const board = !post.parentId && post.board;
  const isOp = opId === post.author.id;
  const role = !!post.author.boardRole;
  if (!floor && !replyTo && !board && !post.author.level && !isOp && !role) return null;
  return (
    <div className="post-sub">
      {floor && <span className="floor">{floor}楼</span>}
      {replyTo && (
        <span className="reply-to">
          回复{' '}
          <Link to={`/u/${post.parentUsername}`} onClick={(e) => e.stopPropagation()}>
            @{post.parentUsername}
          </Link>
        </span>
      )}
      {board && <BoardChip board={post.board} />}
      {post.author.level && <LevelBadge {...post.author.level} board={post.board?.name} compact />}
      {isOp && <span className="tag op">楼主</span>}
      <BoardRoleTags author={post.author} />
    </div>
  );
}

function Head({ post }: { post: Post; opId?: number }) {
  const stop = (e: MouseEvent) => e.stopPropagation();
  return (
    <div className="post-head">
      <Link to={`/u/${post.author.username}`} className="name" onClick={stop} data-admin={post.author.role === 'admin' || undefined}>
        {post.author.displayName}
      </Link>
      <Verified user={post.author} size={17} />
      <SiteRoleTags author={post.author} />
      <span className="muted handle" data-admin={post.author.role === 'admin' || undefined}>@{post.author.username}</span>
      <span className="muted dot">·</span>
      <time className="muted" title={fullTime(post.createdAt)}>
        {timeAgo(post.createdAt)}
      </time>
      <PostMenu post={post} />
    </div>
  );
}

export function BoardChip({ board }: { board: Post['board'] }) {
  if (!board) return null;
  return (
    <Link to={`/b/${board.slug}`} className="board-chip" onClick={(e) => e.stopPropagation()}>
      <i style={{ background: toneFor(board.slug) }} />
      {board.name}吧
    </Link>
  );
}

/* ---------- 列表中的帖子 ---------- */
export function PostCard({
  post: item,
  threadLine,
  floor,
  hideReplyTo,
  opId,
  pinnedContext,
  collapseBlocked,
}: {
  post: Post;
  /** 楼层里：拉黑的人的回复折叠成一行 */
  collapseBlocked?: boolean;
  threadLine?: boolean;
  floor?: number;
  hideReplyTo?: boolean;
  /** 吧首页的置顶区：顶部显示「置顶」 */
  pinnedContext?: boolean;
  /** 楼主的用户 id，用于在回复里标出「楼主」 */
  opId?: number;
}) {
  const nav = useNavigate();
  const post = item.repostOf ?? item;
  const rx = useReactions(post);
  const el = useRef<HTMLElement>(null);
  const [revealed, setRevealed] = useState(false);
  const hidden = !!collapseBlocked && !!post.author.blocked && !post.deleted && !revealed;
  useViewTracking(el, post.id, !post.deleted && !hidden);
  const open = () => {
    if (window.getSelection()?.toString()) return;
    nav(`/post/${post.id}`);
  };

  if (hidden) {
    return (
      <div className="blocked-reply">
        <UserX size={16} />
        {floor ? `${floor} 楼 · ` : ''}你已拉黑这位同学，回复已隐藏
        <button onClick={() => setRevealed(true)}>显示</button>
      </div>
    );
  }

  if (post.deleted) {
    return (
      <article className={`post ${threadLine ? 'no-border' : ''}`} onClick={open}>
        <div className="post-left">
          <span className="avatar ghost" style={{ width: 40, height: 40 }} />
          {threadLine && <div className="thread-line" />}
        </div>
        <div className="post-body">
          <div className="deleted-note">这条内容已删除</div>
        </div>
      </article>
    );
  }

  return (
    <article
      ref={el}
      className={`post ${threadLine ? 'no-border' : ''} ${item.repostOf ? 'is-repost' : ''} ${pinnedContext ? 'is-pinned' : ''}`}
      onClick={open}
    >
      {pinnedContext && (
        <div className="post-context pinned">
          <Pin size={14} /> 置顶
        </div>
      )}
      {item.repostOf && (
        <div className="post-context">
          <Repeat2 size={14} />
          <Link to={`/u/${item.author.username}`} onClick={(e) => e.stopPropagation()}>
            {item.author.displayName} 转发了
          </Link>
        </div>
      )}
      <div className="post-left">
        <Link to={`/u/${post.author.username}`} onClick={(e) => e.stopPropagation()} className="avatar-link">
          <Avatar src={post.author.avatar} name={post.author.displayName} size={40} decoration={post.author.avatarDecoration} />
        </Link>
        {threadLine && <div className="thread-line" />}
      </div>
      <div className="post-body">
        <Head post={post} />
        <SubLine post={post} opId={opId} floor={floor} hideReplyTo={hideReplyTo} />
        {post.content && <ClampedText text={post.content} />}
        <MediaGrid images={post.images} />
        {post.quote && <QuoteCard post={post.quote.post} />}
        <TagList tags={post.tags} />
        <ReactionPills rx={rx} />
        <ActionBar post={item} rx={rx} />
        <Reactors rx={rx} />
      </div>
    </article>
  );
}

/* ---------- 详情页主帖（大字号） ---------- */
export function PostMain({ post: item, onDeleted }: { post: Post; onDeleted?: () => void }) {
  const post = item.repostOf ?? item;
  const rx = useReactions(post);
  useEffect(() => {
    if (!post.deleted) markViewed(post.id);
  }, [post.id, post.deleted]);
  if (post.deleted) {
    return (
      <div className="post-main">
        <div className="deleted-note" style={{ padding: '16px 0' }}>
          这条内容已删除
        </div>
      </div>
    );
  }
  return (
    <div className="post-main">
      {item.repostOf && (
        <div className="post-context">
          <Repeat2 size={14} />
          <Link to={`/u/${item.author.username}`}>{item.author.displayName} 转发了</Link>
        </div>
      )}
      <div className="post-main-head">
        <Link to={`/u/${post.author.username}`} className="avatar-link">
          <Avatar src={post.author.avatar} name={post.author.displayName} size={44} decoration={post.author.avatarDecoration} />
        </Link>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Link to={`/u/${post.author.username}`} className="name" data-admin={post.author.role === 'admin' || undefined}>
              {post.author.displayName}
            </Link>
            <Verified user={post.author} />
            <SiteRoleTags author={post.author} />
            {post.author.level && <LevelBadge {...post.author.level} board={post.board?.name} />}
            <BoardRoleTags author={post.author} />
          </div>
          <div className="muted ellipsis">
            <span data-admin={post.author.role === 'admin' || undefined}>@{post.author.username}</span>
            {post.author.className && ` · ${post.author.className}`}
          </div>
        </div>
        <PostMenu post={item} onDeleted={onDeleted} />
      </div>
      {post.parentUsername && (
        <div className="reply-to" style={{ marginTop: 10 }}>
          回复 <Link to={`/u/${post.parentUsername}`}>@{post.parentUsername}</Link>
        </div>
      )}
      {!post.parentId && post.board && (
        <div style={{ marginTop: 10 }}>
          <BoardChip board={post.board} />
        </div>
      )}
      {post.content && <RichText text={post.content} />}
      <MediaGrid images={post.images} />
      {post.quote && <QuoteCard post={post.quote.post} />}
      <TagList tags={post.tags} />
      <ReactionPills rx={rx} />
      <div className="time">{fullTime(post.createdAt)}</div>
      <ActionBar key={item.id} post={item} big rx={rx} />
      <Reactors rx={rx} />
    </div>
  );
}
