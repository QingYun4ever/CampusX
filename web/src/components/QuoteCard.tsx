import { Link } from 'react-router-dom';
import { media, type QuotePreview } from '../lib/api';
import { fullTime, timeAgo } from '../lib/format';
import { Avatar, Verified } from './ui';
import './quote-card.css';

export function QuoteCard({ post, preview }: { post: QuotePreview | null; preview?: boolean }) {
  if (!post) {
    return <div className="quote-card quote-card-unavailable" onClick={(e) => e.stopPropagation()}>原帖不可用</div>;
  }
  const { author, content, images, createdAt } = post;
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
      {!!images.length && (
        <div className="quote-card-images" style={{ gridTemplateColumns: `repeat(${images.length}, minmax(0, 1fr))` }}>
          {images.map((src, i) => <img key={i} src={media(src)} alt={content ? '' : `原帖图片 ${i + 1}`} loading="lazy" />)}
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
