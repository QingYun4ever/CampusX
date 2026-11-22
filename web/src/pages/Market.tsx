import { useState, type CSSProperties } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { EmojiGlyph } from '../components/EmojiPicker';
import { Avatar, Tabs, toast, TopBar } from '../components/ui';
import { api, type AvatarDecoration, type User } from '../lib/api';
import { useAuth, useMe } from '../lib/auth';
import { DECORATIONS } from '../lib/decorations';
import { EMOJI_PACKS, setEmojiPackInstalled, useInstalledEmojiPacks } from '../lib/emojiPacks';
import './market.css';

type Tab = 'emoji' | 'halo';

function EmojiPacks() {
  const installed = useInstalledEmojiPacks();
  const toggle = (id: string, name: string, on: boolean) => {
    if (!setEmojiPackInstalled(id, on)) return toast('无法保存安装记录', 'error');
    toast(on ? `已安装「${name}」` : `已移除「${name}」`);
  };
  return (
    <>
      <p className="market-intro">安装后会出现在发帖、回复和私信的表情面板里。安装记录只保存在这台设备上。</p>
      <div className="market-list">
        {EMOJI_PACKS.map((pack, i) => {
          const on = installed.includes(pack.id);
          return (
            <article className="market-pack enter" style={{ '--i': i } as CSSProperties} key={pack.id}>
              <header>
                <div className="grow">
                  <h3>
                    {pack.name}
                    {on && <span className="market-owned"><Check size={13} strokeWidth={3} />已安装</span>}
                  </h3>
                  <p>{pack.description}</p>
                </div>
                <button
                  className={`btn sm ${on ? 'btn-outline' : 'btn-primary'}`}
                  onClick={() => toggle(pack.id, pack.name, !on)}
                  aria-label={`${on ? '移除' : '安装'}${pack.name}`}
                >
                  {on ? '移除' : '安装'}
                </button>
              </header>
              <div className="market-emoji" aria-label={`${pack.name}，${pack.emoji.length} 个表情`}>
                {pack.emoji.map((e) => <EmojiGlyph key={e} emoji={e} />)}
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}

function Halos() {
  const me = useMe();
  const { setUser } = useAuth();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<AvatarDecoration | null>(null);
  const wear = async (id: AvatarDecoration, name: string) => {
    if (busy !== null) return;
    setBusy(id);
    try {
      const u = await api<User>('/me', { method: 'PATCH', body: { avatarDecoration: id } });
      setUser(u);
      // 光环出现在动态、回复、私信等各处缓存里
      void qc.invalidateQueries();
      toast(id ? `已佩戴「${name}」` : '已取下装扮');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <p className="market-intro">光环和头像框显示在你的头像周围，在动态、回复和私信里都看得到，所有人看到的都一样。头像框的动画只在个人主页上播放。</p>
      <div className="market-halos">
        {DECORATIONS.map((d, i) => {
          const on = me.avatarDecoration === d.id;
          return (
            <article className={`market-halo enter ${on ? 'on' : ''}`} style={{ '--i': i } as CSSProperties} key={d.id || 'none'}>
              <div className="market-halo-stage">
                <Avatar src={me.avatar} name={me.displayName} size={72} decoration={d.id} />
              </div>
              <h3>{d.name}</h3>
              <p>{d.description}</p>
              <button
                className={`btn sm ${on ? 'btn-outline' : 'btn-primary'}`}
                disabled={on || busy !== null}
                onClick={() => wear(d.id, d.name)}
              >
                {on ? <><Check size={15} strokeWidth={2.5} />{d.id ? '佩戴中' : '当前'}</> : busy === d.id ? '…' : d.id ? '佩戴' : '取下装扮'}
              </button>
            </article>
          );
        })}
      </div>
    </>
  );
}

export function Market() {
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('tab') === 'halo' ? 'halo' : 'emoji';
  return (
    <>
      <TopBar back title="商场" />
      <Tabs<Tab>
        value={tab}
        onChange={(t) => setParams(t === 'emoji' ? {} : { tab: t }, { replace: true })}
        items={[
          ['emoji', '表情包'],
          ['halo', '头像装扮'],
        ]}
      />
      <div className="market" key={tab}>{tab === 'emoji' ? <EmojiPacks /> : <Halos />}</div>
    </>
  );
}
