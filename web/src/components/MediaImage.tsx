import { useCallback, useLayoutEffect, useState, useSyncExternalStore, type ImgHTMLAttributes } from 'react';
import { API_BASE, fetchSiteMedia, getMediaSession, siteMediaUrl, subscribeMediaSession } from '../lib/api';

type Source = string | Blob;
type Result = { source: Source; session: AbortSignal; url: string | null };
type LiveMedia = { users: number; result: Promise<string | null>; dispose: () => void };
const liveMedia = new Map<string, LiveMedia>();

// Share a request/object URL only while views of this resource are mounted in the current session.
function retainMedia(url: string, session: AbortSignal) {
  let entry = liveMedia.get(url);
  if (!entry) {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    const dispose = () => {
      if (controller.signal.aborted) return;
      liveMedia.delete(url);
      session.removeEventListener('abort', dispose);
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    entry = {
      users: 0,
      dispose,
      result: fetchSiteMedia(url, controller.signal).then((blob) => {
        if (controller.signal.aborted) return null;
        objectUrl = URL.createObjectURL(blob);
        return objectUrl;
      }).catch(() => {
        dispose();
        return null;
      }),
    };
    liveMedia.set(url, entry);
    session.addEventListener('abort', dispose);
  }
  entry.users++;
  return entry;
}

export function useMediaResource(source?: Source | null, lazy = false) {
  const siteUrl = typeof source === 'string' ? siteMediaUrl(source) : undefined;
  const resource = siteUrl ?? (source instanceof Blob ? source : undefined);
  const session = useSyncExternalStore(subscribeMediaSession, getMediaSession);
  const [seen, setSeen] = useState(false);
  const [result, setResult] = useState<Result>();
  const wait = !!resource && lazy && !seen && typeof IntersectionObserver !== 'undefined';
  const ref = useCallback((node: HTMLElement | null) => {
    if (!node || !wait) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) setSeen(true);
    }, { rootMargin: '600px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [wait]);

  useLayoutEffect(() => {
    setResult(undefined);
    if (!resource || wait || session.aborted) return;
    if (typeof resource !== 'string') {
      const url = URL.createObjectURL(resource);
      const dispose = () => URL.revokeObjectURL(url);
      session.addEventListener('abort', dispose, { once: true });
      setResult({ source: resource, session, url });
      return () => {
        session.removeEventListener('abort', dispose);
        if (!session.aborted) dispose();
      };
    }
    const entry = retainMedia(resource, session);
    let released = false;
    void entry.result.then((url) => {
      if (!released && !session.aborted) setResult({ source: resource, session, url });
    });
    return () => {
      released = true;
      if (--entry.users === 0) entry.dispose();
    };
  }, [resource, session, wait]);

  const current = result && result.source === resource && result.session === session ? result : undefined;
  const directSrc = !resource && typeof source === 'string' && source
    ? /^(https?:|data:|blob:)/i.test(source) ? source : API_BASE + source
    : undefined;
  return { url: current?.url ?? directSrc, failed: current?.url === null, protected: !!siteUrl, session, ref };
}

export function MediaImage({ src, loading, ...props }: Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'srcSet'> & { src?: Source | null }) {
  const { url, ref } = useMediaResource(src, loading === 'lazy');
  return <img {...props} ref={ref} src={url} loading={loading} />;
}
