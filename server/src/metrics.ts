/**
 * 负载统计：只在内存里，重启清零。用来分清卡顿是服务器慢还是网络慢。
 *
 * - 服务器：每个 /api 请求从解析完请求体到开始回包的处理时间（不含收发数据的网络时间），
 *   通过响应头 X-Server-Time 告诉客户端
 * - 同学端：客户端记下每个请求从发出到收完的总时间，减去 X-Server-Time 就是网络（含反代）花的时间，
 *   攒一批上报到 /api/metrics/client
 * - 系统：每 10 秒采一次 CPU、事件循环延迟、内存
 * - 数据库：每条 SQL 的耗时（同步执行，慢查询会直接卡住所有请求）
 *
 * 按分钟分桶，保留 6 小时；接口和同学的明细只留 1 小时。
 */
import os from 'node:os';
import { monitorEventLoopDelay, performance, type EventLoopUtilization } from 'node:perf_hooks';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/** 直方图分桶上界（毫秒），最后一格是 10 秒以上 */
const BOUNDS = [2, 5, 10, 20, 35, 50, 75, 100, 150, 200, 300, 400, 500, 750, 1000, 1250, 1500, 2000, 3000, 5000, 7500, 10_000];
const newHist = () => new Array<number>(BOUNDS.length + 1).fill(0);
function add(h: number[], ms: number) {
  let i = 0;
  while (i < BOUNDS.length && ms > BOUNDS[i]) i++;
  h[i]++;
}
function merge(into: number[], h: number[]) {
  for (let i = 0; i < h.length; i++) into[i] += h[i];
}
const count = (h: number[]) => h.reduce((a, b) => a + b, 0);
/** 按直方图估分位数（桶内线性插值），没有数据时为 null */
export function quantile(h: number[], q: number): number | null {
  const n = count(h);
  if (!n) return null;
  const target = q * n;
  let acc = 0;
  for (let i = 0; i < h.length; i++) {
    if (!h[i]) continue;
    if (acc + h[i] >= target) {
      const lo = i ? BOUNDS[i - 1] : 0;
      const hi = i < BOUNDS.length ? BOUNDS[i] : BOUNDS[BOUNDS.length - 1] * 2;
      return Math.round(lo + (hi - lo) * Math.max(0, Math.min(1, (target - acc) / h[i])));
    }
    acc += h[i];
  }
  return BOUNDS[BOUNDS.length - 1] * 2;
}

interface RouteStat { n: number; err: number; sum: number; max: number; hist: number[] }
interface UserStat { n: number; fail: number; net: number[]; srv: number[]; app: boolean; conn: string }
interface Minute {
  t: number;
  req: number;
  err: number;
  srv: number[];
  db: number;
  cli: number;
  cliFail: number;
  total: number[];
  net: number[];
  page: number[];
  ticks: number;
  cpu: number;
  sysCpu: number;
  elu: number;
  lagP99: number;
  lagMax: number;
  rss: number;
  routes: Map<string, RouteStat> | null;
  users: Map<number, UserStat> | null;
}

const KEEP_MINUTES = 360;
const DETAIL_MINUTES = 60;
const minutes = new Map<number, Minute>();
const minuteOf = (t: number) => Math.floor(t / 60_000);

function bucket(t = Date.now()): Minute {
  const k = minuteOf(t);
  let m = minutes.get(k);
  if (!m) {
    m = {
      t: k * 60_000, req: 0, err: 0, srv: newHist(), db: 0, cli: 0, cliFail: 0, total: newHist(), net: newHist(), page: newHist(),
      ticks: 0, cpu: 0, sysCpu: 0, elu: 0, lagP99: 0, lagMax: 0, rss: 0, routes: new Map(), users: new Map(),
    };
    minutes.set(k, m);
    for (const [key, old] of minutes) {
      if (key <= k - KEEP_MINUTES) minutes.delete(key);
      else if (key <= k - DETAIL_MINUTES) old.routes = old.users = null;
    }
  }
  return m;
}

