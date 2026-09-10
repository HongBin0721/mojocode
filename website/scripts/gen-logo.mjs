/**
 * 从 TUI 的点阵字模(src/ui/logo.ts)生成站点用的 SVG:
 *   src/assets/wordmark.svg  顶栏与首页的 "mojocode" 像素字,逐字渐变(与 TUI 同一条色带)
 *   public/favicon.svg       单个 "M" 字模的标记
 *
 * 字模与渐变端点都从源码文本里正则抠出来,不复制一份——TUI 改了 logo,这里
 * 重跑一次就跟上。用法:node scripts/gen-logo.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.resolve(here, '../../src/ui/logo.ts'), 'utf8');

const FONT = {};
for (const m of source.matchAll(/^\s+'?([A-Z0-9._-])'?: \[((?:'[.#]{5}',?\s*){5})\]/gm)) {
  FONT[m[1]] = [...m[2].matchAll(/'([.#]{5})'/g)].map((x) => x[1]);
}
const rgb = (name) => {
  const m = source.match(new RegExp(`const ${name} = \\[(0x[0-9a-f]{2}), (0x[0-9a-f]{2}), (0x[0-9a-f]{2})\\]`));
  return m.slice(1, 4).map((v) => parseInt(v, 16));
};
const FROM = rgb('FROM');
const TO = rgb('TO');
const hex = (c) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
const lerp = (k) => hex([0, 1, 2].map((i) => Math.round(FROM[i] + (TO[i] - FROM[i]) * k)));

const W = 5, H = 5, GAP = 1;

function wordmark(text) {
  const chars = [...text.toUpperCase()];
  const width = chars.length * W + (chars.length - 1) * GAP;
  const rects = [];
  chars.forEach((ch, i) => {
    const g = FONT[ch];
    if (!g) return;
    const fill = chars.length === 1 ? hex(FROM) : lerp(i / (chars.length - 1));
    const x0 = i * (W + GAP);
    g.forEach((row, y) => {
      [...row].forEach((px, x) => {
        if (px === '#') rects.push(`<rect x="${x0 + x}" y="${y}" width="1" height="1" fill="${fill}"/>`);
      });
    });
  });
  // shape-rendering 关掉抗锯齿,像素边缘保持硬朗。
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${H}" width="${width * 8}" height="${H * 8}" shape-rendering="crispEdges" role="img" aria-label="${text}">${rects.join('')}</svg>\n`;
}

writeFileSync(path.resolve(here, '../src/assets/wordmark.svg'), wordmark('mojocode'));

const mark = FONT.M;
const markRects = [];
mark.forEach((row, y) => [...row].forEach((px, x) => {
  if (px === '#') markRects.push(`<rect x="${1.5 + x}" y="${1.5 + y}" width="1" height="1" fill="url(#g)"/>`);
}));
writeFileSync(
  path.resolve(here, '../public/favicon.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8" shape-rendering="crispEdges"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="${hex(FROM)}"/><stop offset="1" stop-color="${hex(TO)}"/></linearGradient></defs><rect width="8" height="8" rx="1.6" fill="#0e131a"/>${markRects.join('')}</svg>\n`,
);
console.log('wordmark:', Object.keys(FONT).length, 'glyphs parsed;', hex(FROM), '→', hex(TO));
