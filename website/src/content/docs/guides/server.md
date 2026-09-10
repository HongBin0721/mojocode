---
title: server 模式
description: client-server 进程模型,以及手动拉起、远程连接。
---

TUI 默认以 client-server 方式运行,与 opencode 相同的进程模型:启动时自动拉起一个受管的 `mojocode serve --managed` 子进程,agent 核心、工具、扩展、MCP、LSP、会话存储都在 server 侧,TUI 只是经 HTTP + SSE 连接的瘦客户端。日常使用完全透明;需要时也可以手动操作:

```bash
mojocode serve                          # 独立运行 server,打印地址与 token
MOJOCODE_SERVER_TOKEN=<token> mojocode --attach http://127.0.0.1:<port>
                                        # 另开终端,把 TUI 连到已运行的 server
MOJOCODE_NO_SERVER=1 mojocode           # 排障逃生口:回到单进程模式
```

## 安全边界

server 默认只绑定 `127.0.0.1`,每个请求都要 Bearer token:它能执行任意命令,必须挡住本机上其他程序与浏览器页面的盲发请求。`--host` 可以改绑定地址,但明文 HTTP 暴露到局域网意味着任何能连上的人都能在你的机器上跑 bash,请只在清楚风险时这么做。

密钥不过线:server 推给客户端的配置快照里,`providers.*.apiKey`、`search.apiKey` 与 `mcpServers.*.env` / `.headers` 都被抹成空串。唯一的反向例外是 TUI 的服务商选择器里刚输入的 key 随切换请求送到 server,而且只在环回或 https 传输上允许。

## 断线与恢复

SSE 流的每一帧都带递增 id,server 保留一段回放缓冲;客户端断线重连时带上最后收到的 id 即可无缝续上,连正在跑的那一轮的结果都不会丢。缓冲被滚过时客户端会提示「转录可能不完整」并刷新状态。

受管子进程在父进程退出(stdin 关闭或 ppid 消失)时自动退出;它意外崩溃时退出码、信号与 stderr 尾部会作为错误显示在 TUI 里,而不只是一句「连接断开」。

## 谁在用它

- TUI:默认拉起受管子进程。
- 桌面 GUI(`apps/desktop`,Electron):每个任务一个 sidecar,同一套协议。
- `-p` 非交互模式**不走** server,保持单进程与管道语义。
