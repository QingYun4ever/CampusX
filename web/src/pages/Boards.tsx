import { useState, type CSSProperties, type MouseEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Crown, Lock, Megaphone, Pencil, Plus, Shield, UserMinus, X } from 'lucide-react';
import { Composer } from '../components/Composer';
import { Feed } from '../components/Feed';
import { PostCard, RichText } from '../components/PostCard';
import { Avatar, BoardMark, toneFor, Empty, Field, Modal, PostSkeleton, Tabs, toast, TopBar, Verified } from '../components/ui';
import { api, type Board, type BoardDetail, type Page, type Post, type User } from '../lib/api';
import { useMe } from '../lib/auth';
import { timeAgo } from '../lib/format';

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

function BoardForm({ board, onClose }: { board?: BoardDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [f, setF] = useState({
    slug: board?.slug ?? '',
    name: board?.name ?? '',
    description: board?.description ?? '',
    icon: board?.icon ?? '💬',
    visibility: board?.visibility ?? 'public',
  });
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const { slug, ...patch } = f;
      const r = board
        ? await api<BoardDetail>(`/boards/${board.slug}`, { method: 'PATCH', body: patch })
        : await api<BoardDetail>('/boards', { body: { slug, ...patch } });
      qc.setQueryData(['board', r.slug], r);
      if (board && board.visibility !== r.visibility) void qc.invalidateQueries();
      else void qc.invalidateQueries({ queryKey: ['boards'] });
      toast(board ? '已保存' : '创建成功');
      onClose();
      if (!board) nav(`/b/${r.slug}`);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  if (deleting && board) return <DeleteBoardModal board={board} onClose={() => setDeleting(false)} />;
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
        <div className="radio-list" role="radiogroup" aria-label="可见范围">
          <h4 className="team-h">可见范围</h4>
          {([
            ['public', '公开', '所有同学可见'],
            ['private', '私密', '只有你邀请的同学可见'],
          ] as const).map(([value, label, description]) => (
            <label key={value} className={`radio-item${f.visibility === value ? ' on' : ''}`}>
              <input
                type="radio"
                name="visibility"
                checked={f.visibility === value}
                onChange={() => setF({ ...f, visibility: value })}
              />
              <span><b>{label}</b><small className="muted">{description}</small></span>
            </label>
          ))}
        </div>
        {board && (
          <button className="btn btn-outline danger" style={{ color: 'var(--danger)' }} disabled={busy} onClick={() => setDeleting(true)}>
            删除这个吧
          </button>
        )}
      </div>
    </Modal>
  );
}

