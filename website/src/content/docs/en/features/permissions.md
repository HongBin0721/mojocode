---
title: No permission system
description: The boundary belongs to the runtime; interception belongs to extensions.
---

In line with [pi](https://github.com/badlogic/pi-mono), mojocode has **no permission system**: no sandbox levels, no confirmation prompts, no allow-or-deny rules, no plan mode. `read` / `write` / `edit` / `bash` reach any path the process can reach, and `web_fetch` reaches any address.

This is not laziness: it hands the question of "where the boundary is" back to the runtime. Run mojocode inside a container, a sandbox account or a disposable working copy - that is the fence that actually holds; an in-process permission gate only stops a polite model, never anything inside a `bash` command.

## To intercept, write an extension

The `tool_call` hook is called before every tool execution; returning `{ block: true, reason }` vetoes it - the error goes back to the model and the turn keeps going. The policy is entirely yours: by path, by command prefix, by domain, or with a confirmation prompt thrown in.

```ts
// <project>/.mojocode/extensions/guard.ts
export default (api) => {
  api.on('tool_call', ({ toolName, input }) => {
    const path = String((input as { path?: unknown }).path ?? '');
    if ((toolName === 'write' || toolName === 'edit') && path.startsWith('migrations/')) {
      return { block: true, reason: 'migrations/ is read-only in this project' };
    }
    return undefined;
  });
};
```

Keep veto reasons in English - that text is fed to the model. A throwing hook also counts as a veto, so a buggy interceptor never lets tools run bare. See [Extensions](/extensions/overview/#hooks) for the details.

## Old config

`sandbox` / `approval` / `permissions` / `permissionMode` keys from older versions, rule records in session files and a skill's `allowed-tools` frontmatter are all treated as unknown keys and ignored, without an error.
