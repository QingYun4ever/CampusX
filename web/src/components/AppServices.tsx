import { App } from '@capacitor/app';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Download, RefreshCw } from 'lucide-react';
import { AndroidShell, AndroidUpdates, isAndroid, type UpdateInfo } from '../lib/android';
import { API_BASE, getToken } from '../lib/api';
import { syncPush } from '../lib/push';
import { checkUpdate, formatSpeed, probeLine, releaseNotes, remindLater, shouldPrompt, skipVersion } from '../lib/update';
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
    // 启动时查一次；App 常驻后台不一定会重启，所以回到前台时距上次超过 6 小时也再查
    let last = 0;
    const check = () => {
      last = Date.now();
      checkUpdate()
        .then((u) => u && shouldPrompt(u.latest.version) && setUpdate((cur) => cur ?? u))
        .catch(() => {});
    };
    // 等首页加载完再查，不跟正经请求抢网络
    const t = window.setTimeout(check, 4000);
    const h = App.addListener('resume', () => {
      if (Date.now() - last > 6 * 3600_000) window.setTimeout(check, 2000);
    }).catch(() => null);
    return () => {
      clearTimeout(t);
      void h.then((x) => x?.remove());
    };
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

  const [{ speeds, activeUrl, testing }, setProbe] = useState<{
    speeds: Record<string, number>;
    activeUrl?: string;
    testing: boolean;
  }>({ speeds: {}, testing: true });
  const [picked, setPicked] = useState<string | null>(null);
  const [probeRound, setProbeRound] = useState(0);
  const probeController = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    probeController.current = controller;
    const { signal } = controller;
    // 让清理有机会先取消已关闭的弹窗，不向原生层提交多余的测速。
    queueMicrotask(async () => {
      let results: Record<string, number> = {};
      for (const { url } of latest.downloads) {
        if (signal.aborted) return;
        setProbe({ speeds: results, activeUrl: url, testing: true });
        const speed = await probeLine(url, signal);
        if (signal.aborted) return;
        results = { ...results, [url]: speed };
        if (speed < 0) setPicked((cur) => (cur === url ? null : cur));
      }
      if (!signal.aborted) setProbe({ speeds: results, testing: false });
    });
    return () => controller.abort();
  }, [latest.downloads, probeRound]);

  // 列表保持原顺序；下载优先使用已测通的线路，未测线路排在不可用线路前。
  const ranked = [...latest.downloads].sort((a, b) => (speeds[b.url] ?? -0.5) - (speeds[a.url] ?? -0.5));
  const fastest = ranked.find((d) => (speeds[d.url] ?? -1) >= 0);
  const chosen = latest.downloads.find((d) => d.url === picked) ?? fastest ?? ranked[0];
  const order = [chosen, ...ranked.filter((d) => d !== chosen)].map((d) => d.url);
  const allDown = !testing && latest.downloads.every((d) => speeds[d.url] === -1);

  const stopTesting = () => {
    probeController.current?.abort();
    setProbe((prev) => prev.testing ? { speeds: prev.speeds, testing: false } : prev);
  };

  const browser = async () => {
    stopTesting();
    try {
      await AndroidShell.openBrowser({ url: chosen.url });
      toast('已在浏览器里开始下载，下载完点开安装即可');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const download = async () => {
    if (!verifiable) return browser();
    stopTesting();
    setBusy(true);
    try {
      const { installed } = await AndroidUpdates.installUpdate({
        version: latest.version,
        size: latest.size!,
        sha256: latest.sha256!,
        urls: order,
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
            ? '默认走测速最快的线路，失败会自动换下一条；装之前会核对安装包的校验值和官方签名。登录状态和数据都会保留，若系统提示请允许安装未知应用。'
            : '新版直接覆盖安装，登录状态和数据都会保留。如果提示“未知来源”，允许浏览器安装应用即可。'}
        </p>

        <div className="update-lines" role="radiogroup" aria-label="下载线路">
          <div className="update-lines-head">
            <span>下载线路</span>
            <button className="btn btn-text" onClick={() => setProbeRound((n) => n + 1)} disabled={testing || busy}>
              <RefreshCw size={14} className={testing ? 'spin' : ''} /> {testing ? '测速中' : '重新测速'}
            </button>
          </div>
          {latest.downloads.map((d) => {
            const sp = speeds[d.url];
            const on = d === chosen;
            return (
              <button
                key={d.url}
                role="radio"
                aria-checked={on}
                className={`update-line ${on ? 'on' : ''} ${sp === -1 ? 'down' : ''}`}
                disabled={busy || sp === -1}
                onClick={() => setPicked(d.url)}
              >
                <span className="update-line-name">{d.label}</span>
                <span className="update-line-speed">
                  {sp === undefined ? (activeUrl === d.url ? '测速中…' : testing ? '等待测速' : '未测速') : sp < 0 ? '不可用' : formatSpeed(sp)}
                  {on && fastest === d && !picked && <em>{testing ? '目前最快' : '最快'}</em>}
                </span>
                {on && <Check size={16} strokeWidth={2.5} />}
              </button>
            );
          })}
          {allDown && <p className="update-lines-note">所有线路都连不上，检查一下网络后点「重新测速」。</p>}
        </div>

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
