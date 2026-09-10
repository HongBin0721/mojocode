---
title: 非交互模式
description: 脚本、管道与 CI 里用 -p 单次执行。
---

```bash
mojocode -p "找出所有 TODO 注释并汇总"          # 单次执行,结果输出到 stdout
mojocode -p "分析这段报错" --provider deepseek  # 指定服务商
mojocode -p "..." --json                        # stderr 输出 NDJSON 事件流
cat error.log | mojocode -p "分析这个日志"       # 配合管道
mojocode -p "/init"                             # 生成 AGENTS.md
mojocode -p "/release 1.2.0"                    # 斜杠调用一个技能
```

`-p` 不走 client-server,保持单进程与管道语义:stdout 只有最终回答,`--json` 时 stderr 逐行输出 `AgentEvent`(text-delta、tool-start、tool-end、turn-end 等),便于脚本消费。

## 步数上限

单轮步数默认**不设上限**,取向与 Claude Code 一致:交互场景有人盯着,`esc` 就是刹车,上下文失控由轮内自动压缩兜底。无人值守想加保险丝就用 `--max-steps <n>`(或配置 `maxSteps`):撞上会截停当前轮并提示,续发一条消息即从断点接着干,新轮重新计步。

子 agent 另有独立的 `taskMaxSteps`(默认 50),不随主轮的「默认无上限」走,见[子任务](/features/subagents/)。

## 在 CI 里

```bash
mojocode doctor --offline || exit 1          # 环境门禁:有 ✗ 项就退出 1
mojocode -p "/review base main" --json       # 评审当前分支相对 main 的改动
```

密钥用环境变量给(`DEEPSEEK_API_KEY` 等,见[快速开始](/guides/quickstart/#环境变量)),不要把 `~/.mojocode/config.json` 提交进仓库。
