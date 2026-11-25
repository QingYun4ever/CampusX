/**
 * 管理后台「负载」：分清卡顿是服务器慢还是网络慢。
 * 服务器处理时间 = 收完请求到开始回包；网络 = 同学那边看到的总时间 − 服务器处理时间（包括反代、TLS、传输）。
 * 数据只在服务器内存里，重启清零。
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, CircleAlert, CircleCheck, TriangleAlert } from 'lucide-react';
import { api } from '../lib/api';
import { PostSkeleton } from '../components/ui';
import './admin-load.css';

type N = number | null;
interface Minute {
  t: number;
  req?: number;
  err?: number;
  srvP50?: N;
  srvP95?: N;
  cli?: number;
  cliFail?: number;
  totalP95?: N;
  netP50?: N;
  netP95?: N;
  db?: number;
  cpu?: N;
  sysCpu?: N;
  elu?: N;
  lagP99?: N;
  rss?: N;
}
interface LoadData {
  rangeMinutes: number;
  series: Minute[];
  recent: {
    minutes: number;
    req: number; err: number; cli: number; cliFail: number; db: number;
    srvP50: N; srvP95: N; totalP50: N; totalP95: N; netP50: N; netP95: N;
    pageN: number; pageP50: N; pageP95: N;
    users: number; slowUsers: number;
  };
  now: {
    cpu: N; sysCpu: N; elu: N; lagP99: N; lagMax: N; at: number; inFlight: number;
    rss: number; heapUsed: number; totalMem: number; freeMem: number; cores: number; load: number[];
    uptime: number; node: string;
  };
  routes: { route: string; n: number; err: number; avg: number; p50: N; p95: N; max: number; total: number }[];
  users: { id: number; username: string; displayName: string; n: number; fail: number; app: boolean; conn: string; netP50: N; netP95: N; srvP50: N }[];
  sql: { sql: string; n: number; avg: N; max: N; total: number }[];
  slowQueries: { at: number; ms: number; sql: string }[];
  slowRequests: { at: number; route: string; ms: number; status: number }[];
  queues: { queued: number; running: number; moderation: number };
  dbBytes: number;
  /** 对象存储；没启用时是 null */
  media: null | {
    objects: number; bytes: number; maxBytes: number;
    monthBytes: number; monthRedirects: number; monthlyBytes: number;
    overStorage: boolean; overTraffic: boolean; paused: boolean;
    queued: number; active: number; failed: number; lastError: string; lastErrorAt: number;
    backfill: { total: number; done: number; running: boolean };
  };
}

/** 对象存储那一格：存了多少、本月流量（按跳转次数估算）、补传进度和最近的错误 */
function mediaTile(m: LoadData['media']): [string, string, string?, Tone?] {
  if (!m) return ['对象存储', '未启用', '图片和视频由服务器直出'];
  const notes = [`本月约 ${fmtBytes(m.monthBytes)} / ${fmtBytes(m.monthlyBytes)} 流量`];
  if (m.backfill.running) notes.push(`补传 ${m.backfill.done} / ${m.backfill.total}`);
  else if (m.queued + m.active) notes.push(`待上传 ${m.queued + m.active}`);
  if (m.overTraffic) notes.push('超过月流量上限，已改回服务器直出');
  if (m.overStorage) notes.push('存储满了，新文件不再上传');
  if (m.paused) notes.push('上传连续失败，暂停中');
  const recentError = m.lastError && Date.now() - m.lastErrorAt < 3600_000;
  if (recentError) notes.push(`最近出错：${m.lastError}`);
  return ['对象存储', `${m.objects} 个 · ${fmtBytes(m.bytes)}`, notes.join(' · '), m.overTraffic || m.overStorage || m.paused ? 'bad' : recentError ? 'warn' : undefined];
}

