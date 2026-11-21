import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Search as SearchIcon } from 'lucide-react';
import { Feed, InfiniteList, useInfiniteList } from '../components/Feed';
import { Empty, Tabs, TopBar } from '../components/ui';
import type { User } from '../lib/api';
import { UserRow } from './Profile';

function UserResults({ q }: { q: string }) {
  const list = useInfiniteList<User>(['search-users', q], `/search?type=users&q=${encodeURIComponent(q)}`);
  return (
    <InfiniteList q={list} empty={<Empty title={`没有找到「${q}」`}>试试昵称、用户名或班级。</Empty>} getKey={(u) => u.id} render={(u) => <UserRow user={u} />} />
  );
}

export function Search() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const type = (params.get('type') as 'posts' | 'users') ?? 'posts';
  const [input, setInput] = useState(q);
  const nav = useNavigate();
  useEffect(() => setInput(q), [q]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = input.trim();
    // 单独一个 #话题 直接打开标签页
    const tag = /^#([^\s#]{1,20})$/.exec(v)?.[1];
    if (tag) return nav(`/t/${encodeURIComponent(tag.toLowerCase())}`);
    setParams(v ? { q: v, type } : {});
  };

  return (
    <>
      <TopBar>
        <form className="topbar-row" onSubmit={submit}>
          <label className="search-box">
            <SearchIcon size={18} />
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="搜索"
              autoFocus={!q}
              enterKeyHint="search"
            />
          </label>
        </form>
        {q && (
          <Tabs
            value={type}
            onChange={(t) => setParams({ q, type: t })}
            items={[
              ['posts', '帖子'],
              ['users', '同学'],
            ]}
          />
        )}
      </TopBar>
      {!q ? (
        <Empty title="搜索同学和帖子">可以搜昵称、用户名、班级、帖子内容，或者输入 #标签。</Empty>
      ) : type === 'users' ? (
        <UserResults q={q} />
      ) : (
        <Feed
          key={q}
          queryKey={['search-posts', q]}
          path={`/search?type=posts&q=${encodeURIComponent(q)}`}
          empty={<Empty title={`没有找到「${q}」`}>换个关键词试试。</Empty>}
        />
      )}
    </>
  );
}
