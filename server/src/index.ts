import fs from 'node:fs';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyError } from 'fastify';
import { type SessionUser, touchSeen, userFromToken } from './auth.ts';
import { config } from './config.ts';
import { get, now } from './db.ts';
import { resumePending } from './moderation.ts';
import { registerSiteUploadRoutes, startSiteUploads } from './site-uploads.ts';
import { appRoutes } from './routes/app.ts';
import { authRoutes } from './routes/auth.ts';
import { boardRoutes } from './routes/boards.ts';
import { dmRoutes } from './routes/dm.ts';
import { miscRoutes } from './routes/misc.ts';
import { postRoutes } from './routes/posts.ts';
import { safetyRoutes } from './routes/safety.ts';
import { securityRoutes } from './routes/security.ts';
import { userRoutes } from './routes/users.ts';
import { HttpError } from './util.ts';

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  trustProxy: config.trustProxy,
  bodyLimit: 1024 * 1024,
});

await app.register(cors, {
  origin: (origin, cb) => cb(null, !origin || config.corsOrigins.includes(origin)),
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
});
await app.register(rateLimit, { max: 600, timeWindow: '1 minute' });
await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 1 } });

app.addHook('onSend', async (req, reply) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Referrer-Policy', 'same-origin');
  const pathname = req.url.split('?', 1)[0];
  if (/^\/api\/(?:auth\/login(?:\/2fa)?|me\/(?:security|password|email(?:\/start|\/confirm)?|2fa(?:\/setup|\/confirm)?))$/.test(pathname)) {
    reply.header('Cache-Control', 'no-store');
  }
});

app.decorateRequest('user', null);
app.addHook('onRequest', async (req) => {
  const h = req.headers.authorization;
  req.user = h?.startsWith('Bearer ') ? userFromToken(h.slice(7)) : null;
  // App 后台取推送不算「在线」
  if (req.user && !req.url.startsWith('/api/push/')) touchSeen(req.user.id);
});

// 除登录/注册/验证码外，所有 API 都需要登录（平台只对同学开放）
const PUBLIC_API = [
  '/api/captcha',
  '/api/auth/login',
  '/api/auth/login/2fa',
  '/api/auth/register',
  '/api/auth/invite/check',
  '/api/auth/username/check',
  '/api/auth/logout',
  '/api/health',
  '/api/app/latest',
];
app.addHook('preHandler', async (req) => {
  const url = req.url.split('?')[0];
  if (url.startsWith('/api/') && !PUBLIC_API.includes(url) && !req.user) {
    throw new HttpError(401, '请先登录');
  }
});

app.setErrorHandler((err: FastifyError | HttpError, req, reply) => {
  if (err instanceof HttpError) return reply.status(err.status).send({ ...err.data, error: err.message });
  const status = err.statusCode ?? 500;
  if (status === 429) return reply.status(429).send({ error: '操作太频繁，请稍后再试' });
  if (status === 413 || err.code === 'FST_REQ_FILE_TOO_LARGE') {
    return reply.status(413).send({ error: '文件太大了' });
  }
  if (status < 500) return reply.status(status).send({ error: err.message });
  req.log.error(err);
  return reply.status(500).send({ error: '服务器出错了，请稍后再试' });
});

await app.register(
  async (api) => {
    api.get('/health', async () => ({ ok: true, time: now() }));
    await api.register(authRoutes);
    await api.register(securityRoutes);
    await api.register(postRoutes);
    await api.register(userRoutes);
    await api.register(boardRoutes);
    await api.register(miscRoutes);
    await api.register(dmRoutes);
    await api.register(safetyRoutes);
    await api.register(appRoutes);
  },
  { prefix: '/api' },
);

startSiteUploads();
registerSiteUploadRoutes(app);

// 生产环境：同时托管前端构建产物（SPA）
const hasWeb = fs.existsSync(config.webDist);
if (hasWeb) {
  // 按请求查找文件（重新构建前端后无需重启后端）；hash 文件名的资源可长期缓存
  await app.register(fastifyStatic, {
    root: config.webDist,
    prefix: '/',
    setHeaders: (reply, filePath) => {
      reply.header(
        'Cache-Control',
        /[\\/]assets[\\/]/.test(filePath) ? 'public, max-age=31536000, immutable' : 'no-cache',
      );
    },
  });
}
app.setNotFoundHandler((req, reply) => {
  const url = req.url.split('?')[0];
  const isPage = !/\.[a-z0-9]+$/i.test(url); // 带扩展名的是静态资源，缺失就 404
  if (hasWeb && req.method === 'GET' && isPage && !url.startsWith('/api/') && !url.startsWith('/uploads/')) {
    reply.header('Cache-Control', 'no-cache');
    return reply.sendFile('index.html', config.webDist);
  }
  return reply.status(404).send({ error: '找不到该资源' });
});

if (!get('SELECT 1 FROM users LIMIT 1')) {
  app.log.warn('站点尚未初始化。在服务端运行 npm run invite -w server -- --bootstrap 获取管理员初始化邀请码。');
}

await app.listen({ port: config.port, host: config.host });
resumePending();
