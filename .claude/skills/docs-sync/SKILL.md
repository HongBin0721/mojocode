---
name: docs-sync
description: 改动涉及代码、命令、配置或文档时使用。核对受影响的文档是否真的同步更新(中英双页、侧栏条目、链接写法),以及文档与配置改完后 dev server 是否重启过——磁盘上有文件不等于浏览器看得到。
---

# 文档同步检查

面向用户的文档在 `website/`(Astro + Starlight),给 agent 的约定在根 `AGENTS.md` 与
`website/CLAUDE.md`。规则只有一条:**改了行为就在同一批改动里改文档,文档改完要让 dev server
真的把它渲染出来**。任何可能影响文档的改动,在宣布完成之前跑一遍下面的流程。

## 1. 收集真实改动集(别漏未跟踪文件)

```bash
git status --porcelain          # `??` 开头是未跟踪文件,新页面通常在这里
git diff --name-only HEAD       # 已暂存 + 未暂存
```

`git diff` 系列看不到未跟踪文件,只看它会得出「文档没动」的错误结论。

## 2. 改动 → 必须跟进的文档

| 改了 | 文档 |
|---|---|
| 工具 / 权限 / 配置键 / CLI 命令 / 默认值 | `website/src/content/docs/**` 对应页 **与** `en/` 下同 slug 的镜像页 |
| 新增文档页 | `website/astro.config.mjs` 的 `sidebar` 加一条 `{ slug }`(漏了只能靠搜索到达,slug 写错直接 build 失败) |
| 模块契约、agent 循环、进程模型、测试分层 | 根 `AGENTS.md` |
| 站点自身的约定(主题、custom.css、生成物、链接规则) | `website/CLAUDE.md` |
| npm scripts | `website/CLAUDE.md` 的「命令」段(它自称与 package.json 一致) |
| TUI 行格式 / 行首符号 / 工具摘要措辞 | `website/src/components/demos.ts` |

## 3. 核对文档是否真的动了

```bash
git status --porcelain -- website/src/content/docs website/CLAUDE.md AGENTS.md
```

逐条检查:

- 中英两页都在。只写中文页 = 英文站渲染回退页(`/en/` 下显示中文正文加一句
  `not available in your language yet.`)
- frontmatter 只有 `title` + `description`
- 新页有侧栏条目
- 正文链接写根绝对、不带 base、不带语言段;锚点按**目标语言页面的标题**写——插件只补 base
  与 `/en` 段,不翻译锚点
- 命令、配置键、默认值回到源码重新核对,别照抄旧文档

**没被改的文档也可能已经过期**:改动踩到命令名、配置键、默认值或工具清单时,用 grep 工具
(不要用 shell grep)反向搜旧值,范围 `website/src/content/docs`、`AGENTS.md`、
`website/CLAUDE.md`、`README.md`。

## 4. dev server 是否需要重启

```bash
node .claude/skills/docs-sync/scripts/dev-server-stale.mjs      # 在仓库根目录跑
```

脚本列出正在运行的 `astro dev` 进程、启动时间、`website/` 下最新源码文件的 mtime 与内容存储
`.astro/data-store.json` 的 mtime,给出 `OK` / `STALE`(落后时退出码 1)。

必须重启的三种情况:

- `website/astro.config.mjs` 在 server 启动之后改过(插件、主题、侧栏、locale)。HMR 不重载
  插件注入的样式表,现象是代码块整块无样式;remark 插件没挂上则正文里的站内链接全 404
- 内容文件在 server 启动之后被**新增、改名或移动**。长跑的 server 可能保留旧内容存储:新页面
  404,或 `/en/` 页面继续渲染中文回退
- 脚本报 `STALE`(dev server 的启动时间早于最新源码文件的 mtime)

重启:

```bash
cd website && npx astro dev stop     # 正规停机,会打印停掉的 pid
npm run dev -- --host 127.0.0.1      # 绑回环;只绑 ::1 时探活 127.0.0.1 会失败
```

被 hub 托管的 dev server(`hub op=ps` 里名为 `docs-dev`)用 `hub stop` / `hub start` 重启,
不要按 pid kill。

## 5. 验证浏览器真的看到了

```bash
curl -s http://localhost:4321/mojocode/<路径>/ | grep -c '<title>'
```

| 现象 | 含义 |
|---|---|
| `<html lang="en">` + 中文正文 + `not available in your language yet.` | Starlight 语言回退:英文页不在 dev server 的内容存储里。磁盘上有这个文件 → 重启;没有 → 补镜像页 |
| 新页面 404 | 文件在 server 启动后新增,或 slug 与文件路径不符 |
| 正文里的站内链接全 404 | `remark-base-links` 没生效——配置改动后没重启 |
| 页面能打开但侧栏里没有 | `astro.config.mjs` 少了 `{ slug }` |

## 6. 结论必须带证据

报告里写清:(a) 改了什么代码;(b) 更新了哪些文档,逐页给路径并注明中英;(c) 哪些文档判断为
不需要改、理由是什么;(d) dev server 启动时间对比最新源码 mtime,以及 curl 过哪些 URL。

没有 (b) 与 (d) 就不要说「文档已同步」。

文档站的门禁是 `cd website && npm run build`(Starlight 在构建时校验 frontmatter、侧栏 slug 与
组件导入)。它验证的是源码,不替代第 5 步。
