import type { CapacitorConfig } from '@capacitor/cli';

// 原生 App 打包配置。appId 发布前请改成你自己的（反向域名格式，发布后不能再改）。
const config: CapacitorConfig = {
  appId: 'com.tongxuequan.app',
  appName: '同学圈',
  webDir: 'dist',
  backgroundColor: '#05070d',
  ios: { contentInset: 'never' },
};

export default config;
