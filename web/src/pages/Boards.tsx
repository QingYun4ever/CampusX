import { useState, type CSSProperties, type MouseEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus } from 'lucide-react';
import { Composer } from '../components/Composer';
import { Feed } from '../components/Feed';
import { BoardMark, toneFor, Empty, Field, Modal, PostSkeleton, Tabs, toast, TopBar } from '../components/ui';
import { api, type Board } from '../lib/api';
import { useMe } from '../lib/auth';

function JoinButton({ board }: { board: Board }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const toggle = async (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setBusy(true);
    try {
      await api(`/boards/${board.slug}/join`, { method: board.joined ? 'DELETE' : 'POST' });
      await qc.invalidateQueries({ queryKey: ['boards'] });
      await qc.invalidateQueries({ queryKey: ['board', board.slug] });
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return board.joined ? (
    <button className="btn btn-outline sm" disabled={busy} onClick={toggle}>
      已关注
    </button>
  ) : (
    <button className="btn btn-light sm" disabled={busy} onClick={toggle}>
      关注
    </button>
  );
}

function BoardForm({ board, onClose }: { board?: Board; onClose: () => void }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [f, setF] = useState({
    slug: board?.slug ?? '',
    name: board?.name ?? '',
    description: board?.description ?? '',
    icon: board?.icon ?? '💬',
  });
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const r = board
        ? await api<Board>(`/boards/${board.slug}`, { method: 'PATCH', body: { name: f.name, description: f.description, icon: f.icon } })
        : await api<Board>('/boards', { body: f });
      qc.invalidateQueries({ queryKey: ['boards'] });
      qc.invalidateQueries({ queryKey: ['board', r.slug] });
      toast(board ? '已保存' : '创建成功');
      onClose();
      if (!board) nav(`/b/${r.slug}`);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={board ? '编辑吧' : '创建新吧'}
      onClose={onClose}
      right={
        <button className="btn btn-light" disabled={busy || !f.name || (!board && !f.slug)} onClick={submit}>
          {board ? '保存' : '创建'}
        </button>
      }
    >
      <div className="modal-body">
        <div className="board-form-preview">
          <BoardMark name={f.name || '吧'} slug={f.slug || board?.slug || 'new'} size={56} />
          <div>
            <div className="name">{f.name ? `${f.name}吧` : '新的吧'}</div>
            <div className="muted small">/b/{f.slug || board?.slug || '…'}</div>
          </div>
        </div>
        <Field label="名称" value={f.name} onChange={(v) => setF({ ...f, name: v })} maxLength={16} counter placeholder="例如：高三2班" />
        {!board && (
          <Field
            label="地址"
            prefix="/b/"
            value={f.slug}
            onChange={(v) => setF({ ...f, slug: v.toLowerCase().replace(/[^a-z0-9-]/g, '') })}
            maxLength={24}
            hint="小写字母、数字或 -，创建后不能修改"
          />
        )}
        <Field
          label="简介"
          multiline
          value={f.description}
          onChange={(v) => setF({ ...f, description: v })}
          maxLength={100}
          counter
        />
      </div>
    </Modal>
  );
}

export function Boards() {
  const q = useQuery({ queryKey: ['boards'], queryFn: () => api<Board[]>('/boards') });
  const [creating, setCreating] = useState(false);
  return (
    <>
      <TopBar
        title="吧"
        sub={q.data ? `${q.data.length} 个吧` : undefined}
        right={
          <button className="btn btn-outline sm" onClick={() => setCreating(true)}>
            <Plus size={16} /> 新建
          </button>
        }
      />
      {q.isPending ? (
        <PostSkeleton n={4} />
      ) : q.isError ? (
        <Empty title="加载失败" />
      ) : (
        q.data.map((b, i) => (
          <Link key={b.slug} to={`/b/${b.slug}`} className="board-row enter" style={{ '--i': i } as CSSProperties}>
            <BoardMark name={b.name} slug={b.slug} size={48} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="name">{b.name}吧</div>
              {b.description && <div className="muted ellipsis small">{b.description}</div>}
              <div className="faint small">
                {b.postCount} 帖 · {b.memberCount} 人关注
              </div>
            </div>
            <JoinButton board={b} />
          </Link>
        ))
      )}
      {creating && <BoardForm onClose={() => setCreating(false)} />}
    </>
  );
}

export function BoardPage() {
  const { slug = '' } = useParams();
  const me = useMe();
  const [sort, setSort] = useState<'active' | 'new'>('active');
  const [editing, setEditing] = useState(false);
  const q = useQuery({ queryKey: ['board', slug], queryFn: () => api<Board>(`/boards/${slug}`) });
  if (q.isPending) return <><TopBar back title="吧" /><PostSkeleton /></>;
  if (q.isError) return <><TopBar back title="吧" /><Empty title="没有这个吧">它可能已经被删除了。</Empty></>;
  const b = q.data;
  const canEdit = b.createdBy === me.id || me.role === 'admin';
  return (
    <>
      <TopBar back title={`${b.name}吧`} sub={`${b.postCount} 帖`} />
      <div className="board-hero" style={{ '--tone': toneFor(b.slug) } as CSSProperties}>
        <BoardMark name={b.name} slug={b.slug} size={72} />
        <div className="board-hero-info">
          <h2>{b.name}吧</h2>
          {b.description && <p className="muted">{b.description}</p>}
          <div className="board-stats">
            <span>
              <b>{b.postCount}</b> 帖子
            </span>
            <span>
              <b>{b.memberCount}</b> 人关注
            </span>
          </div>
        </div>
        <div className="board-hero-actions">
          {canEdit && (
            <button className="icon-btn outlined" onClick={() => setEditing(true)} aria-label="编辑吧">
              <Pencil size={16} />
            </button>
          )}
          <JoinButton board={b} />
        </div>
      </div>
      <div className="desktop-composer">
        <Composer boardSlug={b.slug} placeholder={`在${b.name}吧发帖`} />
      </div>
      <div className="tabs-wrap">
        <Tabs
          value={sort}
          onChange={setSort}
          items={[
            ['active', '最新回复'],
            ['new', '最新发布'],
          ]}
        />
      </div>
      <Feed
        key={sort}
        queryKey={['board-posts', slug, sort]}
        path={`/boards/${slug}/posts?sort=${sort}`}
        empty={<Empty title="还没有帖子">发第一帖，坐个沙发。</Empty>}
      />
      {editing && <BoardForm board={b} onClose={() => setEditing(false)} />}
    </>
  );
}
