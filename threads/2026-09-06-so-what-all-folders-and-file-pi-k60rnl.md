---
kind: btw-thread
id: btw_mtq1ghkk_k60rnl
title: so what all folders and file pi
created: "2026-09-06T16:41:07.315Z"
updated: "2026-09-06T16:41:45.542Z"
model: main
session: 01a0778f-414e-7677-b463-e13208eeb0ce
cwd: /Users/benison/Documents/work/pi
messages: 2
---

# so what all folders and file pi

## You · 2026-09-06T16:41:07.318Z

so what all folders and file pi touches and can yo save one of this repose in amd file and share the path

## btw · 2026-09-06T16:41:45.542Z

## What pi touches

**Core config/state — `~/.pi/agent/`:**
- `settings.json` — models, theme, installed packages
- `auth.json` / `.env` — credentials & env vars
- `models-store.json`, `mcp-cache.json` — model & MCP state
- `AGENTS.md` — instructions loaded into context
- `sessions/` — session transcripts
- `extensions/` — global extensions (pi-cloak, web-tools, simple-footer, your `btw` symlink → `~/Documents/work/pi/btw`)
- `npm/` — npm-managed pi packages (subagents, intercom, mcp-adapter, speedometer, etc.)
- `git/`, `intercom/`, `bin/` (fd, rg), `trust.json`, `cloak.json`, `cursor-sdk*.json`
- `AGENTS.md` context dir: `~/.pi/agent/AGENTS.md`

**Install (read-only at runtime):**
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/` (the binary/bundle)

**Project-local:**
- `.pi/extensions/` per project (optional, per your README)
- `btw/notes/` in the repo root — where `/btw-save` files answers

## Saving this response

I'm the read-only side channel — I can't write files. Two ways:

1. **Use your own feature:** run `/btw-save pi-setup-diagnostic` in the main thread → it files this to `btw/notes/`.
2. Or ask the main thread: *"save the last btw answer as `btw/notes/pi-setup-diagnostic.md`"*.
