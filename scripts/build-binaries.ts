#!/usr/bin/env bun
/**
 * 交叉编译单二进制(`bun build --compile`)。
 *
 * 输入是 tsup 的产物 dist/cli.js(先跑 `npm run build`),不是 src/——
 * 复用现有构建链,保证二进制和 npm 包跑的是同一份代码。
 *
 * spike 里踩过的坑在这里处理(docs/opentui-migration.md §6.4):
 * - `$bunfs` 里读不到 package.json,版本号用 `define` 在编译期注入
 *   (见 src/config/version.ts 的 MOJOCODE_BUILD_VERSION)。
 *   (React 时代还需要 stub 掉 @opentui/react 的 react-devtools-core 可选
 *   依赖;SolidJS 迁移后 dist 产物零 react 引用,该插件已随之删除。)
 *
 * 用法:
 *   bun scripts/build-binaries.ts                       # 全 6 平台 + 归档 + SHA256SUMS
 *   bun scripts/build-binaries.ts --target=darwin-arm64 # 只编指定平台(逗号分隔可多个)
 *   bun scripts/build-binaries.ts --no-archive          # 只出二进制,不打 tar/zip
 */
import fs from 'node:fs/promises';
import path from 'node:path';

interface Target {
  /** 产物名后缀,也是 release 资产名的一部分。 */
  name: string;
  /** Bun 的 --target 值。 */
  bunTarget: string;
  /** 该目标要嵌入的 OpenTUI 原生平台包(编译前按需安装,见 ensureNativePackage)。 */
  nativePackage: string;
  windows?: boolean;
  /**
   * linux 目标钉死 libc:OpenTUI 选原生库时按运行期 `OPENTUI_LIBC` 判断
   * glibc/musl,不 define 的话两份 .so 都会被打进二进制(实测 +60MB)。
   */
  libc?: 'glibc' | 'musl';
}

const TARGETS: Target[] = [
  { name: 'darwin-arm64', bunTarget: 'bun-darwin-arm64', nativePackage: '@opentui/core-darwin-arm64' },
  { name: 'darwin-x64', bunTarget: 'bun-darwin-x64', nativePackage: '@opentui/core-darwin-x64' },
  { name: 'linux-x64', bunTarget: 'bun-linux-x64', nativePackage: '@opentui/core-linux-x64', libc: 'glibc' },
  { name: 'linux-arm64', bunTarget: 'bun-linux-arm64', nativePackage: '@opentui/core-linux-arm64', libc: 'glibc' },
  { name: 'linux-x64-musl', bunTarget: 'bun-linux-x64-musl', nativePackage: '@opentui/core-linux-x64-musl', libc: 'musl' },
  { name: 'windows-x64', bunTarget: 'bun-windows-x64', nativePackage: '@opentui/core-win32-x64', windows: true },
];

/**
 * 确保目标平台的 OpenTUI 原生包在 node_modules 里。
 *
 * 这些包各自声明 os/cpu,只有与本机匹配的那个会随普通 `npm ci` 作为
 * @opentui/core 的 optionalDependency 装上;交叉编译需要目标平台的包,
 * 在这里用 `--force --no-save` 补装——不写进 package.json,否则任何机器上
 * 裸跑 npm ci 都会 EBADPLATFORM 直接失败(第一版就是这么踩的)。
 */
async function ensureNativePackage(target: Target, version: string): Promise<void> {
  const dir = path.join(root, 'node_modules', target.nativePackage);
  if (await Bun.file(path.join(dir, 'package.json')).exists()) return;
  console.log(`  补装 ${target.nativePackage}@${version}(交叉编译用,--no-save)`);
  const proc = Bun.spawn(
    ['npm', 'install', '--no-save', '--force', `${target.nativePackage}@${version}`],
    { cwd: root, stdout: 'ignore', stderr: 'inherit' },
  );
  if ((await proc.exited) !== 0) {
    console.error(`✗ 安装 ${target.nativePackage} 失败`);
    process.exit(1);
  }
}

const root = path.resolve(import.meta.dir, '..');
const entry = path.join(root, 'dist', 'cli.js');
const outDir = path.join(root, 'dist', 'bin');

// ---- 参数解析 -------------------------------------------------------------
const args = process.argv.slice(2);
const archive = !args.includes('--no-archive');
const targetArgs = args
  .filter((a) => a.startsWith('--target='))
  .flatMap((a) => a.slice('--target='.length).split(','))
  .map((s) => s.trim())
  .filter(Boolean);
