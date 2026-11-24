import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import type { Post, QuotePreview } from '../lib/api';
import { Composer } from './Composer';
import { Modal, useModalClose } from './ui';

export type ComposeOpts = { boardSlug?: string; /** 预先填好的正文，比如活动话题 */ text?: string } & (
  | { replyTo?: Post; quoteOf?: never }
  | { quoteOf: QuotePreview; replyTo?: never }
);

const Ctx = createContext<(o?: ComposeOpts) => void>(() => {});

function ComposeBody({ opts }: { opts: ComposeOpts }) {
  const close = useModalClose();
  return <Composer {...opts} autoFocus onPosted={close} showReplyContext />;
}

/** 全局发帖弹窗：支持新帖、回复和引用。 */
export function ComposeProvider({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<ComposeOpts | null>(null);
  const open = useCallback((o: ComposeOpts = {}) => setOpts(o), []);
  const close = useCallback(() => setOpts(null), []);
  return (
    <Ctx.Provider value={open}>
      {children}
      {opts && (
        <Modal title={opts.replyTo ? '回复' : opts.quoteOf ? '引用' : '发帖'} onClose={close} className="compose-modal">
          <ComposeBody opts={opts} />
        </Modal>
      )}
    </Ctx.Provider>
  );
}

export const useCompose = () => useContext(Ctx);
