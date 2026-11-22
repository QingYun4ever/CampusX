import { useQuery } from '@tanstack/react-query';
import { Download, ExternalLink } from 'lucide-react';
import { useSyncExternalStore, type ReactNode } from 'react';
import { Spinner, TopBar, toast } from '../components/ui';
import { AndroidShell, isAndroid, type Latest } from '../lib/android';
import { api } from '../lib/api';
import './install.css';

interface BrowserInstallPrompt extends Event {
  prompt(): Promise<unknown>;
}

type InstallState = BrowserInstallPrompt | 'installed' | null;
const inStandaloneMode =
  window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone;
let installState: InstallState = inStandaloneMode ? 'installed' : null;
const installListeners = new Set<() => void>();

function subscribeToInstall(listener: () => void) {
  installListeners.add(listener);
  return () => {
    installListeners.delete(listener);
  };
}

function getInstallState() {
  return installState;
}

function setInstallState(state: InstallState) {
  if (state === installState) return;
  installState = state;
  installListeners.forEach((listener) => listener());
}

function captureInstallPrompt(event: Event) {
  event.preventDefault();
  setInstallState(event as BrowserInstallPrompt);
}

function markInstalled() {
  setInstallState('installed');
}

// App 静态引入此模块，先于页面挂载捕获事件；浏览器不一定会再发一次。
window.addEventListener('beforeinstallprompt', captureInstallPrompt);
window.addEventListener('appinstalled', markInstalled);
import.meta.hot?.dispose(() => {
  window.removeEventListener('beforeinstallprompt', captureInstallPrompt);
  window.removeEventListener('appinstalled', markInstalled);
});

async function installInBrowser(event: BrowserInstallPrompt) {
  if (installState !== event) return;
  setInstallState(null); // 每个浏览器安装事件只可使用一次
  try {
    await event.prompt();
  } catch {
    // 无法打开安装提示时，页面仍会显示手动安装步骤。
  }
}

function ReleaseLink({ url, className, children }: { url: string; className: string; children: ReactNode }) {
  return (
    <a
      className={className}
      href={url}
      target={isAndroid ? undefined : '_blank'}
      rel="noopener noreferrer"
      onClick={(event) => {
        if (!isAndroid) return;
        event.preventDefault();
        void AndroidShell.openBrowser({ url }).catch(() => toast('无法打开系统浏览器', 'error'));
      }}
    >
      {children}
    </a>
  );
}

function AndroidInstall() {
  const release = useQuery({
    queryKey: ['app-latest'],
    queryFn: () => api<Latest | { version: null } | null>('/app/latest'),
  });
  const latest = release.data?.version ? release.data : null;
  // 只有接口拿到安装包大小或校验值时，才使用最后一条 GitHub 直连。
  const apk = latest && (latest.size || latest.sha256) ? latest.downloads.at(-1)?.url : undefined;

  return (
    <section className="card install-card" aria-labelledby="install-android">
      <h2 id="install-android">Android 安装包</h2>
      {release.isPending ? (
        <p className="install-loading" role="status">
          <Spinner size={16} inline /> 正在查询最新版本…
        </p>
      ) : (
        <>
          {apk && latest ? (
            <p>
              官方签名 APK · v{latest.version}
              {latest.size ? ` · ${(latest.size / 1048576).toFixed(1)} MB` : ''}
            </p>
          ) : (
            <p role="status">
              {release.isError
                ? '查询最新版本失败。请检查网络后再试。'
                : latest?.page
                  ? '暂时无法确认最新安装包，可以到发布页查看。'
                  : '暂未获取到 Android 安装包，你也可以安装网页版。'}
            </p>
          )}
          <div className="row">
            {apk ? (
              <ReleaseLink url={apk} className="btn btn-primary">
                <Download size={16} aria-hidden="true" /> 下载 APK
              </ReleaseLink>
            ) : (
              <button className="btn btn-outline" type="button" disabled={release.isFetching} onClick={() => void release.refetch()}>
                {release.isFetching ? '正在查询…' : '重新查询'}
              </button>
            )}
            {latest?.page && (
              <ReleaseLink url={latest.page} className="btn btn-outline">
                查看发布页 <ExternalLink size={15} aria-hidden="true" />
              </ReleaseLink>
            )}
          </div>
          {apk && (
            <p className="small">下载后打开 APK，按系统提示安装。如需允许「安装未知应用」，只给下载 APK 的浏览器或文件管理器开启，装完可以关闭。</p>
          )}
        </>
      )}
    </section>
  );
}

function BrowserInstall() {
  const state = useSyncExternalStore(subscribeToInstall, getInstallState);

  return (
    <section className="card install-card" aria-labelledby="install-browser">
      <h2 id="install-browser">网页版安装</h2>
      {state === 'installed' ? (
        <p role="status">此设备上的浏览器已安装校墙网页版。</p>
      ) : state ? (
        <>
          <p>把校墙添加到主屏幕或桌面，不需要下载安装包。</p>
          <div className="row">
            <button className="btn btn-primary" type="button" onClick={() => void installInBrowser(state)}>
              <Download size={16} aria-hidden="true" /> 安装网页版
            </button>
          </div>
        </>
      ) : (
        <>
          <p>用浏览器打开校墙，再按设备选择下面的步骤：</p>
          <ul>
            <li><strong>Android：</strong>在 Chrome 右上角菜单中选择「安装应用」或「添加到主屏幕」。</li>
            <li><strong>iPhone / iPad：</strong>在 Safari 中点「分享」，选择「添加到主屏幕」，再点「添加」。如有「作为网页 App 打开」选项，请保持开启。</li>
            <li><strong>电脑：</strong>在 Chrome 或 Edge 的地址栏找安装图标，也可以在浏览器菜单里找「安装」或「应用」。Mac 上的 Safari 可以选择「文件」→「添加到程序坞」。</li>
          </ul>
          <p className="small">如果找不到这些选项，可以直接在浏览器里使用校墙。</p>
        </>
      )}
    </section>
  );
}

export function InstallPage() {
  return (
    <main className="install-page">
      <TopBar back title="安装校墙" />
      <div className="install-content">
        <AndroidInstall />
        <BrowserInstall />
      </div>
    </main>
  );
}