const fmtMs = (v: N | undefined) => (v === null || v === undefined ? '—' : v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(v < 10_000 ? 1 : 0)} s`);
const fmtPct = (v: N | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v)}%`);
const fmtBytes = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`);
const hhmm = (t: number) => new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
const clock = (t: number) => new Date(t).toLocaleTimeString('zh-CN', { hour12: false });
function fmtUptime(s: number) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d} 天 ${h} 小时` : h ? `${h} 小时 ${m} 分` : `${m} 分钟`;
}

/* ---------------- 判断 ---------------- */

type Tone = 'ok' | 'warn' | 'bad';
function diagnose(d: LoadData): { tone: Tone; title: string; lines: ReactNode[] } {
  const { recent: r, now: n } = d;
  const busy: string[] = [];
  if ((n.lagP99 ?? 0) > 100) busy.push(`事件循环最近卡顿到 ${fmtMs(n.lagP99)}：有同步的重活（大查询、图片处理）在跑，这期间所有请求都在排队。`);
  if ((n.sysCpu ?? 0) > 85) busy.push(`整台机器 CPU ${fmtPct(n.sysCpu)}，可能是转码视频或别的程序占着。`);
  if ((n.cpu ?? 0) > 90) busy.push(`校墙进程 CPU ${fmtPct(n.cpu)}。`);
  if ((r.srvP95 ?? 0) > 800) busy.push(`最近 ${r.minutes} 分钟，最慢的 5% 请求服务器要处理 ${fmtMs(r.srvP95)}，看下面「最耗时的接口」。`);
  if (n.freeMem / n.totalMem < 0.05) busy.push(`内存只剩 ${fmtBytes(n.freeMem)}。`);
  if (busy.length) return { tone: 'bad', title: '服务器偏忙', lines: busy };

  if (!r.cli) {
    return {
      tone: 'warn',
      title: '服务器不忙，还没有同学端的数据',
      lines: [
        `服务器处理请求中位数 ${fmtMs(r.srvP50)}，最慢的 5% 是 ${fmtMs(r.srvP95)}，事件循环延迟 ${fmtMs(n.lagP99)}，服务器这边没问题。`,
        '同学端每分钟上报一次请求耗时：网页刷新后就有，App 要更新到 0.21.0。有数据之后这里会判断是不是网络慢。',
      ],
    };
  }
  const net50 = r.netP50 ?? 0;
  const net95 = r.netP95 ?? 0;
  const failRate = r.cliFail / Math.max(1, r.cli + r.cliFail);
  const netLines: ReactNode[] = [
    `最近 ${r.minutes} 分钟同学那边请求中位数 ${fmtMs(r.totalP50)}，其中服务器处理只用了 ${fmtMs(r.srvP50)}，网络（含反代）约 ${fmtMs(r.netP50)}；最慢的 5%：网络 ${fmtMs(r.netP95)}，服务器 ${fmtMs(r.srvP95)}。`,
  ];
  if (failRate > 0.02) netLines.push(`有 ${Math.round(failRate * 100)}% 的请求根本没连上（${r.cliFail} 次）。`);
  if (net50 > 300 || net95 > 1500 || failRate > 0.05) {
    if (r.users >= 3 && r.slowUsers <= r.users / 3) {
      netLines.push(`上报的 ${r.users} 位同学里只有 ${r.slowUsers} 位网络慢，多半是他们自己的网络（看下面的名单）。`);
    } else if (r.users >= 3) {
      netLines.push(`上报的 ${r.users} 位同学里有 ${r.slowUsers} 位网络慢，大家都慢：可能是服务器的出口带宽、线路或反代。`);
    }
    return { tone: 'warn', title: '慢在网络，不在服务器', lines: netLines };
  }
  return { tone: 'ok', title: '服务器和网络都正常', lines: netLines };
}

/* ---------------- 折线图 ---------------- */

interface Series {
  name: string;
  /** CSS 颜色变量 */
  color: string;
  values: N[];
}

function niceMax(v: number, floor: number) {
  const x = Math.max(v, floor);
  const p = 10 ** Math.floor(Math.log10(x));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= x) return m * p;
  return 10 * p;
}

