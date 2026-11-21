import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download } from 'lucide-react';
import { AndroidShell, isAndroid } from '../lib/android';
import { syncPush } from '../lib/push';
import { checkUpdate, fastestDownload, releaseNotes, remindLater, shouldPrompt, skipVersion, type UpdateInfo } from '../lib/update';
import { Modal, toast } from './ui';
import './app-services.css';

/** 只在 Android App 里工作：系统通知、点通知跳转、启动时检查更新 */
export function AppServices() {
  const nav = useNavigate();
  const [update, setUpdate] = useState<UpdateInfo | null>(null);

  useEffect(() => {
    if (!isAndroid) return;
    void syncPush();
    const h = AndroidShell.addListener('openPath', ({ path }) => {
      if (path.startsWith('/') && !path.startsWith('//')) nav(path);
    }).catch(() => null);
    return () => void h.then((x) => x?.remove());
  }, [nav]);

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
  const [more, setMore] = useState(false);
  const notes = releaseNotes(latest.notes);

  const open = async (url: string) => {
    try {
      await AndroidShell.openBrowser({ url });
      toast('已在浏览器里开始下载，下载完点开安装即可');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const download = async () => {
    setBusy(true);
    try {
      await open(await fastestDownload(latest.downloads));
    } finally {
      setBusy(false);
    }
  };
  const later = () => {
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

        <p className="update-tip">新版直接覆盖安装，登录状态和数据都会保留。如果提示“未知来源”，允许浏览器安装应用即可。</p>

        <button className="btn btn-primary update-main" onClick={download} disabled={busy}>
          {busy ? '正在找最快的线路…' : '下载更新'}
        </button>

        {more ? (
          <div className="update-lines">
            {latest.downloads.map((d) => (
              <button key={d.url} className="btn btn-outline" onClick={() => open(d.url)}>
                {d.label}
              </button>
            ))}
          </div>
        ) : (
          <button className="btn btn-text update-more" onClick={() => setMore(true)}>
            下载慢？换一条线路
          </button>
        )}

        <div className="update-foot">
          <button
            className="btn btn-text"
            onClick={() => {
              skipVersion(latest.version);
              onClose();
            }}
          >
            跳过这个版本
          </button>
          <button className="btn btn-text" onClick={later}>
            以后再说
          </button>
        </div>
      </div>
    </Modal>
  );
}
