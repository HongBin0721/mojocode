# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

这是 mojocode 的官方文档站（Astro 7 + Starlight 0.42），补充根目录 `CLAUDE.md` 里关于 `website/` 的那一段。**它是独立包**：自带 `package.json` / lockfile / tsconfig，不在根 workspaces 里，根目录的 `build` / `typecheck` / `test` 永远碰不到它。文档正文、代码注释与 commit 信息一律简体中文（英文页面除外）。

## 命令

```bash
npm ci              # 依赖只在这个目录装，与根目录 node_modules 无关
npm run dev         # 本地预览（astro dev）
npm run build       # 唯一的门禁：astro build → dist/，53 页约 2s，含 Pagefind 搜索索引
npm run preview     # 预览 dist/
```

`npm run check`（`astro check`）**当前不可用**：`@astrojs/check` 与 `typescript` 没装，运行时会弹交互式安装提示；它不是门禁，CI 也不跑。判断改动是否正确就跑 `npm run build`——Starlight 会在构建时校验 frontmatter schema、侧栏 slug 是否存在与 `<Card>` 等组件导入。

部署：`.github/workflows/docs.yml` 在 push 到 main 且 `website/**` 有改动时（或手动 dispatch）`npm ci && npm run build`，把 `website/dist` 发到 GitHub Pages。仓库 Settings → Pages → Source 必须是「GitHub Actions」。

## 结构

- `src/content.config.ts`：唯一的内容集合 `docs`，用 Starlight 的 `docsLoader()` + `docsSchema()`，没有自定义字段。
- `src/content/docs/**/*.md(x)`：页面。**slug 由文件路径决定**（`guides/tui.md` → `/guides/tui/`），但侧栏不是自动生成的——`astro.config.mjs` 里的 `sidebar` 手写了每一条 `{ slug }`，新页面必须同时加进去，否则只能靠搜索到达；写错的 slug 会让 build 失败。侧栏分组标签用 `translations: { en: … }` 给英文。
- 语言：`defaultLocale: 'root'`（中文在根路径，`lang: zh-CN`），英文在 `en/` 下**同 slug 镜像**（`src/content/docs/en/guides/quickstart.md`）。英文缺页时 Starlight 自动用中文内容渲染并加一条「This content is not available in your language yet.」提示，所以英文是逐页补的，不需要一次翻完；`hreflang` 与语言切换器都是 Starlight 自动生成。
- `public/favicon.svg`、`src/styles/custom.css`（只有品牌色 token——与 TUI logo 同一青→紫色系——和「表格里的 code 不换行」两条规则）。`src/components/` 与 `scripts/` 目前为空目录。
- `.astro/`、`dist/`、`node_modules/` 都在 `.gitignore` 里。

## 链接规则（最容易踩的坑）

站点部署在 GitHub Pages 的项目子路径下，`astro.config.mjs` 里 `site = https://hongbin0721.github.io`、`base = /mojocode`。Astro 只给侧栏与组件里的链接补 base，**Markdown 正文里的链接原样输出**，不处理就全站 404。解决方式是 `plugins/remark-base-links.mjs`：在 remark 阶段把正文里的根绝对链接（`link` 与 `definition` 节点）加上 `/mojocode` 前缀，文件路径含 `/content/docs/en/` 的再加 `/en`。由此推出三条写法：

1. **正文链接一律写不带 base、不带语言段的站内路径**：`[配置](/config/overview/)`，中英文页面同一份写法。带 `//`、协议、锚点、或已带 `/mojocode/` 前缀的链接插件不动。
2. **frontmatter 里的链接不经 remark**（例如首页 `index.mdx` 的 `hero.actions[].link`），要手写完整路径：中文 `/mojocode/guides/quickstart/`，英文 `/mojocode/en/guides/quickstart/`。
3. 换自定义域名只改 `astro.config.mjs` 的 `site` / `base` 两行，正文与插件都不用动。

这个插件挂在 **legacy 的 `@astrojs/markdown-remark` 处理器**上运行——Astro 7 默认的 Markdown 处理器不跑 remark 插件——这就是 `@astrojs/markdown-remark` 出现在 devDependencies 里的唯一理由，不要当成无用依赖删掉。

## 页面写作约定

- 文档是用户侧的真实来源，**从当前代码写，不从旧 README 抄**（旧 README 在权限系统上早已失真；根目录 README 现在只是一个链到本站的短入口）。改功能的 PR 里同步改对应文档页。
- 每页 frontmatter 只需 `title` + `description`；`description` 会进 `<meta name="description">` 与 og 标签。Starlight 默认把 `<title>` 渲染成 `页面标题 | mojocode`，首页的标题就是站名会变成 `mojocode | mojocode`，所以 `index.mdx` 用 `head: [{ tag: title, content: … }]` 覆盖——只有首页需要这样做。
- 首页是 `template: splash` + `<CardGrid>`/`<Card>`（来自 `@astrojs/starlight/components`，在 mdx 里 import），其他页面全是普通 `.md`。
- 中文标点风格与仓库其他文档一致：正文用中文标点，代码、路径、命令与选项名保持原样放在反引号里；斜杠命令与快捷键写成 `` `/think` `` `` `ctrl+t` ``。
