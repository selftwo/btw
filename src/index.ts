/**
 * btw — ask without interrupting the main thread.
 *
 * /btw <question>      ask btw (bottom sheet, main turn keeps running)
 * /btw-list            revisit every btw in this session
 * /btw-copy [n]        copy the last (or nth) btw answer to clipboard
 * /btw-save [title]    file the last btw answer to btw/notes/
 * /btw-model [ref]     default model for new btw (different from main is fine)
 *
 * Shortcuts: Ctrl+; (or Ctrl+') toggles btw. Inside the panel:
 * Ctrl+Y copy · Ctrl+L model · Ctrl+S save · Ctrl+N/P switch · Esc close.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { copyTextToClipboard } from "./clipboard.ts";
import { buildMainContextSnapshot, buildSideSystemPrompt } from "./context.ts";
import { ensureBtwDir, saveNoteFile, writeThreadFile } from "./btw-files.ts";
import { BtwSheet, type BtwCloseResult } from "./panel.ts";
import { SideStore, type SideThread } from "./store.ts";

const STATUS_KEY = "btw";

// --- session-scoped state (rebound on session_start, survives /reload) ---

let store = new SideStore();
let sessionId = "";
let sessionCwd = "";
let defaultModelRef: string | undefined;

function btwStateDir(): string {
	return path.join(getAgentDir(), "btw", "sessions");
}

function defaultModelFile(): string {
	return path.join(getAgentDir(), "btw", "default-model.json");
}

function loadDefaultModel(): void {
	try {
		const raw = JSON.parse(fs.readFileSync(defaultModelFile(), "utf-8")) as { ref?: string };
		defaultModelRef = typeof raw.ref === "string" && raw.ref.includes("/") ? raw.ref : undefined;
	} catch {
		defaultModelRef = undefined;
	}
}

function bindSession(ctx: ExtensionContext): void {
	try {
		sessionId = ctx.sessionManager.getSessionId() || "ephemeral";
	} catch {
		sessionId = "ephemeral";
	}
	sessionCwd = ctx.cwd;
	store.load(path.join(btwStateDir(), `${sessionId}.json`));
	loadDefaultModel();
	updateStatus(ctx);
}

function updateStatus(ctx: ExtensionContext): void {
	try {
		const n = store.count();
		ctx.ui.setStatus(STATUS_KEY, n > 0 ? `btw · ${n}` : undefined);
	} catch {
		/* ignore */
	}
}

function meta() {
	return { sessionId, cwd: sessionCwd };
}

/** Mirror a thread to the agent-queryable btw/threads/ file. Best effort. */
function mirrorThread(thread: SideThread): string | null {
	try {
		const dir = ensureBtwDir(sessionCwd);
		return writeThreadFile(dir, thread, meta());
	} catch {
		return null;
	}
}

// --- models ---

interface Choice {
	ref: string;
	label: string;
}

function modelChoices(ctx: ExtensionContext): Choice[] {
	try {
		const models = ctx.modelRegistry.getAvailable() as Array<{ id: string; name: string; provider: string }>;
		return models
			.map((m) => ({ ref: `${m.provider}/${m.id}`, label: `${m.name} (${m.provider}/${m.id})` }))
			.sort((a, b) => a.ref.localeCompare(b.ref));
	} catch {
		return [];
	}
}

function findModel(ctx: ExtensionContext, ref: string): { id: string; name?: string; provider: string } | undefined {
	const slash = ref.indexOf("/");
	if (slash < 0) return undefined;
	try {
		return ctx.modelRegistry.find(ref.slice(0, slash), ref.slice(slash + 1)) as
			| { id: string; name?: string; provider: string }
			| undefined;
	} catch {
		return undefined;
	}
}

function mainModelLabel(ctx: ExtensionContext): string {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(no model)";
}

/** Per-thread pin wins; otherwise follow the main chat's live model. */
function resolveModel(ctx: ExtensionContext, thread: SideThread) {
	if (thread.modelRef) {
		const pinned = findModel(ctx, thread.modelRef);
		if (pinned) return pinned;
	}
	if (ctx.model) return ctx.model;
	const first = modelChoices(ctx)[0];
	if (first) return findModel(ctx, first.ref);
	return undefined;
}

