#!/usr/bin/env node
/**
 * 首页宣传片的一键生成:真实录屏 → 合成 → 编码,产物写进 ../public/promo/。
 *
 *   node make.mjs                      # 中英两版全做
 *   node make.mjs --lang en            # 只做一版
 *   node make.mjs --provider glm-coding --model GLM-5.3
 *   node make.mjs --skip-record        # 复用 .work/ 里上次的录屏,只重新合成(改文案、改动效时用)
 *   node make.mjs --skip-record --still 1.8,6.5,13.9   # 只出几张静帧预览,不编码
 *
 * 前置:仓库根已 `npm run build`(录的是 dist/cli.js);装了 vhs(brew install vhs,
 * 顺带 ffmpeg 与 ttyd)、bun、Google Chrome(非默认路径用 CHROME_PATH 指定);
 * 本机 ~/.mojocode/config.json 里有所选服务商的 key。
 */
import { spawnSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const work = path.join(here, '.work');
const outDir = path.resolve(here, '../public/promo');
const cli = path.join(repo, 'dist/cli.js');

const PROMPTS = {
  'zh-CN': 'total() 没把数量 qty 算进去,修一下然后跑测试',
  en: 'total() ignores qty — fix it and run the tests',
};
// 合成时间轴(秒),与 comp.html 的动效对齐:窗口 2.6s 起放录屏,12.1s 前放完。
const FPS = 30, DUR = 15, TERM_IN = 2.6, TERM_BUDGET = 9.5, REC_FPS = 50;

const args = parseArgs(process.argv.slice(2));
const langs = args.lang ? [args.lang] : Object.keys(PROMPTS);
const chrome = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

preflight();
for (const lang of langs) {
  if (!args['skip-record']) record(lang);
  await compose(lang);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    out[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  if (out.lang && !PROMPTS[out.lang]) die(`--lang 只认 ${Object.keys(PROMPTS).join(' / ')}`);
  return out;
}

function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...opts });
  if (r.status !== 0) die(`${cmd} ${argv.join(' ')} 失败:\n${r.stderr || r.stdout}`);
  return r.stdout;
}

function preflight() {
  const need = ['ffmpeg', ...(args['skip-record'] ? [] : ['vhs', 'bun'])];
  for (const c of need) if (spawnSync('which', [c]).status !== 0) die(`缺少 ${c}(brew install vhs 带 ffmpeg/ttyd;bun 见 bun.sh)`);
  if (!fs.existsSync(chrome)) die(`找不到 Chrome:${chrome}(用 CHROME_PATH 指定)`);
  if (!args['skip-record'] && !fs.existsSync(cli)) die('dist/cli.js 不存在,先在仓库根 npm run build');
}

/**
 * 在一个临时 HOME 里真跑一遍 TUI:示例项目放在 ~/shop(横幅显示成 ~/shop),会话记录
 * 不落进你自己的 ~/.mojocode/sessions。配置只带 providers 与所选服务商——language 必须
 * 留空,否则 MOJOCODE_LANG 压不过它。临时 HOME 里有 key 的副本,录完即删。
 */
