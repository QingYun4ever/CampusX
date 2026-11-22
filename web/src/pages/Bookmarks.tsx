import { InfiniteList, useInfiniteList } from '../components/Feed';
import { PostCard } from '../components/PostCard';
import { Empty, TopBar } from '../components/ui';
import type { Post } from '../lib/api';
import { useMe } from '../lib/auth';

/** 书签：只有自己看得到，按加入的时间倒序 */
export function Bookmarks() {
  const me = useMe();
  const q = useInfiniteList<Post>(['bookmarks'], '/bookmarks');
  return (
    <>
      <TopBar back title="书签" sub={`@${me.username}`} />
      <InfiniteList
        q={q}
        empty={
          <Empty title="还没有书签">看到想以后再看的帖子，点帖子下面的书签图标就能存起来。书签只有你自己看得到。</Empty>
        }
        getKey={(p) => p.id}
        render={(p) => <PostCard post={p} />}
      />
    </>
  );
}
