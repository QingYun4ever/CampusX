import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AndroidShell, isAndroid } from '../lib/android';
import { siteMediaUrl, WEB_ORIGIN } from '../lib/api';
import { openLightbox, toast } from './ui';

/** 内容中的站内地址走路由；Android 外链交给系统浏览器。 */
export function ContentLink({ href, image, children }: { href?: string; image?: boolean; children: ReactNode }) {
  if (!href) return <>{children}</>;
  let url: URL;
  try {
    url = new URL(href, window.location.href);
  } catch {
    return <>{children}</>;
  }

  const local = url.protocol === window.location.protocol && url.host === window.location.host;
  const upload = siteMediaUrl(local ? url.pathname : url.href);
  if (upload) {
    return (
      <button
        type="button"
        className="media-link"
        onClick={(e) => {
          e.stopPropagation();
          openLightbox(upload, e.currentTarget.querySelector('img') ?? e.currentTarget);
        }}
      >
        {children}
      </button>
    );
  }

  const isWeb = url.protocol === 'https:' || url.protocol === 'http:';
  const sameSite = local || (isWeb && url.origin === WEB_ORIGIN);
  if (sameSite) {
    const { pathname, search, hash } = url;
    if (!image) {
      return (
        <Link to={{ pathname: pathname.replace(/^\/+/, '/'), search, hash }} onClick={(e) => e.stopPropagation()}>
          {children}
        </Link>
      );
    }
    return (
      <a
        href={url.href}
        onClick={(e) => {
          e.stopPropagation();
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          openLightbox(url.href, e.currentTarget.querySelector('img') ?? e.currentTarget);
        }}
      >
        {children}
      </a>
    );
  }

  return (
    <a
      href={url.href}
      target={isAndroid ? undefined : '_blank'}
      rel="noopener noreferrer nofollow"
      onClick={(e) => {
        e.stopPropagation();
        if (!isAndroid || !isWeb) return;
        e.preventDefault();
        void AndroidShell.openBrowser({ url: url.href }).catch(() => toast('无法打开系统浏览器', 'error'));
      }}
    >
      {children}
    </a>
  );
}
