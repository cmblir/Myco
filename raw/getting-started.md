# Getting Started with Memex

Memex turns a folder of plain Markdown files into a living, cross-referenced
wiki. You point it at a vault, and an LLM maintainer reads your sources, writes
and updates wiki pages, keeps citations accurate, and links related ideas so the
knowledge graph grows as you add material.

The workflow is simple: drop a source document into the vault, run an ingest,
and Memex produces or updates the relevant pages with inline citations back to
that source. Every factual claim is traceable to where it came from, and a 3D
graph view shows how every page connects, so clusters of related topics become
visible as the vault grows.

Because the vault is just Markdown on disk, you keep full control of your data.
There is no lock-in: open the same folder in any editor, sync it however you
like, and own everything the wiki contains. Models are pluggable — run the local
Claude/Gemini/Codex CLI on your existing subscription, a hosted API key, or a
fully offline Ollama model.

This page is a small self-contained sample so a fresh checkout has something to
ingest and render. Replace it with your own sources to start your own wiki.
