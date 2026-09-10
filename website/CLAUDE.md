# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

这是 mojocode 的官方文档站(Astro 7 + Starlight 0.42 + `starlight-theme-black`),补充根目录 `CLAUDE.md` 里关于 `website/` 的那一段。**它是独立包**:自带 `package.json` / lockfile / tsconfig,不在根 workspaces 里,根目录的 `build` / `typecheck` / `test` 永远碰不到它。文档正文、代码注释与 commit 信息一律简体中文(英文页面除外)。

## 命令

```bash
npm ci                     # 依赖只在这个目录装,与根目录 node_modules 无关
npm run dev                # 本地预览 http://127.0.0.1:4321/mojocode/(带 base 前缀)
npm run build              # 唯一的门禁:astro build → dist/,53 页约 2s,含 Pagefind 搜索索引
npm run preview            # 预览 dist/
node scripts/gen-logo.mjs  # 重新生成像素字 logo 与 favicon(改过 src/ui/logo.ts 之后)
```

`npm run check`(`astro check`)**当前不可用**:`@astrojs/check` 与 `typescript` 没装,运行时会弹交互式安装提示;它不是门禁,CI 也不跑。判断改动是否正确就跑 `npm run build`——Starlight 会在构建时校验 frontmatter schema、侧栏 slug 是否存在与组件导入。**改了 `astro.config.mjs` 里的插件(主题、expressive-code 配置)要重启 dev 服务器**:热更新只跟内容与样式,插件注入的样式表不重载,曾表现为代码块整块无样式。

部署:`.github/workflows/docs.yml` 在 push 到 main 且 `website/**` 有改动时(或手动 dispatch)`npm ci && npm run build`,把 `website/dist` 发到 GitHub Pages。仓库 Settings → Pages → Source 必须是「GitHub Actions」(已设置)。

## 结构

- `src/content.config.ts`:唯一的内容集合 `docs`,用 Starlight 的 `docsLoader()` + `docsSchema()`,没有自定义字段。
- `src/content/docs/**/*.md(x)`:页面。**slug 由文件路径决定**(`guides/tui.md` → `/guides/tui/`),但侧栏不是自动生成的——`astro.config.mjs` 里的 `sidebar` 手写了每一条 `{ slug }`,新页面必须同时加进去,否则只能靠搜索到达;写错的 slug 会让 build 失败。侧栏分组标签用 `translations: { en: … }` 给英文。
- 语言:`defaultLocale: 'root'`(中文在根路径,`lang: zh-CN`),英文在 `en/` 下**同 slug 镜像**(`src/content/docs/en/guides/quickstart.md`)。英文缺页时 Starlight 自动用中文内容渲染并加一条「not available in your language yet」提示,所以英文是逐页补的,不需要一次翻完;`hreflang` 与语言切换器都是 Starlight 自动生成。
- `src/components/`:首页专用组件——`Hero.astro`(像素字 + 一句话 + 安装命令 + 两个入口)、`Terminal.astro`(深色终端窗口,正文经 `set:html` 传入)、`Feature.astro`(左文右图的一整行,`flip` 反过来并交换列宽)、`Wordmark.astro`(内联 SVG)。`demos.ts` 是终端窗口里的会话文本(中英各一份)。
- `src/assets/wordmark.svg` 与 `public/favicon.svg` 是**生成物**:`scripts/gen-logo.mjs` 用正则从根目录 `src/ui/logo.ts` 抠出点阵字模与渐变端点(`FROM`/`TO`),逐字渐变画成 SVG。不要手改这两个文件。
- `plugins/remark-base-links.mjs`:正文链接补 base,见下。
- `src/styles/custom.css`:站点级微调(首页容器加宽、隐藏首页的主题标题区与页脚、顶栏 logo 尺寸、表格里 code 不换行)。**它是普通 CSS,不能写 `:global()`**——那是 Astro scoped style 的语法,普通样式表里整条规则会被浏览器静默丢弃,曾让顶栏 logo 卡在主题的 32px 上限。
- `.astro/`、`dist/`、`node_modules/` 都在 `.gitignore` 里。

## 主题与外观

