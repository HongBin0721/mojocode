---
title: 构建、测试与发布
description: 本地开发命令、CI 门禁与发版流程。
---

```bash
git clone https://github.com/HongBin0721/mojocode.git
cd mojocode
npm install
npm run build       # tsup → dist/cli.js
npm run dev         # 监听改动自动重新打包
node dist/cli.js    # 运行构建产物,或 npm link 后直接 mojocode
```

## 质量门

没有 lint 配置,`typecheck` 与测试是唯一的门:

```bash
npm run typecheck   # tsc --noEmit(tsup 不做类型检查;开了 noUnusedLocals / noUnusedParameters)
npm test            # 核心测试,Node 下跑(排除 tests/ui/)
npm run test:ui     # UI 测试,必须在 Bun 下跑:OpenTUI 真渲染 + 模拟键盘
```

UI 测试需要 Bun 是因为 OpenTUI 的测试渲染器就是真实的原生渲染器(FFI)。CI 在 Node 矩阵上跑 typecheck 与核心测试,Bun job 跑 UI 测试与单二进制冒烟。

## 单二进制

需要 [Bun](https://bun.sh),只在构建时用:

```bash
npm run build                                              # 先出 dist/cli.js
npm run build:bin -- --target=darwin-arm64 --no-archive    # 只编本机平台
npm run build:bin                                          # 全 6 平台 + tar.gz/zip + SHA256SUMS
```

产物在 `dist/bin/`。版本号在编译期注入。交叉编译需要目标平台的 `@opentui/core-<platform>` 包,脚本按需安装,不要把它们钉进 package.json(各自声明了 os / cpu,裸 `npm ci` 会在每台机器上 EBADPLATFORM)。

## 发布

两条线互不依赖:二进制靠 tag 触发 CI,npm 手动发。

```bash
npm version minor -m "release: v%s"   # bump + commit + 打 v* tag
git push --follow-tags                # 触发 release.yml:测试 → build → 6 平台交叉编译 → 草稿 Release
# 到 GitHub Releases 页把草稿 Publish 出去;不做这步 install.sh 会 404

npm login && npm publish              # prepublishOnly 跑 typecheck + test + test:ui + build,本机必须有 Bun
```

## 文档站

本站在 `website/`,独立包,Astro Starlight:

```bash
cd website
npm install
npm run dev         # 本地预览
npm run build       # 产物在 website/dist/
```

push 到 main 且 `website/**` 有改动时,`.github/workflows/docs.yml` 自动部署到 GitHub Pages。中文页面在 `src/content/docs/`,英文在 `src/content/docs/en/` 同名镜像,缺页自动回退中文。

## 约定

- 代码注释与 README 用简体中文。
- 界面文案走 `src/i18n/`,两份目录有 parity 测试;喂给模型的文本保持英文。
- 模型 id 一律不硬编码,预设只是起点。
- 仓库根的 `CLAUDE.md` 记录了架构不变量与踩过的坑,改核心前先读。
