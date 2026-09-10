import path from 'node:path';

/**
 * 工具的路径解析:相对工作区根解析,**没有围栏**。
 *
 * 这是 Pi 的语义——read/write/edit/bash 能碰到进程能碰到的任何路径,边界由
 * 运行环境(容器、沙箱账户)划,不由 agent 自己划。原来这里有一整套
 * realpath 圈定工作区 + `.env`/密钥硬拒的地板,连同两轴权限策略一起被拿掉了。
 *
 * `relative` 是喂给模型的那个名字:在工作区内就给相对 posix 路径,出了工作区
 * 给绝对路径——写成相对路径会与工作区文件混淆。
 */
export interface ResolvedPath {
  absolute: string;
  relative: string;
}

export function resolvePath(input: string, root: string): ResolvedPath {
  const absolute = path.resolve(root, input);
  const rel = path.relative(root, absolute);
  if (rel === '') return { absolute, relative: '.' };
  const inside = !rel.startsWith('..') && !path.isAbsolute(rel);
  return { absolute, relative: toPosix(inside ? rel : absolute) };
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}
