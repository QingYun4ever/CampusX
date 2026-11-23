/**
 * 输入框里的 @ 补全：光标前是「@xxx」时列出候选人，选中后换成「@用户名 」。
 * 候选人由服务器排序：当前楼里的人、互相关注、我关注的……打字时按用户名和昵称搜。
 */
import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api, type UserLite } from '../lib/api';
import { Avatar, Verified } from './ui';

export type MentionUser = UserLite & { inThread: boolean; following: boolean };

/** 光标前的 @ 查询：@ 前面不能是字母数字（排除邮箱），查询里不能有空白和标点 */
const TRIGGER = /(^|[^A-Za-z0-9_@])@([^\s@#，。！？、；：,.!?;:()（）「」[\]]{0,20})$/;

export function useMention({
  ta,
  text,
  postId,
  onInsert,
}: {
  ta: RefObject<HTMLTextAreaElement | null>;
  text: string;
  postId?: number;
  /** 用新的正文和光标位置替换 */
  onInsert: (next: string, caret: number) => void;
}) {
  const [at, setAt] = useState<{ start: number; q: string } | null>(null);
  const [q, setQ] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  /** 按 Esc 收起时的位置和查询：没再输入就不重新弹出（输入法输入后浏览器会补发一次 select） */
  const dismissed = useRef<string | null>(null);

  /** 输入、移动光标后调用 */
  const detect = () => {
    const el = ta.current;
    if (!el || el.selectionStart !== el.selectionEnd) return setAt(null);
    const m = TRIGGER.exec(el.value.slice(0, el.selectionStart));
    const next = m ? { start: el.selectionStart - m[2].length - 1, q: m[2] } : null;
    const key = next && `${next.start}:${next.q}`;
    if (key && key === dismissed.current) return setAt(null);
    dismissed.current = null;
    setAt(next);
  };

  // 打字时稍等一下再查；刚输入 @ 时立刻查
  useEffect(() => {
    if (!at) return setQ(null);
    const t = setTimeout(() => setQ(at.q), at.q ? 120 : 0);
    return () => clearTimeout(t);
  }, [at]);

  const res = useQuery({
    queryKey: ['mention-suggest', q, postId ?? 0],
    queryFn: () => api<MentionUser[]>(`/mentions/suggest?q=${encodeURIComponent(q ?? '')}${postId ? `&postId=${postId}` : ''}`),
    enabled: q !== null,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
  const list = at && q !== null ? (res.data ?? []) : [];
  const open = list.length > 0;

  useEffect(() => setActive(0), [res.data]);

  const pick = (u: MentionUser) => {
    const el = ta.current;
    if (!el || !at) return;
    const insert = `@${u.username} `;
    const end = el.selectionStart;
    // 后面已经有空格就不再补
    const rest = text.slice(end);
    const add = rest.startsWith(' ') ? insert.trimEnd() : insert;
    onInsert(text.slice(0, at.start) + add + rest, at.start + add.length + (add === insert ? 0 : 1));
    setAt(null);
    el.focus();
  };

  /** 在输入框的 onKeyDown 里先调用；返回 true 表示已经处理 */
  const onKeyDown = (e: KeyboardEvent) => {
    if (!open || e.nativeEvent.isComposing) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length);
      return true;
    }
    if ((e.key === 'Enter' && !e.metaKey && !e.ctrlKey) || e.key === 'Tab') {
      e.preventDefault();
      pick(list[Math.min(active, list.length - 1)]);
      return true;
    }
    if (e.key === 'Escape') {
      // preventDefault 让外层弹窗不跟着关
      e.preventDefault();
      if (at) dismissed.current = `${at.start}:${at.q}`;
      setAt(null);
      return true;
    }
    return false;
  };

  /** 失焦时收起；点候选项不会失焦（mousedown 里阻止了） */
  const onBlur = () => setTimeout(() => document.activeElement !== ta.current && setAt(null), 150);

  return { detect, onKeyDown, onBlur, menu: open ? <MentionMenu list={list} active={active} setActive={setActive} pick={pick} /> : null };
}

function MentionMenu({
  list,
  active,
  setActive,
  pick,
}: {
  list: MentionUser[];
  active: number;
  setActive: (i: number) => void;
  pick: (u: MentionUser) => void;
}) {
  return (
    <div className="mention-menu" role="listbox" aria-label="提到谁">
      {list.map((u, i) => (
        <button
          key={u.id}
          type="button"
          role="option"
          aria-selected={i === active}
          className={`mention-item ${i === active ? 'active' : ''}`}
          // 不让输入框失焦，手机键盘不会收起
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => setActive(i)}
          onClick={() => pick(u)}
        >
          <Avatar src={u.avatar} name={u.displayName} size={32} decoration={u.avatarDecoration} />
          <span className="mention-who">
            <span className="mention-name">
              <span className="ellipsis">{u.displayName}</span>
              <Verified user={u} size={14} />
              {u.role === 'bot' && <span className="tag bot">AI</span>}
            </span>
            <span className="mention-sub">
              @{u.username}
              {u.inThread ? ' · 在这条帖子里' : u.following ? ' · 已关注' : ''}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}