/* ---------------- 数据库 ---------------- */

interface SqlStat { n: number; sum: number; max: number }
const sqlStats = new Map<string, SqlStat>();
const slowQueries: { at: number; ms: number; sql: string }[] = [];
const SLOW_SQL_MS = 100;

/** db.ts 每执行一条 SQL 调一次 */
export function recordQuery(sql: string, ms: number) {
  bucket().db += ms;
  let s = sqlStats.get(sql);
  if (!s) {
    // 语句是缓存过的，种类有限；以防万一设个上限
    if (sqlStats.size >= 2000) return;
    sqlStats.set(sql, (s = { n: 0, sum: 0, max: 0 }));
  }
  s.n++;
  s.sum += ms;
  if (ms > s.max) s.max = ms;
  if (ms >= SLOW_SQL_MS) {
    slowQueries.unshift({ at: Date.now(), ms, sql: oneLine(sql) });
    slowQueries.length = Math.min(slowQueries.length, 30);
  }
}
const oneLine = (sql: string) => sql.replace(/\s+/g, ' ').trim().slice(0, 240);

/* ---------------- 请求 ---------------- */

const started = new WeakMap<FastifyRequest, number>();
const handled = new WeakMap<FastifyRequest, number>();
const processing = new WeakMap<FastifyRequest, number>();
const slowRequests: { at: number; route: string; ms: number; status: number }[] = [];
const SLOW_REQUEST_MS = 1000;
/** 还没回完的请求 */
const open = new Set<FastifyRequest>();

/** 在注册路由之前调用 */
export function installMetrics(app: FastifyInstance) {
  app.addHook('onRequest', async (req) => {
    started.set(req, performance.now());
    open.add(req);
  });
  // 请求体收完之后才开始算处理时间：上传慢是网络的事
  app.addHook('preValidation', async (req) => {
    handled.set(req, performance.now());
  });
  app.addHook('onSend', async (req, reply) => {
    const from = handled.get(req) ?? started.get(req);
    if (from === undefined) return;
    const ms = performance.now() - from;
    processing.set(req, ms);
    if (req.url.startsWith('/api/')) reply.header('X-Server-Time', ms.toFixed(1));
  });
  app.addHook('onResponse', async (req, reply) => {
    open.delete(req);
    if (!req.url.startsWith('/api/')) return;
    const ms = processing.get(req);
    if (ms === undefined) return;
    const status = reply.statusCode;
    const route = `${req.method} ${req.routeOptions.url ?? '（不存在的地址）'}`;
    const m = bucket();
    m.req++;
    add(m.srv, ms);
    if (status >= 500) m.err++;
    if (m.routes) {
      let r = m.routes.get(route);
      if (!r) m.routes.set(route, (r = { n: 0, err: 0, sum: 0, max: 0, hist: newHist() }));
      r.n++;
      r.sum += ms;
      if (ms > r.max) r.max = ms;
      if (status >= 500) r.err++;
      add(r.hist, ms);
    }
    if (ms >= SLOW_REQUEST_MS) {
      slowRequests.unshift({ at: Date.now(), route, ms: Math.round(ms), status });
      slowRequests.length = Math.min(slowRequests.length, 30);
    }
  });
  app.addHook('onRequestAbort', async (req) => {
    open.delete(req);
  });
}

/* ---------------- 同学端上报 ---------------- */

export interface ClientReport {
  app: boolean;
  conn: string;
  /** d：总耗时；s：服务器处理时间（读不到响应头时为 null） */
  samples: { d: number; s: number | null }[];
  fail: number;
  /** 网页打开到能用的时间 */
  page?: number;
}

