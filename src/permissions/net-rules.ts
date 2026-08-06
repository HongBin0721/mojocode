/**
 * 联网工具(web_search / web_fetch)的域名规则判断。与 bash-rules 同为纯函数
 * 启发式层——真正的边界是用户对看到的 URL/query 做确认。
 *
 * 刻意不复用 bash-rules 的前缀匹配:那套语义是空格边界的 shell 前缀,套在
 * 域名上会把 `example.com.evil.net` 误判为命中 `example.com`。域名走
 * sandbox.ts 的 matchGlob——它锚定全匹配且转义 `.`,天然没有这个问题。
 *
 * 规则字符串(存放于 permissions.allowNet 与会话规则):
 * - `WebSearch`                      —— 放行搜索(打的是配置好的搜索后端 API,
 *                                       不是任意域名,所以是一条总闸)
 * - `WebFetch(domain:example.com)`   —— 放行抓取该域名
 * - `WebFetch(domain:*.example.com)` —— 放行任意深度子域(不含裸域,要两者写两条)
 * - 裸字符串                          —— 手编配置的宽容形式,视同 WebFetch 域名规则
 */

import { matchGlob } from './sandbox.js';

/** 放行搜索的总闸规则。 */
export const WEB_SEARCH_RULE = 'WebSearch';

/** 从 URL 提取规范化的 host。解析失败(不是 URL)返回 undefined。 */
export function hostOf(rawUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  // hostname 已不含端口;IPv6 带方括号,去掉;FQDN 末尾的 `.` 规范化掉。
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

/**
 * 域名 pattern 匹配。基于 matchGlob(锚定全匹配、`.` 转义、`*` 不跨 `/`):
 * - `example.com` 只匹配它自己——不匹配子域、`example.com.evil.net`、`evil-example.com`;
 * - `*.example.com` 匹配任意深度子域(hostname 不含 `/`,所以 `*` 可跨点,
 *   `a.b.example.com` 也命中——这是刻意行为),但不匹配裸 `example.com`。
 */
export function matchDomain(pattern: string, host: string): boolean {
  return matchGlob(pattern.toLowerCase(), host.toLowerCase());
}

/** 解析规则字符串里的域名 pattern。`WebSearch` 与空串返回 undefined。 */
export function ruleToDomain(rule: string): string | undefined {
  const trimmed = rule.trim();
  if (trimmed === WEB_SEARCH_RULE || trimmed === '') return undefined;
  const match = /^WebFetch\(domain:(.+)\)$/.exec(trimmed);
  if (match) return match[1]!.trim().toLowerCase();
  // 宽容:手编配置里的裸域名直接当 pattern 用。
  if (!trimmed.includes('(')) return trimmed.toLowerCase();
  return undefined;
}

/** 生成确认框里"总是允许"对应的规则。fetch 保守到精确 host,不建议通配。 */
export function suggestNetRule(
  target: { tool: 'web_search' } | { tool: 'web_fetch'; host: string },
): string {
  if (target.tool === 'web_search') return WEB_SEARCH_RULE;
  return `WebFetch(domain:${target.host})`;
}

/**
 * host 的网络位置分类:
 * - `loopback`:本机(localhost/127.x/::1)。允许走确认流程——抓本地 dev server
 *   是正当工作流,但不默认放行。
 * - `blocked`:私网、链路本地、云元数据(169.254.169.254)等。**硬拒,任何权限
 *   档位都不放行**——与 sandbox.ts 的路径硬约束同一哲学:模型不该有任何路径
 *   去内网探测,danger-full-access 也不豁免。
 * - `public`:其余,走正常规则/确认。
 */
export function classifyHost(host: string): 'public' | 'loopback' | 'blocked' {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return 'loopback';

  const v4 = parseIpv4(h);
  if (v4) return classifyIpv4(v4);

  if (h.includes(':')) return classifyIpv6(h);

  if (h.endsWith('.local') || h.endsWith('.internal')) return 'blocked';
  return 'public';
}

export type UrlVerdict =
  | { kind: 'invalid'; reason: string }
  | { kind: 'blocked'; reason: string }
  | { kind: 'allowed'; host: string; suggestedRule: string }
  | { kind: 'needs-approval'; host: string; suggestedRule: string };

/** web_fetch 的一站式判断:scheme → 私网 → allow 规则。 */
export function judgeUrl(rawUrl: string, allowRules: readonly string[]): UrlVerdict {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { kind: 'invalid', reason: `"${rawUrl}" is not a valid URL.` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { kind: 'invalid', reason: `Only http(s) URLs can be fetched, got "${url.protocol}//".` };
  }

  const host = hostOf(rawUrl)!;
  if (classifyHost(host) === 'blocked') {
    return {
      kind: 'blocked',
      reason:
        `Refused: ${host} is a private, link-local or internal address. ` +
        'Fetching internal network targets is never allowed.',
    };
  }

  const suggestedRule = suggestNetRule({ tool: 'web_fetch', host });
  for (const rule of allowRules) {
    const pattern = ruleToDomain(rule);
    if (pattern && matchDomain(pattern, host)) return { kind: 'allowed', host, suggestedRule };
  }
  return { kind: 'needs-approval', host, suggestedRule };
}

/**
 * 解析主机名并校验它指向的每个 IP。`classifyHost` 只看字面量,挡不住
 * `127.0.0.1.nip.io`、`localtest.me`、`internal.corp.example.com` 这类
 * "名字是公网形状、解析结果在内网"的地址——那是绕过私网硬拒最省事的办法。
 *
 * **对 DNS 名而言 loopback 也算内网**,与字面量的判法刻意不同:允许字面量
 * loopback 走确认,是因为用户看到 `localhost:3000` 就能自己判断;而
 * `localtest.me` 把本机地址藏在一个公网形状的名字后面,那份透明性没了,
 * 豁免的理由也就不成立。真要抓本机服务,直接写 localhost。
 *
 * 任何一条 A/AAAA 记录落在非公网段就整体拒绝(多条记录里混一条内网地址
 * 同样危险)。解析失败不在这里报错:交给真正的 fetch 去报 DNS 错误,那边的
 * 提示对模型更有用。
 *
 * 残余风险(已知并接受):这里解析一次、undici 连接时又解析一次,两次之间
 * 的 TOCTOU 窗口理论上可被 DNS rebinding 利用。堵死它要接管 undici 的
 * connect lookup;对一个跑在用户自己终端里、每个新域名还要人工确认的 CLI
 * 来说不成比例。
 */
export async function resolvesToInternal(
  host: string,
  lookup: (h: string) => Promise<string[]> = defaultLookup,
): Promise<string | undefined> {
  // 字面量 IP 已经由 classifyHost 判过,不必再走 DNS。
  if (parseIpv4(host) || host.includes(':')) return undefined;
  let addresses: string[];
  try {
    addresses = await lookup(host);
  } catch {
    return undefined;
  }
  return addresses.find((addr) => classifyHost(addr) !== 'public');
}

async function defaultLookup(host: string): Promise<string[]> {
  const { lookup } = await import('node:dns/promises');
  const entries = await lookup(host, { all: true });
  return entries.map((e) => e.address);
}

/** 四段整数式 IPv4 解析。非 IPv4 形状返回 undefined。 */
function parseIpv4(host: string): number[] | undefined {
  const parts = host.split('.');
  if (parts.length !== 4) return undefined;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const n = Number(part);
    if (n > 255) return undefined;
    nums.push(n);
  }
  return nums;
}

