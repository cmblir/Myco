---
title: "Source: Getting Started with Memex"
type: source-summary
tags:
  - memex
  - onboarding
created: 2026-06-22
last_updated: 2026-06-22
source_count: 1
confidence: high
status: active
---

# Source: Getting Started with Memex

A short onboarding note that ships with the repository as a sample source. It
introduces what Memex is and how its ingest workflow turns Markdown sources into
a cross-referenced wiki.

## Key points

- Memex maintains a wiki over a folder of plain Markdown files; an LLM reads
  sources and writes/updates pages with inline citations.[^src-getting-started]
- The core loop is *drop a source → ingest → pages are created or updated*, with
  every claim traceable to its source and a 3D graph view of the connections.[^src-getting-started]
- The vault is just Markdown on disk, so there is no lock-in and the user keeps
  full ownership of their data; model backends are pluggable (local CLI, hosted
  API, or offline Ollama).[^src-getting-started]

## Why it ships

This page exists so a fresh checkout has a coherent, self-made sample to ingest
and render — it carries no third-party material.

[^src-getting-started]: [[getting-started|Getting Started with Memex]]
