# mojocode

一个运行在终端里的通用编程 agent,可接入任意大模型——内置 **Kimi**、**DeepSeek**、**GLM** 预设,也支持任何 OpenAI 兼容接口。

全屏 TUI 交互、真实的文件 / shell / 搜索工具、子 agent、会话持久化与上下文自动压缩、LSP 诊断回喂、MCP、Pi 式扩展。没有权限系统:边界交给运行环境,拦截交给扩展。

**完整文档:<https://hongbin0721.github.io/mojocode/>**(源码在 [`website/`](website/))

## 安装

```bash
# 单二进制(推荐,免装 Node;macOS / Linux)
curl -fsSL https://raw.githubusercontent.com/HongBin0721/mojocode/main/install.sh | sh

# 或 npm(TUI 需 Node ≥ 26.1;-p 与子命令 Node ≥ 22)
npm install -g mojocode
```

Windows 到 [Releases](https://github.com/HongBin0721/mojocode/releases) 下载 `mojocode-windows-x64.zip`。

## 第一次使用

```bash
mojocode auth            # 交互式配置 API key(或设 DEEPSEEK_API_KEY / MOONSHOT_API_KEY / ZHIPU_API_KEY)
mojocode doctor          # 体检:环境、配置、密钥、端点连通
cd ~/你的项目
mojocode                 # 进入全屏 TUI,直接打字提需求
mojocode -p "找出所有 TODO 注释并汇总"   # 非交互,脚本 / 管道 / CI
```

## 文档导航

| 想了解 | 看这里 |
|---|---|
| 安装、密钥、第一次对话 | [快速开始](https://hongbin0721.github.io/mojocode/guides/quickstart/) |
| 快捷键与斜杠命令 | [TUI 交互](https://hongbin0721.github.io/mojocode/guides/tui/) |
| 配置文件全部字段 | [配置总览](https://hongbin0721.github.io/mojocode/config/overview/) |
| 服务商、自定义端点、思考档位 | [模型与服务商](https://hongbin0721.github.io/mojocode/config/providers/) |
| 写一个扩展、钩子与 API | [扩展](https://hongbin0721.github.io/mojocode/extensions/overview/) |
| 为什么没有权限系统 | [没有权限系统](https://hongbin0721.github.io/mojocode/features/permissions/) |
| 架构与会话格式 | [架构](https://hongbin0721.github.io/mojocode/reference/architecture/) |
| 构建、测试、发布 | [开发](https://hongbin0721.github.io/mojocode/dev/contributing/) |

## 开发

```bash
npm install && npm run build     # 打包到 dist/
npm run typecheck                # tsc --noEmit
npm test                         # 核心测试(Node)
npm run test:ui                  # UI 测试(需 Bun)
cd website && npm install && npm run dev   # 本地预览文档站
```

架构不变量与踩过的坑记录在 [`CLAUDE.md`](CLAUDE.md),改核心前先读。

## License

MIT
