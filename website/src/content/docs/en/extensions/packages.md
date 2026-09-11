---
title: Packages
description: mojocode install / remove and the package directory conventions.
---

```bash
mojocode install npm:@someone/mojocode-ext        # installs into ~/.mojocode/packages/npm/
mojocode install npm:@someone/mojocode-ext@1.2.0  # pin a version
mojocode install git:https://github.com/x/y.git   # clones into ~/.mojocode/packages/git/y
mojocode install ./my-ext                         # a local directory: loaded in place, not copied
mojocode install … --local                        # installs into <project>/.mojocode and records the project config
mojocode remove y                                 # uninstall by name (npm package / repo / directory)
mojocode extensions                               # list extensions and packages
```

Installing records the spec under the config key `packages` (global, or the project layer with `--local`; the two layers are unioned); at startup each spec is resolved to a directory on disk, its manifest read, and the extensions and skills inside loaded. Project `.mojocode/packages` comes before global. A package recorded in the config but absent from disk produces a single startup notice.

`remove` ignores scope: both install directories and both config layers are cleaned, and a layer is only written back when it actually records that spec - it never creates an empty project config out of nowhere.

## The shape of a package

A package is a directory with an optional manifest section in `package.json`:

```json
{
  "name": "@someone/mojocode-ext",
  "mojocode": {
    "extensions": ["extensions", "index.ts"],
    "skills": ["skills"],
    "prompts": ["prompts"],
    "themes": ["themes"]
  }
}
```

The four resource kinds have the same names as Pi's package manifest: `extensions` lists files or directories (directories are scanned by the extension-directory rules); `skills` lists skill directories (every `<name>/SKILL.md` inside joins the skill table, with lower priority than local skills); `prompts` lists prompt-template directories; `themes` lists theme directories. Without a manifest the convention applies: `extensions/`, `index.ts` at the root, `skills/`, `prompts/`, `themes/`. Paths that are listed but do not exist are skipped silently.

### Prompt templates

Every `*.md` in a `prompts/` directory (and in `~/.mojocode/prompts/` or `<project>/.mojocode/prompts/`) is a `/name` command for the user alone - it is a skill with a flat directory and no obligations: frontmatter is optional, `name` defaults to the file name, `description` defaults to the first line of the body, `argument-hint` works as in a skill; `$1` / `$ARGUMENTS` substitution follows the same rules. On a name clash a skill wins; project directory beats global directory beats package.

```markdown
---
description: Write unit tests for a function
argument-hint: <file>
---
Write unit tests for $ARGUMENTS, covering the edge cases.
```

### Themes

Every `<name>.json` in a `themes/` directory (and in `<project>/.mojocode/themes/` or `~/.mojocode/themes/`) is a theme; the config key `theme: "<name>"` names the one applied at startup, and `/theme <name>` switches at runtime. The picker lists every theme found and previews the highlighted one as you move the cursor (esc restores the committed theme); the choice is written to whichever config layer already holds `theme` (project if it does, global otherwise). While a theme is active its file is watched: saving it repaints at once. `default` is a reserved name for the built-in palette - `/theme default` restores it and removes the config key. `colors` only needs the keys you want to change, the rest keep the built-in palette; available keys: `accent` `user` `assistant` `dim` `tool` `error` `warn` `success` `added` `removed` `diffAddedBg` `diffAddedFg` `diffRemovedBg` `diffRemovedFg` `code`. Values are named colours or `#rrggbb`.

```json
{ "name": "dusk", "colors": { "accent": "#7aa2f7", "user": "#bb9af7", "code": "#7dcfff" } }
```

A missing named theme or a broken file does not block startup: once the TUI is up you get a notice and the built-in palette stays.

Extensions from a package get their id prefixed with `<package>/` so they cannot collide with local ones.
