import { Capacitor, registerPlugin } from '@capacitor/core';

export const isAndroid = Capacitor.getPlatform() === 'android';

export const AndroidShell = registerPlugin<{
  openBrowser(options: { url: string }): Promise<void>;
  setBackdrop(options: { color: string }): Promise<void>;
  saveText(options: { name: string; text: string }): Promise<void>;
}>('AndroidShell');
