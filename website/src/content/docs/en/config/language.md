---
title: Language
description: English and Simplified Chinese, and why model-facing text stays English.
---

The interface ships in English and Simplified Chinese. Resolution order: the `language` config → `MOJOCODE_LANG` → the system `LC_ALL` / `LANG` (any `zh*` maps to zh-CN). While running, pick "Language" in the `/setting` panel to switch immediately and persist the choice.

Text fed back to the model (tool errors, veto reasons) deliberately stays English: it is part of the prompt, and mixing languages degrades function calling. Extension authors writing `tool_call` veto reasons should stay English too.

The language files live in `src/i18n/`, with a parity test asserting both catalogs have the same keys; adding a language takes one file and one union member.
