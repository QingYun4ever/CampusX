import { useEffect, useRef } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
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
            <PostCard key={a.id} post={a} threadLine collapseBlocked />
          ))}
          <div ref={mainRef} style={{ scrollMarginTop: 60 }}>
            <PostMain post={q.data.post} onDeleted={() => nav(-1)} />
          </div>
          {!q.data.post.deleted && <Composer replyTo={q.data.post} />}
          <InfiniteList
            q={replies}
            empty={<div className="list-end">还没有回复</div>}
            getKey={(r) => r.id}
            render={(r, i) => {
              const opId = isRoot ? q.data.post.author.id : undefined;
              const card = (
                <PostCard
                  post={r}
                  collapseBlocked
                  threadLine={!!r.opReplies?.length}
                  floor={isRoot ? i + 2 : undefined}
                  // 这里列的都是直接回复当前帖子的，「回复 @楼主」不用再写
                  hideReplyTo
                  opId={opId}
                />
              );
              if (!r.opReplies?.length) return card;
              // 楼中楼：最多两条回复直接接在这条评论下面（楼主和 AI 优先），竖线连起来
              const rest = r.replyCount - r.opReplies.length;
              return (
                <div className="op-thread">
                  {card}
                  {r.opReplies.map((c, j) => (
                    <PostCard key={c.id} post={c} hideReplyTo opId={opId} threadLine={j < r.opReplies!.length - 1 || rest > 0} />
                  ))}
                  {rest > 0 && (
                    <Link to={`/post/${r.id}`} className="op-more">
                      <span>查看全部 {r.replyCount} 条回复</span>
                    </Link>
                  )}
                </div>
              );
            }}
          />
        </>
      )}
    </>
  );
}
