import { useLayoutEffect, useState } from 'react';
import { Image, RotateCw, X } from 'lucide-react';
import { closeLightbox, openLightbox, useOnVisible } from '../components/ui';
import { API_BASE, getToken } from '../lib/api';

export const DM_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
export const DM_IMAGE_LIMIT = 4;
export const DM_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

async function getPrivateImage(path: string, signal: AbortSignal) {
  const token = getToken();
  if (!token || !/^\/dm\/messages\/\d+\/images\/\d+$/.test(path)) throw new Error('图片不可用');
  const response = await fetch(`${API_BASE}/api${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
    signal,
  });
  if (!response.ok) throw new Error('图片不可用');
  return response.blob();
}

type Source = string | File;

export function DmImage({ source, number, onRemove }: { source: Source; number: number; onRemove?: () => void }) {
  const [visible, setVisible] = useState(typeof source !== 'string');
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ source: Source; url: string | null } | null>(null);
  const current = result?.source === source ? result : null;
  const url = current?.url;
  const target = useOnVisible(() => setVisible(true), !visible);

  useLayoutEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    const show = (blob: Blob) => {
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      setResult({ source, url: objectUrl });
    };
    if (typeof source !== 'string') show(source);
    else {
      getPrivateImage(source, controller.signal).then(show).catch(() => {
        if (!controller.signal.aborted) setResult({ source, url: null });
      });
    }
    return () => {
      controller.abort();
      if (objectUrl) {
        closeLightbox(objectUrl);
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [source, attempt, visible]);

  return (
    <div className="dm-image" ref={target}>
      {url ? (
        <button
          type="button"
          className="dm-image-tile"
          aria-label={`查看图片 ${number}`}
          onClick={(e) => openLightbox(url, e.currentTarget.querySelector('img'))}
        >
          <img src={url} alt="" decoding="async" draggable={false} onError={() => setResult({ source, url: null })} />
        </button>
      ) : current ? (
        <button
          type="button"
          className="dm-image-tile"
          aria-label={`重新加载图片 ${number}`}
          title="图片加载失败，点击重试"
          onClick={() => {
            setResult(null);
            setAttempt((value) => value + 1);
          }}
        >
          <RotateCw size={18} />
        </button>
      ) : (
        <span className="dm-image-tile" aria-label={`加载图片 ${number}`} role="img">
          <Image size={18} />
        </span>
      )}
      {onRemove && (
        <button type="button" className="dm-image-remove" aria-label={`移除图片 ${number}`} onClick={onRemove}>
          <X size={15} />
        </button>
      )}
    </div>
  );
}
