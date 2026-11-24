import { Link } from 'react-router-dom';
import { thumb, type QuotePreview } from '../lib/api';
import { fullTime, timeAgo } from '../lib/format';
import { MediaImage } from './MediaImage';
import { VideoThumb } from './VideoPlayer';
import { Avatar, Verified } from './ui';
import './quote-card.css';

export function QuoteCard({ post, preview }: { post: QuotePreview | null; preview?: boolean }) {
  if (!post) {
    return <div className="quote-card quote-card-unavailable" onClick={(e) => e.stopPropagation()}>原帖不可用</div>;
  }
  if (post.blocked) {
    return <div className="quote-card quote-card-unavailable" onClick={(e) => e.stopPropagation()}>你已拉黑原帖作者</div>;
  }
  const { author, content, images, video, createdAt } = post;
  const body = (
    <>
      <div className="quote-card-head">
        <Avatar src={author.avatar} name={author.displayName} size={20} decoration={author.avatarDecoration} />
        <span className="name" data-admin={author.role === 'admin' || undefined}>{author.displayName}</span>
        <Verified user={author} size={14} />
        <span className="muted ellipsis">@{author.username}</span>
        <time className="muted" dateTime={new Date(createdAt).toISOString()} title={fullTime(createdAt)}>{timeAgo(createdAt)}</time>
      </div>
      {content && <div className="quote-card-content">{content}</div>}
      {video && <VideoThumb video={video} className="quote-card-video" />}
      {!!images.length && (
        <div className="quote-card-images" style={{ gridTemplateColumns: `repeat(${images.length}, minmax(0, 1fr))` }}>
          {images.map((src, i) => <MediaImage key={i} src={thumb(src)} alt={content ? '' : `原帖图片 ${i + 1}`} loading="lazy" decoding="async" />)}
        </div>
      )}
    </>
  );
  return preview ? (
    <div className="quote-card" role="group" aria-label="原帖预览">{body}</div>
  ) : (
    <Link className="quote-card quote-card-link" to={`/post/${post.id}`} onClick={(e) => e.stopPropagation()}>
      {body}
    </Link>
  );
}
