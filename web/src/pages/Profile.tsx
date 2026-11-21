import { useEffect, useRef, useState, type ChangeEvent, type CSSProperties } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, Camera, GraduationCap, Mail, School, Settings } from 'lucide-react';
import { Feed } from '../components/Feed';
import { FollowButton } from '../components/FollowButton';
import { Avatar, Empty, Field, Modal, PostSkeleton, Tabs, toast, toneFor, TopBar, useModalClose, Verified } from '../components/ui';
import { api, media, uploadImage, type AvatarDecoration, type Profile as ProfileT, type User } from '../lib/api';
import { useAuth, useMe } from '../lib/auth';

type Tab = 'posts' | 'replies' | 'likes';

const AVATAR_DECORATIONS: readonly [AvatarDecoration, string][] = [
  ['', '无装扮'],
  ['halo', '蓝色光环'],
  ['aurora', '极光'],
  ['rose', '玫瑰光环'],
];

export function Profile() {
  const { username = '' } = useParams();
  const me = useMe();
  const [tab, setTab] = useState<Tab>('posts');
  const [editing, setEditing] = useState(false);
  const q = useQuery({ queryKey: ['profile', username], queryFn: () => api<ProfileT>(`/users/${username}`) });
  // 名字滚出视野后，顶栏才显示名字
  const nameRef = useRef<HTMLDivElement>(null);
  const [nameVisible, setNameVisible] = useState(true);
  useEffect(() => {
    const el = nameRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setNameVisible(e.isIntersecting), { rootMargin: '-60px 0px 0px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [q.isSuccess]);

  if (q.isPending) return <><TopBar back title="个人主页" /><div className="banner" /><PostSkeleton n={3} /></>;
  if (q.isError) return <><TopBar back title="个人主页" /><Empty title="没有这个用户">换个用户名搜搜看。</Empty></>;
  const u = q.data;
  const isMe = u.id === me.id;
  const joined = new Date(u.createdAt);

  return (
    <>
      <TopBar
        back
        title={u.displayName}
        sub={`${u.postsCount} 帖`}
        titleHidden={nameVisible}
        right={
          isMe && (
            <Link to="/settings" className="icon-btn mobile-only" aria-label="设置">
              <Settings size={20} />
            </Link>
          )
        }
      />
      <div
        className="banner"
        style={
          u.banner
            ? { backgroundImage: `url(${media(u.banner)})` }
            : ({ '--tone': toneFor(u.username) } as CSSProperties)
        }
      />
      <div className="profile-head">
        <div className="profile-actions">
          {isMe ? (
            <button className="btn btn-outline" onClick={() => setEditing(true)}>
              编辑资料
            </button>
          ) : (
            <>
              <Link to={`/messages/${u.username}`} className="icon-btn outlined" aria-label="发私信" title="发私信">
                <Mail size={19} />
              </Link>
              <FollowButton username={u.username} initial={u.isFollowing} />
            </>
          )}
        </div>
        <div className="profile-avatar avatar" style={{ width: 'min(134px, 25vw)', height: 'min(134px, 25vw)' }}>
          <Avatar src={u.avatar} name={u.displayName} size={134} decoration={u.avatarDecoration} />
        </div>
        <div className="profile-name" ref={nameRef}>
          <span data-admin={u.role === 'admin' || undefined}>{u.displayName}</span>
          <Verified user={u} size={22} />
          {u.role === 'admin' && <span className="tag">管理员</span>}
        </div>
        <div className="muted">
          <span data-admin={u.role === 'admin' || undefined}>@{u.username}</span>
          {u.followsYou && <span className="follows-you">关注了你</span>}
        </div>
        {u.bio && <div className="content" style={{ marginTop: 10 }}>{u.bio}</div>}
        <div className="profile-meta">
          {u.verified && (
            <span className="verified-line">
              <Verified user={u} size={16} /> {u.verifiedNote ? `已认证 · ${u.verifiedNote}` : '已认证'}
            </span>
          )}
          {u.className && (
            <span>
              <School size={16} /> {u.className}
            </span>
          )}
          {u.gradYear && (
            <span>
              <GraduationCap size={16} /> {u.gradYear} 届
            </span>
          )}
          <span>
            <CalendarDays size={16} /> {joined.getFullYear()}年{joined.getMonth() + 1}月加入
          </span>
        </div>
        <div className="profile-stats">
          <Link to={`/u/${u.username}/following`}>
            <b>{u.following}</b> 正在关注
          </Link>
          <Link to={`/u/${u.username}/followers`}>
            <b>{u.followers}</b> 关注者
          </Link>
        </div>
      </div>
      <div style={{ borderBottom: '1px solid var(--line)' }}>
        <Tabs
          value={tab}
          onChange={setTab}
          items={[
            ['posts', '帖子'],
            ['replies', '回复'],
            ['likes', '喜欢'],
          ]}
        />
      </div>
      <Feed
        key={`${username}-${tab}`}
        queryKey={['user-posts', username, tab]}
        path={`/users/${username}/posts?tab=${tab}`}
        empty={<Empty title={tab === 'likes' ? '还没有喜欢过帖子' : tab === 'replies' ? '还没有回复过' : '还没有发过帖子'} />}
      />
      {isMe && editing && <EditProfile user={u} onClose={() => setEditing(false)} />}
    </>
  );
}

/** 放在弹窗里，这样保存后能带动画关闭 */
function SaveButton({ disabled, onClick }: { disabled: boolean; onClick: (close: () => void) => void }) {
  const close = useModalClose();
  return (
    <button className="btn btn-light" disabled={disabled} onClick={() => onClick(close)}>
      保存
    </button>
  );
}

function EditProfile({ user, onClose }: { user: User; onClose: () => void }) {
  const { setUser } = useAuth();
  const qc = useQueryClient();
  const [f, setF] = useState({
    displayName: user.displayName,
    bio: user.bio,
    className: user.className,
    gradYear: user.gradYear ? String(user.gradYear) : '',
    avatar: user.avatar,
    avatarDecoration: user.avatarDecoration,
    banner: user.banner,
  });
  const [busy, setBusy] = useState(false);
  const avatarRef = useRef<HTMLInputElement>(null);
  const bannerRef = useRef<HTMLInputElement>(null);

  const pick = (k: 'avatar' | 'banner') => async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const url = await uploadImage(file);
      setF((x) => ({ ...x, [k]: url }));
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  const save = async (close: () => void) => {
    setBusy(true);
    try {
      const u = await api<User>('/me', {
        method: 'PATCH',
        body: { ...f, gradYear: f.gradYear ? Number(f.gradYear) : null },
      });
      setUser(u);
      qc.setQueryData<ProfileT>(['profile', user.username], (current) => current && { ...current, ...u });
      if (u.avatarDecoration !== user.avatarDecoration) {
        // 头像装扮同时出现在动态、回复、用户列表和私信等缓存中。
        void qc.invalidateQueries();
      } else {
        void qc.invalidateQueries({ queryKey: ['profile', user.username] });
        void qc.invalidateQueries({ queryKey: ['user-posts', user.username] });
      }
      toast('已保存');
      close();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="编辑个人资料"
      onClose={onClose}
      right={
        <SaveButton disabled={busy || !f.displayName.trim()} onClick={save} />
      }
    >
      <div
        className="banner"
        style={{
          position: 'relative',
          ...(f.banner ? { backgroundImage: `url(${media(f.banner)})` } : ({ '--tone': toneFor(user.username) } as CSSProperties)),
        }}
      >
        <button
          className="icon-btn"
          style={{ position: 'absolute', inset: 0, margin: 'auto', background: 'rgba(0,0,0,.5)', color: '#fff', width: 44, height: 44 }}
          onClick={() => bannerRef.current?.click()}
          aria-label="更换背景图"
        >
          <Camera size={20} />
        </button>
      </div>
      <div style={{ padding: '0 16px', marginTop: -44, position: 'relative', width: 'fit-content' }}>
        <div className="edit-avatar">
          <Avatar src={f.avatar} name={f.displayName} size={96} decoration={f.avatarDecoration} />
        </div>
        <button
          className="icon-btn"
          style={{ position: 'absolute', inset: 0, margin: 'auto', background: 'rgba(0,0,0,.5)', color: '#fff', width: 44, height: 44 }}
          onClick={() => avatarRef.current?.click()}
          aria-label="更换头像"
        >
          <Camera size={20} />
        </button>
      </div>
      <input ref={avatarRef} type="file" accept="image/*" hidden onChange={pick('avatar')} />
      <input ref={bannerRef} type="file" accept="image/*" hidden onChange={pick('banner')} />
      <div className="modal-body" style={{ paddingTop: 16 }}>
        <fieldset className="avatar-decoration-picker">
          <legend>头像装扮</legend>
          <div className="avatar-decoration-options">
            {AVATAR_DECORATIONS.map(([decoration, label]) => (
              <label className="avatar-decoration-option" key={decoration}>
                <input
                  type="radio"
                  name="avatar-decoration"
                  checked={f.avatarDecoration === decoration}
                  onChange={() => setF((current) => ({ ...current, avatarDecoration: decoration }))}
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        <Field label="昵称" value={f.displayName} maxLength={20} counter onChange={(v) => setF({ ...f, displayName: v })} />
        <Field label="简介" multiline value={f.bio} maxLength={160} counter onChange={(v) => setF({ ...f, bio: v })} />
        <div className="row">
          <Field label="班级" value={f.className} maxLength={20} placeholder="高三(2)班" onChange={(v) => setF({ ...f, className: v })} />
          <Field
            label="毕业年份"
            inputMode="numeric"
            value={f.gradYear}
            placeholder="2020"
            maxLength={4}
            onChange={(v) => setF({ ...f, gradYear: v.replace(/\D/g, '') })}
          />
        </div>
      </div>
    </Modal>
  );
}

export function FollowList() {
  const { username = '', list = 'followers' } = useParams();
  const q = useQuery({
    queryKey: ['follow-list', username, list],
    queryFn: () => api<User[]>(`/users/${username}/${list === 'following' ? 'following' : 'followers'}`),
  });
  const me = useMe();
  const nav = useNavigate();
  return (
    <>
      <TopBar back title={`@${username}`}>
        <Tabs
          value={list}
          onChange={(v) => nav(`/u/${username}/${v}`, { replace: true })}
          items={[
            ['followers', '关注者'],
            ['following', '正在关注'],
          ]}
        />
      </TopBar>
      {q.isPending ? (
        <PostSkeleton n={4} />
      ) : !q.data?.length ? (
        <Empty title={list === 'following' ? '还没有关注任何人' : '还没有关注者'} />
      ) : (
        q.data.map((u, i) => (
          <div key={u.id} className="enter" style={{ '--i': Math.min(i, 10) } as CSSProperties}>
            <UserRow user={u} showFollow={u.id !== me.id} />
          </div>
        ))
      )}
    </>
  );
}

export function UserRow({ user: u, showFollow = true }: { user: User; showFollow?: boolean }) {
  return (
    <Link to={`/u/${u.username}`} className="user-row">
      <Avatar src={u.avatar} name={u.displayName} size={44} decoration={u.avatarDecoration} />
      <div className="info">
        <div className="name">
          <span className="ellipsis">{u.displayName}</span>
          <Verified user={u} size={16} />
        </div>
        <div className="muted ellipsis" style={{ fontSize: 14 }}>
          @{u.username}
          {u.className && ` · ${u.className}`}
        </div>
        {u.bio && <div className="ellipsis" style={{ fontSize: 14 }}>{u.bio}</div>}
      </div>
      {showFollow && <FollowButton username={u.username} initial={!!u.isFollowing} small />}
    </Link>
  );
}