- 底座是 `starlight-theme-black`(在 `plugins` 里装配):Geist Sans / Geist Mono 字体、顶栏 `navLinks`、正文页的 Copy page 与上下页按钮、expressive-code 的 vesper / github-light 双主题。配色由它提供,`custom.css` 不再定义 accent token。
- 默认深色:`head` 里一段脚本在 Starlight 的主题脚本之前把 `localStorage['starlight-theme']` 置为 `dark`(仅当用户没设过);用户切过之后以用户为准。终端窗口组件始终深色,不跟随明暗切换——它画的是产品真实的样子。
- 顶栏 logo 用 `logo: { src: wordmark.svg, replacesTitle: true }`;主题把 img 压到 32px,`custom.css` 用 `!important` 按 `1.05rem` 高度覆盖。
- 首页是 `template: splash` 但**不写 `hero` frontmatter**——正文就是上面那些组件;主题会照常渲染 h1/描述/Copy page,由 `body:has(.hero) .page-title { display:none }` 隐藏。首页 `<title>` 会变成 `mojocode | mojocode`,所以 `index.mdx` 用 `head: [{ tag: title, content: … }]` 覆盖,只有首页需要。
- 终端窗口里的文本**照抄 TUI 的真实格式**:行首符号来自 `src/ui/theme.ts` 的 `glyphs`(`›` `⏺` `⎿` `✻` `▣`),工具摘要措辞来自 `src/i18n/zh-CN.ts` 的 `sum.*`(「读取 84,共 84 行」「1 处替换」「退出码 0 · 耗时 3.8s」)。TUI 改了行格式,`demos.ts` 要跟着改。颜色类名 `u/d/t/ok/err/warn/b/add/del` 在 `Terminal.astro` 里定义,`add`/`del` 是 diff 底色。

## 链接规则(最容易踩的坑)

站点部署在 GitHub Pages 的项目子路径下,`astro.config.mjs` 里 `site = https://hongbin0721.github.io`、`base = /mojocode`。Astro 只给侧栏与组件里的链接补 base,**Markdown 正文里的链接原样输出**,不处理就全站 404。解决方式是 `plugins/remark-base-links.mjs`:在 remark 阶段把正文里的根绝对链接(`link` 与 `definition` 节点)加上 `/mojocode` 前缀,文件路径含 `/content/docs/en/` 的再加 `/en`。由此推出三条写法:

1. **正文链接一律写不带 base、不带语言段的站内路径**:`[配置](/config/overview/)`,中英文页面同一份写法。带 `//`、协议、锚点、或已带 `/mojocode/` 前缀的链接插件不动。
2. **frontmatter 与组件 props 里的链接不经 remark**(首页 `index.mdx` 传给 `<Hero>` 与 `<Feature href>` 的路径),要手写完整路径:中文 `/mojocode/guides/quickstart/`,英文 `/mojocode/en/guides/quickstart/`。
3. 换自定义域名只改 `astro.config.mjs` 的 `site` / `base` 两行,正文与插件都不用动。

这个插件挂在 **legacy 的 `@astrojs/markdown-remark` 处理器**上运行——Astro 7 默认的 Markdown 处理器不跑 remark 插件——这就是 `@astrojs/markdown-remark` 出现在 devDependencies 里的唯一理由,不要当成无用依赖删掉。

## 页面写作约定

- 文档是用户侧的真实来源,**从当前代码写,不从旧 README 抄**(旧 README 在权限系统上早已失真;根目录 README 现在只是一个链到本站的短入口)。改功能的 PR 里同步改对应文档页。
- 每页 frontmatter 只需 `title` + `description`;`description` 会进 `<meta name="description">` 与 og 标签。
- 除首页外全是普通 `.md`;Starlight 的 `:::note` / `:::tip` / `:::caution` 侧栏提示在 `.md` 里直接可用,不必改成 mdx。
- 中文标点风格与仓库其他文档一致:正文用中文标点,代码、路径、命令与选项名保持原样放在反引号里;斜杠命令与快捷键写成 `` `/think` `` `` `ctrl+t` ``。
- 扩展示例里的 `api` 不标类型:npm 包不附带 `.d.ts`,`import type { ExtensionAPI } from 'mojocode'` 目前不成立,页面注明类型在 `src/core/extension.ts`。
