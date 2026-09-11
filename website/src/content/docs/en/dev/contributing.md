---
title: Build, test and release
description: Local development commands, CI gates and the release flow.
---

```bash
git clone https://github.com/HongBin0721/mojocode.git
cd mojocode
npm install
npm run build       # tsup → dist/cli.js
npm run dev         # watch and rebuild on change
node dist/cli.js    # run the built output, or npm link and call mojocode directly
```

## Quality gates

There is no lint config; `typecheck` and the tests are the only gates:

```bash
npm run typecheck   # tsc --noEmit (tsup does not typecheck; noUnusedLocals / noUnusedParameters are on)
npm test            # core tests, run under Node (excludes tests/ui/)
npm run test:ui     # UI tests, must run under Bun: the real OpenTUI renderer plus simulated keys
```

UI tests need Bun because OpenTUI's test renderer is the real native renderer (FFI). CI runs typecheck and the core tests on a Node matrix, and a Bun job runs the UI tests and a single-binary smoke test.

## Single binary

Requires [Bun](https://bun.sh), only at build time:

```bash
npm run build                                              # produce dist/cli.js first
npm run build:bin -- --target=darwin-arm64 --no-archive    # build only the local platform
npm run build:bin                                          # all 6 platforms + tar.gz/zip + SHA256SUMS
```

Output lands in `dist/bin/`. The version number is injected at compile time. Cross-compilation needs the target platform's `@opentui/core-<platform>` package; the script installs them on demand - do not pin them in package.json (they declare their own os / cpu, and a bare `npm ci` would hit EBADPLATFORM on every machine).

## Release

Two independent tracks: binaries are triggered by a tag in CI, npm is published by hand.

```bash
npm version minor -m "release: v%s"   # bump + commit + tag v*
git push --follow-tags                # triggers release.yml: tests → build → 6-platform cross-compile → draft Release
# Publish the draft on the GitHub Releases page; skipping this leaves install.sh 404ing

npm login && npm publish              # prepublishOnly runs typecheck + test + test:ui + build; Bun must be installed locally
```

## Documentation site

The site lives in `website/`, a separate package built on Astro Starlight:

```bash
cd website
npm install
npm run dev         # local preview
npm run build       # output in website/dist/
```

Pushing to main with changes under `website/**` makes `.github/workflows/docs.yml` deploy to GitHub Pages. Chinese pages live in `src/content/docs/`, English mirrors them under `src/content/docs/en/` with the same slugs, and a missing page falls back to Chinese automatically.

## Conventions

- Code comments and the README are in Simplified Chinese.
- User-facing strings go through `src/i18n/`, with a parity test over both catalogs; model-facing text stays English.
- Model ids are never hardcoded; presets are only a starting point.
- The repo's `CLAUDE.md` records architecture invariants and past traps - read it before changing the core.