export function recordClient(userId: number, r: ClientReport) {
  const m = bucket();
  m.cli += r.samples.length;
  m.cliFail += r.fail;
  if (r.page !== undefined) add(m.page, r.page);
  let u: UserStat | undefined;
  if (m.users) {
    u = m.users.get(userId);
    if (!u) m.users.set(userId, (u = { n: 0, fail: 0, net: newHist(), srv: newHist(), app: r.app, conn: r.conn }));
    u.fail += r.fail;
    u.app = r.app;
    if (r.conn) u.conn = r.conn;
  }
  for (const { d, s } of r.samples) {
    add(m.total, d);
    if (s === null) continue;
    const net = Math.max(0, d - s);
    add(m.net, net);
    if (u) {
      u.n++;
      add(u.net, net);
      add(u.srv, s);
    }
  }
}

/* ---------------- 系统采样 ---------------- */

const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();
function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  }
  return { idle, total };
}
let lastAt = performance.now();
let lastCpu = process.cpuUsage();
let lastSys = cpuTimes();
let lastElu: EventLoopUtilization = performance.eventLoopUtilization();
let current = { cpu: 0, sysCpu: 0, elu: 0, lagP99: 0, lagMax: 0, at: Date.now() };

function sample() {
  const nowAt = performance.now();
  const elapsed = nowAt - lastAt;
  const cpu = process.cpuUsage(lastCpu);
  const sys = cpuTimes();
  const elu = performance.eventLoopUtilization(lastElu);
  const totalDelta = sys.total - lastSys.total;
  current = {
    // 本进程占一个核的百分比（sharp 的线程也算在里面，所以可能超过 100）
    cpu: elapsed > 0 ? ((cpu.user + cpu.system) / 1000 / elapsed) * 100 : 0,
    // 整台机器（容器里看到的是宿主机，包括转码的 ffmpeg 和别的程序）
    sysCpu: totalDelta > 0 ? (1 - (sys.idle - lastSys.idle) / totalDelta) * 100 : 0,
    elu: elu.utilization * 100,
    lagP99: loop.percentile(99) / 1e6,
    lagMax: loop.max / 1e6,
    at: Date.now(),
  };
  loop.reset();
  lastAt = nowAt;
  lastCpu = process.cpuUsage();
  lastSys = sys;
  lastElu = performance.eventLoopUtilization();
  const m = bucket();
  m.ticks++;
  m.cpu += current.cpu;
  m.sysCpu += current.sysCpu;
  m.elu += current.elu;
  m.lagP99 = Math.max(m.lagP99, current.lagP99);
  m.lagMax = Math.max(m.lagMax, current.lagMax);
  m.rss = Math.max(m.rss, process.memoryUsage.rss());
}
setInterval(sample, 10_000).unref();

/* ---------------- 给后台看的汇总 ---------------- */

const r1 = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10);

