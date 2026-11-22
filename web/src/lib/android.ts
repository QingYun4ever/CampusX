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

export interface UpdateInfo {
  current: string;
  latest: { version: string; notes: string; size: number };
}

export const AndroidUpdates = registerPlugin<{
  checkUpdate(): Promise<{ update?: UpdateInfo }>;
  installUpdate(options: { version: string }): Promise<{ installed: boolean }>;
}>('AndroidUpdates');
