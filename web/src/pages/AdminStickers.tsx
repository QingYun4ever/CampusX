/** 管理后台：表情包审核、官方包维护 */
import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ExternalLink, Pencil, X } from 'lucide-react';
import { MediaImage } from '../components/MediaImage';
import { Avatar, Empty, Field, Spinner, toast } from '../components/ui';
import { api, type StickerPack } from '../lib/api';
import { emojiSrc } from '../lib/customEmoji';
import { STICKER_KEY } from '../lib/stickerPacks';
import { fullTime, timeAgo } from '../lib/format';
import './stickers.css';

const STATUS: Record<StickerPack['status'], [string, string]> = {
  draft: ['草稿', ''],
  pending: ['待审核', 'warn'],
  rejected: ['已驳回', 'bad'],
  ok: ['正常', 'ok'],
};

function usePackList(status: 'pending' | 'all') {
  return useQuery({
    queryKey: [...STICKER_KEY, 'admin', status],
    queryFn: () => api<{ items: StickerPack[] }>(`/admin/emoji-packs${status === 'pending' ? '?status=pending' : ''}`),
  });
}

/** 待审核的一个包：把全部表情摊开，新加的（待审）标出来 */
function ReviewItem({ pack, onDone }: { pack: StickerPack; onDone: () => void }) {
  const full = useQuery({
    queryKey: [...STICKER_KEY, 'pack', pack.id],
    queryFn: () => api<StickerPack>(`/emoji-packs/${pack.id}`),
  });
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const items = full.data?.items ?? [];
  const fresh = items.filter((i) => !i.reviewed);
  const act = async (action: 'approve' | 'reject') => {
    setBusy(true);
    try {
      await api(`/admin/emoji-packs/${pack.id}/${action}`, { body: action === 'reject' ? { note } : {} });
      toast(action === 'approve' ? '已通过，已上架' : '已驳回，对方会收到通知');
      onDone();
    } catch (e) {
      toast((e as Error).message, 'error');
      setBusy(false);
    }
  };
  return (
    <div className="log-item">
      <Avatar src={pack.owner?.avatar ?? null} name={pack.owner?.displayName ?? '?'} size={36} decoration={pack.owner?.avatarDecoration} />
      <div className="log-body">
        <div className="log-head">
          <span className="name">{pack.owner?.displayName ?? '已注销'}</span>
          {pack.owner && <span className="muted">@{pack.owner.username}</span>}
          <span className="muted">·</span>
          {pack.submittedAt && <time className="muted" title={fullTime(pack.submittedAt)}>{timeAgo(pack.submittedAt)}</time>}
          {pack.listed && <span className="pill ok">已上架，审改动</span>}
        </div>
        <div className="log-content">
          <b>{pack.name}</b>
          {pack.description && <div className="muted small">{pack.description}</div>}
        </div>
        <div className="muted small">
          {pack.listed ? `新加 ${fresh.length} 个，已上架 ${items.length - fresh.length} 个` : `共 ${items.length} 个表情`}
          {' · '}
          <Link to={`/stickers/${pack.id}/edit`}>打开编辑 <ExternalLink size={12} /></Link>
        </div>
        {full.isPending ? (
          <Spinner inline />
        ) : (
          <div className="sticker-wall admin-sticker-wall">
            {/* 已上架的包只看新加的；第一次审就全看 */}
            {(pack.listed ? fresh : items).map((i) => (
              <span key={i.id} className="sticker-cell">
                <MediaImage src={emojiSrc(i.file)} alt="" loading="lazy" decoding="async" draggable={false} />
                {i.group && <span className="sticker-badge">{i.group}</span>}
              </span>
            ))}
          </div>
        )}
        {rejecting && (
          <div className="entry-reject">
            <Field label="驳回理由（选填，会告诉对方）" value={note} onChange={setNote} maxLength={100} placeholder="比如：有几张图不适合" />
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-danger sm" disabled={busy} onClick={() => void act('reject')}>确认驳回</button>
              <button className="btn btn-outline sm" disabled={busy} onClick={() => setRejecting(false)}>取消</button>
            </div>
          </div>
        )}
        <p className="muted small">有个别不合适的图：先打开编辑删掉，再点通过。</p>
      </div>
      {!rejecting && (
        <div className="log-actions">
          <button className="btn btn-outline sm" disabled={busy || full.isPending} onClick={() => void act('approve')}>
            <Check size={15} /> 通过
          </button>
          <button className="btn btn-outline sm danger" disabled={busy} onClick={() => setRejecting(true)}>
            <X size={15} /> 驳回
          </button>
        </div>
      )}
    </div>
  );
}

