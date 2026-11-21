import { useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Composer } from '../components/Composer';
import { InfiniteList, useInfiniteList } from '../components/Feed';
import { PostCard, PostMain } from '../components/PostCard';
import { Empty, PostSkeleton, TopBar } from '../components/ui';
import { api, type Post } from '../lib/api';

export function PostDetail() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const mainRef = useRef<HTMLDivElement>(null);
  const q = useQuery({
    queryKey: ['post', id],
    queryFn: () => api<{ post: Post; ancestors: Post[] }>(`/posts/${id}`),
  });
  const replies = useInfiniteList<Post>(['replies', id], `/posts/${id}/replies`);

  // 有上文时，把主帖滚动到视口顶部（像 X 一样）
  useEffect(() => {
    if (q.data?.ancestors.length) mainRef.current?.scrollIntoView({ block: 'start' });
    else window.scrollTo({ top: 0 });
  }, [id, q.data?.ancestors.length]);

  const isRoot = q.data && !q.data.post.parentId;

  return (
    <>
      <TopBar back title="帖子" sub={isRoot && q.data?.post.board ? `${q.data.post.board.name}吧` : undefined} />
      {q.isPending ? (
        <PostSkeleton n={2} />
      ) : q.isError ? (
        <Empty title="帖子不存在">可能已经被删除了。</Empty>
      ) : (
        <>
          {q.data.ancestors.map((a) => (
            <PostCard key={a.id} post={a} threadLine />
          ))}
          <div ref={mainRef} style={{ scrollMarginTop: 60 }}>
            <PostMain post={q.data.post} onDeleted={() => nav(-1)} />
          </div>
          {!q.data.post.deleted && <Composer replyTo={q.data.post} />}
          <InfiniteList
            q={replies}
            empty={<div className="list-end">还没有回复</div>}
            getKey={(r) => r.id}
            render={(r, i) => (
              <PostCard
                post={r}
                floor={isRoot ? i + 2 : undefined}
                hideReplyTo={!isRoot}
                opId={isRoot ? q.data.post.author.id : undefined}
              />
            )}
          />
        </>
      )}
    </>
  );
}
