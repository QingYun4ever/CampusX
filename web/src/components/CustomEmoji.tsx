import { useEffect, useRef, useState, type MouseEvent, type TouchEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, SmilePlus } from 'lucide-react';
import { emojiSrc, useEmojiActions, useMyEmojis } from '../lib/customEmoji';
import { useMe } from '../lib/auth';
import { useEscape } from '../lib/escape';
import { MediaImage } from './MediaImage';
import { toast } from './ui';

const LONG_PRESS_MS = 450;

/** 正文里的自定义表情（[e:文件名]）。长按（手机）或右键（电脑）可以加到自己的表情里 */
export function CustomEmojiImg({ file }: { file: string }) {
  const me = useMe();
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const press = useRef<{ timer: number; x: number; y: number; fired: boolean } | null>(null);

  const open = (x: number, y: number) => setAt({ x: Math.min(x, window.innerWidth - 216), y: Math.min(y, window.innerHeight - 60) });

  const onContextMenu = (e: MouseEvent) => {
    if (!me) return;
    // 私信气泡也有右键菜单：表情上优先出表情的
    e.preventDefault();
    e.stopPropagation();
    open(e.clientX, e.clientY);
  };
  // 有的 WebView 长按不触发 contextmenu，自己计时兜底
  const onTouchStart = (e: TouchEvent) => {
    if (!me || e.touches.length !== 1) return;
    const t = e.touches[0];
    const p = { x: t.clientX, y: t.clientY, fired: false, timer: 0 };
    p.timer = window.setTimeout(() => {
      p.fired = true;
      open(p.x, p.y);
    }, LONG_PRESS_MS);
    press.current = p;
  };
  const cancel = () => {
    if (press.current) clearTimeout(press.current.timer);
  };
  const onTouchMove = (e: TouchEvent) => {
    const p = press.current;
    const t = e.touches[0];
    if (p && t && Math.hypot(t.clientX - p.x, t.clientY - p.y) > 10) cancel();
  };
  const onTouchEnd = (e: TouchEvent) => {
    cancel();
    // 长按弹出了菜单：松手不再算一次点击（不然会点进帖子）
    if (press.current?.fired) e.preventDefault();
    press.current = null;
  };

  return (
    <>
      <MediaImage
        className="cemoji"
        src={emojiSrc(file)}
        alt="[表情]"
        title="表情"
        loading="lazy"
        decoding="async"
        draggable={false}
        onContextMenu={onContextMenu}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={cancel}
      />
      {at && createPortal(<EmojiMenu file={file} x={at.x} y={at.y} onClose={() => setAt(null)} />, document.body)}
    </>
  );
}

function EmojiMenu({ file, x, y, onClose }: { file: string; x: number; y: number; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const mine = useMyEmojis();
  const { collect } = useEmojiActions();
  const [busy, setBusy] = useState(false);
  const owned = mine.data?.items.some((e) => e.file === file || e.origin === file);
  useEscape(onClose);
  useEffect(() => {
    const away = (e: Event) => !ref.current?.contains(e.target as Node) && onClose();
    document.addEventListener('pointerdown', away, true);
    window.addEventListener('scroll', onClose, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      window.removeEventListener('scroll', onClose, true);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  const add = async () => {
    setBusy(true);
    try {
      await collect(file);
      toast('已添加到我的表情');
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
      setBusy(false);
    }
  };

  return (
    <div ref={ref} className="menu emoji-ctx" style={{ left: x, top: y }} role="menu" onClick={(e) => e.stopPropagation()}>
      <div className="emoji-ctx-head">
        <img src={emojiSrc(file)} alt="" draggable={false} />
      </div>
      {owned ? (
        <button role="menuitem" disabled>
          <Check size={18} /> 已在我的表情里
        </button>
      ) : (
        <button role="menuitem" disabled={busy || mine.isLoading} onClick={add}>
          <SmilePlus size={18} /> 添加到我的表情
        </button>
      )}
    </div>
  );
}
