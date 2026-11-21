import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd());
  // 打包原生 App 时，页面运行在 App 内部，必须写明后端的完整地址
  if (mode === 'app' && !/^https?:\/\//.test(env.VITE_API_BASE ?? '')) {
    throw new Error('打包 App 需要在 web/.env.app.local 中设置 VITE_API_BASE=https://你的域名');
  }
  return {
    plugins: [react()],
    server: {
      host: true,
      proxy: {
        '/api': 'http://localhost:3000',
        '/uploads': 'http://localhost:3000',
      },
    },
  };
});
