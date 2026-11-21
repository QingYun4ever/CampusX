import { useLayoutEffect, useRef } from 'react';

const stack: (() => void)[] = [];

/** 物理键盘 Escape 和 Android 返回共用同一个弹层栈。 */
export function dismissTopOverlay() {
  const close = stack[stack.length - 1];
  if (!close) return false;
  close();
  return true;
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && !e.defaultPrevented && !e.isComposing && dismissTopOverlay()) {
    e.preventDefault();
  }
}

export function useEscape(close: () => void, active = true) {
  const ref = useRef(close);
  ref.current = close;
  useLayoutEffect(() => {
    if (!active) return;
    const handler = () => ref.current();
    if (!stack.length) window.addEventListener('keydown', onKey);
    stack.push(handler);
    return () => {
      stack.splice(stack.indexOf(handler), 1);
      if (!stack.length) window.removeEventListener('keydown', onKey);
    };
  }, [active]);
}