function classifyIpv4([a, b]: number[]): 'public' | 'loopback' | 'blocked' {
  if (a === 127) return 'loopback';
  if (a === 10) return 'blocked'; // 10/8
  if (a === 172 && b! >= 16 && b! <= 31) return 'blocked'; // 172.16/12
  if (a === 192 && b === 168) return 'blocked'; // 192.168/16
  if (a === 169 && b === 254) return 'blocked'; // 链路本地,含云元数据 169.254.169.254
  if (a === 100 && b! >= 64 && b! <= 127) return 'blocked'; // CGNAT 100.64/10
  if (a === 0) return 'blocked'; // 0.0.0.0/8
  return 'public';
}

/**
 * IPv6 分类。**必须真正解析成 8 组 hextet,不能按字面前缀匹配**:WHATWG URL
 * 会把地址规范化成压缩十六进制形式,`http://[::ffff:169.254.169.254]/` 的
 * hostname 是 `::ffff:a9fe:a9fe`——按点分十进制写的正则永远匹配不到,云元数据
 * 地址就会被判成 public 放过去。
 *
 * 解析失败(未知形状、带 zone id 等)一律 blocked:拦错一个冷门地址,好过
 * 放过一个内网地址。
 */
function classifyIpv6(host: string): 'public' | 'loopback' | 'blocked' {
  const hextets = parseIpv6(host.toLowerCase());
  if (!hextets) return 'blocked';

  const leadingZero = hextets.slice(0, 5).every((h) => h === 0);
  const allZero = hextets.every((h) => h === 0);

  if (allZero) return 'blocked'; // ::
  if (leadingZero && hextets[5] === 0 && hextets[6] === 0 && hextets[7] === 1) return 'loopback'; // ::1

  // 内嵌 IPv4 的三种形态,一律按内层 IPv4 判——否则 ::ffff:a9fe:a9fe 这类
  // 写法就是绕过私网硬拒的直通车。
  const embedded =
    (leadingZero && hextets[5] === 0xffff) || // IPv4-mapped   ::ffff:a.b.c.d
    (leadingZero && hextets[5] === 0) || // IPv4-compatible ::a.b.c.d(已废弃但仍可解析)
    (hextets[0] === 0x64 && hextets[1] === 0xff9b && hextets.slice(2, 6).every((h) => h === 0)); // NAT64 64:ff9b::/96
  if (embedded) {
    const [a, b] = [hextets[6]!, hextets[7]!];
    return classifyIpv4([a >> 8, a & 0xff, b >> 8, b & 0xff]);
  }

  if ((hextets[0]! & 0xfe00) === 0xfc00) return 'blocked'; // ULA fc00::/7
  if ((hextets[0]! & 0xffc0) === 0xfe80) return 'blocked'; // 链路本地 fe80::/10
  return 'public';
}

/** 把 IPv6 文本展开成 8 组 16 位整数。无法解析返回 undefined(调用方按 blocked 处理)。 */
function parseIpv6(text: string): number[] | undefined {
  if (text.includes('%')) return undefined; // 带 zone id,不解析
  const halves = text.split('::');
  if (halves.length > 2) return undefined;

  const expand = (part: string): number[] | undefined => {
    if (part === '') return [];
    const groups: number[] = [];
    for (const g of part.split(':')) {
      // 末组可以是点分十进制(::ffff:1.2.3.4),展开成两个 hextet。
      if (g.includes('.')) {
        const v4 = parseIpv4(g);
        if (!v4) return undefined;
        groups.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(g)) return undefined;
      groups.push(parseInt(g, 16));
    }
    return groups;
  };

  const head = expand(halves[0]!);
  const tail = halves.length === 2 ? expand(halves[1]!) : [];
  if (!head || !tail) return undefined;

  if (halves.length === 1) return head.length === 8 ? head : undefined;
  const gap = 8 - head.length - tail.length;
  if (gap < 1) return undefined; // `::` 至少代表一组零
  return [...head, ...Array(gap).fill(0), ...tail];
}
