---
title: 会话
description: 恢复、分叉、回退与上下文压缩。
---

每场对话都以追加写入的 JSONL 保存在 `~/.mojocode/sessions/` 下,磁盘上的记录始终完整(压缩不会缩短它)。

## 恢复与分叉

```bash
mojocode -c                          # 继续本目录最近一次会话(--continue)
mojocode -r                          # 交互式选择要恢复的会话(--resume)
mojocode -r <id前缀>                  # 恢复指定会话;`mojocode sessions` 列出的 8 位前缀即可
mojocode -r <id前缀> --fork-session   # 载入历史但写入全新会话,原会话不再变动
mojocode sessions                    # 列出本目录的历史会话
mojocode sessions --all              # 所有目录的
```

TUI 内对应 `/resume`(二级选择器)与 `/fork`。恢复时完整回放时间线,并还原扩展的状态(todo 清单、未完成的 `/goal`);**模型不还原**,始终沿用当前配置的 provider / model。历史太长而当前模型的窗口更小时,首轮开始前会自动压缩一次。

超过 `cleanupPeriodDays`(默认 30 天)未活动的会话在启动时自动清理;已归档的会话不清理。

## 回退

空闲时连按两次 `esc` 打开回退选择器,选中一条历史消息即把对话截断到它之前,原文回到输入框,编辑后重发。这是真实的删除:模型历史与展示历史一起裁掉。想保留原对话就先 `/fork` 再回退。

## 上下文压缩

输入 token 超过上下文窗口的 `compactThreshold`(默认 80%)时,自动把较早的历史压缩成一段摘要继续;也可随时 `/compact`。压缩只影响发给模型的消息,磁盘记录与 `/resume` 回放看到的仍是原始对话。

上下文窗口来自服务商预设或 `providers.<id>.contextWindow`,也可按模型在 `providers.<id>.models[]` 里指定,或用 `--max-context` 强制覆盖(测试压缩逻辑时有用)。

## 两份历史

会话存储保存两份历史:`messages` 面向模型,压缩会把前缀换成摘要;`displayMessages` 永不被压缩缩短,`/resume` 回放的是它。回退是真实删除,两份一起裁。记录格式见[会话文件格式](/reference/session-format/)。
