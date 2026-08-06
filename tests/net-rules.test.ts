import { describe, expect, it } from 'vitest';
import {
  classifyHost,
  hostOf,
  judgeUrl,
  matchDomain,
  ruleToDomain,
  resolvesToInternal,
  suggestNetRule,
  WEB_SEARCH_RULE,
} from '../src/permissions/net-rules.js';

describe('hostOf', () => {
  it('提取小写 host,去端口、去尾点、IPv6 去方括号', () => {
    expect(hostOf('https://Example.COM:8443/path?q=1')).toBe('example.com');
    expect(hostOf('https://example.com./x')).toBe('example.com');
    expect(hostOf('http://[::1]:3000/')).toBe('::1');
  });

  it('非 URL 返回 undefined', () => {
    expect(hostOf('not a url')).toBeUndefined();
  });
});

describe('matchDomain', () => {
  it('裸域名只匹配自身——不匹配 evil 后缀、前缀或子域', () => {
    expect(matchDomain('example.com', 'example.com')).toBe(true);
    expect(matchDomain('example.com', 'example.com.evil.net')).toBe(false);
    expect(matchDomain('example.com', 'evil-example.com')).toBe(false);
    expect(matchDomain('example.com', 'sub.example.com')).toBe(false);
    // `.` 必须按字面匹配,不能当正则通配符
    expect(matchDomain('example.com', 'exampleXcom')).toBe(false);
  });

  it('*.example.com 匹配任意深度子域,不匹配裸域', () => {
    expect(matchDomain('*.example.com', 'a.example.com')).toBe(true);
    expect(matchDomain('*.example.com', 'a.b.example.com')).toBe(true);
    expect(matchDomain('*.example.com', 'example.com')).toBe(false);
    expect(matchDomain('*.example.com', 'aexample.com')).toBe(false);
  });

  it('大小写不敏感', () => {
    expect(matchDomain('Example.COM', 'example.com')).toBe(true);
  });
});

describe('ruleToDomain', () => {
  it('解析 WebFetch(domain:x);WebSearch 与空串返回 undefined', () => {
    expect(ruleToDomain('WebFetch(domain:example.com)')).toBe('example.com');
    expect(ruleToDomain('WebFetch(domain:*.example.com)')).toBe('*.example.com');
    expect(ruleToDomain(WEB_SEARCH_RULE)).toBeUndefined();
    expect(ruleToDomain('')).toBeUndefined();
  });

  it('裸域名宽容当作 pattern;其它带括号的形状不认', () => {
    expect(ruleToDomain('example.com')).toBe('example.com');
    expect(ruleToDomain('Bash(git:*)')).toBeUndefined();
  });
});

describe('suggestNetRule', () => {
  it('search 建议总闸,fetch 建议精确 host', () => {
    expect(suggestNetRule({ tool: 'web_search' })).toBe('WebSearch');
    expect(suggestNetRule({ tool: 'web_fetch', host: 'docs.foo.dev' })).toBe(
      'WebFetch(domain:docs.foo.dev)',
    );
  });
});

describe('classifyHost', () => {
  it('loopback:localhost 与 127.x 与 ::1', () => {
    expect(classifyHost('localhost')).toBe('loopback');
    expect(classifyHost('app.localhost')).toBe('loopback');
    expect(classifyHost('127.0.0.1')).toBe('loopback');
    expect(classifyHost('127.8.9.10')).toBe('loopback');
    expect(classifyHost('::1')).toBe('loopback');
  });

  it('blocked:私网、链路本地、云元数据、CGNAT、内部主机名', () => {
    expect(classifyHost('10.0.0.1')).toBe('blocked');
    expect(classifyHost('172.16.0.1')).toBe('blocked');
    expect(classifyHost('172.31.255.255')).toBe('blocked');
    expect(classifyHost('192.168.1.1')).toBe('blocked');
    expect(classifyHost('169.254.169.254')).toBe('blocked');
    expect(classifyHost('100.64.0.1')).toBe('blocked');
    expect(classifyHost('0.0.0.0')).toBe('blocked');
    expect(classifyHost('fd12::1')).toBe('blocked');
    expect(classifyHost('fe80::1')).toBe('blocked');
    expect(classifyHost('::ffff:192.168.1.1')).toBe('blocked');
    expect(classifyHost('printer.local')).toBe('blocked');
    expect(classifyHost('db.internal')).toBe('blocked');
  });

  // 回归:`new URL()` 会把内嵌 IPv4 规范化成压缩十六进制,按点分十进制写的
  // 正则永远匹配不到——`::ffff:169.254.169.254` 曾因此被判成 public 放行。
  // 这里断言的是 hostOf 真正产出的形式,不是解析器从不产生的写法。
  it('内嵌 IPv4 的十六进制形式(URL 解析器的真实输出)照样 blocked', () => {
    const hexOf = (u: string) => hostOf(u)!;
    expect(hexOf('http://[::ffff:169.254.169.254]/')).toBe('::ffff:a9fe:a9fe'); // 前提成立
    expect(classifyHost(hexOf('http://[::ffff:169.254.169.254]/'))).toBe('blocked'); // 云元数据
    expect(classifyHost(hexOf('http://[::ffff:192.168.1.1]/'))).toBe('blocked');
    expect(classifyHost(hexOf('http://[::ffff:10.0.0.1]/'))).toBe('blocked');
    expect(classifyHost(hexOf('http://[::7f00:1]/'))).toBe('loopback'); // IPv4-compatible ::127.0.0.1
    expect(classifyHost('64:ff9b::a9fe:a9fe')).toBe('blocked'); // NAT64 包裹的元数据地址
    // 内嵌的公网 IPv4 仍应放行,别一刀切
    expect(classifyHost(hexOf('http://[::ffff:8.8.8.8]/'))).toBe('public');
  });

  it('IPv6 解析失败一律 blocked(宁可拦错也不放过内网)', () => {
    expect(classifyHost('::ffff:1:2:3:4:5:6:7')).toBe('blocked'); // 组数超限
    expect(classifyHost('1::2::3')).toBe('blocked'); // 两个 ::
    expect(classifyHost('fe80::1%eth0')).toBe('blocked'); // 带 zone id
    expect(classifyHost('gggg::1')).toBe('blocked'); // 非十六进制
  });

  it('压缩写法的公网 IPv6 正常放行', () => {
    expect(classifyHost('2606:4700::1111')).toBe('public');
    expect(classifyHost('2001:db8:0:0:0:0:0:1')).toBe('public');
  });

  it('public:公网域名与 IP,含边界值', () => {
    expect(classifyHost('example.com')).toBe('public');
    expect(classifyHost('8.8.8.8')).toBe('public');
    expect(classifyHost('172.15.0.1')).toBe('public'); // 172.16/12 下边界外
    expect(classifyHost('172.32.0.1')).toBe('public'); // 上边界外
    expect(classifyHost('100.63.0.1')).toBe('public');
    expect(classifyHost('2606:4700::1111')).toBe('public');
  });
});

