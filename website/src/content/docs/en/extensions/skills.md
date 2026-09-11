---
title: Skills
description: Reusable instruction packages following the agentskills.io standard.
---

Skills are reusable instruction packages following the open [agentskills.io](https://agentskills.io) standard: one directory per skill, entered through `SKILL.md` (YAML frontmatter plus a Markdown body). Existing skills from the Claude Code / opencode ecosystem work as is.

Discovery directories, in priority order:

```
<project>/.mojocode/skills/<name>/SKILL.md    project level (can be committed)
~/.mojocode/skills/<name>/SKILL.md            global
<project>/.claude/skills/<name>/SKILL.md      Claude Code project skills, for compatibility
~/.claude/skills/<name>/SKILL.md              Claude Code global skills, for compatibility
skills directories declared in a package manifest  lowest priority
```

Smallest example (`~/.mojocode/skills/release/SKILL.md`):

```markdown
---
description: Publish a new release. Use when the user asks to release, tag or update the changelog.
argument-hint: "[version]"
---

Publish a version following these steps for $0:
1. Get npm test and npm run typecheck passing
2. Update CHANGELOG.md and the version in package.json
3. Commit and tag v$0
```

## Two entry points

- **The model loads them**: a skill's name and description live permanently in the description of the built-in `skill` tool (a few dozen tokens each); the model loads the body itself when it judges it relevant.
- **Slash invocation**: skill names appear in the `/` completion menu, `/release 1.2.0` expands the body and starts a turn (`$ARGUMENTS`, `$0` to `$N` are replaced with the arguments), and `-p "/release 1.2.0"` works in scripts too.

`/skills` forces a rescan and lists every skill; normal additions, edits and deletions take effect within 15 seconds. A skill whose name collides with a built-in command does not enter the menu; built-in commands win.

## frontmatter fields

| Field | Notes |
|---|---|
| `name` | defaults to the directory name; if written it must match the directory name |
| `description` | required, the model uses it to decide when to load the skill |
| `argument-hint` | the argument hint in the completion menu |
| `disable-model-invocation: true` | only the user may trigger it with a slash command - right for side-effecting flows such as releasing or deploying |
| `user-invocable: false` | only the model may load it - right for background knowledge |
| `context: fork` | the body runs in a subagent with its own context and only the report returns to the main conversation, through the same channel as the `task` tool |

Unknown fields are ignored, Claude Code's `allowed-tools` included: mojocode has no permission system, so there is nothing to pre-authorise. A skill directory may carry supporting files such as `references/` or `scripts/`; `read` / `glob` reach them directly.

:::caution[Safety note]
A skill body is instructions fed to the model, with the same prompt-injection surface as any executable content that arrives with a repository. Use only skills you wrote or reviewed; `/skills` and `mojocode doctor` both list the active skills and their source directories.
:::
