import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { Package, Plus, Smile, Store, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { getToken, REACTIONS } from '../lib/api';
import { BUNDLED_EMOJI, EMOJI_PACKS, setEmojiPackInstalled, useInstalledEmojiPacks } from '../lib/emojiPacks';
import { useEscape } from '../lib/escape';
import { Emoji, Spinner, toast } from './ui';
import { MediaImage } from './MediaImage';
import { EMOJI_TYPES, emojiSrc, emojiToken, useEmojiActions, useMyEmojis } from '../lib/customEmoji';
import { groupItems, useInstalledStickerPacks, useStickerActions, useStickerCatalog } from '../lib/stickerPacks';
import type { InstalledPack } from '../lib/api';
import './EmojiPicker.css';

const MINE = '__mine';
/** 图片表情包在面板里的 id：s:包 id */
const stickerKey = (id: number) => `s:${id}`;

const MODES = [
  { id: 'picker', label: '表情', icon: Smile },
  { id: 'catalog', label: '表情商场', icon: Store },
  { id: 'manage', label: '管理', icon: Package },
] as const;

export function EmojiGlyph({ emoji }: { emoji: string }) {
  return (
    <span className="emoji-picker-glyph" aria-hidden="true">
      {BUNDLED_EMOJI.has(emoji) ? <Emoji e={emoji} size={24} /> : emoji}
    </span>
  );
}

/** 「我的」：自己上传的表情。第一格是上传；「整理」模式下点表情就是删除 */
function MyEmojis({ onPick }: { onPick: (emoji: string) => void }) {
  const q = useMyEmojis();
  const { upload, remove } = useEmojiActions();
  const [uploading, setUploading] = useState(0);
  const [editing, setEditing] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const items = q.data?.items ?? [];
  const limit = q.data?.limit ?? 60;
  const full = items.length >= limit;

  // 删光了就退出整理，不然上传按钮一直藏着
  useEffect(() => {
    if (editing && !q.isPending && !items.length) setEditing(false);
  }, [editing, q.isPending, items.length]);

  const onFiles = async (files: FileList | null) => {
    const list = [...(files ?? [])].slice(0, Math.max(0, limit - items.length));
    if (input.current) input.current.value = '';
    // 一批传到一半退出或换了账号：剩下的不再传，免得传进别人的表情里
    const token = getToken();
    for (const file of list) {
      if (getToken() !== token) break;
      setUploading((n) => n + 1);
      try {
        await upload(file);
      } catch (e) {
        toast((e as Error).message, 'error');
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  return (
    <>
      <div className="my-emoji-head">
        <h3>
          我的表情 <small>{items.length}/{limit}</small>
        </h3>
        {items.length > 0 && (
          <button type="button" className="emoji-picker-action" aria-pressed={editing} onClick={() => setEditing(!editing)}>
            {editing ? '完成' : '整理'}
          </button>
        )}
      </div>
      {q.isPending ? (
        <Spinner inline />
      ) : (
        <div className="my-emoji-grid">
          {!editing && (
            <button
              type="button"
              className="my-emoji-add"
              disabled={full}
              title={full ? `最多 ${limit} 个，先删掉一些吧` : '上传表情（图片或 GIF）'}
              aria-label="上传表情"
              onClick={() => input.current?.click()}
            >
              <Plus size={22} />
              <span>{full ? '已满' : '上传'}</span>
            </button>
          )}
          {Array.from({ length: uploading }, (_, i) => (
            <span key={`u${i}`} className="my-emoji-tile uploading" aria-label="正在上传">
              <Spinner size={20} inline />
            </span>
          ))}
          {items.map((e) => (
            <button
              type="button"
              key={e.id}
              className={`my-emoji-tile ${editing ? 'editing' : ''}`}
              aria-label={editing ? '删除这个表情' : '插入表情'}
              onMouseDown={(ev) => ev.preventDefault()}
              onClick={async () => {
                if (!editing) return onPick(emojiToken(e.file));
                try {
                  await remove(e.id);
                } catch (err) {
                  toast((err as Error).message, 'error');
                }
              }}
            >
              <MediaImage src={e.url} alt="" loading="lazy" draggable={false} />
              {editing && <i aria-hidden="true"><X size={12} strokeWidth={3} /></i>}
            </button>
          ))}
        </div>
      )}
      {!q.isPending && !items.length && !uploading && (
        <p className="emoji-picker-hint">支持图片和 GIF 动图，会压缩成小图保存，最多 {limit} 个。删掉不影响已经发出去的内容。</p>
      )}
      <input ref={input} type="file" accept={EMOJI_TYPES} multiple hidden onChange={(e) => void onFiles(e.target.files)} />
    </>
  );
}

/** 装上的图片表情包：按分组排，点一下插入 */
function StickerGrid({ pack, onPick }: { pack: InstalledPack; onPick: (emoji: string) => void }) {
  const groups = groupItems(pack.items);
  return (
    <>
      <h3>{pack.name}</h3>
      {groups.map(([group, items]) => (
        <section key={group || '_'}>
          {groups.length > 1 && <h4 className="sticker-group">{group || '其他'}</h4>}
          <div className="my-emoji-grid sticker-grid">
            {items.map((e) => (
              <button
                type="button"
                key={e.file}
                className="my-emoji-tile"
                aria-label={`插入表情${group ? `（${group}）` : ''}`}
                onMouseDown={(ev) => ev.preventDefault()}
                onClick={() => onPick(emojiToken(e.file))}
              >
                <MediaImage src={emojiSrc(e.file)} alt="" loading="lazy" decoding="async" draggable={false} />
              </button>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

function EmojiPanel({ id, style, onPick, onClose }: {
  id: string;
  style: CSSProperties;
  onPick: (emoji: string) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<(typeof MODES)[number]['id']>('picker');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const installedIds = useInstalledEmojiPacks();
  const packs = EMOJI_PACKS.filter((pack) => installedIds.includes(pack.id));
  const activePack = packs.find((pack) => pack.id === activeId);
  const stickers = useInstalledStickerPacks();
  const installedStickers = stickers.data?.items ?? [];
  const activeSticker = installedStickers.find((p) => stickerKey(p.id) === activeId);
  const catalog = useStickerCatalog(mode === 'catalog');
  const { setInstalled } = useStickerActions();
  const [busyPack, setBusyPack] = useState<number | null>(null);
  const toggleSticker = async (packId: number, on: boolean) => {
    setBusyPack(packId);
    try {
      await setInstalled(packId, on);
      if (on) {
        setActiveId(stickerKey(packId));
        setMode('picker');
      } else if (activeId === stickerKey(packId)) setActiveId(null);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusyPack(null);
    }
  };

  const changeInstallation = (packId: string, install: boolean) => {
    if (!setEmojiPackInstalled(packId, install)) toast('无法保存本机表情包设置', 'error');
    if (install) setActiveId(packId);
    else if (activeId === packId) setActiveId(null);
  };

  return (
    <section className="menu emoji-picker-panel" id={id} style={style} role="dialog" aria-label="表情选择器">
      <header className="emoji-picker-header">
        <nav className="emoji-picker-modes" aria-label="表情面板">
          {MODES.map(({ id: modeId, label, icon: Icon }) => (
            <button type="button" key={modeId} aria-pressed={mode === modeId} onClick={() => setMode(modeId)}>
              <Icon size={15} aria-hidden="true" /> {label}
            </button>
          ))}
        </nav>
        <button type="button" className="icon-btn emoji-picker-close" aria-label="关闭表情选择器" onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      {mode === 'picker' && (
        <nav className="emoji-picker-packs" aria-label="选择表情包">
          <button type="button" aria-pressed={!activePack && activeId !== MINE} onClick={() => setActiveId(null)}>常用</button>
          <button type="button" aria-pressed={activeId === MINE} onClick={() => setActiveId(MINE)}>我的</button>
          {installedStickers.map((pack) => (
            <button
              type="button"
              key={pack.id}
              className="sticker-tab"
              aria-pressed={activeSticker?.id === pack.id}
              aria-label={pack.name}
              title={pack.name}
              onClick={() => setActiveId(stickerKey(pack.id))}
            >
              {pack.cover && <MediaImage src={emojiSrc(pack.cover)} alt="" draggable={false} />}
              <span>{pack.name}</span>
            </button>
          ))}
          {packs.map((pack) => (
            <button type="button" key={pack.id} aria-pressed={activePack?.id === pack.id} onClick={() => setActiveId(pack.id)}>
              {pack.name}
            </button>
          ))}
        </nav>
      )}
      <div className="emoji-picker-content" key={mode === 'picker' ? activeId === MINE ? MINE : activeSticker ? stickerKey(activeSticker.id) : activePack?.id ?? 'basic' : mode}>
        {mode === 'picker' && activeId === MINE && <MyEmojis onPick={onPick} />}
        {mode === 'picker' && activeSticker && <StickerGrid pack={activeSticker} onPick={onPick} />}
        {mode === 'picker' && activeId !== MINE && !activeSticker && (
          <>
            <h3>{activePack?.name ?? '常用表情'}</h3>
            <div className="emoji-menu">
              {(activePack?.emoji ?? REACTIONS).map((emoji) => (
                <button type="button" key={emoji} aria-label={`插入 ${emoji}`} onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(emoji)}>
                  <EmojiGlyph emoji={emoji} />
                </button>
              ))}
            </div>
          </>
        )}
        {mode === 'catalog' && (
          <>
            <h3>发现表情包</h3>
            <p className="emoji-picker-hint">
              免费使用，安装后会出现在你的表情面板。<Link to="/market" className="emoji-picker-link" onClick={onClose}>在商场里看全部</Link>
            </p>
            {catalog.isPending && <Spinner inline />}
            {catalog.data?.items.map((pack) => (
              <article className="emoji-picker-card" key={`s${pack.id}`}>
                <div className="emoji-picker-card-head">
                  {pack.cover && <MediaImage className="sticker-card-cover" src={emojiSrc(pack.cover)} alt="" draggable={false} />}
                  <div>
                    <h4>{pack.name} <small>{pack.count} 个表情</small></h4>
                    <p>{pack.official ? '官方' : pack.owner ? `@${pack.owner.username} 制作` : '同学制作'}</p>
                  </div>
                  {pack.installed ? (
                    <button type="button" className="emoji-picker-action" onClick={() => { setActiveId(stickerKey(pack.id)); setMode('picker'); }}>使用</button>
                  ) : (
                    <button type="button" className="emoji-picker-action" disabled={busyPack === pack.id} aria-label={`安装${pack.name}`} onClick={() => void toggleSticker(pack.id, true)}>安装</button>
                  )}
                </div>
                <div className="sticker-card-samples" aria-hidden="true">
                  {pack.preview.slice(0, 5).map((f) => <MediaImage key={f} src={emojiSrc(f)} alt="" loading="lazy" draggable={false} />)}
                </div>
              </article>
            ))}
            {EMOJI_PACKS.map((pack) => {
              const expanded = previewId === pack.id;
              const installed = installedIds.includes(pack.id);
              return (
                <article className="emoji-picker-card" key={pack.id}>
                  <div className="emoji-picker-card-head">
                    <div>
                      <h4>{pack.name} <small>{pack.emoji.length} 个表情</small></h4>
                      <p>{pack.description}</p>
                    </div>
                    {installed ? (
                      <button type="button" className="emoji-picker-action" aria-label={`使用${pack.name}`} onClick={() => { setActiveId(pack.id); setMode('picker'); }}>使用</button>
                    ) : (
                      <button type="button" className="emoji-picker-action" aria-label={`安装${pack.name}`} onClick={() => changeInstallation(pack.id, true)}>安装</button>
                    )}
                  </div>
                  <div className="emoji-picker-samples" aria-label={`${pack.name}预览`}>
                    {(expanded ? pack.emoji : pack.emoji.slice(0, 5)).map((emoji) => (
                      <span key={emoji} role="img" aria-label={emoji}><EmojiGlyph emoji={emoji} /></span>
                    ))}
                  </div>
                  <button type="button" className="emoji-picker-preview" aria-expanded={expanded} aria-label={`${expanded ? '收起' : '预览'}${pack.name}`} onClick={() => setPreviewId(expanded ? null : pack.id)}>
                    {expanded ? '收起预览' : '预览全部'}
                  </button>
                </article>
              );
            })}
          </>
        )}
        {mode === 'manage' && (
          <>
            <h3>已安装的表情包</h3>
            <p className="emoji-picker-hint">移除不会影响已经发出去的表情。</p>
            {!installedIds.length && !installedStickers.length && <p className="emoji-picker-hint">还没有安装表情包。</p>}
            {installedStickers.map((pack) => (
              <article className="emoji-picker-card emoji-picker-card-head" key={`s${pack.id}`}>
                {pack.cover && <MediaImage className="sticker-card-cover" src={emojiSrc(pack.cover)} alt="" draggable={false} />}
                <div>
                  <h4>{pack.name}</h4>
                  <p>{pack.items.length} 个表情</p>
                </div>
                <button type="button" className="emoji-picker-action emoji-picker-remove" disabled={busyPack === pack.id} aria-label={`移除${pack.name}`} onClick={() => void toggleSticker(pack.id, false)}>移除</button>
              </article>
            ))}
            {installedIds.map((packId) => {
              const pack = packs.find((item) => item.id === packId);
              return (
                <article className="emoji-picker-card emoji-picker-card-head" key={packId}>
                  {pack && <EmojiGlyph emoji={pack.emoji[0]} />}
                  <div>
                    <h4>{pack?.name ?? '已下架的表情包'}</h4>
                    <p>{pack ? `${pack.emoji.length} 个表情` : packId}</p>
                  </div>
                  <button type="button" className="emoji-picker-action emoji-picker-remove" aria-label={`移除${pack?.name ?? packId}`} onClick={() => changeInstallation(packId, false)}>移除</button>
                </article>
              );
            })}
          </>
        )}
      </div>
    </section>
  );
}

function getPanelPosition(anchor: HTMLElement): CSSProperties {
  const r = anchor.getBoundingClientRect();
  // 在软键盘上方、缩放后的可见区域内摆放，而不是按整个布局视口计算。
  const viewport = window.visualViewport;
  const leftEdge = (viewport?.offsetLeft ?? 0) + 8;
  const topEdge = (viewport?.offsetTop ?? 0) + 8;
  const width = Math.min(364, (viewport?.width ?? window.innerWidth) - 16);
  const rightEdge = leftEdge + (viewport?.width ?? window.innerWidth) - 16;
  const bottomEdge = topEdge + (viewport?.height ?? window.innerHeight) - 16;
  const left = Math.max(leftEdge, Math.min(r.left + (r.width - width) / 2, rightEdge - width));
  const above = Math.min(r.top - 5, bottomEdge);
  const below = Math.max(r.bottom + 5, topEdge);
  const roomAbove = above - topEdge;
  const roomBelow = bottomEdge - below;
  const opensAbove = roomBelow < 270 && roomAbove > roomBelow;
  const room = opensAbove ? roomAbove : roomBelow;
  if (room < 144) {
    return { left, width, bottom: window.innerHeight - bottomEdge, maxHeight: Math.min(380, bottomEdge - topEdge), transformOrigin: 'bottom' };
  }
  return opensAbove
    ? { left, width, bottom: window.innerHeight - above, maxHeight: Math.min(380, room), transformOrigin: 'bottom' }
    : { left, width, top: below, maxHeight: Math.min(380, room), transformOrigin: 'top' };
}

export function EmojiPicker({ onPick, onOpen, className = 'icon-btn accent', disabled = false }: {
  onPick: (emoji: string) => void;
  onOpen?: () => void;
  className?: string;
  disabled?: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties>({});
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const visible = open && !disabled;
  const close = () => {
    if (root.current?.contains(document.activeElement)) trigger.current?.focus({ preventScroll: true });
    setOpen(false);
  };
  useEscape(close, visible);

  useLayoutEffect(() => {
    if (disabled) setOpen(false);
    if (!visible) return;
    const place = () => {
      if (trigger.current) setStyle(getPanelPosition(trigger.current));
    };
    const dismissOutside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const followScroll = (e: Event) => {
      if (e.target === window || (e.target instanceof Node && e.target.contains(trigger.current))) place();
    };
    place();
    const viewport = window.visualViewport;
    document.addEventListener('pointerdown', dismissOutside, true);
    window.addEventListener('scroll', followScroll, true);
    window.addEventListener('resize', place);
    viewport?.addEventListener('scroll', place);
    viewport?.addEventListener('resize', place);
    return () => {
      document.removeEventListener('pointerdown', dismissOutside, true);
      window.removeEventListener('scroll', followScroll, true);
      window.removeEventListener('resize', place);
      viewport?.removeEventListener('scroll', place);
      viewport?.removeEventListener('resize', place);
    };
  }, [disabled, visible]);

  return (
    <div className="popover-anchor emoji-picker-anchor" ref={root}>
      <button
        type="button"
        className={className}
        ref={trigger}
        title="表情"
        aria-label="表情"
        aria-haspopup="dialog"
        aria-expanded={visible}
        aria-controls={visible ? id : undefined}
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          if (!visible) onOpen?.();
          setOpen(!visible);
        }}
      >
        <Smile size={20} />
      </button>
      {visible && <EmojiPanel id={id} style={style} onPick={onPick} onClose={close} />}
    </div>
  );
}