function record(lang) {
  // realpath:macOS 的 tmpdir 是 /var → /private/var 的软链,TUI 按真实 cwd 比对 HOME,不解开就显示不成 ~/shop。
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mojocode-promo-')));
  try {
    const shop = path.join(home, 'shop');
    fs.cpSync(path.join(here, 'shop'), shop, { recursive: true });
    const git = (...a) => run('git', ['-c', 'user.name=promo', '-c', 'user.email=promo@localhost', ...a], { cwd: shop });
    git('init', '-q');
    git('add', '-A');
    git('commit', '-qm', 'init');

    const realHome = process.env.HOME ?? os.homedir();
    const real = JSON.parse(fs.readFileSync(path.join(realHome, '.mojocode/config.json'), 'utf8'));
    const config = { providers: real.providers ?? {}, provider: args.provider ?? 'deepseek' };
    fs.mkdirSync(path.join(home, '.mojocode'));
    fs.writeFileSync(path.join(home, '.mojocode/config.json'), JSON.stringify(config, null, 2));

    const frames = path.join(work, lang, 'raw');
    fs.rmSync(frames, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(frames), { recursive: true });
    const env = [`HOME='${home}'`, `MOJOCODE_LANG=${lang}`, ...(args.model ? [`MOJOCODE_MODEL='${args.model}'`] : [])];
    const tape = path.join(work, lang, 'record.tape');
    fs.writeFileSync(tape, tapeFor(frames, `export ${env.join(' ')} && cd ~/shop && clear && bun '${cli}'`, PROMPTS[lang]));

    console.log(`● 录制 ${lang}(真实调用模型,约 30s)`);
    // vhs 0.12 配 ffmpeg 9 直接出视频会静默失败,所以输出到帧目录(文字层与光标层分开),自己合。
    run('vhs', [tape], { cwd: work });
    const merged = path.join(work, lang, 'frames');
    fs.rmSync(merged, { recursive: true, force: true });
    fs.mkdirSync(merged);
    run('ffmpeg', ['-loglevel', 'error', '-y',
      '-framerate', String(REC_FPS), '-i', path.join(frames, 'frame-text-%05d.png'),
      '-framerate', String(REC_FPS), '-i', path.join(frames, 'frame-cursor-%05d.png'),
      '-filter_complex', 'overlay', '-q:v', '2', path.join(merged, '%05d.jpg')]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function tapeFor(output, launch, prompt) {
  const c = { bg: '#0e131a', fg: '#d5dde6', dim: '#6b7887', white: '#eef2f6', red: '#f28b9b', green: '#86d99a', yellow: '#e8c672', blue: '#8ab4ff', magenta: '#c4a7ff', cyan: '#5eead4' };
  const theme = {
    background: c.bg, foreground: c.fg, cursor: c.cyan,
    black: c.bg, red: c.red, green: c.green, yellow: c.yellow, blue: c.blue, magenta: c.magenta, cyan: c.cyan, white: c.fg,
    brightBlack: c.dim, brightRed: c.red, brightGreen: c.green, brightYellow: c.yellow, brightBlue: c.blue, brightMagenta: c.magenta, brightCyan: c.cyan, brightWhite: c.white,
  };
  return `Output "${output}/"
Set Shell bash
Set FontSize 22
Set FontFamily "${process.env.PROMO_FONT ?? 'Menlo'}"
Set Width 1440
Set Height 840
Set Padding 0
Set TypingSpeed 45ms
Set Theme ${JSON.stringify(theme)}
Hide
Type "${launch}"
Enter
Sleep 3s
Show
Sleep 1200ms
Type "${prompt}"
Sleep 400ms
Enter
Wait+Screen@120s /▣/
Sleep 3s
`;
}

/**
 * 从文字层的帧哈希找剪辑点:第一次变化(开始打字)之前留 16 帧,定稿(最后一段不变的帧)
 * 之后留 1 秒。录屏比 TERM_BUDGET 长就整体加速,角标如实写倍速。
 */
function cutPoints(lang) {
  const raw = path.join(work, lang, 'raw');
  const texts = fs.readdirSync(raw).filter((f) => f.startsWith('frame-text-')).sort();
  const hashes = texts.map((f) => createHash('md5').update(fs.readFileSync(path.join(raw, f))).digest('hex'));
  const firstChange = hashes.findIndex((h) => h !== hashes[0]);
  let finalStart = hashes.length - 1;
  while (finalStart > 0 && hashes[finalStart - 1] === hashes[hashes.length - 1]) finalStart--;
  if (firstChange < 0 || hashes.length - finalStart < REC_FPS) die(`${lang} 的录屏看起来不完整(没有定稿后的静止段),重录一次`);
  const frameStart = Math.max(1, firstChange + 1 - 16);
  const frameEnd = Math.min(hashes.length, finalStart + 1 + REC_FPS);
  const speed = Math.max(1, Math.ceil(((frameEnd - frameStart) / REC_FPS / TERM_BUDGET) * 10) / 10);
  return { frameStart, frameEnd, speed };
}

async function compose(lang) {
  const merged = path.join(work, lang, 'frames');
  if (!fs.existsSync(merged)) die(`没有 ${lang} 的录屏,去掉 --skip-record 先录一次`);
  const cut = cutPoints(lang);
  console.log(`● 合成 ${lang}:录屏帧 ${cut.frameStart}–${cut.frameEnd},${cut.speed}×`);

  const svg = fs.readFileSync(path.resolve(here, '../src/assets/wordmark.svg'), 'utf8');
  const pixels = [...svg.matchAll(/<rect x="(\d+)" y="(\d+)"[^>]*fill="(#[0-9a-fA-F]+)"/g)].map((m) => [+m[1], +m[2], m[3]]);
  const cfg = { lang, dir: pathToFileURL(merged).href, termIn: TERM_IN, ...cut };

  const { default: puppeteer } = await import('puppeteer-core');
  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    args: ['--allow-file-access-from-files', '--force-color-profile=srgb', '--hide-scrollbars'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(path.join(here, 'comp.html')).href);
    await page.evaluate((cfg, pixels) => setup(cfg, pixels), cfg, pixels);
    await page.evaluate(() => document.fonts.ready);
    const at = (t) => page.evaluate((t) => render(t), t);

    if (args.still) {
      for (const t of String(args.still).split(',').map(Number)) {
        await at(t);
        const file = path.join(work, `still-${lang}-${t}.png`);
        await page.screenshot({ path: file });
        console.log(`  ${file}`);
      }
      return;
    }

    fs.mkdirSync(outDir, { recursive: true });
    const mp4 = path.join(outDir, `promo-${lang}.mp4`);
    const ff = spawn('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4],
    { stdio: ['pipe', 'inherit', 'inherit'] });
    const done = new Promise((resolve) => ff.on('close', resolve));
    for (let f = 0; f < FPS * DUR; f++) {
      await at(f / FPS);
      const buf = await page.screenshot({ type: 'png' });
      if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
    }
    ff.stdin.end();
    if ((await done) !== 0) die(`ffmpeg 编码 ${mp4} 失败`);

    // poster 取录屏定稿那一刻(窗口 12.25s 开始退场)
    await at(11.8);
    await page.screenshot({ path: path.join(outDir, `poster-${lang}.jpg`), type: 'jpeg', quality: 82 });
    run('ffmpeg', ['-loglevel', 'error', '-y', '-i', mp4, '-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-row-mt', '1',
      path.join(outDir, `promo-${lang}.webm`)]);
    console.log(`✓ ${path.relative(repo, outDir)}/promo-${lang}.{mp4,webm} + poster-${lang}.jpg`);
  } finally {
    await browser.close();
  }
}
