import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download } from 'lucide-react';
import { AndroidShell, AndroidUpdates, isAndroid, type UpdateInfo } from '../lib/android';
import { API_BASE, getToken } from '../lib/api';
import { syncPush } from '../lib/push';
import { checkUpdate, releaseNotes, remindLater, shouldPrompt, skipVersion } from '../lib/update';
import { Modal, toast } from './ui';
import './app-services.css';

/** 只在 Android App 里工作：系统通知、点通知跳转、启动时检查更新 */
export function AppServices() {
  const nav = useNavigate();
  const navRef = useRef(nav);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);

  useEffect(() => {
    navRef.current = nav;
    if (isAndroid) void syncPush();
  }, [nav]);

  useEffect(() => {
    if (!isAndroid) return;
    let active = true;
    const open = () => {
      const token = getToken();
      const apiBase = API_BASE;
      if (!active || !token) return;
      void AndroidShell.takeNotificationPath({ apiBase, token })
        .then(({ path }) => {
          if (active && path && getToken() === token && API_BASE === apiBase) navRef.current(path);
        })
        .catch(() => {});
    };
    const h = AndroidShell.addListener('notificationOpened', open)
      .then((listener) => {
        // A notification can start the app before the signed-in WebView attaches.
        open();
        return listener;
      })
      .catch(() => null);
    return () => {
      active = false;
      void h.then((x) => x?.remove());
    };
  }, []);

  useEffect(() => {
    if (!isAndroid) return;
    // 等首页加载完再查，不跟正经请求抢网络
    const t = window.setTimeout(() => {
      checkUpdate()
        .then((u) => u && shouldPrompt(u.latest.version) && setUpdate(u))
        .catch(() => {});
    }, 4000);
    return () => clearTimeout(t);
  }, []);

  return update ? <UpdateModal info={update} onClose={() => setUpdate(null)} auto /> : null;
}

export function UpdateModal({ info, onClose, auto = false }: { info: UpdateInfo; onClose: () => void; auto?: boolean }) {
  const { latest, current } = info;
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const notes = releaseNotes(latest.notes);
  // 服务器拿不到 SHA-256 时没法在 App 里校验，只能交给浏览器下载
  const verifiable = !!latest.sha256 && !!latest.size;

  const browser = async () => {
    try {
      await AndroidShell.openBrowser({ url: latest.downloads[0].url });
      toast('已在浏览器里开始下载，下载完点开安装即可');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const download = async () => {
    if (!verifiable) return browser();
    setBusy(true);
    try {
      const { installed } = await AndroidUpdates.installUpdate({
        version: latest.version,
        size: latest.size!,
        sha256: latest.sha256!,
        urls: latest.downloads.map((d) => d.url),
      });
      if (installed) onClose();
    } catch (e) {
      setFailed(true);
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const later = () => {
    if (busy) return;
    if (auto) remindLater();
    onClose();
  };

  return (
    <Modal title="有新版本" onClose={later} className="update-modal">
      <div className="modal-body update">
        <div className="update-head">
          <span className="update-icon">
            <Download size={22} />
          </span>
          <div>
            <strong>校墙 {latest.version}</strong>
            <span>
              当前 {current}
              {latest.size ? ` · 安装包 ${(latest.size / 1048576).toFixed(1)} MB` : ''}
            </span>
          </div>
        </div>

        {notes.length > 0 && (
          <ul className="update-notes">
            {notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        )}

        <p className="update-tip">
          {verifiable
            ? '优先走加速线路下载，装之前会核对安装包的校验值和官方签名。登录状态和数据都会保留；若系统提示，请允许安装未知应用。'
            : '新版直接覆盖安装，登录状态和数据都会保留。如果提示“未知来源”，允许浏览器安装应用即可。'}
        </p>

        <button className="btn btn-primary update-main" onClick={download} disabled={busy}>
          {busy ? '正在下载并校验…' : verifiable ? '下载更新' : '用浏览器下载'}
        </button>
        {verifiable && failed && !busy && (
          <button className="btn btn-text update-more" onClick={browser}>
            改用浏览器下载
          </button>
        )}

        <div className="update-foot">
          <button
            className="btn btn-text"
            disabled={busy}
            onClick={() => {
              skipVersion(latest.version);
              onClose();
            }}
          >
            跳过这个版本
          </button>
          <button className="btn btn-text" onClick={later} disabled={busy}>
            以后再说
          </button>
        </div>
      </div>
    </Modal>
  );
}
