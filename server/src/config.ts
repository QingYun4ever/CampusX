import path from 'node:path';

const serverRoot = path.resolve(import.meta.dirname, '..');

function list(v: string | undefined, fallback: string[]): string[] {
  if (!v) return fallback;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  // 部署在 Nginx/Caddy 等反向代理后面时设为 1，才能拿到真实 IP（用于限流）
  trustProxy: process.env.TRUST_PROXY === '1',
  dataDir: path.resolve(process.env.DATA_DIR ?? path.join(serverRoot, 'data')),
  webDist: path.resolve(serverRoot, '../web/dist'),
  // 允许跨域访问 API 的来源：原生 App 的 WebView + 本地开发
  corsOrigins: list(process.env.CORS_ORIGINS, [
    'capacitor://localhost', // iOS App
    'https://localhost', // Android App
    'http://localhost',
    'http://localhost:5173', // Vite dev
  ]),
  sessionDays: 60,
  maxUploadBytes: 8 * 1024 * 1024,
  maxPostLength: 2000,
};

export const uploadsDir = path.join(config.dataDir, 'uploads');
