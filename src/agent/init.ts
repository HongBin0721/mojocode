/**
 * `/init` 命令发给模型的指令(英文——喂给模型的文本按约定不本地化)。
 *
 * 首行是稳定标记:回放与回退列表据此把整段指令显示为 `/init`
 * (见 src/session/replay.ts),后续修改正文时不要动首行。
 */
export const INIT_PROMPT_MARKER =
  'Analyze this repository and create an AGENTS.md file at the workspace root.';

export const INIT_PROMPT = `${INIT_PROMPT_MARKER}

AGENTS.md is injected into the system prompt of coding agents working in this
repository (including you, on future runs), so write it in English, in
Markdown, for an agent audience.

What to cover:

1. Commands: how to build, lint, typecheck and run the tests — including how
   to run a single test file. Only list commands you have verified against the
   project manifest (package.json scripts, Makefile, CI config, ...).
2. Architecture: the big picture that takes reading several files to work
   out — the main modules, how they interact, and where key responsibilities
   live. Do not write an exhaustive directory listing.
3. Conventions: project-specific rules an agent must follow — code style,
   naming, comment language, i18n rules, testing patterns. Skip generic advice
   that applies to any codebase ("write tests", "handle errors").

How to work:

- Start from README.md, the project manifest and CI config. Incorporate any
  existing agent or editor rule files (CLAUDE.md, .cursorrules,
  .github/copilot-instructions.md, ...) rather than contradicting them.
- Keep it concise — roughly 20 to 60 lines. A few load-bearing facts beat
  completeness.
- If AGENTS.md already exists, improve it instead of rewriting it: keep what
  is accurate, fix what is stale, add what is missing.
- After writing the file, state in one or two sentences what you documented.`;

/**
 * 持久历史中的用户消息是否为 /init 指令。
 *
 * 要求首行"恰好"是标记(后接空行),而不只是以标记开头:用户自己写的
 * "Analyze this repository and create an AGENTS.md file at the workspace
 * root. 再说明发布流程" 的附加要求写在同一行,据此不会被误判——否则回退
 * 列表把它显示成 `/init`,重发时用户附加的要求就被悄悄丢掉了。
 */
export function isInitPrompt(text: string): boolean {
  return text.startsWith(`${INIT_PROMPT_MARKER}\n\n`);
}
