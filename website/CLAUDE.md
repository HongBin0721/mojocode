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
cd promo && npm ci && npm run make   # 重录首页宣传片(真实调用模型,见下方「结构」)
```

`npm run check`(`astro check`)**当前不可用**:`@astrojs/check` 与 `typescript` 没装,运行时会弹交互式安装提示;它不是门禁,CI 也不跑。判断改动是否正确就跑 `npm run build`——Starlight 会在构建时校验 frontmatter schema、侧栏 slug 是否存在与组件导入。**改了 `astro.config.mjs` 里的插件(主题、expressive-code 配置)要重启 dev 服务器**:热更新只跟内容与样式,插件注入的样式表不重载,曾表现为代码块整块无样式。

部署:`.github/workflows/docs.yml` 在 push 到 main 且 `website/**` 有改动时(或手动 dispatch)`npm ci && npm run build`,把 `website/dist` 发到 GitHub Pages。仓库 Settings → Pages → Source 必须是「GitHub Actions」(已设置)。

## 结构

- `src/content.config.ts`:唯一的内容集合 `docs`,用 Starlight 的 `docsLoader()` + `docsSchema()`,没有自定义字段。
- `src/content/docs/**/*.md(x)`:页面。**slug 由文件路径决定**(`guides/tui.md` → `/guides/tui/`),但侧栏不是自动生成的——`astro.config.mjs` 里的 `sidebar` 手写了每一条 `{ slug }`,新页面必须同时加进去,否则只能靠搜索到达;写错的 slug 会让 build 失败。侧栏分组标签用 `translations: { en: … }` 给英文。
- 语言:`defaultLocale: 'root'`(中文在根路径,`lang: zh-CN`),英文在 `en/` 下**同 slug 镜像**(`src/content/docs/en/guides/quickstart.md`)。英文缺页时 Starlight 自动用中文内容渲染并加一条「not available in your language yet」提示,所以英文是逐页补的,不需要一次翻完;`hreflang` 与语言切换器都是 Starlight 自动生成。
- `src/components/`:首页专用组件——`Hero.astro`(像素字 + 一句话 + 安装命令 + 两个入口)、`Terminal.astro`(深色终端窗口,正文经 `set:html` 传入)、`Feature.astro`(左文右图的一整行,`flip` 反过来并交换列宽)、`Wordmark.astro`(内联 SVG)、`Promo.astro`(Hero 下方的 15 秒静音循环宣传片,按语言取 `public/promo/promo-<lang>.{webm,mp4}` 与 `poster-<lang>.jpg`,系统「减少动态效果」时不自动播、改给控件)。`demos.ts` 是特性段终端窗口里的会话文本(中英各一份)。
- `promo/`:宣传片的生成工具,**又一个独立包**(自带 package.json / lockfile,只依赖 `puppeteer-core`;tsconfig 里 exclude 掉,构建不碰它)。`npm run make` 一条命令走完:在临时 HOME 里放示例项目 `promo/shop/`(横幅因此显示 `~/shop`,会话不落进你的 `~/.mojocode`)、只拷配置里的 `providers`(`language` 必须留空,否则 `MOJOCODE_LANG` 压不过它)→ VHS 真跑仓库根的 `dist/cli.js` → 帧哈希自动找剪辑点(开打前 16 帧到定稿后 1 秒,超出 9.5 秒预算就整体加速、角标如实写倍速)→ 无头 Chrome 逐帧调 `comp.html` 的 `render(t)` 截图 → ffmpeg 出 mp4/webm/poster。文案(标语、三条字幕、片尾)在 `comp.html` 的 `COPY` 里;只改文案或动效用 `--skip-record` 复用 `.work/` 里上一次的录屏(gitignore,约 250MB),`--still 1.8,6.5` 只出静帧。三个坑:vhs 0.12 配 ffmpeg 9 直接出视频会**静默**失败(退出码 0、没有文件),所以输出帧目录再自己合;macOS 的 tmpdir 是软链,临时 HOME 不 `realpath` 的话 TUI 显示不成 `~`;录的是 `dist/`,改完 TUI 先在仓库根 `npm run build`。每次录制是真实的模型调用(缺省 deepseek,`--provider`/`--model` 可换),模型的回答每次不一样,出片后看一眼 poster 再提交。
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

站点部署在 GitHub Pages 的项目子路径下,`astro.config.mjs` 里 `site = https://hongbin0721.github.io`、`base = /mojocode`。Astro 只给侧栏与组件里的链接补 base,**Markdown 正文里的链接原样输出**,不处理就全站 404。解决方式是 `plugins/remark-base-links.mjs`:在 remark 阶段把正文里的根绝对链接(`link` 与 `definition` 节点)加上 `/mojocode` 前缀,文件路径含 `/content/docs/en/` 的再加 `/en`。由此推出四条写法:

1. **正文链接一律写不带 base、不带语言段的站内路径**:`[配置](/config/overview/)`,中英文页面路径同一份写法(锚点见第 4 条)。带 `//`、协议、纯锚点(`#…`)、或已带 `/mojocode/` 前缀的链接插件不动。
2. **frontmatter 与组件 props 里的链接不经 remark**(首页 `index.mdx` 传给 `<Hero>` 与 `<Feature href>` 的路径),要手写完整路径:中文 `/mojocode/guides/quickstart/`,英文 `/mojocode/en/guides/quickstart/`。
3. 换自定义域名只改 `astro.config.mjs` 的 `site` / `base` 两行,正文与插件都不用动。
4. **锚点按目标语言页面的标题写**:插件只补 base 与 `/en` 段,不翻译锚点——英文页里的 `/config/providers/#vision-models` 对应英文页的 `## Vision models`,照抄中文页的 `#视觉模型` 会静默落到页首。

这个插件挂在 **legacy 的 `@astrojs/markdown-remark` 处理器**上运行——Astro 7 默认的 Markdown 处理器不跑 remark 插件——这就是 `@astrojs/markdown-remark` 出现在 devDependencies 里的唯一理由,不要当成无用依赖删掉。

## 页面写作约定

- 文档是用户侧的真实来源,**从当前代码写,不从旧 README 抄**(旧 README 在权限系统上早已失真;根目录 README 现在只是一个链到本站的短入口)。改功能的 PR 里同步改对应文档页。
- 每页 frontmatter 只需 `title` + `description`;`description` 会进 `<meta name="description">` 与 og 标签。
- 除首页外全是普通 `.md`;Starlight 的 `:::note` / `:::tip` / `:::caution` 侧栏提示在 `.md` 里直接可用,不必改成 mdx。
- 中文标点风格与仓库其他文档一致:正文用中文标点,代码、路径、命令与选项名保持原样放在反引号里;斜杠命令与快捷键写成 `` `/think` `` `` `ctrl+t` ``。
- 扩展示例里的 `api` 可以不标类型(例子更短),但**类型是真的能 import 的**:npm 包有 `exports['./extension']`,tsup 的第二个 entry 出 `dist/extension.d.ts`,写法是 `import type { ExtensionAPI } from 'mojocode/extension'`(不是裸 `'mojocode'`)。别再说「npm 包不附带 .d.ts」。