function PendingList() {
  const qc = useQueryClient();
  const q = usePackList('pending');
  const done = () => {
    void qc.invalidateQueries({ queryKey: STICKER_KEY });
    void qc.invalidateQueries({ queryKey: ['admin-packs-count'] });
  };
  if (q.isPending) return <Spinner />;
  if (!q.data?.items.length) return <Empty title="没有要审核的表情包">同学提交表情包后会出现在这里。</Empty>;
  return <>{q.data.items.map((p) => <ReviewItem key={p.id} pack={p} onDone={done} />)}</>;
}

function AllList() {
  const q = usePackList('all');
  if (q.isPending) return <Spinner />;
  if (!q.data?.items.length) return <Empty title="还没有表情包" />;
  return (
    <div className="admin-sticker-list">
      {q.data.items.map((p) => {
        const [label, tone] = STATUS[p.status];
        return (
          <Link key={p.id} to={`/stickers/${p.id}/edit`} className="admin-sticker-row">
            {p.cover ? <MediaImage className="sticker-cover" src={emojiSrc(p.cover)} alt="" /> : <span className="sticker-cover empty" />}
            <div className="grow">
              <b>{p.name}</b>
              <div className="muted small">
                {p.official ? '官方' : p.owner ? `@${p.owner.username}` : '已注销'} · {p.total ?? p.count} 个表情 · {p.installs} 人安装
              </div>
            </div>
            <span className={`pill ${p.listed ? 'ok' : ''}`}>{p.listed ? '上架中' : '未上架'}</span>
            {p.status !== 'ok' && <span className={`pill ${tone}`}>{label}</span>}
            <Pencil size={16} className="muted" />
          </Link>
        );
      })}
    </div>
  );
}

function NewOfficial() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [credit, setCredit] = useState('');
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const p = await api<StickerPack>('/emoji-packs', { body: { name, description: desc, credit, official: true } });
      await qc.invalidateQueries({ queryKey: STICKER_KEY });
      toast('建好了，加完表情记得点「上架」');
      nav(`/stickers/${p.id}/edit`);
    } catch (e) {
      toast((e as Error).message, 'error');
      setBusy(false);
    }
  };
  return (
    <div className="admin-form">
      <p className="muted">官方包不用审核，传上去的表情直接可用；加完表情在编辑页点「上架」，商场里就能看到。可以「导入文件夹」，子文件夹名会变成分组。</p>
      <Field label="名字" value={name} onChange={setName} maxLength={20} counter />
      <Field label="介绍" value={desc} onChange={setDesc} maxLength={100} counter multiline />
      <Field label="来源和版权说明" value={credit} onChange={setCredit} maxLength={200} multiline placeholder="比如：整理自 xxx，仅限非商业使用" />
      <button className="btn btn-primary" disabled={busy || !name.trim()} onClick={() => void create()}>新建官方表情包</button>
    </div>
  );
}

export function StickersAdminPage({ head }: { head: (right: ReactNode) => ReactNode }) {
  const [tab, setTab] = useState<'pending' | 'all' | 'new'>('pending');
  return (
    <>
      {head(
        <div className="seg">
          <button className={tab === 'pending' ? 'on' : ''} onClick={() => setTab('pending')}>待审核</button>
          <button className={tab === 'all' ? 'on' : ''} onClick={() => setTab('all')}>全部</button>
          <button className={tab === 'new' ? 'on' : ''} onClick={() => setTab('new')}>新建官方包</button>
        </div>,
      )}
      {tab === 'pending' ? <PendingList /> : tab === 'all' ? <AllList /> : <NewOfficial />}
    </>
  );
}
