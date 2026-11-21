import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AndroidShell, isAndroid } from '../lib/android';
import { media, WEB_ORIGIN } from '../lib/api';
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

  const isWeb = url.protocol === 'https:' || url.protocol === 'http:';
  const local = url.protocol === window.location.protocol && url.host === window.location.host;
  const sameSite = local || (isWeb && url.origin === WEB_ORIGIN);
  if (sameSite) {
    const { pathname, search, hash } = url;
    const upload = pathname.startsWith('/uploads/');
    if (!image && !upload) {
      return (
        <Link to={{ pathname: pathname.replace(/^\/+/, '/'), search, hash }} onClick={(e) => e.stopPropagation()}>
          {children}
        </Link>
      );
    }
    const src = upload ? media(`${pathname}${search}${hash}`) ?? url.href : url.href;
    return (
      <a
        href={src}
        onClick={(e) => {
          e.stopPropagation();
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          openLightbox(src, e.currentTarget.querySelector('img') ?? e.currentTarget);
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
