import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { threadFileName, type SideThread } from "./store.ts";

/** Notebook directory name. Plain `btw/` — no dotfile, no hidden magic. */
export const BTW_DIR_NAME = "btw";

const BTW_README = `# btw — sidechat notebook

This directory is the writable home for pi's btw (\`/btw\`).
The main repo stays read-only during btw chats; anything worth keeping
— ideas, streams, collected notes, follow-ups — lands here on request.

Layout:

- \`threads/\` — one markdown file per btw thread (auto-saved mirror).
- \`notes/\` — things you explicitly asked to keep (\`/btw-save\`, \`Ctrl+S\`,
  or "save this" inside a btw chat).
- \`index.json\` — machine-readable index of threads + notes.

Every file carries YAML frontmatter (id, title, timestamps, model,
session) so it is trivially agent-queryable:

\`\`\`bash
# find every btw thread that mentions retries
grep -ril "retry" btw/threads/ btw/notes/
# newest notes first
ls -t btw/notes/
# what did I discuss in this session?
grep -l "<session-id>" btw/threads/*.md
# structured overview
cat btw/index.json
\`\`\`

Safe to commit or to gitignore — your call. Suggested: commit \`notes/\`,
gitignore \`threads/\` if they feel ephemeral.
`;

export interface BtwMeta {
	sessionId: string;
	cwd: string;
}

/** Nearest git root, falling back to cwd. The "btw repo at root level". */
export function findBtwRoot(cwd: string): string {
	try {
		const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf-8", timeout: 5000 });
		const root = (r.stdout || "").trim();
		if (r.status === 0 && root) return root;
	} catch {
		/* not a git repo */
	}
	return cwd;
}

export function ensureBtwDir(cwd: string): string {
	const dir = path.join(findBtwRoot(cwd), BTW_DIR_NAME);
	fs.mkdirSync(path.join(dir, "threads"), { recursive: true });
	fs.mkdirSync(path.join(dir, "notes"), { recursive: true });
	const readme = path.join(dir, "README.md");
	if (!fs.existsSync(readme)) {
		try {
			fs.writeFileSync(readme, BTW_README, "utf-8");
		} catch {
			/* ignore */
		}
	}
	return dir;
}

function yamlEscape(s: string): string {
	if (/[:#\n"'[\]{}&*!|>]/.test(s) || s.trim() !== s || s === "") {
		return JSON.stringify(s);
	}
	return s;
}

function frontmatter(fields: Record<string, string | number | undefined>): string {
	const lines = ["---"];
	for (const [k, v] of Object.entries(fields)) {
		if (v === undefined) continue;
		lines.push(`${k}: ${yamlEscape(String(v))}`);
	}
	lines.push("---", "");
	return lines.join("\n");
}

function threadMarkdown(thread: SideThread, meta: BtwMeta): string {
	const fm = frontmatter({
		kind: "btw-thread",
		id: thread.id,
		title: thread.title,
		created: new Date(thread.createdAt).toISOString(),
		updated: new Date(thread.updatedAt).toISOString(),
		model: thread.modelRef ?? "main",
		session: meta.sessionId,
		cwd: meta.cwd,
		messages: thread.messages.length,
	});
	const body = thread.messages
		.map((m) => {
			const who = m.role === "user" ? "You" : `btw${m.modelRef ? ` (${m.modelRef})` : ""}`;
			const when = new Date(m.ts).toISOString();
			return `## ${who} · ${when}\n\n${m.text.trim()}\n`;
		})
		.join("\n");
	return `${fm}\n# ${thread.title}\n\n${body}`;
}

/** Mirror a thread into btw/threads/. Returns the file path. */
export function writeThreadFile(btwDir: string, thread: SideThread, meta: BtwMeta): string {
	const file = path.join(btwDir, "threads", threadFileName(thread));
	try {
		fs.writeFileSync(file, threadMarkdown(thread, meta), "utf-8");
		updateIndex(btwDir);
	} catch {
		/* ignore */
	}
	return file;
}

/** Save a note into btw/notes/. Returns the file path. */
export function saveNoteFile(
	btwDir: string,
	title: string,
	body: string,
	meta: BtwMeta & { model?: string; sourceThread?: string },
): string {
	const stamp = new Date().toISOString().slice(0, 10);
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	const file = path.join(btwDir, "notes", `${stamp}-${slug || "note"}.md`);
	const fm = frontmatter({
		kind: "btw-note",
		title,
		created: new Date().toISOString(),
		model: meta.model ?? "main",
		session: meta.sessionId,
		cwd: meta.cwd,
		source_thread: meta.sourceThread,
	});
	try {
		fs.writeFileSync(file, `${fm}\n# ${title}\n\n${body.trim()}\n`, "utf-8");
		updateIndex(btwDir);
	} catch {
		/* ignore */
	}
	return file;
}

interface IndexEntry {
	file: string;
	title: string;
	updated: string;
	model?: string;
	session?: string;
	messages?: number;
}

function scanMarkdown(dir: string): IndexEntry[] {
	const out: IndexEntry[] = [];
	let files: string[] = [];
	try {
		files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
	} catch {
		return out;
	}
	for (const f of files) {
		try {
			const full = path.join(dir, f);
			const stat = fs.statSync(full);
			const head = fs.readFileSync(full, "utf-8").slice(0, 1500);
			const title = head.match(/^title:\s*(.+)$/m)?.[1]?.replace(/^"|"$/g, "") ?? f;
			const updated = head.match(/^updated:\s*(.+)$/m)?.[1] ?? stat.mtime.toISOString();
			const model = head.match(/^model:\s*(.+)$/m)?.[1]?.replace(/^"|"$/g, "");
			const session = head.match(/^session:\s*(.+)$/m)?.[1];
			const messages = Number(head.match(/^messages:\s*(\d+)/m)?.[1]);
			out.push({
				file: f,
				title,
				updated,
				model: model || undefined,
				session: session || undefined,
				messages: Number.isFinite(messages) ? messages : undefined,
			});
		} catch {
			/* skip unreadable */
		}
	}
	return out.sort((a, b) => (a.updated < b.updated ? 1 : -1));
}

/** Rebuild btw/index.json so agents can query without parsing markdown. */
export function updateIndex(btwDir: string): void {
	try {
		const index = {
			version: 1,
			updated: new Date().toISOString(),
			threads: scanMarkdown(path.join(btwDir, "threads")),
			notes: scanMarkdown(path.join(btwDir, "notes")),
		};
		fs.writeFileSync(path.join(btwDir, "index.json"), JSON.stringify(index, null, 2), "utf-8");
	} catch {
		/* ignore */
	}
}