function LineChart({ title, sub, times, series, fmt, floor, extra }: {
  title: string;
  sub?: string;
  times: number[];
  series: Series[];
  fmt: (v: N) => string;
  /** 纵轴最小的上限，没什么数据时不至于把噪声放大 */
  floor: number;
  /** 提示框里额外显示的一行（比如请求数） */
  extra?: (i: number) => string | null;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    setW(Math.max(240, Math.round(el.clientWidth)));
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const H = 180;
  const pad = { l: 48, r: series.length > 1 ? 64 : 16, t: 10, b: 22 };
  const iw = w - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const max = niceMax(Math.max(0, ...series.flatMap((s) => s.values.filter((v): v is number => v !== null))), floor);
  const n = times.length;
  const x = (i: number) => pad.l + (n > 1 ? (i / (n - 1)) * iw : iw / 2);
  const y = (v: number) => pad.t + ih - (Math.min(v, max) / max) * ih;
  const path = (vals: N[]) => {
    let d = '';
    let pen = false;
    vals.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  // 线尾的名字，挤在一起时上下错开
  const ends = series
    .map((s) => {
      let i = s.values.length - 1;
      while (i >= 0 && s.values[i] === null) i--;
      return { s, i, y: i >= 0 ? y(s.values[i]!) : null };
    })
    .filter((e): e is { s: Series; i: number; y: number } => e.y !== null)
    .sort((a, b) => a.y - b.y);
  for (let k = 1; k < ends.length; k++) if (ends[k].y - ends[k - 1].y < 14) ends[k].y = ends[k - 1].y + 14;

  const pick = (clientX: number) => {
    const el = wrap.current;
    if (!el || n < 1) return;
    const rx = clientX - el.getBoundingClientRect().left;
    const i = Math.round(((rx - pad.l) / iw) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };
  const xTicks = n > 1 ? [0, Math.floor((n - 1) / 2), n - 1] : [0];
  const hasData = series.some((s) => s.values.some((v) => v !== null));
  const tipLeft = hover === null ? 0 : x(hover) > w / 2 ? x(hover) - 12 : x(hover) + 12;

  return (
    <figure className="load-chart">
      <figcaption>
        <h3>{title}</h3>
        {sub && <p className="muted small">{sub}</p>}
        {series.length > 1 && (
          <ul className="load-legend">
            {series.map((s) => (
              <li key={s.name}><i style={{ background: s.color }} />{s.name}</li>
            ))}
          </ul>
        )}
      </figcaption>
      <div
        ref={wrap}
        className="load-plot"
        onPointerMove={(e) => pick(e.clientX)}
        onPointerDown={(e) => pick(e.clientX)}
        // 手指抬起也会触发 leave：触屏上提示留着，点别处再换
        onPointerLeave={(e) => e.pointerType === 'mouse' && setHover(null)}
      >
        <svg width={w} height={H} role="img" aria-label={title}>
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line className="grid" x1={pad.l} x2={pad.l + iw} y1={pad.t + ih - f * ih} y2={pad.t + ih - f * ih} />
              <text className="axis" x={pad.l - 6} y={pad.t + ih - f * ih + 4} textAnchor="end">{fmt(max * f)}</text>
            </g>
          ))}
          {xTicks.map((i) => (
            <text key={i} className="axis" x={x(i)} y={H - 4} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}>
              {times[i] !== undefined ? hhmm(times[i]) : ''}
            </text>
          ))}
          {series.map((s) => (
            <g key={s.name}>
              <path d={path(s.values)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {/* 前后都没数据的点连不成线，画成小圆点 */}
              {s.values.map((v, i) => v !== null && s.values[i - 1] == null && s.values[i + 1] == null && (
                <circle key={i} cx={x(i)} cy={y(v)} r={2.5} fill={s.color} />
              ))}
            </g>
          ))}
          {series.length > 1 && ends.map((e) => (
            <text key={e.s.name} className="end-label" x={pad.l + iw + 6} y={e.y + 4}>{e.s.name}</text>
          ))}
          {hover !== null && (
            <g>
              <line className="crosshair" x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + ih} />
              {series.map((s) => s.values[hover] !== null && (
                <circle key={s.name} cx={x(hover)} cy={y(s.values[hover]!)} r={4.5} fill={s.color} className="dot" />
              ))}
            </g>
          )}
          {!hasData && <text className="axis" x={pad.l + iw / 2} y={pad.t + ih / 2} textAnchor="middle">这段时间还没有数据</text>}
        </svg>
        {hover !== null && times[hover] !== undefined && (
          <div className="load-tip" style={{ left: tipLeft, transform: x(hover) > w / 2 ? 'translateX(-100%)' : undefined }}>
            <div className="muted">{hhmm(times[hover])}</div>
            {series.map((s) => (
              <div key={s.name} className="row"><i style={{ background: s.color }} /><b>{fmt(s.values[hover])}</b> {s.name}</div>
            ))}
            {extra?.(hover) && <div className="muted">{extra(hover)}</div>}
          </div>
        )}
      </div>
    </figure>
  );
}

