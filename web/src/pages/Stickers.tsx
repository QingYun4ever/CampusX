/**
 * 表情包：商场里的列表、包的详情页、自己做的包、编辑页（管理员也用它维护官方包）。
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Check, FolderInput, ImagePlus, Pencil, Plus, Star, Tag, Trash2, X } from 'lucide-react';
import { Avatar, Empty, Field, Spinner, toast, TopBar } from '../components/ui';
import { MediaImage } from '../components/MediaImage';
import { api, ApiError, getToken, type StickerItem, type StickerPack } from '../lib/api';
import { useMe } from '../lib/auth';
import { emojiSrc, EMOJI_TYPES, MAX_EMOJI_UPLOAD } from '../lib/customEmoji';
import { groupItems, STICKER_KEY, useMadeStickerPacks, useStickerActions, useStickerCatalog, useStickerPack } from '../lib/stickerPacks';
import { timeAgo } from '../lib/format';
import './market.css';
import './stickers.css';

/* ---------------- 状态 ---------------- */

function statusOf(p: StickerPack): [string, string] {
  if (p.status === 'pending') return ['审核中', 'warn'];
  if (p.status === 'rejected') return [p.listed ? '改动没通过' : '没通过', 'bad'];
  if (p.status === 'draft') return p.listed ? ['有改动未提交', 'warn'] : ['草稿', ''];
  return p.listed ? ['已上架', 'ok'] : ['未上架', ''];
}

const byline = (p: StickerPack) => (p.official ? '校墙官方' : p.owner ? `${p.owner.displayName} 制作` : '同学制作');

