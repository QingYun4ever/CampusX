/**
 * 浏览数：帖子在屏幕上露出一半以上就算看过，攒一批每 2.5 秒报给服务器。
 * 服务器按「每人每帖一次、作者自己不算」去重，这里只是少发重复请求。
 */
import { useEffect, type RefObject } from 'react';
import { api } from './api';

const sent = new Set<number>();
const queue = new Set<number>();
let timer = 0;

function flush() {
  timer = 0;
  if (!queue.size) return;
  const ids = [...queue].slice(0, 50);
  ids.forEach((id) => queue.delete(id));
  api('/posts/views', { body: { ids } }).catch(() => ids.forEach((id) => sent.delete(id)));
  if (queue.size) schedule();
}
function schedule() {
  if (!timer) timer = window.setTimeout(flush, 2500);
}

export function markViewed(id: number) {
  if (sent.has(id)) return;
  sent.add(id);
  queue.add(id);
  schedule();
}

const io =
  typeof IntersectionObserver === 'undefined'
    ? null
    : new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            markViewed(Number((e.target as HTMLElement).dataset.viewId));
            io!.unobserve(e.target);
          }
        },
        { threshold: 0.5 },
      );

document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush());

export function useViewTracking(ref: RefObject<HTMLElement | null>, id: number, enabled = true) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled || !io || sent.has(id)) return;
    el.dataset.viewId = String(id);
    io.observe(el);
    return () => io.unobserve(el);
  }, [ref, id, enabled]);
}
