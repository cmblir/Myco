# myco — Repository Guide

Development repo for myco, a local-first knowledge wiki.

## Layout

```
app/            # myco desktop app (Tauri 2 + React)
mcp-server/     # MCP server (28 tools) — shares the app's vault layout
clipper/        # web clipper (browser extension + bookmarklet)
automation/     # automated ingest scripts
templates/      # project vault templates
docs/           # user docs, screenshots, signing/release guide
```

## Rules

- The app (`app/`) follows its own conventions (tests, lint, i18n) — see
  `app/docs/specs/`.
- A user vault's `raw/` is **immutable** — never modify or delete through any
  path (app, MCP, agents). Read only.
- Commits in English, Conventional Commits (`<type>(<scope>): <subject>`).
- Gates: `cd app && npm run lint && npx tsc -b && npx vitest run`;
  Rust: `cd app/src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`.
