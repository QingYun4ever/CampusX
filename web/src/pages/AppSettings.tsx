import { useEffect, useState } from 'react';
import { App } from '@capacitor/app';
import { Bell, ChevronRight, Download, X } from 'lucide-react';
import { UpdateModal } from '../components/AppServices';
import { Spinner, Switch, toast } from '../components/ui';
import { AndroidShell, isAndroid } from '../lib/android';
import { enablePush, getPushPrefs, savePushPrefs, type PushPrefs } from '../lib/push';
import { checkUpdate, type UpdateInfo } from '../lib/update';

const KINDS: { key: keyof Omit<PushPrefs, 'enabled'>; name: string }[] = [
  { key: 'dm', name: '私信' },
  { key: 'posts', name: '关注的人发帖' },
  { key: 'interactions', name: '回复、提到和关注' },
];

/** 推送通知（只有 App 里有） */
export function PushSettings() {
  const [prefs, setPrefs] = useState(getPushPrefs);
  const [granted, setGranted] = useState<boolean | null>(null);
  const [blocked, setBlocked] = useState(false);

  // 从系统设置回来时重新看一下权限
  useEffect(() => {
    if (!isAndroid) return;
    const check = () =>
      AndroidShell.checkNotifications()
        .then((r) => setGranted(r.granted))
        .catch(() => setGranted(false));
    void check();
    const h = App.addListener('resume', check);
    return () => void h.then((x) => x.remove());
  }, []);

  if (!isAndroid) return null;
  const on = prefs.enabled && granted === true;
  const update = (p: PushPrefs) => {
    setPrefs(p);
    savePushPrefs(p);
  };

  const toggle = async (v: boolean) => {
    if (!v) return update({ ...prefs, enabled: false });
    try {
      const r = await enablePush();
      if (r.ok) {
        setGranted(true);
        setBlocked(false);
        setPrefs(getPushPrefs());
      } else {
        setGranted(false);
        setBlocked(!r.canAsk);
        if (r.canAsk) toast('没有通知权限，收不到推送', 'error');
      }
    } catch {
      toast('这个版本的 App 还不支持推送，请先更新', 'error');
    }
  };

  return (
    <section className="section push-settings">
      <h3>通知</h3>
      <div className="setting-row">
        <Bell size={20} />
        <span className="grow">
          推送通知
          <span className="muted small">App 不在前台时，用系统通知提醒你</span>
        </span>
        <Switch on={on} onChange={toggle} label="推送通知" disabled={granted === null} />
      </div>
      {blocked && (
        <p className="section-sub push-blocked">
          通知权限被关掉了。
          <button className="link-btn" onClick={() => AndroidShell.openNotificationSettings().catch(() => {})}>
            去系统设置打开
          </button>
        </p>
      )}
      {on && (
        <div className="push-kinds">
          {KINDS.map((k) => (
            <div className="setting-row sub" key={k.key}>
              <span className="grow">{k.name}</span>
              <Switch on={prefs[k.key]} onChange={(v) => update({ ...prefs, [k.key]: v })} label={k.name} />
            </div>
          ))}
        </div>
      )}
      <p className="section-sub">
        校墙没有接入手机厂商的推送服务，App 在后台大约每 15 分钟检查一次新消息，所以会晚几分钟。
        如果一直收不到，请在系统设置里允许校墙后台运行、关闭对它的省电限制。
      </p>
    </section>
  );
}

/** 检查更新（只有 App 里有） */
export function UpdateRow() {
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [current, setCurrent] = useState('');
  useEffect(() => {
    if (isAndroid) App.getInfo().then((i) => setCurrent(i.version)).catch(() => {});
  }, []);
  if (!isAndroid) return null;

  const check = async () => {
    setBusy(true);
    try {
      const u = await checkUpdate();
      if (u) setInfo(u);
      else toast('已经是最新版本');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button className="list-link" onClick={check} disabled={busy}>
        <Download size={20} />
        <span className="grow">
          检查更新
          <span className="muted small">当前版本 {current || '…'}</span>
        </span>
        {busy ? <Spinner inline /> : <ChevronRight size={18} className="muted" />}
      </button>
      {info && <UpdateModal info={info} onClose={() => setInfo(null)} />}
    </>
  );
}

const ASK_KEY = 'txq_push_ask_closed';

/** 通知页顶上的一张小卡片：还没开推送时建议打开，关掉后不再出现 */
export function PushAsk() {
  const [show, setShow] = useState(() => {
    if (!isAndroid || getPushPrefs().enabled) return false;
    try {
      return !localStorage.getItem(ASK_KEY);
    } catch {
      return false;
    }
  });
  if (!show) return null;
  const close = () => {
    setShow(false);
    try {
      localStorage.setItem(ASK_KEY, '1');
    } catch {
      /* ignore */
    }
  };
  const turnOn = async () => {
    try {
      const r = await enablePush();
      if (r.ok) {
        toast('已打开推送通知');
        close();
      } else if (!r.canAsk) {
        await AndroidShell.openNotificationSettings();
      } else {
        toast('没有通知权限，收不到推送', 'error');
      }
    } catch {
      toast('这个版本的 App 还不支持推送，请先更新', 'error');
    }
  };
  return (
    <div className="push-ask">
      <Bell size={22} />
      <p>
        <strong>打开推送通知</strong>
        私信、关注的人发帖和回复，不打开 App 也能知道。
      </p>
      <button className="btn btn-primary sm" onClick={turnOn}>
        打开
      </button>
      <button className="icon-btn" aria-label="不用了" onClick={close}>
        <X size={18} />
      </button>
    </div>
  );
}
