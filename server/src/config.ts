import path from 'node:path';

const serverRoot = path.resolve(import.meta.dirname, '..');

function list(v: string | undefined, fallback: string[]): string[] {
  if (!v) return fallback;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

function smtpConfig() {
  const host = process.env.SMTP_HOST?.trim();
  const from = process.env.MAIL_FROM?.trim();
  if (!host || !from) return null;
  const secureSetting = process.env.SMTP_SECURE?.toLowerCase();
  const implicitTls = secureSetting === '1' || secureSetting === 'true';
  const port = Number(process.env.SMTP_PORT ?? (implicitTls ? 465 : 587));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SMTP_PORT 无效');
  const secure = implicitTls || (secureSetting === undefined && port === 465);
  if (secureSetting !== undefined && !['0', '1', 'false', 'true'].includes(secureSetting)) {
    throw new Error('SMTP_SECURE 无效');
  }
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (Boolean(user) !== Boolean(pass)) throw new Error('SMTP_USER 和 SMTP_PASS 必须一起设置');
  const plaintext = (secureSetting === '0' || secureSetting === 'false')
    && process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1', '::1'].includes(host.toLowerCase());
  return { from, host, port, secure, requireTLS: !secure && !plaintext, auth: user && pass ? { user, pass } : undefined };
}

/** 0 是不信任代理，直接用连进来的地址 */
function trustProxyHops(v: string | undefined): number {
  if (v === 'true') return 1;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n <= 5 ? n : 0;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  // 部署在 Nginx/Caddy 等反向代理后面时设为 1，才能拿到真实 IP（用于限流和同一网络注册上限）。
  // 数字是信任几层代理：取 X-Forwarded-For 从右往左数第几个，用户自己在请求里伪造的那些在最左边，不会被当真。
  // 只有 Nginx 一层填 1；前面还有 CDN（CDN → Nginx → 校墙）填 2
  trustProxyHops: trustProxyHops(process.env.TRUST_PROXY),
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
  /** App 更新：从这个 GitHub 仓库的 Releases 找最新安装包 */
  releaseRepo: process.env.APP_RELEASE_REPO?.trim() || 'QingYun4ever/CampusX',
  /**
   * 下载加速镜像；格式是「前缀 + GitHub 原始下载地址」。设为 none 只用 GitHub 直连。
   * 哪条快因地区和网络而异（服务器上测的不算数），App 会在手机上逐条测速再选
   */
  downloadMirrors:
    process.env.APP_DOWNLOAD_MIRRORS?.trim() === 'none'
      ? []
      : list(process.env.APP_DOWNLOAD_MIRRORS, [
          'https://v4.gh-proxy.org/',
          'https://axisnow.gh-proxy.org/',
          'https://v6.gh-proxy.org/',
          'https://gh-proxy.org/',
        ]),
  maxPostLength: 2000,
  smtp: smtpConfig(),
};

export const uploadsDir = path.join(config.dataDir, 'uploads');
export const videosDir = path.join(config.dataDir, 'videos');
export const accountSecurityKeyPath = path.join(config.dataDir, 'account-security.key');

/**
 * 用户协议版本，和 web/src/pages/Terms.tsx 里的 TERMS_VERSION 保持一致。
 * 协议有实质修改时两边一起加 1，所有人下次打开会被请求重新确认。
 */
export const TERMS_VERSION = 1;
