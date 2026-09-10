---
title: 项目指令
description: AGENTS.md / MOJOCODE.md 注入系统提示词。
---

在项目根放 `AGENTS.md`(或 `MOJOCODE.md`),内容会注入系统提示词,用来声明项目规范:构建命令、代码风格、禁改目录、测试怎么跑。

`/init` 会分析代码库并生成或改进这份文件;`-p "/init"` 在脚本里同样可用。

想在所有项目上追加一段固定指令,用配置的 `systemPromptAppend`。
