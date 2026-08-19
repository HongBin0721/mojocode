/** 扁平路径 → 目录树(自 RightPanel.tsx 迁出的纯函数;文件 tab 的数据形状)。 */

export interface TreeNode {
  name: string;
  path: string;
  children?: TreeNode[];
}

/** 目录在前,字典序。 */
export function buildFileTree(paths: string[]): TreeNode[] {
  interface Dir {
    dirs: Map<string, Dir>;
    files: string[];
    path: string;
  }
  const root: Dir = { dirs: new Map(), files: [], path: '' };
  for (const path of paths) {
    const parts = path.split('/');
    let dir = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i]!;
      let next = dir.dirs.get(name);
      if (!next) {
        next = { dirs: new Map(), files: [], path: dir.path ? `${dir.path}/${name}` : name };
        dir.dirs.set(name, next);
      }
      dir = next;
    }
    dir.files.push(parts[parts.length - 1]!);
  }
  const toNodes = (dir: Dir): TreeNode[] => [
    ...[...dir.dirs.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, sub]) => ({ name, path: sub.path, children: toNodes(sub) })),
    ...dir.files
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({ name, path: dir.path ? `${dir.path}/${name}` : name })),
  ];
  return toNodes(root);
}
