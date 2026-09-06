# btw

Ask without interrupting the main thread.

`btw` is a pi extension that adds a Claude Code `/btw`-style side channel with
Grok Build-flavoured TUI ergonomics: a right-side panel you can open **at any
point — even mid-turn** — that answers from the session's existing context
while the main task keeps running. The exchange never enters the main
transcript, so a tangent can't become an accidental instruction.

## Why this shape (research notes)

**Claude Code `/btw`** (terminal / Desktop / VS Code panel):

- Single-turn side question over *already-gathered* session context
  (earlier messages, replies, tool results). No tool access, no new
  investigation, no edits.
- Runs while the main turn is processing; answer appears in a dismissible
  overlay, kept out of the primary transcript.
- Recent side exchanges stay navigable in session memory; a useful tangent
  escalates by forking into a real session.
- Desktop opens with `Cmd+;` / `Ctrl+;`.

**Grok Build CLI** (best TUI details, stolen with love):

- `/btw <message>` — "send an aside without interrupting the main task".
- `Ctrl+;` / `Ctrl+'` toggle the prompt queue; `Ctrl+.` / `Ctrl+X` shortcut help.
- `/copy [N|path]` — copy a recent response or write it to a file.
- `Enter` queues a follow-up mid-turn, `Ctrl+Enter`/`Ctrl+I` steers immediately.
- `Ctrl+U` / `Ctrl+D` half-page scroll; `y` copies in vim scrollback mode.
- Minimal vs fullscreen TUI, `/transcript` in `$PAGER`, modal pickers for
  sessions/models/extensions.

`btw` keeps Claude's safety boundary (read-only, no autonomous tools, never
pollutes the main thread) and adds what both lack: **per-btw model choice,
one-key copy, a revisitable per-session history, and a plain-markdown
`btw/` notebook** with frontmatter + `index.json` so any agent can query it
with `grep`/`read`.

## Install

pi auto-discovers extensions, no build step (loaded via jiti):

```bash
# global (all projects)
mkdir -p ~/.pi/agent/extensions
cp -r /path/to/btw ~/.pi/agent/extensions/btw

# or project-local
mkdir -p .pi/extensions
cp -r /path/to/btw .pi/extensions/btw
```

Then `/reload` (or restart pi). No dependencies beyond what pi ships with.
No hardcoded paths — session state resolves through pi's own agent dir,
and the notebook is a plain `btw/` folder at the repo root (git root when
available, otherwise cwd). Nothing hidden, nothing dotfile-based.

## Use

| What | How |
|---|---|
| Ask btw | `/btw <question>` or `Ctrl+;` (fallback `Ctrl+'`), then type |
| Ask mid-turn | Same — the panel opens over streaming output; main turn continues |
| Copy last answer | `Ctrl+Y` inside the panel, or `/btw-copy [n]` anywhere |
| Save answer to notebook | `Ctrl+S` inside the panel, or `/btw-save [title]` |
| Different model for this btw | `Ctrl+L` inside the panel, or `/btw --model <ref> <question>` |
| Default model for new btw | `/btw-model [ref]` (may differ from main chat; main chat never changes) |
| Revisit btw in this session | `/btw-list`, or `Ctrl+N` / `Ctrl+P` inside the panel, or `/threads` in-panel |
| New btw in-panel | `/new [question]` |
| Dismiss | `Esc` (clears input first; `Esc` while thinking cancels the btw request) |
| Scroll transcript | `Ctrl+U` / `Ctrl+D` (also `PgUp`/`PgDn` where the terminal delivers them) |
| In-panel help | `/help` |

`Ctrl+;` needs a terminal speaking the Kitty keyboard protocol; if yours
doesn't deliver it, remap in `~/.pi/agent/keybindings.json` or just use
`/btw` (the command always works).

Non-interactive modes (`-p`, `--mode json`) have no overlay: `/btw <question>`
runs single-shot and reports the answer via notification instead.

## The `btw/` notebook

Created lazily at the repo root on first save/answer — never uninvited:

- `btw/threads/` — auto-saved mirror of every btw thread, one file each.
- `btw/notes/` — things you explicitly kept (`Ctrl+S`, `/btw-save`, "save this").
- `btw/index.json` — machine-readable index (titles, timestamps, models,
  sessions, message counts).

Every file carries YAML frontmatter (`kind`, `id`, `title`, `created`,
`updated`, `model`, `session`, `cwd`), so agents query it with zero tooling:

```bash
grep -ril "retry" btw/threads/ btw/notes/   # every btw mentioning retries
ls -t btw/notes/                             # newest kept notes first
grep -l "<session-id>" btw/threads/*.md     # btw from one session
cat btw/index.json                           # structured overview
```

Commit `btw/notes/`, gitignore `btw/threads/` — or commit both. Your call.

## Design boundaries (on purpose)

- **Read-only in the repo.** btw calls the model directly with a snapshot of
  the main thread — it has no tools, so it cannot read new files, run
  commands, or edit code. If it needs something it hasn't seen, it says what
  exact prompt to ask the main thread.
- **Writes only to `btw/`, only on request.** Saves happen through explicit
  actions (`Ctrl+S`, `/btw-save`, "save this"), never autonomously.
- **One-way context.** btw sees a snapshot of the main thread (last ~40
  messages, capped ~18k chars — *not* the response still streaming). The main
  thread never sees btw. Escalate a tangent by asking the main chat, or fork.
- **Per-session history.** btw threads persist per pi session, so `/resume`
  brings its btw back too.

## Roadmap

- `--read` mode: a bounded tool loop (read/grep/find/ls only, writes still
  confined to `btw/`) enforced with a `tool_call` gate — for questions that
  need one fresh file, not a full main-thread detour.
- Streaming tokens into the panel (currently a thinking indicator, then the
  full answer — same pattern as pi's `qna` example).
- `btw export <id>` to clipboard/file a whole thread (Grok `/export` parity).
