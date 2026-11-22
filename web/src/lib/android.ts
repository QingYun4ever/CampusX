import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export const isAndroid = Capacitor.getPlatform() === 'android';

export const AndroidShell = registerPlugin<{
  openBrowser(options: { url: string }): Promise<void>;
  setBackdrop(options: { color: string }): Promise<void>;
  saveText(options: { name: string; text: string }): Promise<void>;
  /** 保存到相册「Pictures/校墙」：url 由原生下载，data 是 base64 */
  saveImage(options: { url?: string; data?: string; mime?: string }): Promise<void>;
  checkNotifications(): Promise<{ granted: boolean; canAsk: boolean }>;
  requestNotifications(): Promise<{ granted: boolean; canAsk: boolean }>;
  openNotificationSettings(): Promise<void>;
  configurePush(options: {
    enabled: boolean;
    apiBase: string;
    token: string;
    dm: boolean;
    posts: boolean;
    interactions: boolean;
  }): Promise<void>;
  /** The native notification activity has recorded a pending, login-scoped destination. */
  addListener(event: 'notificationOpened', fn: () => void): Promise<PluginListenerHandle>;
  takeNotificationPath(options: { apiBase: string; token: string }): Promise<{ path?: string }>;
}>('AndroidShell');

export interface Latest {
  version: string;
  notes: string;
  size: number | null;
  sha256: string | null;
  publishedAt: string | null;
  /** 第一个是推荐线路（加速镜像在前，最后是 GitHub 直连） */
  downloads: { label: string; url: string }[];
  page: string;
}

export interface UpdateInfo {
  current: string;
  latest: Latest;
}

export const AndroidUpdates = registerPlugin<{
  /** 按 urls 的顺序下载，核对 SHA-256 和官方签名后交给系统安装器 */
  installUpdate(options: { version: string; size: number; sha256: string; urls: string[] }): Promise<{ installed: boolean }>;
}>('AndroidUpdates');
