---
title: "Memex"
type: entity
tags:
  - memex
  - product
created: 2026-06-22
last_updated: 2026-06-22
source_count: 1
confidence: high
status: active
---

# Memex

Memex is a desktop application that maintains a living, cross-referenced wiki
over a folder of plain Markdown files.[^src-getting-started] The human curates
sources and asks questions; an LLM maintainer reads the sources, writes and
updates wiki pages, keeps citations accurate, and links related ideas.[^src-getting-started]

## How it works

The core workflow is *drop a source into the vault → run an ingest → the
relevant pages are created or updated with inline citations back to that
source*.[^src-getting-started] A 3D graph view renders how every page connects,
so clusters of related topics become visible as the vault grows.[^src-getting-started]

## Design principles

- **Plain files, no lock-in.** The vault is Markdown on disk; the same folder
  opens in any editor and syncs however the user likes.[^src-getting-started]
- **Pluggable models.** Backends include the local Claude / Gemini / Codex CLI
  (on an existing subscription), a hosted API key, or a fully offline Ollama
  model.[^src-getting-started]
- **Traceable claims.** Every factual statement on a page cites the source it
  came from.[^src-getting-started]

## See also

- [[getting-started|Getting Started with Memex]] — the onboarding source
- [[source-getting-started]] — its summary

[^src-getting-started]: [[getting-started|Getting Started with Memex]]
