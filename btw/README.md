# btw — sidechat notebook

This directory is the writable home for pi's btw (`/btw`).
The main repo stays read-only during btw chats; anything worth keeping
— ideas, streams, collected notes, follow-ups — lands here on request.

Layout:

- `threads/` — one markdown file per btw thread (auto-saved mirror).
- `notes/` — things you explicitly asked to keep (`/btw-save`, `Ctrl+S`,
  or "save this" inside a btw chat).
- `index.json` — machine-readable index of threads + notes.

Every file carries YAML frontmatter (id, title, timestamps, model,
session) so it is trivially agent-queryable:

```bash
# find every btw thread that mentions retries
grep -ril "retry" btw/threads/ btw/notes/
# newest notes first
ls -t btw/notes/
# what did I discuss in this session?
grep -l "<session-id>" btw/threads/*.md
# structured overview
cat btw/index.json
```

Safe to commit or to gitignore — your call. Suggested: commit `notes/`,
gitignore `threads/` if they feel ephemeral.
