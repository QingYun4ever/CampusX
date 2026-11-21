import type { CSSProperties, Key, ReactNode } from 'react';
import { useInfiniteQuery, type QueryKey } from '@tanstack/react-query';
import { api, type Page, type Post } from '../lib/api';
import { PostCard } from './PostCard';
import { Empty, PostSkeleton, Spinner, useOnVisible } from './ui';

const PAGE = 20;

/** 通用无限滚动列表 */
export function useInfiniteList<T>(key: QueryKey, path: string) {
  const sep = path.includes('?') ? '&' : '?';
  return useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam }) =>
      api<Page<T>>(pageParam ? `${path}${sep}cursor=${encodeURIComponent(pageParam)}` : path),
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function InfiniteList<T>({
  q,
  render,
  getKey,
  empty,
}: {
  q: ReturnType<typeof useInfiniteList<T>>;
  render: (item: T, index: number) => ReactNode;
  getKey: (item: T) => Key;
  empty?: ReactNode;
}) {
  const sentinel = useOnVisible(() => q.fetchNextPage(), !!q.hasNextPage && !q.isFetchingNextPage);
  if (q.isPending) return <PostSkeleton />;
  if (q.isError) return <Empty title="加载失败">{(q.error as Error).message}</Empty>;
  const items = q.data.pages.flatMap((p) => p.items);
  if (!items.length) return <>{empty ?? <Empty title="暂无内容" />}</>;
  return (
    <>
      {items.map((it, i) => (
        // 每一页的条目依次淡入；已经渲染过的条目 key 不变，不会重复播放
        <div key={getKey(it)} className="enter" style={{ '--i': Math.min(i % PAGE, 10) } as CSSProperties}>
          {render(it, i)}
        </div>
      ))}
      <div ref={sentinel} />
      {q.isFetchingNextPage && <Spinner />}
      {!q.hasNextPage && items.length > 8 && <div className="list-end">没有更多了</div>}
    </>
  );
}

export function Feed({ queryKey, path, empty }: { queryKey: QueryKey; path: string; empty?: ReactNode }) {
  const q = useInfiniteList<Post>(queryKey, path);
  return <InfiniteList q={q} empty={empty} getKey={(p) => p.id} render={(p) => <PostCard post={p} />} />;
}