// --- the ask: one btw turn, straight at the model, never the main loop ---

async function askBtw(
	ctx: ExtensionContext,
	thread: SideThread,
	question: string,
	signal: AbortSignal,
): Promise<{ text: string } | null> {
	const model = resolveModel(ctx, thread);
	if (!model) throw new Error("no model available for btw (pick one with /btw-model)");

	const snapshot = buildMainContextSnapshot(ctx);
	const systemPrompt = buildSideSystemPrompt(snapshot);

	const history = thread.messages.slice(-20).map((m) => ({
		role: m.role as "user" | "assistant",
		content: [{ type: "text" as const, text: m.text.slice(0, 2000) }],
		timestamp: m.ts,
	}));

	const response = await ctx.modelRegistry.complete(
		model as never,
		{ systemPrompt, messages: history } as never,
		{ signal } as never,
	);
	const msg = response as unknown as {
		stopReason?: string;
		content?: Array<{ type?: string; text?: string }>;
	};
	if (msg.stopReason === "aborted") return null;
	const text = (msg.content || [])
		.filter((c) => c && c.type === "text" && typeof c.text === "string")
		.map((c) => c.text as string)
		.join("\n")
		.trim();
	return { text: text || "(empty response)" };
}

// --- panel ---

async function openBtw(
	ctx: ExtensionContext,
	opts: { initial?: string; threadId?: string } = {},
): Promise<void> {
	bindSession(ctx);

	let selected = opts.threadId ?? store.list()[0]?.id;
	if (!selected || !store.get(selected)) {
		selected = store.create(opts.initial && !opts.initial.startsWith("/") ? opts.initial : undefined).id;
		if (defaultModelRef && findModel(ctx, defaultModelRef)) {
			store.get(selected)!.modelRef = defaultModelRef;
		}
		if (!opts.initial) store.touch(store.get(selected)!);
	}

	// Outside the TUI there is no overlay: run single-shot instead.
	if (ctx.mode !== "tui") {
		const thread = store.get(selected)!;
		const q = (opts.initial || "").trim();
		if (!q) {
			ctx.ui.notify("btw needs a question outside interactive mode: /btw <question>", "info");
			return;
		}
		thread.messages.push({ role: "user", text: q, ts: Date.now() });
		const ctl = new AbortController();
		const res = await askBtw(ctx, thread, q, ctl.signal);
		if (res) {
			thread.messages.push({ role: "assistant", text: res.text, ts: Date.now() });
			store.touch(thread);
			mirrorThread(thread);
			ctx.ui.notify(res.text.slice(0, 500), "info");
		}
		updateStatus(ctx);
		return;
	}

	const selectedId = { value: selected };
	const mainLabel = mainModelLabel(ctx);

	const result = await ctx.ui.custom<BtwCloseResult>(
		(tui, theme, _kb, done) => {
			const panel = new BtwSheet(
				theme,
				{
					getThreads: () => store.list(),
					getSelectedId: () => selectedId.value,
					setSelectedId: (id) => {
						selectedId.value = id;
					},
					createThread: (first) => {
						const t = store.create(first);
						if (defaultModelRef && findModel(ctx, defaultModelRef)) t.modelRef = defaultModelRef;
						store.persist();
						selectedId.value = t.id;
						updateStatus(ctx);
						return t;
					},
					touch: (t) => {
						store.touch(t);
						mirrorThread(t);
					},
					modelChoices: () => modelChoices(ctx),
					threadModelLabel: (t, fallback) => t.modelRef ?? `${fallback} (main)`,
					setThreadModel: (id, ref) => {
						const t = store.get(id);
						if (t) {
							t.modelRef = ref;
							store.touch(t);
							mirrorThread(t);
						}
					},
					ask: (threadId, question, signal) => {
						const t = store.get(threadId);
						if (!t) return Promise.resolve(null);
						return askBtw(ctx, t, question, signal);
					},
					copyLast: async (threadId, n) => {
						const t = store.get(threadId);
						const answers = (t?.messages || []).filter((m) => m.role === "assistant");
						const msg = answers[answers.length - n];
						if (!t || !msg) return "Nothing to copy yet — ask btw something first.";
						const r = await copyTextToClipboard(msg.text);
						return r.ok
							? `Copied ${msg.text.length} chars to clipboard.`
							: `Clipboard unavailable (${r.detail}). The answer is visible above — select-copy it manually.`;
					},
					saveSnapshot: async (threadId, title) => {
						const t = store.get(threadId);
						if (!t) return "No btw to save.";
						const answers = t.messages.filter((m) => m.role === "assistant");
						const last = answers[answers.length - 1];
						const body = last ? last.text : t.messages.map((m) => `**${m.role}:** ${m.text}`).join("\n\n");
						try {
							const dir = ensureBtwDir(sessionCwd);
							const file = saveNoteFile(dir, title || t.title, body, {
								...meta(),
								model: t.modelRef ?? mainModelLabel(ctx),
								sourceThread: t.id,
							});
							return `Saved to ${path.relative(sessionCwd, file) || file}`;
						} catch (e) {
							return `Save failed: ${e instanceof Error ? e.message : String(e)}`;
						}
					},
					done,
					requestRender: () => tui.requestRender(),
				},
				mainLabel,
			);
			if (opts.initial) panel.submitExternal(opts.initial);
			return panel;
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "bottom-center",
				width: "100%",
				maxHeight: "80%",
			},
		},
	);

	updateStatus(ctx);
	void result;
}

