# Repository Guidelines

## Project Structure & Module Organization

- `index.mjs` — CLI to translate Angular i18n XLF files via OpenAI.
- `messages.xlf` — sample source file; `messages.en-US.translated.xlf` — example output.
- `.i18n-cache.json` — SHA-256 keyed translation cache (safe to reuse across runs).
- `package.json`, `package-lock.json` — Node project metadata; `node_modules/` — deps.

## Build, Test, and Development Commands

- Install deps: `npm install` (or `npm ci` in CI).
- Run CLI: `node index.mjs <path/to/messages.xlf> -t en -m gpt-4o -b 25 -c 3 [--clobber] [--no-verbose]`.
  - Creates/updates `messages.<lang>.xlf` alongside the source file.
  - Tip: `chmod +x index.mjs` then `./index.mjs ...` works due to shebang.
- Environment: set `OPENAI_API_KEY` before running, e.g. `export OPENAI_API_KEY=sk-…`.

- NPM scripts:
  - Translate: `npm run translate -- -t fr` (outputs `messages.fr.xlf`).
  - Smoke check: `npm test` (or `npm run smoke`) validates `target-language` and presence of `<target>`.
  - Lint: `npm run lint` (auto-fix with `npm run lint:fix`).
  - Format: `npm run format` (Prettier write) or `npm run format:check`.

## Coding Style & Naming Conventions

- Language: Node.js (ES Modules in `.mjs`), target Node 18+.
- Indentation: 2 spaces; keep semicolons; prefer double quotes in JS.
- Naming: functions `lowerCamelCase`; constants `UPPER_SNAKE_CASE`; CLI flags `kebab-case`.
- XML output: pretty-printed, 2-space indent preserved by `xml2js.Builder`.
- Lint/Format: ESLint + Prettier configured in repo.

## Testing Guidelines

- No formal test suite yet. Validate by:
  - Running on `messages.xlf` and confirming `messages.<lang>.xlf` is created/updated.
  - Checking console counts ("Found N translation units") and verbose logs of submissions/results.
  - Optional: XML sanity check `xmllint --noout messages.<lang>.xlf` if available.

## Commit & Pull Request Guidelines

- Use Conventional Commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`.
- PRs should include:
  - What changed and why, exact run command(s), and before/after snippet(s) for a few units.
  - Any impacts to flags, caching, or output file naming.

## Security & Configuration Tips

- Never commit API keys. Provide `OPENAI_API_KEY` via env/secret store.
- Tune `--batch` and `--concurrency` to manage rate limits and cost; cache reduces repeat spend.
- `.i18n-cache.json` can be committed for reproducibility or ignored if ephemeral.

## Architecture Overview

- Parse XLF → detect source lang (OpenAI) → batch-translate → update `<trans-unit>` targets → rebuild XML.
- Cache key: `sha256(sourceText)`; concurrency via `p-limit`.

## Agent-Specific Instructions

- Keep CLI flags stable; add new ones without breaking existing names.
- Preserve XML structure and notes; never alter placeholder tags.
- If changing output format or defaults, update these guidelines and examples.
