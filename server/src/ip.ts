/** 内网、本机地址（反代连过来的地址就是这种） */
export function isPrivateIp(ip: string | undefined) {
  if (!ip) return true;
  let s = ip.trim().toLowerCase();
  if (s.startsWith('::ffff:') && s.includes('.')) s = s.slice(7);
  if (s.includes(':')) return s === '::1' || /^(fc|fd|fe[89ab])/.test(s);
  const [a, b] = s.split('.').map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

/**
 * 反代后面怎么认真实 IP。hops 是信任几层代理（TRUST_PROXY 的值）：
 * X-Forwarded-For 从右往左数，最右边是离我们最近的那层代理写的，用户自己在请求里伪造的在最左边，不会被当真。
 * 直接连进来的必须是本机或内网地址（Nginx、Docker 网关），否则不信任任何转发头：3000 端口被直接访问时也伪造不了
 */
export function trustProxyFn(hops: number) {
  return (addr: string, i: number) => i < hops && (i > 0 || isPrivateIp(addr));
}
