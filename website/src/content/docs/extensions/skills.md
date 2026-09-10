---
title: 技能
description: 遵循 agentskills.io 标准的可复用指令包。
---

技能是可复用的指令包,遵循 [agentskills.io](https://agentskills.io) 开放标准:一个目录一个技能,入口是 `SKILL.md`(YAML frontmatter 加 Markdown 正文)。Claude Code / opencode 生态里现成的技能可以直接拿来用。

发现目录按优先级:

```
<项目>/.mojocode/skills/<名字>/SKILL.md    项目级(可提交进仓库)
~/.mojocode/skills/<名字>/SKILL.md         全局
<项目>/.claude/skills/<名字>/SKILL.md      兼容 Claude Code 的项目技能
~/.claude/skills/<名字>/SKILL.md           兼容 Claude Code 的全局技能
扩展包 manifest 里声明的 skills 目录          优先级最低
```

最小示例(`~/.mojocode/skills/release/SKILL.md`):

```markdown
---
description: 发布一个新版本。用户要求发版、打 tag 或更新 changelog 时使用。
argument-hint: "[版本号]"
---

按以下步骤发布版本 $0:
1. 跑通 npm test 与 npm run typecheck
2. 更新 CHANGELOG.md 与 package.json 的版本号
3. 提交并打 tag v$0
```

## 两个入口

- **模型自主调用**:技能的 name 与 description 常驻在内置 `skill` 工具的描述里(每个只占几十 token),模型判断相关时自己加载正文。
- **斜杠直接调用**:技能名出现在 `/` 补全菜单里,`/release 1.2.0` 直接展开正文发起一轮(`$ARGUMENTS`、`$0` 到 `$N` 被替换成参数),`-p "/release 1.2.0"` 在脚本里同样可用。

`/skills` 强制重扫并列出全部技能;平时的增删改在 15 秒内自动生效。与内置命令同名的技能不进菜单,内置命令优先。

## frontmatter 字段

| 字段 | 说明 |
|---|---|
| `name` | 缺省取目录名,写了必须与目录名一致 |
| `description` | 必填,模型据此判断何时用 |
| `argument-hint` | 补全菜单里的参数提示 |
| `disable-model-invocation: true` | 只允许用户斜杠触发,适合发版、部署这类有副作用的流程 |
| `user-invocable: false` | 只允许模型加载,适合背景知识 |
| `context: fork` | 正文交给子 agent 在独立上下文里执行,只把报告带回主对话,走 `task` 工具同一条通道 |

未知字段一律忽略,Claude Code 的 `allowed-tools` 也在其列:mojocode 没有权限系统,没有东西可以预授权。技能目录里可以放 `references/`、`scripts/` 等附属文件,`read` / `glob` 直接够得着。

:::caution[安全提示]
技能正文是喂给模型的指令,与随仓库而来的任何可执行内容一样存在提示注入面。只使用你自己写的或审阅过的技能;`/skills` 与 `mojocode doctor` 都会列出当前生效的技能及其来源目录。
:::