function useInstallToggle() {
  const { setInstalled } = useStickerActions();
  const [busy, setBusy] = useState<number | null>(null);
  const toggle = async (p: StickerPack) => {
    setBusy(p.id);
    try {
      await setInstalled(p.id, !p.installed);
      toast(p.installed ? `已移除「${p.name}」` : `已安装「${p.name}」，在表情面板里就能用`);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };
  return { busy, toggle };
}

/* ---------------- 商场里的列表 ---------------- */

export function StickerPackList() {
  const q = useStickerCatalog();
  const { busy, toggle } = useInstallToggle();
  return (
    <section className="sticker-shelf">
      <div className="sticker-shelf-head">
        <h2>表情包</h2>
        <Link to="/stickers/mine" className="btn btn-outline sm">
          <Plus size={15} /> 做一个
        </Link>
      </div>
      {q.isPending && <Spinner />}
      {q.data && !q.data.items.length && <p className="market-intro">还没有表情包，来做第一个吧。</p>}
      <div className="market-list">
        {q.data?.items.map((p, i) => (
          <article className="market-pack sticker-pack enter" style={{ '--i': i } as CSSProperties} key={p.id}>
            <header>
              <Link to={`/stickers/${p.id}`} className="sticker-pack-link">
                {p.cover && <MediaImage className="sticker-cover" src={emojiSrc(p.cover)} alt="" draggable={false} />}
                <div className="grow">
                  <h3>
                    {p.name}
                    {p.installed && <span className="market-owned"><Check size={13} strokeWidth={3} />已安装</span>}
                  </h3>
                  <p className="sticker-byline">{byline(p)} · {p.count} 个表情</p>
                </div>
              </Link>
              <button
                className={`btn sm ${p.installed ? 'btn-outline' : 'btn-primary'}`}
                disabled={busy === p.id}
                onClick={() => void toggle(p)}
                aria-label={`${p.installed ? '移除' : '安装'}${p.name}`}
              >
                {p.installed ? '移除' : '安装'}
              </button>
            </header>
            {p.description && <p className="sticker-desc">{p.description}</p>}
            <Link to={`/stickers/${p.id}`} className="sticker-preview" aria-label={`查看「${p.name}」的全部表情`}>
              {p.preview.map((f) => <MediaImage key={f} src={emojiSrc(f)} alt="" loading="lazy" decoding="async" draggable={false} />)}
            </Link>
          </article>
        ))}
      </div>
    </section>
  );
}

/* ---------------- 详情页 ---------------- */

function StickerGrid({ items, selected, onTap }: {
  items: StickerItem[];
  selected?: ReadonlySet<number>;
  onTap?: (item: StickerItem) => void;
}) {
  const groups = groupItems(items);
  return (
    <>
      {groups.map(([group, list]) => (
        <section key={group || '_'} className="sticker-section">
          {(groups.length > 1 || group) && <h3 className="sticker-section-title">{group || '其他'} <small>{list.length}</small></h3>}
          <div className="sticker-wall">
            {list.map((item) => {
              const on = selected?.has(item.id);
              const body = (
                <>
                  <MediaImage src={emojiSrc(item.file)} alt="" loading="lazy" decoding="async" draggable={false} />
                  {!item.reviewed && <span className="sticker-badge">待审</span>}
                  {on && <i className="sticker-check" aria-hidden="true"><Check size={13} strokeWidth={3} /></i>}
                </>
              );
              return onTap ? (
                <button type="button" key={item.id} className={`sticker-cell ${on ? 'on' : ''}`} aria-pressed={on} aria-label="选择这个表情" onClick={() => onTap(item)}>
                  {body}
                </button>
              ) : (
                <span key={item.id} className="sticker-cell">{body}</span>
              );
            })}
          </div>
        </section>
      ))}
    </>
  );
}

export function StickerPackPage() {
  const id = Number(useParams().id);
  const q = useStickerPack(id);
  const { busy, toggle } = useInstallToggle();
  const p = q.data;
  if (q.isPending) return <><TopBar back title="表情包" /><Spinner /></>;
  if (!p) return <><TopBar back title="表情包" /><Empty title="表情包不存在">可能已经下架或者删除了。</Empty></>;
  const [label, tone] = statusOf(p);
  const items = p.items ?? [];
  return (
    <>
      <TopBar
        back
        title={p.name}
        right={p.editable ? <Link to={`/stickers/${p.id}/edit`} className="btn btn-outline sm"><Pencil size={14} /> 编辑</Link> : undefined}
      />
      <div className="sticker-page">
        <header className="sticker-hero">
          {p.cover ? <MediaImage className="sticker-hero-cover" src={emojiSrc(p.cover)} alt="" draggable={false} /> : <div className="sticker-hero-cover empty" />}
          <div className="grow">
            <h1>{p.name}</h1>
            <p className="sticker-byline">
              {p.owner ? (
                <Link to={`/u/${p.owner.username}`} className="sticker-owner">
                  <Avatar src={p.owner.avatar} name={p.owner.displayName} size={20} />
                  {p.owner.displayName}
                </Link>
              ) : byline(p)}
              <span> · {p.count} 个表情{p.installs > 0 ? ` · ${p.installs} 人在用` : ''}</span>
            </p>
            {p.editable && <span className={`pill ${tone}`}>{label}</span>}
          </div>
        </header>
        {p.description && <p className="sticker-desc">{p.description}</p>}
        {p.listed && (
          <button
            className={`btn ${p.installed ? 'btn-outline' : 'btn-primary'} sticker-install`}
            disabled={busy === p.id}
            onClick={() => void toggle(p)}
          >
            {p.installed ? '从我的表情面板移除' : '添加到表情面板'}
          </button>
        )}
        {p.editable && p.unreviewed ? <p className="sticker-note">标「待审」的表情只有你看得到，审核通过后才会出现在包里。</p> : null}
        {items.length ? <StickerGrid items={items} /> : <Empty title="还没有表情" />}
        {p.credit && <p className="sticker-credit">{p.credit}</p>}
      </div>
    </>
  );
}

/* ---------------- 我做的包 ---------------- */

export function MyStickerPacks() {
  const q = useMadeStickerPacks();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [busy, setBusy] = useState(false);
  const items = q.data?.items ?? [];
  const full = !!q.data && items.length >= q.data.limit;

  const create = async () => {
    setBusy(true);
    try {
      const p = await api<StickerPack>('/emoji-packs', { body: { name, description: desc } });
      await qc.invalidateQueries({ queryKey: STICKER_KEY });
      nav(`/stickers/${p.id}/edit`, { replace: true });
    } catch (e) {
      toast((e as Error).message, 'error');
      setBusy(false);
    }
  };

  return (
    <>
      <TopBar back title="我做的表情包" />
      <div className="sticker-page">
        <p className="market-intro">
          自己挑图做一个表情包，提交给管理员审核，通过后会在商场上架，大家都能装上用。
          {q.data && ` 每人最多 ${q.data.limit} 个包，每个包 ${q.data.minItems}～${q.data.maxItems} 个表情。`}
        </p>
        {q.isPending && <Spinner />}
        {creating ? (
          <div className="sticker-form">
            <Field label="名字" value={name} onChange={setName} maxLength={20} counter autoFocus />
            <Field label="介绍（选填）" value={desc} onChange={setDesc} maxLength={100} counter multiline />
            <div className="sticker-form-actions">
              <button className="btn btn-primary" disabled={busy || !name.trim()} onClick={() => void create()}>创建，开始加表情</button>
              <button className="btn btn-outline" disabled={busy} onClick={() => setCreating(false)}>取消</button>
            </div>
          </div>
        ) : (
          q.data && (
            <button className="btn btn-primary sticker-new" disabled={full} onClick={() => setCreating(true)}>
              <Plus size={16} /> {full ? `最多 ${q.data.limit} 个包` : '新建表情包'}
            </button>
          )
        )}
        <div className="market-list">
          {items.map((p) => {
            const [label, tone] = statusOf(p);
            return (
              <Link to={`/stickers/${p.id}/edit`} className="market-pack sticker-pack sticker-mine" key={p.id}>
                <header>
                  {p.cover ? <MediaImage className="sticker-cover" src={emojiSrc(p.cover)} alt="" draggable={false} /> : <div className="sticker-cover empty" />}
                  <div className="grow">
                    <h3>{p.name} <span className={`pill ${tone}`}>{label}</span></h3>
                    <p className="sticker-byline">{p.total ?? p.count} 个表情{p.listed ? ` · ${p.installs} 人在用` : ''}</p>
                    {p.status === 'rejected' && p.note && <p className="sticker-reject">理由：{p.note}</p>}
                  </div>
                </header>
              </Link>
            );
          })}
        </div>
      </div>
    </>
  );
}

/* ---------------- 编辑 ---------------- */

/** 别处整理好的表情包文件夹常用英文分组名：按文件夹导入时换成中文 */
const GROUP_NAMES: Record<string, string> = {
  happy: '开心', sad: '难过', angry: '生气', surprised: '惊讶', shy: '害羞', confused: '疑惑', tired: '累了',
  eating: '吃吃', food: '吃吃', affection: '贴贴', teasing: '调侃', approval: '赞同', refusal: '拒绝', greeting: '打招呼',
  reply: '回应', action: '日常', interaction: '互动', afraid: '害怕', sleep: '睡觉', meme: '梗图', sneering: '不屑',
  surrender: '投降', question: '疑问', attack: '出击', apology: '道歉',
};
const folderGroup = (file: File) => {
  const parts = (file.webkitRelativePath || '').split('/');
  const dir = parts.length > 2 ? parts[parts.length - 2] : '';
  return (GROUP_NAMES[dir.toLowerCase()] ?? dir).slice(0, 10);
};

export function StickerPackEditor() {
  const id = Number(useParams().id);
  const me = useMe();
  const admin = me.role === 'admin';
  const nav = useNavigate();
  const qc = useQueryClient();
  const q = useStickerPack(id);
  const p = q.data;
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [group, setGroup] = useState('');
  const [queue, setQueue] = useState({ done: 0, total: 0, failed: 0 });
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<{ name: string; description: string; credit: string } | null>(null);
  const files = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);
  const uploading = queue.done + queue.failed < queue.total;
  const items = useMemo(() => p?.items ?? [], [p?.items]);
  const groups = useMemo(() => [...new Set(items.map((i) => i.group).filter(Boolean))], [items]);
  const max = p?.official ? 1000 : 120;

  useEffect(() => {
    // 文件夹导入要用 webkitdirectory（React 不认这个属性）
    folder.current?.setAttribute('webkitdirectory', '');
  }, [p?.id]);

  const refresh = () => qc.invalidateQueries({ queryKey: STICKER_KEY });

  const upload = async (list: File[], groupOf: (f: File) => string) => {
    const picked = list.filter((f) => EMOJI_TYPES.split(',').includes(f.type)).slice(0, Math.max(0, max - items.length));
    if (!picked.length) return toast('没有可以上传的图片（支持 PNG、JPG、WebP、GIF）', 'error');
    const token = getToken();
    setQueue({ done: 0, total: picked.length, failed: 0 });
    let lastError = '';
    for (const [i, file] of picked.entries()) {
      // 传到一半退出或换了账号：剩下的不再传
      if (getToken() !== token) break;
      try {
        if (file.size > MAX_EMOJI_UPLOAD) throw new Error(`${file.name} 太大了（最大 8 MB）`);
        const form = new FormData();
        form.append('file', file);
        const path = `/emoji-packs/${id}/items?group=${encodeURIComponent(groupOf(file))}`;
        // 一次导入几百张会撞上每分钟的上传次数限制：等一会儿接着传
        for (let tries = 0; ; tries++) {
          try {
            await api(path, { form });
            break;
          } catch (e) {
            if (!(e instanceof ApiError && e.status === 429) || tries >= 12 || getToken() !== token) throw e;
            await new Promise((r) => setTimeout(r, 10_000));
          }
        }
        setQueue((s) => ({ ...s, done: s.done + 1 }));
      } catch (e) {
        lastError = (e as Error).message;
        setQueue((s) => ({ ...s, failed: s.failed + 1 }));
      }
      // 每传 10 个刷新一次，边传边能看到
      if (i % 10 === 9) void refresh();
    }
    await refresh();
    if (lastError) toast(lastError, 'error');
  };

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await fn();
      await refresh();
      if (done) toast(done);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  if (q.isPending) return <><TopBar back title="编辑表情包" /><Spinner /></>;
  if (!p || !p.editable) return <><TopBar back title="编辑表情包" /><Empty title="表情包不存在" /></>;

  const [label, tone] = statusOf(p);
  const sel = items.filter((i) => selected.has(i.id));
  const canRename = admin || !p.listed;
  const canSubmit = !p.official && p.status !== 'pending' && (!!p.unreviewed || !p.listed);
  const toggleSel = (item: StickerItem) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(item.id)) n.delete(item.id);
      else n.add(item.id);
      return n;
    });

  const removeSelected = () =>
    act(async () => {
      if (!confirm(`删掉选中的 ${sel.length} 个表情？已经发出去的不受影响。`)) return;
      for (const i of sel) await api(`/emoji-packs/${id}/items/${i.id}`, { method: 'DELETE' });
      setSelected(new Set());
    });
  const regroupSelected = () => {
    const g = prompt('分组名（最多 10 个字，留空就是不分组）', sel[0]?.group ?? '');
    if (g === null) return;
    void act(async () => {
      for (const i of sel) await api(`/emoji-packs/${id}/items/${i.id}`, { method: 'PATCH', body: { group: g.trim().slice(0, 10) } });
      setSelected(new Set());
    });
  };

  return (
    <>
      <TopBar back title="编辑表情包" right={p.listed ? <Link to={`/stickers/${p.id}`} className="btn btn-outline sm">查看</Link> : undefined} />
      <div className="sticker-page">
        <header className="sticker-hero">
          {p.cover ? <MediaImage className="sticker-hero-cover" src={emojiSrc(p.cover)} alt="" draggable={false} /> : <div className="sticker-hero-cover empty" />}
          <div className="grow">
            <h1>{p.name}</h1>
            <p className="sticker-byline">{byline(p)} · {p.total} / {max} 个表情</p>
            <span className={`pill ${tone}`}>{label}</span>
          </div>
          {canRename && !info && (
            <button className="icon-btn" aria-label="改名字和介绍" onClick={() => setInfo({ name: p.name, description: p.description, credit: p.credit })}>
              <Pencil size={18} />
            </button>
          )}
        </header>

        {info ? (
          <div className="sticker-form">
            <Field label="名字" value={info.name} onChange={(v) => setInfo({ ...info, name: v })} maxLength={20} counter />
            <Field label="介绍" value={info.description} onChange={(v) => setInfo({ ...info, description: v })} maxLength={100} counter multiline />
            {admin && <Field label="来源和版权说明（显示在包的最下面）" value={info.credit} onChange={(v) => setInfo({ ...info, credit: v })} maxLength={200} multiline />}
            <div className="sticker-form-actions">
              <button
                className="btn btn-primary"
                disabled={busy || !info.name.trim()}
                onClick={() => void act(async () => {
                  await api(`/emoji-packs/${id}`, { method: 'PATCH', body: admin ? info : { name: info.name, description: info.description } });
                  setInfo(null);
                }, '已保存')}
              >
                保存
              </button>
              <button className="btn btn-outline" onClick={() => setInfo(null)}>取消</button>
            </div>
          </div>
        ) : (
          p.description && <p className="sticker-desc">{p.description}</p>
        )}

        {p.status === 'rejected' && p.note && <p className="sticker-reject">管理员的理由：{p.note}</p>}
        {p.status === 'pending' && <p className="sticker-note">已经提交，管理员审核完会通知你。审核期间还可以改，管理员看到的是最新的。</p>}
        {!p.official && p.listed && !!p.unreviewed && p.status !== 'pending' && (
          <p className="sticker-note">新加的 {p.unreviewed} 个表情要提交审核，通过后才会出现在包里。</p>
        )}
        {!p.official && !p.listed && p.status === 'draft' && <p className="sticker-note">加够至少 4 个表情就能提交审核。可以点「分组」把表情分成开心、难过之类的几组。</p>}

        <div className="sticker-toolbar">
          <button className="btn btn-primary sm" disabled={uploading || (p.total ?? 0) >= max} onClick={() => files.current?.click()}>
            <ImagePlus size={15} /> 加表情
          </button>
          {admin && (
            <button className="btn btn-outline sm" disabled={uploading} onClick={() => folder.current?.click()} title="按子文件夹分组导入一整个文件夹">
              <FolderInput size={15} /> 导入文件夹
            </button>
          )}
          <label className="sticker-group-pick">
            <Tag size={14} />
            <input list="sticker-groups" placeholder="新表情放进哪个分组" value={group} maxLength={10} onChange={(e) => setGroup(e.target.value)} />
            <datalist id="sticker-groups">{groups.map((g) => <option key={g} value={g} />)}</datalist>
          </label>
        </div>
        {queue.total > 0 && (
          <p className="sticker-progress" aria-live="polite">
            {uploading ? <Spinner size={16} inline /> : <Check size={16} />}
            {uploading ? `正在上传 ${queue.done + queue.failed + 1} / ${queue.total}` : `传好了 ${queue.done} 个`}
            {queue.failed > 0 && `，${queue.failed} 个没传上`}
          </p>
        )}

        {sel.length > 0 && (
          <div className="sticker-selbar">
            <button className="icon-btn" aria-label="取消选择" onClick={() => setSelected(new Set())}><X size={18} /></button>
            <span>{sel.length} 个</span>
            {sel.length === 1 && (
              <button className="btn btn-outline sm" disabled={busy || (p.listed && !sel[0].reviewed && !admin)} onClick={() => void act(() => api(`/emoji-packs/${id}`, { method: 'PATCH', body: { cover: sel[0].file } }), '已设为封面')}>
                <Star size={14} /> 封面
              </button>
            )}
            <button className="btn btn-outline sm" disabled={busy} onClick={regroupSelected}><Tag size={14} /> 分组</button>
            <button className="btn btn-outline sm danger" disabled={busy} onClick={() => void removeSelected()}><Trash2 size={14} /> 删除</button>
          </div>
        )}

        {items.length ? (
          <StickerGrid items={items} selected={selected} onTap={toggleSel} />
        ) : (
          <Empty title="还没有表情">点「加表情」选几张图片或 GIF，会压缩成小图保存。</Empty>
        )}

        <div className="sticker-footer">
          {canSubmit && (
            <button className="btn btn-primary" disabled={busy || uploading || (p.total ?? 0) < 4} onClick={() => void act(() => api(`/emoji-packs/${id}/submit`, { body: {} }), '已提交审核')}>
              提交审核
            </button>
          )}
          {p.status === 'pending' && (
            <button className="btn btn-outline" disabled={busy} onClick={() => void act(() => api(`/emoji-packs/${id}/withdraw`, { body: {} }), '已撤回')}>撤回审核</button>
          )}
          {admin && (p.official || p.reviewedAt) && (
            <button className="btn btn-outline" disabled={busy} onClick={() => void act(() => api(`/admin/emoji-packs/${id}/listed`, { body: { listed: !p.listed } }), p.listed ? '已下架' : '已上架')}>
              {p.listed ? '下架' : '上架'}
            </button>
          )}
          <button
            className="btn btn-outline danger"
            disabled={busy}
            onClick={() => {
              if (!confirm(`删除「${p.name}」？装了的人也会被移除，已经发出去的表情不受影响。`)) return;
              void act(async () => {
                await api(`/emoji-packs/${id}`, { method: 'DELETE' });
                nav(-1);
              }, '已删除');
            }}
          >
            删除表情包
          </button>
        </div>
        {p.credit && <p className="sticker-credit">{p.credit}</p>}
        {p.reviewedAt && <p className="sticker-credit">上次审核 {timeAgo(p.reviewedAt)}</p>}
      </div>
      <input ref={files} type="file" accept={EMOJI_TYPES} multiple hidden onChange={(e) => {
        const list = [...(e.target.files ?? [])];
        e.target.value = '';
        void upload(list, () => group.trim());
      }} />
      <input ref={folder} type="file" multiple hidden onChange={(e) => {
        const list = [...(e.target.files ?? [])];
        e.target.value = '';
        void upload(list, (f) => group.trim() || folderGroup(f));
      }} />
    </>
  );
}
