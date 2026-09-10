---
title: 包管理
description: mojocode install / remove 与扩展包的目录约定。
---

```bash
mojocode install npm:@someone/mojocode-ext        # 装进 ~/.mojocode/packages/npm/
mojocode install npm:@someone/mojocode-ext@1.2.0  # 锁版本
mojocode install git:https://github.com/x/y.git   # 克隆到 ~/.mojocode/packages/git/y
mojocode install ./my-ext                         # 本地目录:原地加载,不拷贝
mojocode install … --local                        # 装进 <项目>/.mojocode,记进项目配置
mojocode remove y                                 # 按名字卸载(npm 包名 / 仓库名 / 目录名)
mojocode extensions                               # 列出扩展与包
```

安装把 spec 记进配置的 `packages`(全局或 `--local` 的项目层,两层取并集);启动时逐个解析到磁盘目录、读 manifest、装载里面的扩展与技能。项目 `.mojocode/packages` 先于全局。配置里记着却不在盘上的包只出一条启动提示。

`remove` 不看 scope:两个安装目录与两层配置都清,而且只有那一层真的记着这条 spec 时才回写,不会凭空给项目建一个空配置文件。

## 一个包的形状

一个包就是一个目录,`package.json` 里可选一段 manifest:

```json
{
  "name": "@someone/mojocode-ext",
  "mojocode": {
    "extensions": ["extensions", "index.ts"],
    "skills": ["skills"]
  }
}
```

`extensions` 列文件或目录(目录按扩展目录的规则扫),`skills` 列技能目录(里面的每个 `<name>/SKILL.md` 都进技能表,优先级低于本地技能)。没写 manifest 时按约定找:`extensions/`、根目录的 `index.ts`、`skills/`。

包里扩展的 id 冠以 `<包名>/` 前缀,避免与本地扩展撞车。
