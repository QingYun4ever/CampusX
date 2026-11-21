import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export const isAndroid = Capacitor.getPlatform() === 'android';

export const AndroidShell = registerPlugin<{
  openBrowser(options: { url: string }): Promise<void>;
  setBackdrop(options: { color: string }): Promise<void>;
  saveText(options: { name: string; text: string }): Promise<void>;
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
  /** 点了系统通知，要打开的站内路径 */
  addListener(event: 'openPath', fn: (e: { path: string }) => void): Promise<PluginListenerHandle>;
}>('AndroidShell');
