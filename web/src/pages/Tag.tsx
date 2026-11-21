import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Hash } from 'lucide-react';
import { Feed } from '../components/Feed';
import { Empty, TopBar } from '../components/ui';
import { api, type Page, type Post } from '../lib/api';

export function TagPage() {
  const tag = decodeURIComponent(useParams().tag ?? '').toLowerCase();
  const path = `/tags/${encodeURIComponent(tag)}/posts`;
  // 第一页同时带回总数，和下面的列表共用缓存
  const head = useQuery({
    queryKey: ['tag-posts', tag, 'head'],
    queryFn: () => api<Page<Post> & { count: number }>(path),
    staleTime: 30_000,
  });
  return (
    <>
      <TopBar back title={`#${tag}`} sub={head.data ? `${head.data.count} 条帖子` : undefined} />
      <div className="tag-hero">
        <span className="tag-hero-ico">
          <Hash size={28} />
        </span>
        <div>
          <h1>{tag}</h1>
          <p className="muted">{head.data ? `${head.data.count} 条帖子带有这个标签` : '　'}</p>
        </div>
      </div>
      <Feed
        queryKey={['tag-posts', tag]}
        path={path}
        empty={<Empty title="还没有帖子">发帖时加上 #{tag} 就会出现在这里。</Empty>}
      />
    </>
  );
}
