import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { CrystalAmount, CrystalIcon } from './Crystal';
import { Modal, Spinner, toast } from './ui';
import { api, type Post } from '../lib/api';
import { useWallet } from '../lib/crystals';

/** 给帖子作者打赏紫水晶 */
export function TipDialog({ post, onClose }: { post: Post; onClose: () => void }) {
  const w = useWallet();
  const qc = useQueryClient();
  const [amount, setAmount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const balance = w.data?.balance ?? 0;
  const send = async () => {
    if (!amount) return;
    setBusy(true);
    try {
      await api(`/posts/${post.id}/tip`, { body: { amount } });
      toast(`已打赏 ${amount} 颗紫水晶`);
      void qc.invalidateQueries({ queryKey: ['wallet'] });
      void qc.invalidateQueries({ queryKey: ['crystal-log'] });
      void qc.invalidateQueries({ queryKey: ['post'] });
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
      setBusy(false);
    }
  };
  return (
    <Modal title={`打赏 ${post.author.displayName}`} onClose={onClose}>
      <div className="tip-dialog">
        {w.isPending ? (
          <Spinner />
        ) : (
          <>
            <div className="tip-balance">
              <span>我的紫水晶</span>
              <Link to="/crystals" onClick={onClose}><CrystalAmount n={balance} /></Link>
            </div>
            <div className="tip-amounts" role="radiogroup" aria-label="打赏数量">
              {(w.data?.rules.tipAmounts ?? [1, 5, 10, 20, 50]).map((n) => (
                <button
                  key={n}
                  role="radio"
                  aria-checked={amount === n}
                  className={amount === n ? 'on' : ''}
                  disabled={n > balance}
                  onClick={() => setAmount(n)}
                >
                  <CrystalIcon size={20} />
                  {n}
                </button>
              ))}
            </div>
            <button className="btn btn-primary" disabled={!amount || busy} onClick={send}>
              {amount ? `送出 ${amount} 颗` : '选一个数量'}
            </button>
            <div className="tip-note">
              {balance ? '紫水晶会直接转给作者，送出后不能撤回' : <>还没有紫水晶，<Link to="/crystals" onClick={onClose}>去签到领一些</Link></>}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
