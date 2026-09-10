---
title: LSP 诊断回喂
description: write / edit 之后把语言服务器的错误与警告随工具结果喂回模型。
---

agent 每次 `write` / `edit` 成功后,`lsp` 扩展把文件交给对应语言的 LSP 服务器,将**错误与警告**(不含 info / hint)随工具结果一并回喂给模型:改坏了当场就知道,不用等到跑 `tsc` 或测试才发现。工具卡片的摘要也会带上错误数(如 `1 处替换 · 2 个 LSP 错误`)。

内置识别四个服务器,**装了就用,没装就静默跳过**,绝不自动下载,也绝不因此报错:

| 语言 | 命令 | 安装 |
|---|---|---|
| TypeScript / JavaScript | `typescript-language-server` | `npm i -g typescript-language-server typescript@5`(工作区 node_modules 里有 typescript@5 也行;tsls 尚不支持 typescript@7) |
| Python | `pyright-langserver` | `npm i -g pyright` |
| Go | `gopls` | `go install golang.org/x/tools/gopls@latest` |
| Rust | `rust-analyzer` | `rustup component add rust-analyzer` |

服务器按需惰性拉起(首次检查多付一次握手时间),拉不起来的本会话不再重试。

## 配置

```json
{
  "lsp": {
    "enabled": true,
    "timeoutMs": 3000,
    "servers": {
      "typescript": { "enabled": false },
      "rust-analyzer": { "graceMs": 3000 },
      "clangd": { "command": "clangd", "extensions": [".c", ".cc", ".cpp", ".h"] }
    }
  }
}
```

| 键 | 说明 |
|---|---|
| `enabled` | `false` 整体关闭 |
| `timeoutMs` | 单次等诊断的时长,超时不打扰模型 |
| `servers.<id>.command` / `args` | 可执行与参数;内置 id(`typescript` `pyright` `gopls` `rust-analyzer`)只写要覆盖的字段,自定义条目至少要 `command` 和 `extensions` |
| `servers.<id>.extensions` | 接管的文件扩展名,含点;覆盖内置条目时整组替换 |
| `servers.<id>.enabled` | `false` 禁用该服务器 |
| `servers.<id>.graceMs` | 收到空诊断批次后再等后续批次的时长。rust-analyzer 与 gopls 先发空批次占位,内置宽限分别 1500 / 1000ms(其余 400ms),大项目上漏报「有错」时调大 |

全局与项目配置按服务器 id 合并。

## 跨文件连带错误

改了 A 的签名、之前检查过的 B 的调用点炸了,结果里会带一行 `src/b.ts: 2 errors(本次改动可能弄坏了它)`。只报本会话检查过的文件,全工程分析器顺手推送的存量问题不算。

## doctor

`mojocode doctor` 的「LSP 诊断」分节逐个列出合并后的服务器。命令不在 PATH 上时,内置服务器报 info(没装是常态),用户显式配置的条目告警;在 PATH 上的会做一次真握手探测(拉起、initialize、随即杀掉),因为只查存在性抓不住「装了个坏的」。`--offline` 跳过探测;TUI 的 `/doctor` 对会话内已拉起的服务器直接采信运行状态,不重复拉起。
