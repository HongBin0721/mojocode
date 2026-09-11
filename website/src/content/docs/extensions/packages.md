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
    "skills": ["skills"],
    "prompts": ["prompts"],
    "themes": ["themes"]
  }
}
```

四类资源与 Pi 的包 manifest 同名:`extensions` 列文件或目录(目录按扩展目录的规则扫);`skills` 列技能目录(里面的每个 `<name>/SKILL.md` 都进技能表,优先级低于本地技能);`prompts` 列提示词模板目录;`themes` 列主题目录。没写 manifest 时按约定找:`extensions/`、根目录的 `index.ts`、`skills/`、`prompts/`、`themes/`。列出来但不存在的路径静默跳过。

### 提示词模板

`prompts/` 目录(以及 `~/.mojocode/prompts/`、`<项目>/.mojocode/prompts/`)里的每个 `*.md` 都是一条只给用户敲的 `/name` 命令——它就是一个只有正文、目录扁平的技能:frontmatter 可省,`name` 缺省取文件名,`description` 缺省取正文第一行,`argument-hint` 同技能;正文里的 `$1` / `$ARGUMENTS` 替换规则与技能相同。同名时技能赢;项目目录优先于全局目录优先于包。

```markdown
---
description: 给函数写单元测试
argument-hint: <文件>
---
为 $ARGUMENTS 补全单元测试,覆盖边界情况。
```

### 主题

`themes/` 目录(以及 `<项目>/.mojocode/themes/`、`~/.mojocode/themes/`)里的 `<name>.json` 是一个主题,配置 `theme: "<name>"` 指名,TUI 起来前应用一次(运行期不切换)。`colors` 只需写要改的键,其余沿用内置配色;可用键:`accent` `user` `assistant` `dim` `tool` `error` `warn` `success` `added` `removed` `diffAddedBg` `diffAddedFg` `diffRemovedBg` `diffRemovedFg` `code`,值是命名色或 `#rrggbb`。

```json
{ "name": "dusk", "colors": { "accent": "#7aa2f7", "user": "#bb9af7", "code": "#7dcfff" } }
```

找不到指名的主题或文件坏了不拦启动,进 TUI 后给一条提示并沿用内置配色。

包里扩展的 id 冠以 `<包名>/` 前缀,避免与本地扩展撞车。
