import { useEffect, useState, useSyncExternalStore, type ImgHTMLAttributes } from 'react';
import { API_BASE, getMediaSession, siteMediaUrl, subscribeMediaSession } from '../lib/api';

type Source = string | Blob;
const noRef = () => {};

/** 本地文件（发帖时还没上传的图）给它一个临时地址，组件卸载时释放 */
function useObjectUrl(blob?: Blob) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!blob) return setUrl(undefined);
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url;
}

/**
 * 图片地址：站内上传的图是公开地址（文件名随机），直接交给 <img>，浏览器能长期缓存；
 * App 里相对路径要拼上所选服务器。
 */
export function useMediaResource(source?: Source | null, _lazy = false) {
  const session = useSyncExternalStore(subscribeMediaSession, getMediaSession);
  const blobUrl = useObjectUrl(source instanceof Blob ? source : undefined);
  let url: string | undefined = blobUrl;
  if (typeof source === 'string' && source) {
    url = siteMediaUrl(source) ?? (/^(https?:|data:|blob:)/i.test(source) ? source : API_BASE + source);
  }
  return { url, failed: false, protected: false, session, ref: noRef };
}

export function MediaImage({ src, ...props }: Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'srcSet'> & { src?: Source | null }) {
  const { url } = useMediaResource(src);
  return <img {...props} src={url} />;
}