/* ---------------- 页面 ---------------- */

export function LoadAdminPage({ head }: { head: (right: ReactNode) => ReactNode }) {
  const [range, setRange] = useState<60 | 360>(60);
  const q = useQuery({
    queryKey: ['admin-load', range],
    queryFn: () => api<LoadData>(`/admin/load?range=${range}`),
    refetchInterval: 10_000,
    placeholderData: (prev) => prev,
  });
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const right = (
    <div className="seg">
      {([60, 360] as const).map((r) => (
        <button key={r} className={range === r ? 'on' : ''} onClick={() => setRange(r)}>{r === 60 ? '1 小时' : '6 小时'}</button>
      ))}
    </div>
  );
  const d = q.data;
  if (!d) return <>{head(right)}<PostSkeleton n={2} /></>;
  const verdict = diagnose(d);
  const times = d.series.map((m) => m.t);
  const col = <K extends keyof Minute>(k: K) => d.series.map((m) => (m[k] ?? null) as N);
  const r = d.recent;
  const tiles: [string, string, string?, Tone?][] = [
    ['服务器处理', fmtMs(r.srvP50), `最慢 5%：${fmtMs(r.srvP95)}`, (r.srvP95 ?? 0) > 800 ? 'bad' : undefined],
    ['同学端网络', fmtMs(r.netP50), r.cli ? `最慢 5%：${fmtMs(r.netP95)}` : '还没有上报', (r.netP50 ?? 0) > 300 ? 'warn' : undefined],
    ['事件循环延迟', fmtMs(d.now.lagP99), `最长 ${fmtMs(d.now.lagMax)}`, (d.now.lagP99 ?? 0) > 100 ? 'bad' : undefined],
    ['CPU（校墙 / 整机）', `${fmtPct(d.now.cpu)} / ${fmtPct(d.now.sysCpu)}`, `${d.now.cores} 核 · 负载 ${d.now.load.map((x) => x.toFixed(1)).join(' ')}`, (d.now.sysCpu ?? 0) > 85 ? 'bad' : undefined],
    ['每分钟请求', String(Math.round(r.req / r.minutes)), `正在处理 ${d.now.inFlight} 个${r.err ? ` · 出错 ${r.err}` : ''}`, r.err ? 'warn' : undefined],
    ['内存', fmtBytes(d.now.rss), `整机剩 ${fmtBytes(d.now.freeMem)} / ${fmtBytes(d.now.totalMem)}`, d.now.freeMem / d.now.totalMem < 0.05 ? 'bad' : undefined],
    ['排队', `${d.queues.moderation} / ${d.queues.queued + d.queues.running}`, '待审帖子 / 视频转码', undefined],
    mediaTile(d.media),
    ['网页打开', fmtMs(r.pageP50), r.pageN ? `最慢 5%：${fmtMs(r.pageP95)} · ${r.pageN} 次` : '网页版刷新后才有', (r.pageP50 ?? 0) > 4000 ? 'warn' : undefined],
  ];
  const Icon = verdict.tone === 'ok' ? CircleCheck : verdict.tone === 'warn' ? TriangleAlert : CircleAlert;

  return (
    <div className="load-page">
      {head(right)}
      <div className={`load-verdict ${verdict.tone}`}>
        <Icon size={20} aria-hidden />
        <div>
          <b>{verdict.title}</b>
          {verdict.lines.map((l, i) => <p key={i}>{l}</p>)}
        </div>
      </div>

      <div className="stat-grid load-tiles">
        {tiles.map(([label, value, delta, tone], i) => (
          <div key={label} className={`stat-tile enter ${tone ?? ''}`} style={{ '--i': i } as CSSProperties}>
            <span className="muted">{label}</span>
            <b>{value}</b>
            {delta && <span className="muted small">{delta}</span>}
          </div>
        ))}
      </div>
      <p className="muted small load-foot">
        <Activity size={13} aria-hidden /> 最近 {r.minutes} 分钟 · 每 10 秒刷新 · 服务器已运行 {fmtUptime(d.now.uptime)}，重启后统计清零 · 数据库 {fmtBytes(d.dbBytes)} · Node {d.now.node} · 更新于 {clock(d.now.at)}
      </p>

      <div className="load-charts">
        <LineChart
          title="响应时间（最慢的 5%）"
          sub="服务器处理：收完请求到开始回包；网络：同学那边等的总时间减去服务器处理，包括反代和传输"
          times={times}
          series={[
            { name: '服务器处理', color: 'var(--series-1)', values: col('srvP95') },
            { name: '网络', color: 'var(--series-2)', values: col('netP95') },
          ]}
          fmt={fmtMs}
          floor={200}
          extra={(i) => (d.series[i].req ? `${d.series[i].req} 个请求${d.series[i].cli ? ` · 同学上报 ${d.series[i].cli} 个` : ''}` : null)}
        />
        <LineChart
          title="CPU"
          sub="校墙进程占一个核的百分比（图片处理的线程也算在内，可能超过 100%）；整机包括转码和别的程序"
          times={times}
          series={[
            { name: '校墙进程', color: 'var(--series-1)', values: col('cpu') },
            { name: '整机', color: 'var(--series-2)', values: col('sysCpu') },
          ]}
          fmt={fmtPct}
          floor={50}
        />
        <LineChart
          title="事件循环延迟（每分钟最高）"
          sub="Node 只有一个主线程，同步的重活（大查询、压图）会让所有请求一起等；超过 100 ms 就能感觉到卡"
          times={times}
          series={[{ name: '延迟', color: 'var(--series-1)', values: col('lagP99') }]}
          fmt={fmtMs}
          floor={50}
        />
      </div>

      <details className="load-raw">
        <summary>按分钟看数据</summary>
        <div className="load-table-wrap">
          <table className="load-table">
            <thead>
              <tr><th>时间</th><th>请求</th><th>服务器 p50 / p95</th><th>网络 p50 / p95</th><th>CPU</th><th>延迟</th><th>SQL 耗时</th></tr>
            </thead>
            <tbody>
              {[...d.series].reverse().filter((m) => m.req || m.cpu != null || m.cli).slice(0, 120).map((m) => (
                <tr key={m.t}>
                  <td>{hhmm(m.t)}</td>
                  <td>{m.req ?? 0}{m.err ? ` (${m.err} 错)` : ''}</td>
                  <td>{fmtMs(m.srvP50)} / {fmtMs(m.srvP95)}</td>
                  <td>{fmtMs(m.netP50)} / {fmtMs(m.netP95)}</td>
                  <td>{fmtPct(m.cpu)} / {fmtPct(m.sysCpu)}</td>
                  <td>{fmtMs(m.lagP99)}</td>
                  <td>{fmtMs(m.db ?? null)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <h2 className="admin-h2">最耗时的接口</h2>
      <p className="muted small">最近 {Math.min(range, 60)} 分钟，按服务器花的总时间排，次数多的慢接口最拖累大家</p>
      <div className="load-table-wrap">
        <table className="load-table">
          <thead>
            <tr><th>接口</th><th>次数</th><th>中位数</th><th>最慢 5%</th><th>最长</th><th>总共</th></tr>
          </thead>
          <tbody>
            {d.routes.map((x) => (
              <tr key={x.route} className={(x.p95 ?? 0) > 1000 ? 'slow' : ''}>
                <td className="mono-cell">{x.route}{x.err ? <span className="load-err"> {x.err} 次出错</span> : null}</td>
                <td>{x.n}</td>
                <td>{fmtMs(x.p50)}</td>
                <td>{fmtMs(x.p95)}</td>
                <td>{fmtMs(x.max)}</td>
                <td>{fmtMs(x.total)}</td>
              </tr>
            ))}
            {!d.routes.length && <tr><td colSpan={6} className="muted">还没有请求</td></tr>}
          </tbody>
        </table>
      </div>

      <h2 className="admin-h2">网络最慢的同学</h2>
      <p className="muted small">最近 {r.minutes} 分钟，至少上报过 3 个请求的；只有个别人慢，多半是他们自己的网络</p>
      <div className="load-table-wrap">
        <table className="load-table">
          <thead>
            <tr><th>同学</th><th>客户端</th><th>网络中位数</th><th>最慢 5%</th><th>服务器</th><th>请求</th></tr>
          </thead>
          <tbody>
            {d.users.map((u) => (
              <tr key={u.id} className={(u.netP50 ?? 0) > 300 ? 'slow' : ''}>
                <td>{u.displayName || u.username} <span className="muted">@{u.username}</span></td>
                <td>{u.app ? 'App' : '网页'}{u.conn ? ` · ${u.conn}` : ''}</td>
                <td>{fmtMs(u.netP50)}</td>
                <td>{fmtMs(u.netP95)}</td>
                <td>{fmtMs(u.srvP50)}</td>
                <td>{u.n}{u.fail ? <span className="load-err"> 失败 {u.fail}</span> : null}</td>
              </tr>
            ))}
            {!d.users.length && <tr><td colSpan={6} className="muted">还没有同学上报</td></tr>}
          </tbody>
        </table>
      </div>

      <h2 className="admin-h2">数据库</h2>
      <p className="muted small">SQLite 是同步执行的，一条慢查询会让所有请求一起等。下面是服务器启动以来花时间最多的 SQL</p>
      <div className="load-table-wrap">
        <table className="load-table">
          <thead>
            <tr><th>SQL</th><th>次数</th><th>平均</th><th>最长</th><th>总共</th></tr>
          </thead>
          <tbody>
            {d.sql.map((x) => (
              <tr key={x.sql} className={(x.avg ?? 0) > 50 ? 'slow' : ''}>
                <td className="mono-cell sql" title={x.sql}>{x.sql}</td>
                <td>{x.n}</td>
                <td>{fmtMs(x.avg)}</td>
                <td>{fmtMs(x.max)}</td>
                <td>{fmtMs(x.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="load-logs">
        <section>
          <h2 className="admin-h2">最近的慢请求</h2>
          <p className="muted small">服务器处理超过 1 秒的</p>
          {d.slowRequests.length ? (
            <ul className="load-log">
              {d.slowRequests.map((x, i) => (
                <li key={i}><span className="muted">{clock(x.at)}</span> <b>{fmtMs(x.ms)}</b> <code>{x.route}</code>{x.status >= 400 ? <span className="load-err"> {x.status}</span> : null}</li>
              ))}
            </ul>
          ) : <p className="muted">没有</p>}
        </section>
        <section>
          <h2 className="admin-h2">最近的慢查询</h2>
          <p className="muted small">超过 100 ms 的</p>
          {d.slowQueries.length ? (
            <ul className="load-log">
              {d.slowQueries.map((x, i) => (
                <li key={i}><span className="muted">{clock(x.at)}</span> <b>{fmtMs(x.ms)}</b> <code title={x.sql}>{x.sql}</code></li>
              ))}
            </ul>
          ) : <p className="muted">没有</p>}
        </section>
      </div>
    </div>
  );
}