describe('judgeUrl', () => {
  it('非 http(s) 与非 URL 判 invalid', () => {
    expect(judgeUrl('ftp://example.com/x', []).kind).toBe('invalid');
    expect(judgeUrl('file:///etc/passwd', []).kind).toBe('invalid');
    expect(judgeUrl('nonsense', []).kind).toBe('invalid');
  });

  it('私网判 blocked,不看 allow 规则', () => {
    const verdict = judgeUrl('http://192.168.1.1/admin', ['WebFetch(domain:192.168.1.1)']);
    expect(verdict.kind).toBe('blocked');
  });

  it('规则命中判 allowed,未命中判 needs-approval 并带建议规则', () => {
    expect(judgeUrl('https://docs.foo.dev/a', ['WebFetch(domain:docs.foo.dev)']).kind).toBe('allowed');
    expect(judgeUrl('https://docs.foo.dev/a', ['docs.foo.dev']).kind).toBe('allowed'); // 裸域名规则
    expect(judgeUrl('https://a.foo.dev/x', ['WebFetch(domain:*.foo.dev)']).kind).toBe('allowed');

    const verdict = judgeUrl('https://other.dev/x', ['WebFetch(domain:docs.foo.dev)']);
    expect(verdict.kind).toBe('needs-approval');
    expect(verdict.kind === 'needs-approval' && verdict.suggestedRule).toBe(
      'WebFetch(domain:other.dev)',
    );
  });

  it('WebSearch 规则不放行 fetch', () => {
    expect(judgeUrl('https://example.com/', ['WebSearch']).kind).toBe('needs-approval');
  });
});

describe('resolvesToInternal(DNS 名指向内网)', () => {
  const fakeLookup = (map: Record<string, string[]>) => async (h: string) => {
    const addrs = map[h];
    if (!addrs) throw new Error('ENOTFOUND');
    return addrs;
  };

  it('公网形状但解析到内网的名字被识别出来', async () => {
    // nip.io / localtest.me 这类服务把内网地址编码进公网域名,是绕过
    // 字面量判断最省事的办法。
    const lookup = fakeLookup({
      '127.0.0.1.nip.io': ['127.0.0.1'],
      'internal.corp.example.com': ['10.0.0.5'],
      'metadata.example.com': ['169.254.169.254'],
    });
    expect(await resolvesToInternal('127.0.0.1.nip.io', lookup)).toBe('127.0.0.1');
    expect(await resolvesToInternal('internal.corp.example.com', lookup)).toBe('10.0.0.5');
    expect(await resolvesToInternal('metadata.example.com', lookup)).toBe('169.254.169.254');
  });

  it('多条记录里混一条内网地址即整体拒绝', async () => {
    const lookup = fakeLookup({ 'mixed.example.com': ['93.184.216.34', '10.1.2.3'] });
    expect(await resolvesToInternal('mixed.example.com', lookup)).toBe('10.1.2.3');
  });

  it('纯公网解析放行;字面量 IP 不重复走 DNS;解析失败交给 fetch 报错', async () => {
    const lookup = fakeLookup({ 'example.com': ['93.184.216.34'] });
    expect(await resolvesToInternal('example.com', lookup)).toBeUndefined();
    // 字面量 IP 已由 classifyHost 判过,这里直接短路(即使 lookup 会抛错)
    expect(await resolvesToInternal('8.8.8.8', lookup)).toBeUndefined();
    expect(await resolvesToInternal('::ffff:a9fe:a9fe', lookup)).toBeUndefined();
    expect(await resolvesToInternal('nope.invalid', lookup)).toBeUndefined();
  });
});
