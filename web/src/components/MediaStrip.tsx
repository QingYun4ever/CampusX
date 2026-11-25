import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { thumb } from '../lib/api';
import { MediaImage } from './MediaImage';
import { openGallery } from './ui';

/** 5 张及以上的图：横着排成一条，左右滑着看 */
export const STRIP_FROM = 5;

/** 图还没加载出来时先按这个宽高比占位，免得几十张宽度为 0 的图一下子全进视口、全都开始下载 */
const PLACEHOLDER_RATIO = 3 / 4;
/** 极端比例兜一下再用 cover 裁中间；放得很宽，切成细条的连续画也不会被裁 */
const clampRatio = (r: number) => Math.min(8, Math.max(0.1, r));

function StripImage({ src, alt, onOpen }: { src: string; alt: string; onOpen: (el: HTMLImageElement) => void }) {
  const [ratio, setRatio] = useState<number>();
  const measure = useCallback((img: HTMLImageElement | null) => {
    if (img?.complete && img.naturalWidth && img.naturalHeight) setRatio(clampRatio(img.naturalWidth / img.naturalHeight));
  }, []);
  const style: CSSProperties = { aspectRatio: String(ratio ?? PLACEHOLDER_RATIO) };
  return (
    <MediaImage
      ref={measure}
      src={thumb(src)}
      alt={alt}
      loading="lazy"
      decoding="async"
      style={style}
      onLoad={(e) => measure(e.currentTarget)}
      onClick={(e) => {
        e.stopPropagation();
        onOpen(e.currentTarget);
      }}
    />
  );
}

/**
 * 多图横条（像 X 的多图）：每张图按原比例、同一高度、紧挨着排，
 * 把一幅长画切成几张发，连起来就是完整的一幅。
 * 手机上手指左右滑；电脑上用两侧的箭头或触控板横滑。
 */
export function MediaStrip({ images }: { images: string[] }) {
  const track = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: false });

  const update = useCallback(() => {
    const el = track.current;
    if (!el) return;
    const start = el.scrollLeft <= 2;
    const end = el.scrollLeft + el.clientWidth >= el.scrollWidth - 2;
    setEdges((o) => (o.start === start && o.end === end ? o : { start, end }));
  }, []);

  useEffect(() => {
    const el = track.current;
    if (!el) return;
    update();
    // 图片陆续加载、宽度变化时重新算两头还有没有内容
    const ro = new ResizeObserver(update);
    ro.observe(el);
    for (const child of el.children) ro.observe(child);
    return () => ro.disconnect();
  }, [images, update]);

  const scroll = (dir: 1 | -1) => {
    const el = track.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: 'smooth' });
  };

  /** 关掉大图时，横条滚到当前那张（只横向滚，不带着页面上下跳） */
  const reveal = (i: number) => {
    const el = track.current;
    const item = el?.children[i] as HTMLElement | undefined;
    if (!el || !item) return item;
    const left = item.offsetLeft;
    const right = left + item.offsetWidth;
    if (left < el.scrollLeft) el.scrollLeft = left;
    else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth;
    return item;
  };

  const open = (i: number) =>
    openGallery({
      images,
      previews: images.map((source) => thumb(source)),
      index: i,
      origin: reveal,
    });

  return (
    <div className="media-strip">
      <div ref={track} className="media-strip-track" onScroll={update}>
        {images.map((src, i) => (
          <StripImage key={`${i}:${src}`} src={src} alt={`第 ${i + 1} 张，共 ${images.length} 张`} onOpen={() => open(i)} />
        ))}
      </div>
      <span className="media-strip-count" aria-hidden>
        {images.length} 张
      </span>
      {!edges.start && (
        <button
          type="button"
          className="media-strip-nav prev"
          aria-label="往左看"
          onClick={(e) => {
            e.stopPropagation();
            scroll(-1);
          }}
        >
          <ChevronLeft size={20} />
        </button>
      )}
      {!edges.end && (
        <button
          type="button"
          className="media-strip-nav next"
          aria-label="往右看"
          onClick={(e) => {
            e.stopPropagation();
            scroll(1);
          }}
        >
          <ChevronRight size={20} />
        </button>
      )}
    </div>
  );
}
