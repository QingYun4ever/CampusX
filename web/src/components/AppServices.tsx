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
  const notes = releaseNotes(latest.notes);

  const download = async () => {
    setBusy(true);
    try {
      const { installed } = await AndroidUpdates.installUpdate({ version: latest.version });
      if (installed) onClose();
    } catch (e) {
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

        <p className="update-tip">从官方 GitHub 下载并校验安装包，不影响现有登录和数据。若系统提示，请在设置中允许安装未知应用。</p>

        <button className="btn btn-primary update-main" onClick={download} disabled={busy}>
          {busy ? '正在准备更新…' : '下载并验证更新'}
        </button>

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