function DeleteBoardModal({ board, onClose }: { board: BoardDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const q = useQuery({
    queryKey: ['board', board.slug],
    queryFn: () => api<BoardDetail>(`/boards/${board.slug}`),
    refetchOnMount: 'always',
  });
  const current = q.data;
  const count = current?.deletePostCount;
  const ready = !busy && !q.isFetching && !q.isError && count != null && name === current?.name;
  const remove = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      await api(`/boards/${board.slug}`, { method: 'DELETE' });
      void qc.invalidateQueries();
      nav('/boards', { replace: true });
      toast('已删除');
    } catch (e) {
      toast((e as Error).message, 'error');
      setBusy(false);
    }
  };
  return (
    <Modal
      title="删除这个吧"
      onClose={onClose}
      right={
        <button className="btn btn-outline danger" style={{ color: 'var(--danger)' }} disabled={!ready} onClick={remove}>
          确认删除
        </button>
      }
    >
      <div className="modal-body">
        {q.isFetching ? (
          <p className="muted">正在统计帖子…</p>
        ) : q.isError || !current || count == null ? (
          <p role="alert">无法确认要删除的帖子数。</p>
        ) : (
          <>
            <p>删除后会一起删掉 {count} 条帖子和回复，无法恢复。</p>
            <Field label="输入吧名确认" hint={`请输入「${current.name}」`} value={name} onChange={setName} autoComplete="off" />
          </>
        )}
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
              <div className="name team-part">
                {b.name}吧
                {b.visibility === 'private' && <Lock size={13} className="muted" aria-label="私密" />}
              </div>
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

/* ---------- 吧详情：公告 ---------- */
function Announcement({ b, onEdit }: { b: BoardDetail; onEdit: () => void }) {
  const [more, setMore] = useState(false);
  const a = b.announcement;
  if (!a) {
    return b.myRole ? (
      <button className="announce-empty" onClick={onEdit}>
        <Megaphone size={16} /> 发布公告
      </button>
    ) : null;
  }
  const long = a.text.length > 140 || a.text.split('\n').length > 4;
  return (
    <section className="announce">
      <div className="announce-head">
        <span className="announce-ico">
          <Megaphone size={15} />
        </span>
        <b>公告</b>
        <span className="muted small">
          {a.by ? `@${a.by.username} · ` : ''}
          {timeAgo(a.updatedAt)}更新
        </span>
        {b.myRole && (
          <button className="icon-btn sm" onClick={onEdit} aria-label="编辑公告" title="编辑公告">
            <Pencil size={15} />
          </button>
        )}
      </div>
      <div className={`announce-body ${long && !more ? 'clamped' : ''}`}>
        <RichText text={a.text} />
      </div>
      {long && (
        <button className="announce-more" onClick={() => setMore((m) => !m)}>
          {more ? '收起' : '展开全部'}
        </button>
      )}
    </section>
  );
}

function AnnouncementEditor({ b, onClose }: { b: BoardDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const [text, setText] = useState(b.announcement?.text ?? '');
  const [busy, setBusy] = useState(false);
  const save = async (t: string) => {
    setBusy(true);
    try {
      const r = await api<BoardDetail>(`/boards/${b.slug}/announcement`, { method: 'PUT', body: { text: t } });
      qc.setQueryData(['board', b.slug], r);
      toast(t ? '公告已更新' : '公告已清除');
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="吧公告"
      onClose={onClose}
      right={
        <button className="btn btn-light" disabled={busy || !text.trim()} onClick={() => save(text.trim())}>
          发布
        </button>
      }
    >
      <div className="modal-body">
        <Field
          label="公告内容"
          multiline
          value={text}
          onChange={setText}
          maxLength={1000}
          counter
          hint="显示在吧首页最上面。支持 Markdown，比如 **加粗**、列表、链接"
        />
        {b.announcement && (
          <div className="modal-actions">
            <button className="btn btn-outline danger sm" disabled={busy} onClick={() => save('')}>
              清除公告
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}

/* ---------- 吧务团队 ---------- */
function TeamMember({ u, role, action }: { u: User; role?: 'owner' | 'mod'; action?: React.ReactNode }) {
  return (
    <div className="team-row">
      <Link to={`/u/${u.username}`} className="team-user">
        <Avatar src={u.avatar} name={u.displayName} size={40} decoration={u.avatarDecoration} />
        <div style={{ minWidth: 0 }}>
          <div className="name">
            <span className="ellipsis">{u.displayName}</span>
            <Verified user={u} size={15} />
            {role && <span className={`tag ${role}`}>{role === 'owner' ? '吧主' : '吧务'}</span>}
          </div>
          <div className="muted small ellipsis">@{u.username}{!role && u.className && ` · ${u.className}`}</div>
        </div>
      </Link>
      {action}
    </div>
  );
}

function TeamModal({ b, onClose }: { b: BoardDetail; onClose: () => void }) {
  const me = useMe();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [owner, setOwner] = useState('');
  const [busy, setBusy] = useState(false);
  const isOwner = b.myRole === 'owner' || b.myRole === 'admin';
  const call = async (path: string, init: { method?: string; body?: unknown }, ok: string) => {
    setBusy(true);
    try {
      const r = await api<BoardDetail>(`/boards/${b.slug}${path}`, init);
      qc.setQueryData(['board', b.slug], r);
      toast(ok);
      return true;
    } catch (e) {
      toast((e as Error).message, 'error');
      return false;
    } finally {
      setBusy(false);
    }
  };
  const add = async () => {
    if (await call('/mods', { body: { username: name } }, '已添加吧务')) setName('');
  };
  const transfer = async () => {
    const who = owner.trim().replace(/^@/, '');
    if (!who) return;
    const msg = b.owner
      ? `把吧主转让给 @${who}？${b.myRole === 'owner' ? '你会变成吧务。' : '原吧主会变成吧务。'}`
      : `设置 @${who} 为吧主？`;
    if (!confirm(msg)) return;
    if (await call('/owner', { body: { username: who } }, '吧主已更新')) setOwner('');
  };
  return (
    <Modal title={`${b.name}吧 · 吧务团队`} onClose={onClose}>
      <div className="modal-body team">
        <div>
          <h4 className="team-h">
            <Crown size={15} /> 吧主
          </h4>
          {b.owner ? <TeamMember u={b.owner} role="owner" /> : <p className="muted small">这个吧还没有吧主。</p>}
        </div>
        <div>
          <h4 className="team-h">
            <Shield size={15} /> 吧务 <span className="muted">{b.mods.length} / 10</span>
          </h4>
          {!b.mods.length && <p className="muted small">还没有吧务。吧务可以发公告、置顶和删除吧里的帖子。</p>}
          {b.mods.map((u) => (
            <TeamMember
              key={u.id}
              u={u}
              role="mod"
              action={
                isOwner ? (
                  <button
                    className="icon-btn"
                    disabled={busy}
                    aria-label={`移除 ${u.displayName}`}
                    title="移除吧务"
                    onClick={() => confirm(`移除吧务 @${u.username}？`) && call(`/mods/${u.username}`, { method: 'DELETE' }, '已移除')}
                  >
                    <X size={18} />
                  </button>
                ) : u.id === me.id ? (
                  <button
                    className="btn btn-outline sm"
                    disabled={busy}
                    onClick={() => confirm('确定卸任吧务？') && call(`/mods/${u.username}`, { method: 'DELETE' }, '已卸任')}
                  >
                    <UserMinus size={15} /> 卸任
                  </button>
                ) : null
              }
            />
          ))}
          {isOwner && b.mods.length < 10 && (
            <form
              className="inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (name.trim()) add();
              }}
            >
              <Field label="添加吧务（用户名）" value={name} onChange={setName} prefix="@" />
              <button className="btn btn-primary" disabled={busy || !name.trim()}>
                添加
              </button>
            </form>
          )}
        </div>
        {isOwner && (
          <div>
            <h4 className="team-h">{b.owner ? '转让吧主' : '设置吧主'}</h4>
            <form
              className="inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                transfer();
              }}
            >
              <Field label="新吧主（用户名）" value={owner} onChange={setOwner} prefix="@" />
              <button className="btn btn-outline" disabled={busy || !owner.trim()}>
                {b.owner ? '转让' : '设置'}
              </button>
            </form>
          </div>
        )}
      </div>
    </Modal>
  );
}

function TeamStrip({ b, onOpen }: { b: BoardDetail; onOpen: () => void }) {
  return (
    <button className="board-team" onClick={onOpen}>
      <span className="team-part">
        <Crown size={14} className="crown" />
        {b.owner ? (
          <>
            <Avatar src={b.owner.avatar} name={b.owner.displayName} size={22} decoration={b.owner.avatarDecoration} />
            <span className="ellipsis">{b.owner.displayName}</span>
          </>
        ) : (
          <span className="muted">暂无吧主</span>
        )}
      </span>
      {b.mods.length > 0 && (
        <span className="team-part">
          <span className="muted">吧务</span>
          <span className="face-stack">
            {b.mods.slice(0, 4).map((u) => (
              <Avatar key={u.id} src={u.avatar} name={u.displayName} size={22} decoration={u.avatarDecoration} />
            ))}
          </span>
          {b.mods.length > 4 && <span className="muted">+{b.mods.length - 4}</span>}
        </span>
      )}
      <ChevronRight size={16} className="muted chev" />
    </button>
  );
}

function ViewersModal({ b, onClose }: { b: BoardDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const owner = b.myRole === 'owner';
  const path = `/boards/${b.slug}/viewers`;
  const [name, setName] = useState('');
  const [showClasses, setShowClasses] = useState(false);
  const [busy, setBusy] = useState(false);
  const username = name.trim().replace(/^@/, '');
  const viewers = useQuery({ queryKey: ['board-viewers', b.slug], queryFn: () => api<User[]>(path) });
  const search = useQuery({
    queryKey: ['viewer-search', username],
    queryFn: () => api<Page<User>>(`/search?type=users&q=${encodeURIComponent(username)}`),
    enabled: owner && !!username,
  });
  const classes = useQuery({
    queryKey: ['classes'],
    queryFn: () => api<{ name: string; count: number }[]>('/classes'),
    enabled: owner && showClasses,
  });
  const candidates = search.data?.items.filter((u) => u.id !== b.ownerId && !viewers.data?.some((v) => v.id === u.id));

  const change = async (target: { username: string } | { className: string }, remove = false) => {
    setBusy(true);
    try {
      let board: BoardDetail;
      let message: string;
      if (remove && 'username' in target) {
        board = await api<BoardDetail>(`${path}/${encodeURIComponent(target.username)}`, { method: 'DELETE' });
        message = '已移除';
      } else {
        const result = await api<{ added: number; board: BoardDetail }>(path, {
          body: 'username' in target ? { usernames: [target.username] } : target,
        });
        board = result.board;
        message = result.added ? `已添加 ${result.added} 位同学` : '没有新增成员';
      }
      qc.setQueryData(['board', b.slug], board);
      await qc.invalidateQueries({ queryKey: ['board-viewers', b.slug] });
      if (remove) void qc.invalidateQueries({ queryKey: ['boards'] });
      toast(message);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="可见成员" onClose={onClose}>
      <div className="modal-body team">
        <p className="muted small">吧主、吧务和网站管理员始终可见</p>
        <div>
          <h4 className="team-h">成员名单 <span className="muted">{b.viewerCount} 人</span></h4>
          {viewers.isPending ? <p className="muted small">正在加载…</p>
            : viewers.isError ? <p className="muted small" role="alert">成员名单加载失败</p>
            : !viewers.data.length && <p className="muted small">还没有添加同学。</p>}
          {viewers.data?.map((u) => (
            <TeamMember key={u.id} u={u} action={owner && (
              <button className="icon-btn" disabled={busy} aria-label={`移除 ${u.displayName}`} onClick={() => change(u, true)}>
                <X size={18} />
              </button>
            )} />
          ))}
        </div>
        {owner && (
          <>
            <div>
              <Field label="搜索同学" value={name} onChange={setName} placeholder="昵称或用户名" autoComplete="off" />
              {username && (search.isPending ? <p className="muted small">正在搜索…</p>
                : search.isError ? <p className="muted small" role="alert">搜索失败</p>
                : !candidates?.length && <p className="muted small">没有可添加的同学。</p>)}
              {candidates?.map((u) => (
                <TeamMember key={u.id} u={u} action={(
                  <button className="btn btn-outline sm" disabled={busy} aria-label={`添加 ${u.displayName}`} onClick={() => change(u)}>
                    添加
                  </button>
                )} />
              ))}
            </div>
            <div>
              <button className="btn btn-outline sm" aria-expanded={showClasses} onClick={() => setShowClasses(!showClasses)}>
                按班级添加
              </button>
              {showClasses && (
                <div className="chip-row" style={{ marginTop: 8 }}>
                  {classes.isPending ? <p className="muted small">正在加载…</p>
                    : classes.isError ? <p className="muted small" role="alert">班级加载失败</p>
                    : !classes.data.length && <p className="muted small">没有可添加的班级。</p>}
                  {classes.data?.map(({ name, count }) => (
                    <button key={name} className="chip" disabled={busy} onClick={() => {
                      if (confirm(`让「${name}」的同学都能看到这个吧？`)) void change({ className: name });
                    }}>
                      {name} · {count} 人
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

function Pinned({ slug }: { slug: string }) {
  const q = useQuery({ queryKey: ['board-pinned', slug], queryFn: () => api<Post[]>(`/boards/${slug}/pinned`) });
  if (!q.data?.length) return null;
  return (
    <div className="pinned-list">
      {q.data.map((p) => (
        <PostCard key={p.id} post={p} pinnedContext />
      ))}
    </div>
  );
}

export function BoardPage() {
  const { slug = '' } = useParams();
  const me = useMe();
  const [sort, setSort] = useState<'active' | 'new'>('active');
  const [editing, setEditing] = useState(false);
  const [announcing, setAnnouncing] = useState(false);
  const [team, setTeam] = useState(false);
  const [viewers, setViewers] = useState(false);
  const q = useQuery({ queryKey: ['board', slug], queryFn: () => api<BoardDetail>(`/boards/${slug}`) });
  if (q.isPending) return <><TopBar back title="吧" /><PostSkeleton /></>;
  if (q.isError) return (
    <>
      <TopBar back title="吧" />
      {q.error.message.includes('私密') ? (
        <div className="empty">
          <Lock size={24} className="muted" aria-hidden />
          <h3>这是私密吧</h3>
          <p>只有吧主邀请的同学可以查看。</p>
        </div>
      ) : <Empty title="没有这个吧">它可能已经被删除了。</Empty>}
    </>
  );
  const b = q.data;
  const canEdit = b.myRole === 'owner' || me.role === 'admin';
  const isPrivate = b.visibility === 'private';
  const canSeeViewers = isPrivate && (b.myRole === 'owner' || b.myRole === 'mod');
  return (
    <>
      <TopBar back title={`${b.name}吧`} sub={`${b.postCount} 帖`} />
      <div className="board-hero" style={{ '--tone': toneFor(b.slug) } as CSSProperties}>
        <BoardMark name={b.name} slug={b.slug} size={72} />
        <div className="board-hero-info">
          <h2>
            {b.name}吧
            {isPrivate && <span className="tag team-part"><Lock size={12} aria-hidden /> 私密</span>}
            {b.myRole === 'owner' && <span className="tag owner">我是吧主</span>}
            {b.myRole === 'mod' && <span className="tag mod">我是吧务</span>}
          </h2>
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
            <button className="icon-btn outlined" onClick={() => setEditing(true)} aria-label="编辑吧资料" title="编辑吧资料">
              <Pencil size={16} />
            </button>
          )}
          <JoinButton board={b} />
        </div>
        <TeamStrip b={b} onOpen={() => setTeam(true)} />
        {canSeeViewers && (
          <button className="board-team" onClick={() => setViewers(true)}>
            <span className="team-part"><Lock size={14} aria-hidden /> 私密吧 · {b.viewerCount} 位同学可见</span>
            <ChevronRight size={16} className="muted chev" aria-hidden />
          </button>
        )}
      </div>
      <Announcement b={b} onEdit={() => setAnnouncing(true)} />
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
      <Pinned slug={slug} />
      <Feed
        key={sort}
        queryKey={['board-posts', slug, sort]}
        path={`/boards/${slug}/posts?sort=${sort}`}
        empty={<Empty title="还没有帖子">发第一帖，坐个沙发。</Empty>}
      />
      {editing && <BoardForm board={b} onClose={() => setEditing(false)} />}
      {announcing && <AnnouncementEditor b={b} onClose={() => setAnnouncing(false)} />}
      {team && <TeamModal b={b} onClose={() => setTeam(false)} />}
      {viewers && canSeeViewers && <ViewersModal b={b} onClose={() => setViewers(false)} />}
    </>
  );
}
