---
title: 会话文件格式
description: ~/.mojocode/sessions/ 下 JSONL 的记录类型。
---

每个会话是一个追加写入的 JSONL 文件 `~/.mojocode/sessions/<id>.jsonl`,每行一条记录,`kind` 区分类型;旁边的 `<id>.meta.json` 是同内容的元数据副本,让列表操作不必读整个文件。旧版本读到未知 `kind` 一律静默跳过,格式向后兼容。

| kind | 内容 | 谁写 |
|---|---|---|
| `meta` | `{ id, root, provider, model, createdAt, updatedAt, title, messageCount, archivedAt? }` | 创建、改名、归档、切模型时 |
| `append` | 上次保存之后新增的消息 | 每步之后,历史是纯扩展时 |
| `snapshot` | 全量替换的消息数组;`display` 字段只在与 `messages` 不同时出现 | 压缩或回退让历史不再是旧历史的扩展时 |
| `state` | 会话级状态,目前是 `changedFiles`(本会话 write / edit 落地过的文件) | 变化时 |
| `task` | 一次子任务的完整过程:`{ callId, description, mode, steps, tokens, finishReason, error, messages }` | 子任务结束 |
| `usage` | 一轮的用量:`{ provider, model, inputTokens, outputTokens, cachedInputTokens? }` | 每轮结束 |
| `custom` | 扩展的自定义记录 `{ type, data }`,核心不解释 | 扩展 `appendEntry` |
| `messages` | 旧格式的全量快照,只读兼容 | 不再写 |

## 两份历史

`messages` 面向模型,压缩会把前缀换成一段摘要;`displayMessages` 永不被压缩缩短,`/resume` 回放的是它。`snapshot` 记录只在两者不同时带 `display`;没有 `display` 的旧文件按形状重建。回退是真实删除,两份一起裁。

## 分叉

`/fork` 或 `--fork-session` 把当前历史、`state` 与全部 `custom` 记录整体带进新文件,原会话停在分叉点。扩展的状态(todo 清单、目标条件)与会话同属,分叉丢了它就等于分叉丢了 todo。

## 元数据

`title` 由首条用户消息生成;`archivedAt` 是时间戳,归档的会话仍在列表里由消费方过滤,启动清理也跳过它们。`provider` / `model` 只用于展示(会话选择器、`mojocode sessions`),恢复时不会切回去。
