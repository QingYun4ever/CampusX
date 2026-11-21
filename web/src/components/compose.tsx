import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import type { Post } from '../lib/api';
import { Composer } from './Composer';
import { Modal, useModalClose } from './ui';

export interface ComposeOpts {
  replyTo?: Post;
  boardSlug?: string;
}

const Ctx = createContext<(o?: ComposeOpts) => void>(() => {});

function ComposeBody({ opts }: { opts: ComposeOpts }) {
  const close = useModalClose();
  return <Composer autoFocus replyTo={opts.replyTo} boardSlug={opts.boardSlug} onPosted={close} showReplyContext />;
}

/** 全局发帖弹窗：任何地方 useCompose()({ replyTo }) 即可打开 */
export function ComposeProvider({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<ComposeOpts | null>(null);
  const open = useCallback((o: ComposeOpts = {}) => setOpts(o), []);
  const close = useCallback(() => setOpts(null), []);
  return (
    <Ctx.Provider value={open}>
      {children}
      {opts && (
        <Modal title={opts.replyTo ? '回复' : '发帖'} onClose={close} className="compose-modal">
          <ComposeBody opts={opts} />
        </Modal>
      )}
    </Ctx.Provider>
  );
}

export const useCompose = () => useContext(Ctx);
