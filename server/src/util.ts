import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';

export class HttpError extends Error {
  status: number;
  /** 一起返回给前端的附加字段（例如审核结果） */
  data?: Record<string, unknown>;
  constructor(status: number, message: string, data?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    const issue = r.error.issues[0];
    // 自定义的提示是中文；zod 自带的英文提示（类型不对、缺字段）统一换成中文
    const msg = issue?.message && /[\u4e00-\u9fa5]/.test(issue.message) ? issue.message : '请求参数有误，请刷新页面后重试';
    throw new HttpError(400, msg);
  }
  return r.data;
}

export function me(req: FastifyRequest) {
  if (!req.user) throw new HttpError(401, '请先登录');
  return req.user;
}

export function cursorNum(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function escapeLike(s: string) {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}
