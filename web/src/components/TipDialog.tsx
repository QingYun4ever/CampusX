import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CrystalAmount, CrystalIcon } from './Crystal';
import { Modal, Spinner, toast } from './ui';
import { api, type BoostStatus, type Post, type Wallet } from '../lib/api';
import { useSetWallet, useWallet } from '../lib/crystals';
import { timeAgo } from '../lib/format';

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

/** 花紫水晶推流：让这条帖子在首页「推荐」「最新」里被更多人看到 */
export function BoostDialog({ post, onClose }: { post: Post; onClose: () => void }) {
  const w = useWallet();
  const setWallet = useSetWallet();
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ['boost', post.id],
    queryFn: () => api<BoostStatus>(`/posts/${post.id}/boost`),
    staleTime: 0,
  });
  const [amount, setAmount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const balance = w.data?.balance ?? 0;
  const per = w.data?.rules.boostReachPer ?? 2;
  const room = status.data?.room;
  const send = async () => {
    if (!amount) return;
    setBusy(true);
    try {
      const r = await api<{ reach: number; status: BoostStatus; wallet: Wallet }>(`/posts/${post.id}/boost`, { body: { amount } });
      setWallet(r.wallet);
      qc.setQueryData(['boost', post.id], r.status);
      toast(`已推流，会多 ${r.reach} 个人看到`);
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
      setBusy(false);
    }
  };
  const s = status.data;
  return (
    <Modal title="推流" onClose={onClose}>
      <div className="tip-dialog">
        {w.isPending ? (
          <Spinner />
        ) : (
          <>
            <p className="boost-intro">
              花紫水晶让这条帖子出现在更多人的首页里，标着「推流」。只推给还没看过它的同学，每人一次。
            </p>
            {s && s.reach > 0 && (
              <div className="boost-progress">
                <div className="boost-progress-head">
                  <span>{s.active ? '推流中' : '推流已结束'}</span>
                  <b>{s.shown.toLocaleString('zh-CN')} / {s.reach.toLocaleString('zh-CN')} 人看到</b>
                </div>
                <div className="boost-bar"><i style={{ width: `${Math.min(100, (s.shown / s.reach) * 100)}%` }} /></div>
              </div>
            )}
            {room !== undefined && (
              <div className="boost-room">
                {room > 0 ? <>最近两周活跃的同学里，还有 <b>{room}</b> 人没看过这条</> : '最近两周活跃的同学基本都看过这条了，不用推流啦'}
              </div>
            )}
            <div className="tip-balance">
              <span>我的紫水晶</span>
              <Link to="/crystals" onClick={onClose}><CrystalAmount n={balance} /></Link>
            </div>
            <div className="tip-amounts boost-amounts" role="radiogroup" aria-label="推流数量">
              {(w.data?.rules.boostAmounts ?? [10, 25, 50]).map((n) => (
                <button
                  key={n}
                  role="radio"
                  aria-checked={amount === n}
                  className={amount === n ? 'on' : ''}
                  disabled={n > balance || (room !== undefined && n * per > room) || status.isPending}
                  onClick={() => setAmount(n)}
                >
                  <span className="boost-reach">{(n * per).toLocaleString('zh-CN')} 人</span>
                  <span className="boost-cost"><CrystalIcon size={14} />{n}</span>
                </button>
              ))}
            </div>
            <button className="btn btn-primary" disabled={!amount || busy} onClick={send}>
              {amount ? `花 ${amount} 颗，让 ${amount * per} 个人看到` : '选一个档位'}
            </button>
            <div className="tip-note">72 小时内没推完的，按没看到的人数退回紫水晶</div>
            {!!s?.mine.length && (
              <div className="boost-mine">
                <div className="boost-mine-title">我推过的</div>
                {s.mine.map((b) => (
                  <div className="boost-mine-row" key={b.id}>
                    <span className="grow">{timeAgo(b.createdAt)} · {b.amount} 颗</span>
                    <span className="muted">
                      {b.shown}/{b.reach} 人{b.endedAt ? (b.refund ? ` · 退回 ${b.refund} 颗` : ' · 已结束') : ' · 进行中'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
