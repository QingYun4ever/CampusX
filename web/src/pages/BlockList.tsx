import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, UserX } from 'lucide-react';
import { useBlockToggle } from '../components/Safety';
import { Avatar, Empty, Modal, Spinner } from '../components/ui';
import { api, type BlockedUser } from '../lib/api';

function BlockListBody() {
  const q = useQuery({ queryKey: ['blocks'], queryFn: () => api<BlockedUser[]>('/me/blocks') });
  const toggle = useBlockToggle();
  const [busy, setBusy] = useState<string | null>(null);
  if (q.isPending) return <div className="modal-body"><Spinner /></div>;
  if (q.isError) return <Empty title="加载失败">{(q.error as Error).message}</Empty>;
  if (!q.data.length) return <Empty title="没有拉黑任何人">在对方主页或帖子的 ⋯ 里可以拉黑。</Empty>;
  return (
    <div>
      {q.data.map((u) => (
        <div className="block-row" key={u.id}>
          <Link to={`/u/${u.username}`}>
            <Avatar src={u.avatar} name={u.displayName} size={40} decoration={u.avatarDecoration} />
            <span className="who">
              <b className="ellipsis">{u.displayName}</b>
              <span className="muted small ellipsis">@{u.username}</span>
            </span>
          </Link>
          <button
            className="btn btn-outline sm"
            disabled={busy === u.username}
            onClick={async () => {
              setBusy(u.username);
              await toggle(u, true);
              setBusy(null);
            }}
          >
            解除
          </button>
        </div>
      ))}
    </div>
  );
}

/** 设置里的「拉黑名单」入口 */
export function BlockListRow() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="list-link" onClick={() => setOpen(true)}>
        <UserX size={20} />
        <span className="grow">
          拉黑名单
          <span className="muted small">被拉黑的人不能和你互动，你也看不到他们的帖子</span>
        </span>
        <ChevronRight size={18} className="muted" />
      </button>
      {open && (
        <Modal title="拉黑名单" onClose={() => setOpen(false)}>
          <BlockListBody />
        </Modal>
      )}
    </>
  );
}
