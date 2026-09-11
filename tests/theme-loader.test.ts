import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyTheme, loadTheme, parseThemeColors, themeLocations } from '../src/ui/theme-loader.js';
import { theme } from '../src/ui/theme.js';
import { phaseColor } from '../src/ui/StatusLine.js';
import { extensionTheme } from '../src/core/extension-types.js';
import { sgrForeground } from '../src/core/palette.js';

/**
 * 主题文件(Pi 的 themes):按名字在项目 > 全局 > 贡献目录里找 `<name>.json`,
 * 只收已知色键;找不到 / 坏文件不抛,回落内置配色。theme 对象就地换色。
 */
let home: string;
let root: string;
const original = { ...theme };

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-theme-home-'));
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-theme-root-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
});

afterEach(async () => {
  applyTheme(original);
  vi.unstubAllEnvs();
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(root, { recursive: true, force: true });
});

describe('主题文件', () => {
  it('parseThemeColors 只收已知键的非空字符串', () => {
    expect(parseThemeColors({ colors: { accent: ' #123456 ', bogus: 'x', dim: 7, tool: '' } })).toEqual({
      accent: '#123456',
    });
    expect(parseThemeColors({})).toBeUndefined();
    expect(parseThemeColors('nope')).toBeUndefined();
  });

  it('查找顺序:项目 > 全局 > 贡献目录;找不到 not-found,坏 JSON invalid', async () => {
    const extra = path.join(root, 'pkg-themes');
    const [project, global] = themeLocations(root, [extra]);
    for (const dir of [project!, global!, extra]) await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(global!, 'dusk.json'), JSON.stringify({ colors: { accent: 'global' } }));
    await fs.writeFile(path.join(extra, 'dusk.json'), JSON.stringify({ colors: { accent: 'pkg' } }));
    await fs.writeFile(path.join(extra, 'only-pkg.json'), JSON.stringify({ colors: { accent: 'pkg2' } }));
    await fs.writeFile(path.join(project!, 'broken.json'), '{ not json');
    await fs.writeFile(path.join(project!, 'nocolors.json'), '{"name":"x"}');

    const dirs = themeLocations(root, [extra]);
    expect(await loadTheme('dusk', dirs)).toMatchObject({ ok: true, theme: { name: 'dusk', colors: { accent: 'global' } } });
    expect(await loadTheme('only-pkg', dirs)).toMatchObject({ ok: true, theme: { colors: { accent: 'pkg2' } } });
    expect(await loadTheme('nope', dirs)).toEqual({ ok: false, reason: 'not-found' });
    expect(await loadTheme('broken', dirs)).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await loadTheme('nocolors', dirs)).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('applyTheme 就地换色,只改给了的键,返回改动数', () => {
    expect(applyTheme({ accent: '#abcdef', dim: theme.dim })).toBe(1);
    expect(theme.accent).toBe('#abcdef');
    expect(theme.user).toBe(original.user);
  });

  it('sgrForeground:命名色查表,#rgb / #rrggbb 走真彩色,不认识的退回默认前景', () => {
    expect(sgrForeground('cyan')).toBe('36');
    expect(sgrForeground(' Gray ')).toBe('90');
    expect(sgrForeground('#1e4023')).toBe('38;2;30;64;35');
    expect(sgrForeground('#abc')).toBe('38;2;170;187;204');
    expect(sgrForeground('chartreuse')).toBe('39');
  });

  it('换色也打到扩展拿到的 ExtensionTheme 上——配色表只有一张', () => {
    // 回归:两张表时,换了主题只有 TUI 自己的边框与文字变色,扩展画的行、
    // 工具的 renderResult、整段回滚转储全是内置色。
    expect(extensionTheme.fg('accent', 'x')).toBe('\x1b[36mx\x1b[39m');
    applyTheme({ accent: '#7aa2f7' });
    expect(extensionTheme.fg('accent', 'x')).toBe('\x1b[38;2;122;162;247mx\x1b[39m');
    // text 没有对应的配色键,照旧是终端默认前景。
    expect(extensionTheme.fg('text', 'x')).toBe('\x1b[39mx\x1b[39m');
  });

  it('换色打得到状态线的阶段色上——phaseColor 现读 theme,不是模块级快照', () => {
    // 这一条是回归:StatusLine 曾把 `{ responding: theme.accent }` 做成模块级
    // 常量表,而本模块在 applyTheme 跑之前就被 import 了,于是换了主题满屏
    // 变色、只有工作状态线还是内置的 cyan。
    expect(phaseColor('responding')).toBe(original.accent);
    applyTheme({ accent: '#7aa2f7', tool: '#9ece6a' });
    expect(phaseColor('responding')).toBe('#7aa2f7');
    expect(phaseColor('compacting')).toBe('#7aa2f7');
    expect(phaseColor('tool')).toBe('#9ece6a');
    // magenta 不在可换色键里,照旧是字面量。
    expect(phaseColor('thinking')).toBe('magenta');
  });
});