export function loadSnapshot(rangeMinutes: number) {
  const nowMinute = minuteOf(Date.now());
  const series = [];
  for (let k = nowMinute - rangeMinutes + 1; k <= nowMinute; k++) {
    const m = minutes.get(k);
    series.push(m
      ? {
          t: m.t, req: m.req, err: m.err,
          srvP50: quantile(m.srv, 0.5), srvP95: quantile(m.srv, 0.95),
          cli: m.cli, cliFail: m.cliFail, totalP95: quantile(m.total, 0.95),
          netP50: quantile(m.net, 0.5), netP95: quantile(m.net, 0.95),
          db: Math.round(m.db),
          cpu: m.ticks ? r1(m.cpu / m.ticks) : null, sysCpu: m.ticks ? r1(m.sysCpu / m.ticks) : null,
          elu: m.ticks ? r1(m.elu / m.ticks) : null, lagP99: m.ticks ? r1(m.lagP99) : null,
          rss: m.rss || null,
        }
      : { t: k * 60_000 });
  }

  // 最近 15 分钟的汇总，判断用
  const recent = { req: 0, err: 0, cli: 0, cliFail: 0, db: 0, srv: newHist(), total: newHist(), net: newHist(), page: newHist() };
  const routes = new Map<string, RouteStat>();
  const users = new Map<number, UserStat>();
  for (const [k, m] of minutes) {
    if (k > nowMinute - 15) {
      recent.req += m.req;
      recent.err += m.err;
      recent.cli += m.cli;
      recent.cliFail += m.cliFail;
      recent.db += m.db;
      merge(recent.srv, m.srv);
      merge(recent.total, m.total);
      merge(recent.net, m.net);
      merge(recent.page, m.page);
      for (const [id, u] of m.users ?? []) {
        let x = users.get(id);
        if (!x) users.set(id, (x = { n: 0, fail: 0, net: newHist(), srv: newHist(), app: u.app, conn: u.conn }));
        x.n += u.n;
        x.fail += u.fail;
        merge(x.net, u.net);
        merge(x.srv, u.srv);
        x.app = u.app;
        if (u.conn) x.conn = u.conn;
      }
    }
    if (k > nowMinute - rangeMinutes && k > nowMinute - DETAIL_MINUTES) {
      for (const [key, r] of m.routes ?? []) {
        let x = routes.get(key);
        if (!x) routes.set(key, (x = { n: 0, err: 0, sum: 0, max: 0, hist: newHist() }));
        x.n += r.n;
        x.err += r.err;
        x.sum += r.sum;
        x.max = Math.max(x.max, r.max);
        merge(x.hist, r.hist);
      }
    }
  }
  const mem = process.memoryUsage();
  const reporting = [...users.values()].filter((u) => u.n >= 3);
  return {
    rangeMinutes,
    series,
    recent: {
      minutes: 15,
      req: recent.req, err: recent.err, cli: recent.cli, cliFail: recent.cliFail, db: Math.round(recent.db),
      srvP50: quantile(recent.srv, 0.5), srvP95: quantile(recent.srv, 0.95),
      totalP50: quantile(recent.total, 0.5), totalP95: quantile(recent.total, 0.95),
      netP50: quantile(recent.net, 0.5), netP95: quantile(recent.net, 0.95),
      pageN: count(recent.page), pageP50: quantile(recent.page, 0.5), pageP95: quantile(recent.page, 0.95),
      /** 上报过的同学，和其中网络中位数超过 300ms 的 */
      users: reporting.length,
      slowUsers: reporting.filter((u) => (quantile(u.net, 0.5) ?? 0) > 300).length,
    },
    now: {
      ...current,
      cpu: r1(current.cpu), sysCpu: r1(current.sysCpu), elu: r1(current.elu), lagP99: r1(current.lagP99), lagMax: r1(current.lagMax),
      inFlight: open.size,
      rss: mem.rss, heapUsed: mem.heapUsed,
      totalMem: os.totalmem(), freeMem: os.freemem(), cores: os.availableParallelism(), load: os.loadavg(),
      uptime: Math.round(process.uptime()), node: process.version,
    },
    routes: [...routes]
      .map(([route, r]) => ({ route, n: r.n, err: r.err, avg: Math.round(r.sum / r.n), p50: quantile(r.hist, 0.5), p95: quantile(r.hist, 0.95), max: Math.round(r.max), total: Math.round(r.sum) }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 20),
    users: [...users]
      .filter(([, u]) => u.n >= 3)
      .map(([id, u]) => ({ id, n: u.n, fail: u.fail, app: u.app, conn: u.conn, netP50: quantile(u.net, 0.5), netP95: quantile(u.net, 0.95), srvP50: quantile(u.srv, 0.5) }))
      .sort((a, b) => (b.netP50 ?? 0) - (a.netP50 ?? 0))
      .slice(0, 12),
    sql: [...sqlStats]
      .map(([sql, s]) => ({ sql: oneLine(sql), n: s.n, avg: r1(s.sum / s.n), max: r1(s.max), total: Math.round(s.sum) }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 12),
    slowQueries: slowQueries.map((q) => ({ ...q, ms: Math.round(q.ms) })),
    slowRequests,
  };
}
