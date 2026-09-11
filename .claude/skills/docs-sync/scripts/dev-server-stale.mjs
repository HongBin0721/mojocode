#!/usr/bin/env node
/**
 * 判断文档站的 dev server 是否落后于源码 —— 供 docs-sync 技能调用。
 *
 * 长跑的 `astro dev` 会保留旧的内容存储:server 启动之后新增的内容文件进不了
 * store(页面继续渲染语言回退),启动之后改的 astro.config.mjs 也不会重载插件。
 * 两种都只能重启解决,而「启动时间早于最新源码 mtime」就是这两种情况的共同特征,
 * 所以这里把三个时间并排摆出来给判断,不做任何猜测性的自动重启。
 *
 * 用法:node .claude/skills/docs-sync/scripts/dev-server-stale.mjs [--site <目录>]
 * 退出码:0 = 无需重启(含「没有 server 在跑」),1 = 有 server 落后,2 = 用法错误。
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 只统计 dev server 真正读的东西:配置、内容、组件、样式、插件、静态资源。 */
const WATCHED_FILES = ['astro.config.mjs', 'package.json'];
const WATCHED_DIRS = ['src', 'plugins', 'public'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.astro', '.git']);

function fail(message) {
  console.error(message);
  process.exit(2);
}

/**
 * `ps -Ao pid,lstart,command` 的一行 → { pid, startedAt, command },格式不认识就返回 null。
 * lstart 是 `Fri Sep 11 19:01:22 2026`——星期、月、日、时间、年,共五个字段。
 */
function parsePsLine(line) {
  const match =
    /^(\d+)\s+\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s+(.*)$/.exec(
      line.trim(),
    );
  if (!match) return null;
  const [, pid, mon, day, hh, mm, ss, year, command] = match;
  const month = MONTHS.indexOf(mon);
  if (month === -1) return null;
  return {
    pid: Number(pid),
    // lstart 是本地时间,按本地时间构造,别走 Date 的字符串解析(年份在末尾,各引擎不一致)。
    startedAt: new Date(Number(year), month, Number(day), Number(hh), Number(mm), Number(ss)),
    command,
  };
}

/** 递归找最新 mtime 的文件,返回 { file, mtimeMs };目录不存在时返回 null。 */
function newestIn(target, newest = null) {
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return newest;
  }
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
      newest = newestIn(path.join(target, entry.name), newest);
    }
    return newest;
  }
  if (!stat.isFile()) return newest;
  if (!newest || stat.mtimeMs > newest.mtimeMs) return { file: target, mtimeMs: stat.mtimeMs };
  return newest;
}

function mtimeOf(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

function stamp(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

const args = process.argv.slice(2);
let siteArg = 'website';
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--site') {
    siteArg = args[i + 1];
    i += 1;
    if (!siteArg) fail('--site 需要一个目录参数');
  } else if (args[i] === '-h' || args[i] === '--help') {
    console.log('用法: node .claude/skills/docs-sync/scripts/dev-server-stale.mjs [--site <目录>]');
    process.exit(0);
  } else {
    fail(`未知参数: ${args[i]}`);
  }
}

const site = path.resolve(process.cwd(), siteArg);
if (!fs.existsSync(path.join(site, 'astro.config.mjs'))) {
  fail(`不是 Astro 站点目录(找不到 astro.config.mjs): ${site}`);
}

// 最新的源码文件:配置、内容、组件、样式、插件、静态资源里最近被写过的那个。
let newest = newestIn(path.join(site, 'package.json'));
for (const name of WATCHED_FILES) newest = newestIn(path.join(site, name), newest);
for (const name of WATCHED_DIRS) newest = newestIn(path.join(site, name), newest);

// 内容存储:server 的「上次同步快照」,比最新内容文件旧就说明它没跟上。
const store = mtimeOf(path.join(site, '.astro', 'data-store.json'));
const newestContent = newestIn(path.join(site, 'src', 'content'));

const servers = execFileSync('ps', ['-Ao', 'pid,lstart,command'], { encoding: 'utf8' })
  .split('\n')
  .map(parsePsLine)
  .filter(Boolean)
  .filter(
    (row) =>
      /astro(\.mjs)?\s+dev\b/.test(row.command) &&
      !/dev\s+stop\b/.test(row.command) &&
      row.command.includes(site),
  );

console.log(`站点: ${site}`);
if (newest) console.log(`最新源码: ${path.relative(process.cwd(), newest.file)}  ${stamp(newest.mtimeMs)}`);
if (newestContent) {
  console.log(
    `最新内容: ${path.relative(process.cwd(), newestContent.file)}  ${stamp(newestContent.mtimeMs)}`,
  );
}
console.log(
  store === null
    ? '内容存储: 不存在(server 还没同步过)'
    : `内容存储: ${path.relative(process.cwd(), path.join(site, '.astro', 'data-store.json'))}  ${stamp(store)}`,
);

if (servers.length === 0) {
  console.log('dev server: 没有在跑(不需要重启)');
  process.exit(0);
}

let stale = false;
for (const server of servers) {
  const behind = newest && newest.mtimeMs > server.startedAt.getTime();
  stale = stale || Boolean(behind);
  console.log(
    `dev server: pid ${server.pid}  启动于 ${stamp(server.startedAt.getTime())}  ` +
      `→ ${behind ? 'STALE(启动早于最新源码)' : 'OK'}`,
  );
}

if (stale) {
  console.log(
    '结论: 需要重启。cd website && npx astro dev stop,然后 npm run dev -- --host 127.0.0.1',
  );
  console.log('      (hub 托管的 dev server 用 hub stop / hub start,不要按 pid kill)');
  process.exit(1);
}

console.log('结论: 无需重启。');
