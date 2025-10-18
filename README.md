# Angular i18n XLF Translator (OpenAI)

Translate Angular `messages.xlf` files into one or more locales using OpenAI models. The CLI is designed to plug into a typical Angular i18n workflow, preserving structure and existing translations while smartly updating only what’s needed.

## Features

- Angular‑ready XLIFF 1.2: reads `messages.xlf`, writes `messages.<lang>.xlf`.
- Smart updates: preserves existing `<target>` nodes unless `--clobber` is used.
- Multi‑language runs: `-t en,es,fr,de` or alias packs `-t west|east`.
- Unique batching: de‑duplicates and sorts source strings; translates unique set.
- Language‑aware cache: `<src>|<tgt>|<model>|sha256(text)` prevents cross‑locale bleed.
- Context strategies: `--context none|lang|run` to reuse chat context (capped to last 5 Q/A pairs).
- Verbose tracing: `--verbose` prints submitted strings and returned translations.
- Progress feedback: concise progress bar per language.

## Requirements

- Node.js 18+
- OpenAI API key in `OPENAI_API_KEY`

## Quick Start

1. Extract i18n messages from Angular

- `ng extract-i18n` (produces `messages.xlf`)

2. Install and run

- Local: install deps `npm install`
- Global (optional): `npm i -g .` then use `trans` or `i18n-translator` directly
- Single language: `node index.mjs messages.xlf -t fr` or `trans messages.xlf -t fr`
- Multiple: `node index.mjs messages.xlf -t en,es,fr,de`
- Packs: `node index.mjs messages.xlf -t west` (→ `pt,en,es,fr,de`), `-t east` (→ `jp,ko,zh,ar`), or `-t all`

Outputs are saved next to the source as `messages.<lang>.xlf` with `<file target-language="...">` set.

## CLI Options

- `-t, --target <langs>`: Comma‑separated languages or alias `west|east` (default: `en`).
- `-m, --model <model>`: OpenAI model (default: `gpt-4o`).
- `-b, --batch <size>`: Batch size for unique strings (default: `50`).
- `--clobber`: Overwrite existing `<target>` values.
- `--verbose`: Print submitted strings and returned translations.
- `--context <strategy>`: `none` (default), `lang`, or `run` (alias `all`).
- `--cache <file>`: Cache path (default: `.i18n-cache.json`).
- `--clean-cache`: Remove cache file before running.
- `-s, --source <lang>`: Specify source language and skip detection.

## How It Works

1. Parse source XLF and detect source language (full-corpus detection; prompts if unsure, or use `--source`).
2. Collect all `<trans-unit>` sources, trim/sort, and de‑duplicate.
3. Prewarm cache from existing targets (unless `--clobber`).
4. Translate only cache misses, in batches. Optional context reuse per `--context`.
5. Apply translations to every unit; ensure each unit has a `<target>`.
6. Write `messages.<lang>.xlf` with structure preserved.

## Caching Details

- Nested JSON structure per source/target/model: entries[src][tgt][model][sha256(text)] = translation.
- Migrates old flat cache keys `<src>|<tgt>|<model>|<hash>` on first run.
- Cache file: `.i18n-cache.json` can be committed for reproducibility or ignored.
- Global installs default to `~/.trans/cache.json`. Local runs still use `.i18n-cache.json` if present.

## Examples

- Update French only: `node index.mjs messages.xlf -t fr`
- Refresh Spanish with overwrite: `node index.mjs messages.xlf -t es --clobber`
- Multi‑lang, per‑lang context: `node index.mjs messages.xlf -t en,es,fr --context lang`
- Run‑wide context with tracing: `node index.mjs messages.xlf -t west --context run --verbose`

## Validation & Tooling

- Smoke test: `npm test` (or `npm run smoke`) checks `target-language` and `<target>` presence.
- Lint: `npm run lint` (auto‑fix: `npm run lint:fix`).
- Format: `npm run format` or `npm run format:check`.

## Troubleshooting

- “Missing OPENAI_API_KEY”: set `export OPENAI_API_KEY=sk-...` before running.
- Rate limits/costs: lower `--batch`, reduce `--context`, or rely on cache hits.
- Placeholders: tags like `<x id="INTERPOLATION_1"/>` are preserved by the prompt; report any anomalies.
- Invalid XLF: run `xmllint --noout messages.<lang>.xlf` to check well‑formedness.