const unknown = args.filter((a) => a !== '--no-archive' && !a.startsWith('--target='));
if (unknown.length > 0) {
  console.error(`未知参数:${unknown.join(' ')}`);
  process.exit(2);
}
const selected =
  targetArgs.length === 0
    ? TARGETS
    : targetArgs.map((name) => {
        const found = TARGETS.find((t) => t.name === name);
        if (!found) {
          console.error(`未知 target「${name}」,可选:${TARGETS.map((t) => t.name).join(', ')}`);
          process.exit(2);
        }
        return found;
      });

// ---- 前置检查 -------------------------------------------------------------
if (!(await Bun.file(entry).exists())) {
  console.error('缺少 dist/cli.js,先跑 `npm run build`。');
  process.exit(1);
}
const pkg = (await Bun.file(path.join(root, 'package.json')).json()) as {
  version: string;
  dependencies: Record<string, string>;
};
// 原生平台包必须与 @opentui/core 同版本(上游三方精确锁死)。
const opentuiVersion = pkg.dependencies['@opentui/core']!;

await fs.rm(outDir, { recursive: true, force: true });
await fs.mkdir(outDir, { recursive: true });

// ---- 逐平台编译 -----------------------------------------------------------
const produced: { target: Target; file: string }[] = [];
for (const target of selected) {
  await ensureNativePackage(target, opentuiVersion);
  const outfile = path.join(outDir, `mojocode-${target.name}${target.windows ? '.exe' : ''}`);
  const started = Date.now();
  const result = await Bun.build({
    entrypoints: [entry],
    compile: { target: target.bunTarget, outfile },
    define: {
      MOJOCODE_BUILD_VERSION: JSON.stringify(pkg.version),
      ...(target.libc ? { 'process.env.OPENTUI_LIBC': JSON.stringify(target.libc) } : {}),
    },
  });
  if (!result.success) {
    console.error(`✗ ${target.name} 编译失败:`);
    for (const log of result.logs) console.error(String(log));
    process.exit(1);
  }
  const size = (await fs.stat(outfile)).size;
  console.log(
    `✓ ${target.name.padEnd(16)} ${(size / 1024 / 1024).toFixed(1)}MB · ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
  produced.push({ target, file: outfile });
}

// ---- 清扫 Bun 泄漏的编译临时文件 -------------------------------------------
// `bun build --compile` 每次调用都会在 cwd 留下一个 `.{hash}-00000000.bun-build`
// (约 60MB,带假 mtime,与产物无关——成品已改名挪进 outfile)。不清的话
// 一次全平台构建就往仓库根堆 6 个共 ~370MB。已在 .gitignore,此处只管磁盘。
for (const entry of await fs.readdir(root)) {
  if (entry.endsWith('.bun-build')) await fs.rm(path.join(root, entry), { force: true });
}

// ---- 归档 + 校验和 ---------------------------------------------------------
// 归档内的二进制统一叫 mojocode(.exe),用户解包即用;tar 用 -C 进临时
// stage 目录取平名,避开 GNU/bsd tar 改名 flag 的差异。
if (archive) {
  const sums: string[] = [];
  for (const { target, file } of produced) {
    const plain = target.windows ? 'mojocode.exe' : 'mojocode';
    const archiveName = `mojocode-${target.name}.${target.windows ? 'zip' : 'tar.gz'}`;
    const archivePath = path.join(outDir, archiveName);
    const stage = path.join(outDir, `.stage-${target.name}`);
    await fs.mkdir(stage, { recursive: true });
    await fs.copyFile(file, path.join(stage, plain));
    const proc = target.windows
      ? Bun.spawn(['zip', '-j', '-q', archivePath, path.join(stage, plain)])
      : Bun.spawn(['tar', '-czf', archivePath, '-C', stage, plain]);
    if ((await proc.exited) !== 0) {
      console.error(`✗ 归档 ${archiveName} 失败`);
      process.exit(1);
    }
    await fs.rm(stage, { recursive: true, force: true });

    const hasher = new Bun.CryptoHasher('sha256');
    hasher.update(await Bun.file(archivePath).arrayBuffer());
    sums.push(`${hasher.digest('hex')}  ${archiveName}`);
  }
  const sumsFile = path.join(outDir, 'SHA256SUMS');
  await Bun.write(sumsFile, sums.join('\n') + '\n');
  console.log(`✓ ${produced.length} 个归档 + SHA256SUMS → dist/bin/`);
}
