import { lazy, Suspense, useEffect, useState, type CSSProperties, type MouseEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Heart, Link2, MessageCircle, MoreHorizontal, Repeat2, SmilePlus, Trash2 } from 'lucide-react';
import { api, media, REACTIONS, WEB_ORIGIN, type Post, type Reaction } from '../lib/api';
import { useMe } from '../lib/auth';
import { fullTime, timeAgo } from '../lib/format';
import { useCompose } from './compose';
import { Avatar, openLightbox, Rolling, toast, toneFor, usePopover, Verified } from './ui';

/* ---------- 正文 ---------- */
// Markdown / LaTeX 渲染器比较大（KaTeX），只有正文里出现相应语法时才加载
const Markdown = lazy(() => import('./Markdown'));
export const preloadMarkdown = () => import('./Markdown');
const NEEDS_MD = /[*_`~$|>[\]]|^\s{0,3}(#{1,6}\s|[-+*]\s|\d+[.)]\s|-{3,}\s*$)/m;

export function RichText({ text }: { text: string }) {
  if (!NEEDS_MD.test(text)) return <PlainText text={text} />;
  return (
    <Suspense fallback={<PlainText text={text} />}>
      <Markdown text={text} />
    </Suspense>
  );
}

/* 纯文本：@提及、#话题、链接 */
const TOKEN = /(@[A-Za-z0-9_]{3,20}|#[^\s#@，。！？、；：,.!?;:()（）「」]{1,20}|https?:\/\/[^\s]+)/g;

function PlainText({ text }: { text: string }) {
  const parts = text.split(TOKEN);
  const stop = (e: MouseEvent) => e.stopPropagation();
  return (
    <div className="content">
      {parts.map((p, i) => {
        if (i % 2 === 0) return p;
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
          <a key={i} href={p} target="_blank" rel="noopener noreferrer nofollow" onClick={stop}>
            {p.replace(/^https?:\/\//, '').slice(0, 40)}
            {p.length > 48 ? '…' : ''}
          </a>
        );
      })}
    </div>
  );
}

export function MediaGrid({ images }: { images: string[] }) {
  if (!images.length) return null;
  return (
    <div className={`media n${Math.min(images.length, 4)}`}>
      {images.slice(0, 4).map((src) => (
        <img
          key={src}
          src={media(src)}
          alt=""
          loading="lazy"
          onLoad={(e) => e.currentTarget.classList.add('loaded')}
          onClick={(e) => {
            e.stopPropagation();
            openLightbox(media(src)!, e.currentTarget);
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
  // 只在用户亲手点的时候播放动画（key 变化会让动画元素重新挂载）
  const [fx, setFx] = useState<{ kind: 'like' | 'repost'; key: number } | null>(null);
  const qc = useQueryClient();

  useEffect(() => {
    setLiked(post.liked);
    setLikes(post.likeCount);
    setReposted(post.reposted);
    setReposts(post.repostCount);
  }, [post.liked, post.likeCount, post.reposted, post.repostCount]);

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
    const next = !reposted;
    setReposted(next);
    setReposts((n) => n + (next ? 1 : -1));
    if (next) setFx({ kind: 'repost', key: Date.now() });
    try {
      await api(`/posts/${post.id}/repost`, { method: next ? 'POST' : 'DELETE' });
      toast(next ? '已转发' : '已取消转发');
      qc.invalidateQueries({ queryKey: ['feed'] });
    } catch (e) {
      setReposted(!next);
      setReposts((n) => n + (next ? -1 : 1));
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
  return { liked, likes, reposted, reposts, fx, toggleLike, toggleRepost, share };
}

/* ---------- 表情回应（类似 GitHub） ---------- */
function useReactions(post: Post) {
  const [list, setList] = useState<Reaction[]>(post.reactions);
  const [pop, setPop] = useState<string | null>(null);
  useEffect(() => setList(post.reactions), [post.reactions]);
  const toggle = async (key: string) => {
    const cur = list.find((r) => r.key === key);
    const on = !cur?.me;
    // 乐观更新
    setList((l) => {
      if (on) {
        return cur ? l.map((r) => (r.key === key ? { ...r, count: r.count + 1, me: true } : r)) : [...l, { key, count: 1, me: true }];
      }
      return l.map((r) => (r.key === key ? { ...r, count: r.count - 1, me: false } : r)).filter((r) => r.count > 0);
    });
    if (on) setPop(key + Date.now());
    try {
      const next = await api<Reaction[]>(`/posts/${post.id}/reactions/${encodeURIComponent(key)}`, { method: on ? 'PUT' : 'DELETE' });
      setList(next);
    } catch (e) {
      setList(post.reactions);
      toast((e as Error).message, 'error');
    }
  };
  return { list, toggle, pop };
}
type Rx = ReturnType<typeof useReactions>;

const EMOJI = Object.fromEntries(REACTIONS.map((r) => [r.key, r]));

function ReactionPills({ rx }: { rx: Rx }) {
  if (!rx.list.length) return null;
  return (
    <div className="reactions" onClick={(e) => e.stopPropagation()}>
      {rx.list.map((r) => (
        <button
          key={r.key}
          className={`rx-pill ${r.me ? 'on' : ''}`}
          onClick={() => rx.toggle(r.key)}
          aria-pressed={r.me}
          title={`${EMOJI[r.key]?.name ?? r.key}${r.me ? '（再点一次取消）' : ''}`}
        >
          <span className="rx-emoji" key={rx.pop?.startsWith(r.key) ? rx.pop : r.key}>
            {EMOJI[r.key]?.emoji ?? '❔'}
          </span>
          <Rolling value={r.count} />
        </button>
      ))}
    </div>
  );
}

function ReactButton({ rx, size }: { rx: Rx; size: number }) {
  const pop = usePopover(true);
  return (
    <div className="popover-anchor" ref={pop.ref} onClick={(e) => e.stopPropagation()}>
      <button className="act react" onClick={() => pop.setOpen((o) => !o)} aria-label="表情回应" aria-expanded={pop.open} title="表情回应">
        <span className="ico">
          <SmilePlus size={size} />
        </span>
      </button>
      {pop.open && (
        <div className="menu rx-menu" style={pop.style} role="menu">
          {REACTIONS.map((r, i) => {
            const on = rx.list.some((x) => x.key === r.key && x.me);
            return (
              <button
                key={r.key}
                className={on ? 'on' : ''}
                style={{ '--i': i } as CSSProperties}
                title={r.name}
                aria-label={r.name}
                aria-pressed={on}
                onClick={() => {
                  rx.toggle(r.key);
                  pop.setOpen(false);
                }}
              >
                {r.emoji}
              </button>
            );
          })}
        </div>
      )}
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

function ActionBar({ post, big, rx }: { post: Post; big?: boolean; rx: Rx }) {
  const a = usePostActions(post);
  const compose = useCompose();
  const size = big ? 22 : 18;
  const stop = (fn: () => void) => (e: MouseEvent) => {
    e.stopPropagation();
    fn();
  };
  return (
    <>
      {big && (a.reposts > 0 || a.likes > 0) && (
        <div className="stats">
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
        </div>
      )}
      <div className="actions">
        <button className="act reply" onClick={stop(() => compose({ replyTo: post }))} aria-label="回复">
          <span className="ico">
            <MessageCircle size={size} />
          </span>
          {!big && <Rolling value={post.replyCount} />}
        </button>
        <button
          className={`act repost ${a.reposted ? 'on' : ''}`}
          onClick={stop(a.toggleRepost)}
          aria-label="转发"
          aria-pressed={a.reposted}
        >
          <span className="ico">
            <Repeat2 size={size} key={a.fx?.kind === 'repost' ? a.fx.key : 0} className={a.fx?.kind === 'repost' ? 'spin-once' : ''} />
          </span>
          {!big && <Rolling value={a.reposts} />}
        </button>
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
        <ReactButton rx={rx} size={size} />
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
  if (post.author.id !== me.id && me.role !== 'admin') return null;
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
  return (
    <div ref={ref} onClick={(e) => e.stopPropagation()} className="post-menu">
      <button className="icon-btn more" onClick={() => setOpen((o) => !o)} aria-label="更多" aria-expanded={open}>
        <MoreHorizontal size={18} />
      </button>
      {open && (
        <div className="menu" role="menu">
          <button className="danger" onClick={del} role="menuitem">
            <Trash2 size={18} /> 删除{post.author.id !== me.id ? '（管理员）' : ''}
          </button>
        </div>
      )}
    </div>
  );
}

function Head({ post, opId }: { post: Post; opId?: number }) {
  const stop = (e: MouseEvent) => e.stopPropagation();
  return (
    <div className="post-head">
      <Link to={`/u/${post.author.username}`} className="name" onClick={stop}>
        {post.author.displayName}
      </Link>
      <Verified user={post.author} size={17} />
      {opId === post.author.id && <span className="tag op">楼主</span>}
      {post.author.role === 'admin' && <span className="tag">管理员</span>}
      <span className="muted handle">@{post.author.username}</span>
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
}: {
  post: Post;
  threadLine?: boolean;
  floor?: number;
  hideReplyTo?: boolean;
  /** 楼主的用户 id，用于在回复里标出「楼主」 */
  opId?: number;
}) {
  const nav = useNavigate();
  const post = item.repostOf ?? item;
  const rx = useReactions(post);
  const open = () => {
    if (window.getSelection()?.toString()) return;
    nav(`/post/${post.id}`);
  };

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
    <article className={`post ${threadLine ? 'no-border' : ''} ${item.repostOf ? 'is-repost' : ''}`} onClick={open}>
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
          <Avatar src={post.author.avatar} name={post.author.displayName} size={40} />
        </Link>
        {threadLine && <div className="thread-line" />}
      </div>
      <div className="post-body">
        <Head post={post} opId={opId} />
        {(floor || (!hideReplyTo && post.parentUsername)) && (
          <div className="reply-to">
            {floor && <span className="floor">{floor}楼</span>}
            {!hideReplyTo && post.parentUsername && (
              <>
                回复{' '}
                <Link to={`/u/${post.parentUsername}`} onClick={(e) => e.stopPropagation()}>
                  @{post.parentUsername}
                </Link>
              </>
            )}
          </div>
        )}
        {!post.parentId && <BoardChip board={post.board} />}
        {post.content && <RichText text={post.content} />}
        <MediaGrid images={post.images} />
        <TagList tags={post.tags} />
        <ReactionPills rx={rx} />
        <ActionBar post={post} rx={rx} />
      </div>
    </article>
  );
}

/* ---------- 详情页主帖（大字号） ---------- */
export function PostMain({ post, onDeleted }: { post: Post; onDeleted?: () => void }) {
  const rx = useReactions(post);
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
      <div className="post-main-head">
        <Link to={`/u/${post.author.username}`} className="avatar-link">
          <Avatar src={post.author.avatar} name={post.author.displayName} size={44} />
        </Link>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Link to={`/u/${post.author.username}`} className="name">
              {post.author.displayName}
            </Link>
            <Verified user={post.author} />
            {post.author.role === 'admin' && <span className="tag">管理员</span>}
          </div>
          <div className="muted ellipsis">
            @{post.author.username}
            {post.author.className && ` · ${post.author.className}`}
          </div>
        </div>
        <PostMenu post={post} onDeleted={onDeleted} />
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
      <TagList tags={post.tags} />
      <ReactionPills rx={rx} />
      <div className="time">{fullTime(post.createdAt)}</div>
      <ActionBar post={post} big rx={rx} />
    </div>
  );
}
