---
title: 界面语言
description: 英文与简体中文,以及为什么喂给模型的文本始终是英文。
---

界面内置英文和简体中文。解析顺序:配置 `language` → `MOJOCODE_LANG` → 系统 `LC_ALL` / `LANG`(任何 `zh*` 都映射到 zh-CN)。运行中在 `/setting` 设置面板里选「语言」即时切换并落盘。

回喂给模型的文本(工具报错、否决原因)刻意保持英文:那是 prompt 的一部分,混语言会影响 function calling 质量。扩展作者写 `tool_call` 的否决原因时也请用英文。

语言文件在 `src/i18n/`,有 parity 测试保证两份目录键位对齐,新增语言只需加一个文件和一个联合类型成员。
