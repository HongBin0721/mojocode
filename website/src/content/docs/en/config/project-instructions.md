---
title: Project instructions
description: AGENTS.md / MOJOCODE.md injected into the system prompt.
---

Put an `AGENTS.md` (or `MOJOCODE.md`) at the project root and its content is injected into the system prompt - the place to declare project conventions: build commands, code style, directories not to touch, how to run the tests.

`/init` analyses the codebase and generates or improves this file; `-p "/init"` works in scripts too.

To append a fixed block of instructions on every project, use the config key `systemPromptAppend`.
