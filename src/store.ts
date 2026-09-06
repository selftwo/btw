import * as fs from "node:fs";
import * as path from "node:path";

export interface SideMessage {
	role: "user" | "assistant";
	text: string;
	ts: number;
	/** Model ref (provider/id) that produced this message, for assistant messages. */
	modelRef?: string;
}

export interface SideThread {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	/** Model ref (provider/id) pinned to this thread. Undefined = follow current main model. */
	modelRef?: string;
	messages: SideMessage[];
}

export function newThreadId(): string {
	const rand = Math.random().toString(36).slice(2, 8);
	return `btw_${Date.now().toString(36)}_${rand}`;
}

export function titleFromQuestion(q: string): string {
	const words = q.replace(/\s+/g, " ").trim().split(" ").slice(0, 7).join(" ");
	const t = words || "untitled";
	return t.length > 48 ? `${t.slice(0, 47)}…` : t;
}

export function slugify(s: string): string {
	const slug = s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return slug || "untitled";
}

function dayStamp(ts: number): string {
	const d = new Date(ts);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function threadFileName(thread: SideThread): string {
	return `${dayStamp(thread.createdAt)}-${slugify(thread.title)}-${thread.id.slice(-6)}.md`;
}

/**
 * In-memory thread list with JSON-file persistence.
 *
 * One file per pi session, located via pi's own getAgentDir() — no
 * hardcoded paths. Session-scoped (not global) so `/resume` shows the
 * btw chats that belong to that session — the "go back to all btw
 * chats in that session" requirement. The agent-queryable markdown
 * mirror lives in the project's btw/ directory (see btw-files.ts).
 */
export class SideStore {
	private threads: SideThread[] = [];
	private file: string | null = null;

	load(file: string): void {
		this.file = file;
		try {
			if (!fs.existsSync(file)) {
				this.threads = [];
				return;
			}
			const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as { threads?: SideThread[] };
			this.threads = Array.isArray(raw.threads) ? raw.threads : [];
		} catch {
			this.threads = [];
		}
	}

	persist(): void {
		if (!this.file) return;
		try {
			fs.mkdirSync(path.dirname(this.file), { recursive: true });
			fs.writeFileSync(this.file, JSON.stringify({ version: 1, threads: this.threads }, null, 2), "utf-8");
		} catch {
			/* best effort — session memory still works */
		}
	}

	list(): SideThread[] {
		return [...this.threads].sort((a, b) => b.updatedAt - a.updatedAt);
	}

	count(): number {
		return this.threads.length;
	}

	get(id: string): SideThread | undefined {
		return this.threads.find((t) => t.id === id);
	}

	create(firstQuestion?: string): SideThread {
		const now = Date.now();
		const t: SideThread = {
			id: newThreadId(),
			title: firstQuestion ? titleFromQuestion(firstQuestion) : "new sidechat",
			createdAt: now,
			updatedAt: now,
			messages: [],
		};
		this.threads.push(t);
		this.persist();
		return t;
	}

	touch(thread: SideThread): void {
		thread.updatedAt = Date.now();
		if (thread.messages.length > 0 && thread.title === "new sidechat") {
			const first = thread.messages.find((m) => m.role === "user");
			if (first) thread.title = titleFromQuestion(first.text);
		}
		this.persist();
	}

	lastAssistantText(thread: SideThread, n = 1): string | undefined {
		const answers = thread.messages.filter((m) => m.role === "assistant");
		const msg = answers[answers.length - n];
		return msg?.text;
	}
}
