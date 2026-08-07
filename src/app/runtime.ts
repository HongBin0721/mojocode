import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { t } from '../i18n/index.js';

/**
 * TUI 运行时门。OpenTUI 的渲染核心是原生 FFI:Bun 走 `bun:ffi`(一等公民,
 * 单二进制的路径);Node 需要 26.1+ 且开 `--experimental-ffi`。`-p` headless
 * 与全部子命令不经过这里,Node 20 照旧可用——TUI 模块必须保持动态 import,
 * 这个检查在 import 之前跑。
 */
export type TuiRuntime =
  /** 当前进程可以直接跑 TUI。 */
  | { kind: 'ok' }
  /** Node 版本够但缺 flag:以 `--experimental-ffi` 重新执行自身。 */
  | { kind: 'reexec' }
  /** 跑不了,给指引(装单二进制 / 升级 Node)。 */
  | { kind: 'unsupported'; message: string };

/** 重执行的环回保护:带着 flag 仍然没有 FFI 时不再无限重启。 */
const REEXEC_ENV = 'MOJOCODE_TUI_REEXEC';

export async function detectTuiRuntime(): Promise<TuiRuntime> {
  if (process.versions.bun) return { kind: 'ok' };
  try {
    // 经变量绕开 TS 的模块解析:@types/node 24 还没有 node:ffi 的类型,
    // 而这里只关心 import 在运行期能否成功。
    const ffiModule = 'node:ffi';
    await import(ffiModule);
    return { kind: 'ok' };
  } catch {
    // Node < 26 没有这个内置模块;26+ 未开 flag 时同样 import 失败。
  }
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  if ((major > 26 || (major === 26 && minor >= 1)) && !process.env[REEXEC_ENV]) {
    return { kind: 'reexec' };
  }
  return {
    kind: 'unsupported',
    message: t('cli.tuiNeedsRuntime', { version: process.versions.node }),
  };
}

/**
 * 以 `--experimental-ffi` 重新执行自身,阻塞至子进程退出,返回其退出码。
 * stdio 直通,TUI 在子进程里正常接管终端。用户原本传给 node 的运行时旗标
 * (--max-old-space-size / --inspect / --import 等在 execArgv 里)必须原样
 * 带上,否则堆上限、调试器在真正跑 TUI 的子进程里静默消失。
 */
export function reexecWithFfi(): number {
  const result = spawnSync(
    process.execPath,
    [...process.execArgv, '--experimental-ffi', ...process.argv.slice(1)],
    {
      stdio: 'inherit',
      env: { ...process.env, [REEXEC_ENV]: '1' },
    },
  );
  return result.status ?? 1;
}
