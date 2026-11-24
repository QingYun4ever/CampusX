import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, Eye, Hash, ImagePlus, PenLine, ShieldAlert, X } from 'lucide-react';
import { api, ApiError, uploadImage, type Board, type Post } from '../lib/api';
import { ImageCropper } from './ImageCropper';
import { useMe } from '../lib/auth';
import type { ComposeOpts } from './compose';
import { EmojiPicker } from './EmojiPicker';
import { MediaImage } from './MediaImage';
import { useMention } from './MentionMenu';
import { RichText } from './PostCard';
import { QuoteCard } from './QuoteCard';
import { Avatar, BoardMark, Modal, Spinner, toast, usePopover } from './ui';

const MAX = 2000;
const MAX_IMAGES = 4;
const MAX_TAGS = 5;
const cleanTag = (t: string) => t.trim().replace(/^#+/, '').replace(/[\s#@，,]/g, '').toLowerCase().slice(0, 20);

/** 标签输入：回车、空格或逗号确认，退格删除最后一个 */
function TagInput({ tags, onChange }: { tags: string[]; onChange: (t: string[]) => void }) {
  const [draft, setDraft] = useState('');
  const add = (raw: string) => {
    const t = cleanTag(raw);
    setDraft('');
    if (!t || tags.includes(t)) return;
    if (tags.length >= MAX_TAGS) return toast(`最多 ${MAX_TAGS} 个标签`, 'error');
    onChange([...tags, t]);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter' || e.key === ' ' || e.key === ',' || e.key === '，') {
      e.preventDefault();
      add(draft);
    } else if (e.key === 'Backspace' && !draft && tags.length) {
      onChange(tags.slice(0, -1));
    }
  };
  return (
    <div className="tag-input">
      <Hash size={16} className="muted" />
      {tags.map((t) => (
        <span key={t} className="tag-chip editable">
          {t}
          <button onClick={() => onChange(tags.filter((x) => x !== t))} aria-label={`移除标签 ${t}`}>
            <X size={12} strokeWidth={3} />
          </button>
        </span>
      ))}
      {tags.length < MAX_TAGS && (
        <input
          value={draft}
          autoFocus
          onChange={(e) => (/[,，\s]$/.test(e.target.value) ? add(e.target.value) : setDraft(e.target.value))}
          onKeyDown={onKey}
          onBlur={() => draft && add(draft)}
          placeholder={tags.length ? '' : '添加标签，回车确认'}
          aria-label="输入标签"
          maxLength={20}
        />
      )}
    </div>
  );
}

/** 字数圈：接近上限时显示剩余字数 */
function CharRing({ len }: { len: number }) {
  if (!len) return null;
  const left = MAX - len;
  const warn = left <= 200;
  const r = warn ? 12 : 9;
  const c = 2 * Math.PI * r;
  const p = Math.min(len / MAX, 1);
  return (
    <span className={`ring ${warn ? 'warn' : ''} ${left < 0 ? 'over' : ''}`} aria-label={`还可以输入 ${left} 字`}>
      <svg viewBox="0 0 30 30" width={30} height={30}>
        <circle cx="15" cy="15" r={r} className="ring-bg" />
        <circle cx="15" cy="15" r={r} className="ring-fg" strokeDasharray={c} strokeDashoffset={c * (1 - p)} />
      </svg>
      {warn && <b>{left}</b>}
    </span>
  );
}

function BoardPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { open, setOpen, ref, style } = usePopover(true);
  const boards = useQuery({ queryKey: ['boards'], queryFn: () => api<Board[]>('/boards'), staleTime: 60_000 });
  const cur = boards.data?.find((b) => b.slug === value);
  const pick = (v: string) => {
    onChange(v);
    setOpen(false);
  };
  return (
    <div className="board-picker" ref={ref}>
      <button type="button" className="board-pick" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {cur ? `${cur.name}吧` : '动态'}
        <ChevronDown size={14} className={open ? 'flip' : ''} />
      </button>
      {open && (
        <div className="menu board-menu" role="listbox" style={style}>
          <div className="menu-title">发到哪里</div>
          <button type="button" onClick={() => pick('')} role="option" aria-selected={!value}>
            <span className="board-mark plain">#</span>
            <span className="grow">
              <span className="name">动态</span>
              <span className="muted">只出现在时间线和你的主页</span>
            </span>
            {!value && <Check size={18} className="accent" />}
          </button>
          {boards.data?.map((b) => (
            <button type="button" key={b.slug} onClick={() => pick(b.slug)} role="option" aria-selected={value === b.slug}>
              <BoardMark name={b.name} slug={b.slug} avatar={b.avatar} size={32} />
              <span className="grow">
                <span className="name">{b.name}吧</span>
                <span className="muted ellipsis">{b.description || `${b.memberCount} 人关注`}</span>
              </span>
              {value === b.slug && <Check size={18} className="accent" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Composer({
  replyTo,
  quoteOf,
  boardSlug,
  text: initialText,
  autoFocus,
  onPosted,
  showReplyContext,
  placeholder,
}: ComposeOpts & {
  autoFocus?: boolean;
  onPosted?: (p: Post) => void;
  showReplyContext?: boolean;
  placeholder?: string;
}) {
  const me = useMe();
  const qc = useQueryClient();
  const [text, setText] = useState(initialText ?? '');
  // file：本机的原图，用来再次编辑（旋转、裁剪），不用再从服务器下载
  const [images, setImages] = useState<{ key: string; url: string | null; file: File }[]>([]);
  const [editing, setEditing] = useState<number | null>(null);
  const [uploading, setUploading] = useState(0);
  const [busy, setBusy] = useState(false);
  const [board, setBoard] = useState(boardSlug ?? '');
  const ta = useRef<HTMLTextAreaElement>(null);
  const selection = useRef<[number, number]>([0, 0]);
  const pendingSelection = useRef<[number, number] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [showTags, setShowTags] = useState(false);
  const [preview, setPreview] = useState(false);

  useEffect(() => setBoard(boardSlug ?? ''), [boardSlug]);

  const rememberSelection = () => {
    const el = ta.current;
    if (el) selection.current = [el.selectionStart, el.selectionEnd];
  };

  useLayoutEffect(() => {
    const range = pendingSelection.current;
    if (!range || !ta.current) return;
    pendingSelection.current = null;
    ta.current.setSelectionRange(...range);
  }, [text, preview]);

  const insertEmoji = (emoji: string) => {
    if (document.activeElement === ta.current) rememberSelection();
    const [start, end] = selection.current;
    if (text.length - (end - start) + emoji.length > MAX) {
      toast(`正文最多 ${MAX} 字，无法插入这个表情`, 'error');
      return;
    }
    const next = text.slice(0, start) + emoji + text.slice(end);
    const caret = start + emoji.length;
    selection.current = [caret, caret];
    if (next === text && !preview) {
      ta.current?.setSelectionRange(caret, caret);
    } else {
      pendingSelection.current = [caret, caret];
      setText(next);
      if (preview) setPreview(false);
    }
  };

  // 自动增高
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 480)}px`;
  }, [text, preview]);

  const addFiles = async (files: File[]) => {
    const room = MAX_IMAGES - images.length - uploading;
    const list = files.filter((f) => f.type.startsWith('image/')).slice(0, Math.max(room, 0));
    if (files.length > list.length) toast(`最多 ${MAX_IMAGES} 张图片`, 'error');
    for (const f of list) {
      setUploading((n) => n + 1);
      try {
        const url = await uploadImage(f);
        setImages((arr) => [...arr, { key: url, url, file: f }]);
      } catch (e) {
        toast((e as Error).message, 'error');
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  const onPaste = (e: ClipboardEvent) => {
    const files = [...e.clipboardData.files];
    if (files.length) {
      e.preventDefault();
      if (!busy) addFiles(files);
    }
  };

  // 服务端和文本框选区都按 UTF-16 代码单元计数。
  const len = text.length;
  const canPost = (text.trim() || images.length) && len <= MAX && !uploading && !busy;
  const target = replyTo?.repostOf ?? replyTo;
  const mention = useMention({
    ta,
    text,
    postId: target?.id ?? quoteOf?.id,
    onInsert: (next, caret) => {
      if (next.length > MAX) return toast(`正文最多 ${MAX} 字`, 'error');
      selection.current = [caret, caret];
      pendingSelection.current = [caret, caret];
      setText(next);
    },
  });

  const [blocked, setBlocked] = useState<Blocked | null>(null);
  const submit = async () => {
    if (!canPost) return;
    setBusy(true);
    const submitted: string[] = [];
    try {
      // 已被拒绝的帖子持有旧路径；只有那些附件需要上传新副本。
      for (const image of images) {
        const url = image.url ?? await uploadImage(image.file);
        submitted.push(url);
        if (!image.url) setImages((arr) => arr.map((x) => x === image ? { ...x, url } : x));
      }
      const post = await api<Post>('/posts', {
        body: {
          content: text,
          images: submitted,
          parentId: target?.id ?? null,
          quoteOfId: quoteOf?.id,
          boardSlug: target ? null : board || null,
          tags,
        },
      });
      setText('');
      selection.current = [0, 0];
      pendingSelection.current = null;
      setImages([]);
      setTags([]);
      setShowTags(false);
      setPreview(false);
      const entry = post.eventEntries?.[0];
      toast(
        entry
          ? `已发布，参加了「${entry.title}」${entry.reward ? `，管理员审核通过后得 ${entry.reward} 颗紫水晶` : ''}`
          : target ? '已回复' : quoteOf ? '已发布引用' : '已发布',
      );
      if (entry) void qc.invalidateQueries({ queryKey: ['events'] });
      // board：发帖涨经验，吧首页的经验条要跟着变
      for (const k of ['feed', 'board-posts', 'replies', 'post', 'user-posts', 'boards', 'board', 'board-ranking', 'tag-posts', 'search-posts']) {
        qc.invalidateQueries({ queryKey: [k] });
      }
      onPosted?.(post);
    } catch (e) {
      const mod = e instanceof ApiError ? (e.data.moderation as Blocked | undefined) : undefined;
      // 没通过审核：草稿留着，弹窗说明原因和警告次数
      const unavailable = e instanceof ApiError && e.data.code === 'UPLOAD_UNAVAILABLE';
      if (mod || unavailable) {
        const unavailablePath = unavailable ? e.data.uploadPath : undefined;
        setImages((arr) => arr.map((image) => (
          image.url && submitted.includes(image.url) && (typeof unavailablePath !== 'string' || image.url === unavailablePath)
            ? { ...image, url: null }
            : image
        )));
      }
      if (mod) setBlocked(mod);
      else if (unavailable) toast('附件已失效，再次发布时会重新上传', 'error');
      else toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {blocked && <BlockedNotice {...blocked} onClose={() => setBlocked(null)} />}
      {editing !== null && images[editing]?.file && (
        <ImageCropper
          file={images[editing].file}
          title="编辑图片"
          editable
          output={{ maxEdge: 2560 }}
          onCancel={() => setEditing(null)}
          onDone={async (file) => {
            const at = editing;
            const url = await uploadImage(file);
            // 编辑后的图片当新的原图，再编辑时从这一版继续；旋转方向等不会叠加出错
            setImages((arr) => arr.map((x, i) => (i === at ? { ...x, url, file } : x)));
            setEditing(null);
          }}
        />
      )}
      {showReplyContext && target && (
        <div className="composer reply-context">
          <div className="post-left">
            <Avatar src={target.author.avatar} name={target.author.displayName} size={40} decoration={target.author.avatarDecoration} />
            <div className="thread-line" />
          </div>
          <div className="composer-body">
            <div className="post-head">
              <span className="name">{target.author.displayName}</span>
              <span className="muted handle">@{target.author.username}</span>
            </div>
            <div className="content clamp">{target.content || (target.images.length ? '[图片]' : '')}</div>
            <div className="reply-to" style={{ marginTop: 8 }}>
              回复 <a>@{target.author.username}</a>
            </div>
          </div>
        </div>
      )}
      <div className={`composer ${busy ? 'busy' : ''}`}>
        <Avatar src={me.avatar} name={me.displayName} size={40} decoration={me.avatarDecoration} />
        <div className="composer-body">
          {!target && !boardSlug && <BoardPicker value={board} onChange={setBoard} />}
          {preview ? (
            <div className="composer-preview">
              {text.trim() ? <RichText text={text} /> : <span className="muted">没有内容可以预览</span>}
            </div>
          ) : (
          <textarea
            ref={ta}
            value={text}
            autoFocus={autoFocus}
            onChange={(e) => {
              setText(e.target.value);
              mention.detect();
            }}
            onSelect={() => {
              rememberSelection();
              mention.detect();
            }}
            onBlur={() => {
              rememberSelection();
              mention.onBlur();
            }}
            onPaste={onPaste}
            onKeyDown={(e) => {
              if (mention.onKeyDown(e)) return;
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit();
            }}
            placeholder={placeholder ?? (target ? '发布你的回复' : quoteOf ? '说说你对原帖的看法' : '有什么新鲜事？')}
            aria-label="帖子内容"
            rows={2}
          />
          )}
          {!preview && mention.menu}
          {(showTags || tags.length > 0) && <TagInput tags={tags} onChange={setTags} />}
          {(images.length > 0 || uploading > 0) && (
            <div className={`thumbs n${Math.min(images.length + uploading, 4)}`}>
              {images.map((im, i) => (
                <div className="thumb" key={im.key}>
                  <MediaImage src={im.file} alt="" />
                  <button
                    className="thumb-remove"
                    onClick={() => setImages((a) => a.filter((x) => x.key !== im.key))}
                    aria-label="移除图片"
                  >
                    <X size={15} />
                  </button>
                  {im.file.type !== 'image/gif' && (
                    <button className="thumb-edit" onClick={() => setEditing(i)}>
                      编辑
                    </button>
                  )}
                </div>
              ))}
              {Array.from({ length: uploading }, (_, i) => (
                <div className="thumb loading" key={`u${i}`}>
                  <Spinner size={22} />
                </div>
              ))}
            </div>
          )}
          {quoteOf && <QuoteCard post={quoteOf} preview />}
          <div className="composer-tools">
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              multiple
              hidden
              onChange={(e) => {
                addFiles([...(e.target.files ?? [])]);
                e.target.value = '';
              }}
            />
            <button
              className="icon-btn accent"
              title="图片"
              aria-label="添加图片"
              disabled={images.length + uploading >= MAX_IMAGES}
              onClick={() => fileRef.current?.click()}
            >
              <ImagePlus size={20} />
            </button>
            <EmojiPicker onPick={insertEmoji} onOpen={rememberSelection} disabled={busy} />
            <button
              className={`icon-btn accent ${showTags || tags.length ? 'on' : ''}`}
              title="标签"
              aria-label="标签"
              aria-pressed={showTags || tags.length > 0}
              onClick={() => setShowTags((v) => !v)}
            >
              <Hash size={20} />
            </button>
            <button
              className={`icon-btn accent ${preview ? 'on' : ''}`}
              title={preview ? '继续编辑' : '预览（支持 Markdown 和 $LaTeX$ 公式）'}
              aria-label={preview ? '继续编辑' : '预览'}
              aria-pressed={preview}
              onClick={() => {
                if (preview) pendingSelection.current = selection.current;
                else rememberSelection();
                setPreview(!preview);
              }}
            >
              {preview ? <PenLine size={20} /> : <Eye size={20} />}
            </button>
            <span className="spacer" />
            <CharRing len={len} />
            <button className="btn btn-primary" disabled={!canPost} onClick={submit}>
              {busy ? <Spinner size={18} inline /> : target ? '回复' : '发布'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

type Blocked = { reason: string; warnings: number };

/** 内容没通过审核时的说明 */
function BlockedNotice({ reason, warnings, onClose }: Blocked & { onClose: () => void }) {
  return (
    <Modal title="没有发出去" onClose={onClose} className="blocked-modal">
      <div className="modal-body blocked">
        <div className="blocked-head">
          <span className="blocked-icon"><ShieldAlert size={22} /></span>
          <p>这条内容没有通过审核，所以没有发布。草稿还在，修改后可以重新发。</p>
        </div>
        <blockquote className="blocked-reason">{reason}</blockquote>
        <p className="blocked-warn">
          这是你第 <b>{warnings}</b> 次收到内容警告。多次违规，管理员可能会限制你的账号。
        </p>
        <div className="blocked-actions">
          <button className="btn btn-primary" onClick={onClose}>回去修改</button>
        </div>
      </div>
    </Modal>
  );
}