function matchModelRef(ctx: ExtensionContext, pattern: string): Choice | undefined {
	const p = pattern.toLowerCase();
	return modelChoices(ctx).find((m) => m.ref.toLowerCase() === p || m.ref.toLowerCase().endsWith(`/${p}`));
}

// --- extension ---

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		bindSession(ctx);
	});

	const toggle = async (ctx: ExtensionContext) => {
		await openBtw(ctx);
	};

	// Ctrl+; mirrors Claude Desktop / Grok (prompt queue) for muscle memory.
	// Ctrl+' is the fallback for terminals that can't deliver Ctrl+;.
	for (const key of ["ctrl+;", "ctrl+'"]) {
		try {
			pi.registerShortcut(key as never, {
				description: "Toggle btw (ask without interrupting)",
				handler: toggle,
			});
		} catch {
			/* terminal/keyboard layer doesn't accept it — /btw still works */
		}
	}

	pi.registerCommand("btw", {
		description: "Ask btw without interrupting the main task (side sheet)",
		getArgumentCompletions: (prefix) => {
			const opts = ["--model ", "help"];
			const hit = opts.filter((o) => o.startsWith(prefix));
			return hit.length > 0 ? hit.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			let rest = args.trim();
			let modelRef: string | undefined;
			const m = rest.match(/^(--model|-m)\s+(\S+)\s*/);
			if (m) {
				modelRef = m[2];
				rest = rest.slice(m[0].length).trim();
			}
			if (modelRef) {
				const found = matchModelRef(ctx, modelRef);
				if (!found) {
					ctx.ui.notify(`No model matching "${modelRef}". See /btw-model.`, "error");
					return;
				}
				defaultModelRef = found.ref;
				try {
					fs.mkdirSync(path.dirname(defaultModelFile()), { recursive: true });
					fs.writeFileSync(defaultModelFile(), JSON.stringify({ ref: found.ref }, null, 2), "utf-8");
				} catch {
					/* ignore */
				}
				if (!rest) {
					ctx.ui.notify(`New btw will use ${found.ref}. Main chat unchanged.`, "info");
					return;
				}
			}
			await openBtw(ctx, rest ? { initial: rest } : {});
		},
	});

	pi.registerCommand("btw-list", {
		description: "Revisit every btw in this session",
		handler: async (_args, ctx) => {
			bindSession(ctx);
			const threads = store.list();
			if (threads.length === 0) {
				ctx.ui.notify("No btw yet — /btw starts one.", "info");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify(
					threads.map((t, i) => `[${i + 1}] ${t.title} (${t.messages.length} msgs)`).join("\n"),
					"info",
				);
				return;
			}
			const picked = await ctx.ui.select(
				"btw in this session",
				threads.map((t) => `[${t.title}] — ${t.messages.length} msgs · ${t.modelRef ?? "main"}`),
			);
			if (!picked) return;
			const idx = threads.findIndex((t) => picked.includes(t.title));
			await openBtw(ctx, { threadId: threads[Math.max(0, idx)]!.id });
		},
	});

	pi.registerCommand("btw-copy", {
		description: "Copy the last btw answer to clipboard (/btw-copy [n])",
		handler: async (args, ctx) => {
			bindSession(ctx);
			const threads = store.list();
			const thread = threads[0];
			if (!thread) {
				ctx.ui.notify("No btw yet — /btw starts one.", "info");
				return;
			}
			const n = Number.parseInt(args.trim(), 10);
			const answers = thread.messages.filter((x) => x.role === "assistant");
			const msg = answers[answers.length - (Number.isFinite(n) && n > 0 ? n : 1)];
			if (!msg) {
				ctx.ui.notify("That btw has no answer yet.", "info");
				return;
			}
			const r = await copyTextToClipboard(msg.text);
			ctx.ui.notify(
				r.ok ? `Copied ${msg.text.length} chars to clipboard.` : `Clipboard unavailable (${r.detail}).`,
				r.ok ? "info" : "error",
			);
		},
	});

	pi.registerCommand("btw-save", {
		description: "File the last btw answer to btw/notes/ (/btw-save [title])",
		handler: async (args, ctx) => {
			bindSession(ctx);
			const thread = store.list()[0];
			if (!thread) {
				ctx.ui.notify("No btw yet — /btw starts one.", "info");
				return;
			}
			const answers = thread.messages.filter((x) => x.role === "assistant");
			const last = answers[answers.length - 1];
			const body = last
				? last.text
				: thread.messages.map((x) => `**${x.role}:** ${x.text}`).join("\n\n");
			if (!body) {
				ctx.ui.notify("That btw is empty.", "info");
				return;
			}
			try {
				const dir = ensureBtwDir(sessionCwd);
				const file = saveNoteFile(dir, args.trim() || thread.title, body, {
					...meta(),
					model: thread.modelRef ?? mainModelLabel(ctx),
					sourceThread: thread.id,
				});
				ctx.ui.notify(`Saved to ${path.relative(sessionCwd, file) || file}`, "info");
			} catch (e) {
				ctx.ui.notify(`Save failed: ${e instanceof Error ? e.message : String(e)}`, "error");
			}
		},
	});

	pi.registerCommand("btw-model", {
		description: "Default model for new btw (may differ from main chat)",
		handler: async (args, ctx) => {
			bindSession(ctx);
			const pattern = args.trim();
			if (pattern) {
				const found = matchModelRef(ctx, pattern);
				if (!found) {
					ctx.ui.notify(`No model matching "${pattern}".`, "error");
					return;
				}
				defaultModelRef = found.ref;
			} else {
				if (!ctx.hasUI) {
					ctx.ui.notify(`btw default: ${defaultModelRef ?? "(follows main)"}.`, "info");
					return;
				}
				const choices = modelChoices(ctx);
				if (choices.length === 0) {
					ctx.ui.notify("No models available.", "error");
					return;
				}
				const picked = await ctx.ui.select("Default model for new btw", [
					"(follow main chat)",
					...choices.map((c) => c.label),
				]);
				if (!picked) return;
				if (picked.startsWith("(follow")) {
					defaultModelRef = undefined;
				} else {
					const found = choices.find((c) => c.label === picked);
					if (found) defaultModelRef = found.ref;
				}
			}
			try {
				fs.mkdirSync(path.dirname(defaultModelFile()), { recursive: true });
				fs.writeFileSync(defaultModelFile(), JSON.stringify({ ref: defaultModelRef }, null, 2), "utf-8");
			} catch {
				/* ignore */
			}
			ctx.ui.notify(
				defaultModelRef ? `New btw will use ${defaultModelRef}. Main chat unchanged.` : "New btw will follow the main chat model.",
				"info",
			);
		},
	});
}
