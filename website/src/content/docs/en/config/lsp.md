---
title: LSP diagnostics
description: Feed language-server errors and warnings back after write / edit.
---

After every successful `write` / `edit`, the `lsp` extension hands the file to the language server for that language and feeds its **errors and warnings** (not info / hint) back to the model with the tool result: breakage shows up right away instead of after you run `tsc` or the tests. The tool card summary carries the error count too (for example `1 replacement · 2 LSP errors`).

Four servers are recognised out of the box; **an installed one is used, a missing one is skipped silently** - nothing is ever downloaded, and nothing ever errors because of it:

| Language | Command | Install |
|---|---|---|
| TypeScript / JavaScript | `typescript-language-server` | `npm i -g typescript-language-server typescript@5` (a typescript@5 in the workspace node_modules works too; tsls does not support typescript@7 yet) |
| Python | `pyright-langserver` | `npm i -g pyright` |
| Go | `gopls` | `go install golang.org/x/tools/gopls@latest` |
| Rust | `rust-analyzer` | `rustup component add rust-analyzer` |

Servers are started lazily on demand (the first check pays the handshake once), and a server that failed to start is not retried for the rest of the session.

## Configuration

```json
{
  "lsp": {
    "enabled": true,
    "timeoutMs": 3000,
    "servers": {
      "typescript": { "enabled": false },
      "rust-analyzer": { "graceMs": 3000 },
      "clangd": { "command": "clangd", "extensions": [".c", ".cc", ".cpp", ".h"] }
    }
  }
}
```

| Key | Notes |
|---|---|
| `enabled` | `false` turns the whole thing off |
| `timeoutMs` | how long to wait for diagnostics once; timing out does not bother the model |
| `servers.<id>.command` / `args` | executable and arguments; for a built-in id (`typescript` `pyright` `gopls` `rust-analyzer`) write only the fields you want to override, a custom entry needs at least `command` and `extensions` |
| `servers.<id>.extensions` | file extensions it takes over, dot included; overriding a built-in entry replaces the whole set |
| `servers.<id>.enabled` | `false` disables that server |
| `servers.<id>.graceMs` | how long to keep waiting for further batches after an empty one. rust-analyzer and gopls send an empty batch first; their built-in grace is 1500 / 1000ms (400ms for the rest) - raise it if a large project misses "there are errors" |

Global and project config merge by server id.

## Cross-file fallout

Change A's signature and a call site in B that was checked earlier explodes: the result carries a line `src/b.ts: 2 errors (this change may have broken it)`. Only files this session has checked are reported; pre-existing problems a whole-project analyser happens to push over do not count.

## doctor

`mojocode doctor`'s "LSP diagnostics" section lists the merged servers one by one. When a command is not on PATH a built-in server reports info (not having it installed is normal) while a user-configured entry warns; a server that is on PATH gets a real handshake probe (start, initialize, kill right away), because checking existence alone cannot catch "installed a broken one". `--offline` skips the probe; the TUI's `/doctor` trusts the state of servers already started in the session instead of starting them again.
