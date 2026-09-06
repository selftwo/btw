import type { Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
	type Focusable,
	Input,
	Markdown,
	matchesKey,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { SideThread } from "./store.ts";

export interface ModelChoice {
	ref: string;
	label: string;
}

export interface BtwCloseResult {
	threadId: string;
	asked: boolean;
}

export interface BtwPanelHooks {
	getThreads(): SideThread[];
	getSelectedId(): string;
	setSelectedId(id: string): void;
	createThread(firstQuestion?: string): SideThread;
	touch(t: SideThread): void;
	modelChoices(): ModelChoice[];
	threadModelLabel(t: SideThread, fallbackMain: string): string;
	setThreadModel(id: string, ref: string | undefined): void;
	ask(threadId: string, question: string, signal: AbortSignal): Promise<{ text: string } | null>;
	copyLast(threadId: string, n: number): Promise<string>;
	saveSnapshot(threadId: string, title?: string): Promise<string>;
	done(result: BtwCloseResult): void;
	requestRender(): void;
}

type Mode = "chat" | "threads" | "models" | "help";

/** Lines shown when the sheet is collapsed (Antigravity-style peek). */
const COLLAPSED_LINES = 7;
const SPINNER = ["✻", "✽", "✶", "✷"];

/** What slice of the content the last render showed, for the hint line. */
interface WindowInfo {
	start: number;
	shown: number;
	total: number;
}

/**
 * Antigravity-style btw sheet.
 *
 * A full-width, bottom-docked block with a left accent bar. The main
 * transcript stays visible above; the exchange renders in-flow with real
 * markdown. Collapsed by default (Tab expands), ↑↓ scrolls, Esc dismisses.
 * The answer never touches the main thread.
 */
export class BtwSheet implements Focusable {
	focused = false;

	private theme: Theme;
	private hooks: BtwPanelHooks;
	private mainModelLabel: string;
	private input: Input;
	private mode: Mode = "chat";
	private expanded = false;
	private scroll = 0;
	private loading = false;
	private frame = 0;
	private timer: ReturnType<typeof setInterval> | null = null;
	private aborter: AbortController | null = null;
	private notice = "";
	private asked = false;
	private threadIndex = 0;
	private modelIndex = 0;
	private modelFilter = "";
	private lastWindow: WindowInfo = { start: 0, shown: 0, total: 0 };
	private contentCache: { key: string; lines: string[]; latestStart: number } | null = null;
	/** Line index (in buildContent output) where the latest exchange begins. */
	private latestStart = 0;

	constructor(theme: Theme, hooks: BtwPanelHooks, mainModelLabel: string, prefill = "") {
		this.theme = theme;
		this.hooks = hooks;
		this.mainModelLabel = mainModelLabel;
		this.input = new Input({ prompt: "btw> ", placeholder: "Ask btw…" });
		if (prefill) this.input.setValue(prefill);
		this.input.onSubmit = (value) => void this.handleSubmit(value);
		this.input.onEscape = () => {
			if (this.input.getValue().trim()) this.input.setValue("");
			else this.close();
		};
	}

	/** /btw <question>: send immediately instead of waiting for Enter. */
	submitExternal(question: string): void {
		if (!question.trim() || this.loading) return;
		this.expanded = true;
		void this.handleSubmit(question);
	}

	dispose(): void {
		this.stopSpinner();
	}

	private currentThread(): SideThread | undefined {
		return this.hooks.getThreads().find((t) => t.id === this.hooks.getSelectedId());
	}

	private setNotice(s: string): void {
		this.notice = s;
		this.hooks.requestRender();
	}

	private close(): void {
		this.stopSpinner();
		this.aborter?.abort();
		this.hooks.done({ threadId: this.hooks.getSelectedId(), asked: this.asked });
	}

	private startSpinner(): void {
		this.stopSpinner();
		this.timer = setInterval(() => {
			this.frame = (this.frame + 1) % SPINNER.length;
			this.hooks.requestRender();
		}, 120);
	}

	private stopSpinner(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	private async handleSubmit(raw: string): Promise<void> {
		const text = raw.trim();
		if (!text) return;
		if (text.startsWith("/")) {
			this.input.setValue("");
			await this.runPanelCommand(text);
			return;
		}
		this.input.setValue("");
		await this.ask(text);
	}

	private async runPanelCommand(raw: string): Promise<void> {
		const [cmd, ...rest] = raw.slice(1).split(/\s+/);
		const arg = rest.join(" ").trim();
		const thread = this.currentThread();
		switch ((cmd || "").toLowerCase()) {
			case "help":
				this.mode = "help";
				break;
			case "threads":
				this.threadIndex = Math.max(
					0,
					this.hooks.getThreads().findIndex((t) => t.id === this.hooks.getSelectedId()),
				);
				this.mode = "threads";
				break;
			case "new":
				this.hooks.createThread(arg || undefined);
				this.scroll = 0;
				this.expanded = true;
				this.mode = "chat";
				if (arg) await this.ask(arg);
				break;
			case "copy": {
				if (!thread) break;
				const n = Number.parseInt(arg, 10);
				this.setNotice(await this.hooks.copyLast(thread.id, Number.isFinite(n) && n > 0 ? n : 1));
				break;
			}
			case "save": {
				if (!thread) break;
				this.setNotice(await this.hooks.saveSnapshot(thread.id, arg || undefined));
				break;
			}
			case "model": {
				if (!arg) {
					this.modelFilter = "";
					this.modelIndex = 0;
					this.mode = "models";
					break;
				}
				const found = this.hooks
					.modelChoices()
					.find((m) => m.ref.toLowerCase() === arg.toLowerCase() || m.ref.toLowerCase().endsWith(`/${arg.toLowerCase()}`));
				if (!found) {
					this.setNotice(`No model matching "${arg}". Pick from the list (ctrl+l).`);
					break;
				}
				if (thread) {
					this.hooks.setThreadModel(thread.id, found.ref);
					this.setNotice(`This btw now uses ${found.ref}. Main chat unchanged.`);
				}
				break;
			}
			case "close":
			case "quit":
			case "q":
				this.close();
				break;
			default:
				this.setNotice(`Unknown btw command /${cmd}. Try /help.`);
		}
		this.hooks.requestRender();
	}

	private async ask(question: string): Promise<void> {
		const thread = this.currentThread();
		if (!thread || this.loading) return;
		thread.messages.push({ role: "user", text: question, ts: Date.now() });
		this.hooks.touch(thread);
		this.loading = true;
		this.expanded = true;
		this.scroll = 0;
		this.aborter = new AbortController();
		this.startSpinner();
		this.hooks.requestRender();
		try {
			const res = await this.hooks.ask(thread.id, question, this.aborter.signal);
			if (res === null) {
				this.setNotice("Cancelled.");
			} else {
				thread.messages.push({ role: "assistant", text: res.text, ts: Date.now() });
				this.hooks.touch(thread);
				this.asked = true;
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			thread.messages.push({ role: "assistant", text: `(btw failed: ${msg})`, ts: Date.now() });
			this.hooks.touch(thread);
		} finally {
			this.loading = false;
			this.aborter = null;
			this.stopSpinner();
			this.hooks.requestRender();
		}
	}

	private stepThread(dir: 1 | -1): void {
		const threads = this.hooks.getThreads();
		if (threads.length < 2) {
			this.setNotice("Only one btw in this session. /new starts another.");
			return;
		}
		const i = threads.findIndex((t) => t.id === this.hooks.getSelectedId());
		const next = threads[(i + dir + threads.length) % threads.length]!;
		this.hooks.setSelectedId(next.id);
		this.scroll = 0;
		this.hooks.requestRender();
	}

	private filteredModels(): ModelChoice[] {
		const q = this.modelFilter.toLowerCase();
		const all = this.hooks.modelChoices();
		if (!q) return all;
		return all.filter((m) => m.ref.toLowerCase().includes(q) || m.label.toLowerCase().includes(q));
	}

	handleInput(data: string): void {
		// While streaming, Esc / Ctrl+C cancels — main turn untouched.
		if (this.loading && (matchesKey(data, "escape") || matchesKey(data, "ctrl+c"))) {
			this.aborter?.abort();
			return;
		}

		if (this.mode === "threads") {
			const threads = this.hooks.getThreads();
			if (matchesKey(data, "escape")) {
				this.mode = "chat";
			} else if (matchesKey(data, "up")) {
				this.threadIndex = Math.max(0, this.threadIndex - 1);
			} else if (matchesKey(data, "down")) {
				this.threadIndex = Math.min(threads.length - 1, this.threadIndex + 1);
			} else if (matchesKey(data, "enter")) {
				const t = threads[this.threadIndex];
				if (t) {
					this.hooks.setSelectedId(t.id);
					this.scroll = 0;
				}
				this.mode = "chat";
			} else if (data === "n") {
				this.hooks.createThread();
				this.scroll = 0;
				this.mode = "chat";
			}
			this.hooks.requestRender();
			return;
		}

		if (this.mode === "models") {
			const list = this.filteredModels();
			if (matchesKey(data, "escape")) {
				this.mode = "chat";
			} else if (matchesKey(data, "up")) {
				this.modelIndex = Math.max(0, this.modelIndex - 1);
			} else if (matchesKey(data, "down")) {
				this.modelIndex = Math.min(list.length - 1, this.modelIndex + 1);
			} else if (matchesKey(data, "enter")) {
				const m = list[this.modelIndex];
				const thread = this.currentThread();
				if (m && thread) {
					this.hooks.setThreadModel(thread.id, m.ref);
					this.setNotice(`This btw now uses ${m.ref}. Main chat unchanged.`);
				}
				this.mode = "chat";
			} else if (matchesKey(data, "backspace")) {
				this.modelFilter = this.modelFilter.slice(0, -1);
				this.modelIndex = 0;
			} else if (data.length === 1 && data.charCodeAt(0) >= 32) {
				this.modelFilter += data;
				this.modelIndex = 0;
			}
			this.hooks.requestRender();
			return;
		}

		if (this.mode === "help") {
			this.mode = "chat";
			this.hooks.requestRender();
			return;
		}

		// Chat-mode shortcuts.
		if (matchesKey(data, "tab")) {
			this.expanded = !this.expanded;
			if (!this.expanded) this.scroll = 0; // collapsing returns to the latest exchange
			this.hooks.requestRender();
			return;
		}
		if (matchesKey(data, "ctrl+y")) {
			const thread = this.currentThread();
			if (thread) void this.hooks.copyLast(thread.id, 1).then((s) => this.setNotice(s));
			return;
		}
		if (matchesKey(data, "ctrl+l")) {
			this.modelFilter = "";
			this.modelIndex = 0;
			this.mode = "models";
			this.hooks.requestRender();
			return;
		}
		if (matchesKey(data, "ctrl+s")) {
			const thread = this.currentThread();
			if (thread) void this.hooks.saveSnapshot(thread.id).then((s) => this.setNotice(s));
			return;
		}
		if (matchesKey(data, "ctrl+n")) {
			this.stepThread(1);
			return;
		}
		if (matchesKey(data, "ctrl+p")) {
			this.stepThread(-1);
			return;
		}
		if (this.expanded && (matchesKey(data, "up") || matchesKey(data, "ctrl+u") || matchesKey(data, "pageup"))) {
			// Scroll up into earlier exchanges of this thread.
			this.scroll += matchesKey(data, "up") ? 3 : 10;
			this.hooks.requestRender();
			return;
		}
		if (this.expanded && (matchesKey(data, "down") || matchesKey(data, "ctrl+d") || matchesKey(data, "pagedown"))) {
			this.scroll = Math.max(0, this.scroll - (matchesKey(data, "down") ? 3 : 10));
			this.hooks.requestRender();
			return;
		}

		this.input.focused = this.focused;
		this.input.handleInput(data);
		this.hooks.requestRender();
	}

	invalidate(): void {
		this.contentCache = null;
	}

	/**
	 * Render the full exchange (question + markdown answers) as flat lines.
	 * Cached per (width, content signature).
	 */
	private buildContent(width: number): string[] {
		const thread = this.currentThread();
		const msgs = thread?.messages ?? [];
		const sig = `${width}:${msgs.length}:${msgs.map((m) => m.text.length + m.role[0]).join(",")}`;
		if (this.contentCache && this.contentCache.key === sig) {
			this.latestStart = this.contentCache.latestStart;
			return this.contentCache.lines;
		}

		const th = this.theme;
		const inner = Math.max(20, width - 2); // 2 cols reserved for the accent bar
		const mdTheme = getMarkdownTheme();
		const lines: string[] = [];

		if (msgs.length === 0) {
			lines.push(th.fg("dim", "Ask btw anything — the main task keeps running."));
		} else {
			for (const m of msgs) {
				if (m.role === "user") {
					// Each user message starts a new exchange; the last one is
					// what the TUI shows by default (one exchange at a time).
					this.latestStart = lines.length;
					const wrapped = wrapTextWithAnsi(m.text, inner - 5);
					wrapped.forEach((l, i) => {
						if (i === 0) {
							lines.push(truncateToWidth(th.fg("accent", th.bold("/btw ")) + th.fg("text", l), width - 2));
						} else {
							lines.push(truncateToWidth(th.fg("text", `     ${l}`), width - 2));
						}
					});
					lines.push("");
				} else {
					const md = new Markdown(m.text, 0, 0, mdTheme);
					for (const l of this.fancyMarkdown(md.render(inner), inner)) {
						lines.push(truncateToWidth(l, width - 2));
					}
					lines.push("");
				}
			}
			while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
		}

		this.contentCache = { key: sig, lines, latestStart: this.latestStart };
		return lines;
	}

	/** Accent bar + content line, clipped to width. */
	/**
	 * Post-process Markdown render output: turn ``` fences into a bordered
	 * box (Antigravity-style) and use • for list bullets.
	 */
	private fancyMarkdown(lines: string[], inner: number): string[] {
		const mdTheme = this.mdThemeCache ?? (this.mdThemeCache = getMarkdownTheme());
		const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
		// ``` starts a code block (optionally with a language tag); ``` alone ends it.
		const isFence = (s: string) => { const t = strip(s).trim(); return /^```/.test(t); };
		const out: string[] = [];
		let inCode = false;
		let codeBuf: string[] = [];
		let codeW = 0;
		for (const l of lines) {
			if (isFence(l)) {
				if (!inCode) {
					inCode = true;
					codeBuf = [];
					codeW = 0;
				} else {
					inCode = false;
					// Borders hug the code content: Markdown pads every line to the
					// full width, so trim trailing padding before measuring.
					const bw = Math.max(2, Math.min(codeW, inner - 4));
					out.push(mdTheme.codeBlockBorder("╭" + "─".repeat(bw) + "╮"));
					for (const cl of codeBuf) {
						const body = (cl.startsWith("  ") ? cl.slice(2) : cl).replace(/\s+$/, "");
						out.push(mdTheme.codeBlock("│ ") + body);
					}
					out.push(mdTheme.codeBlockBorder("╰" + "─".repeat(bw) + "╯"));
					codeBuf = [];
				}
				continue;
			}
			if (inCode) {
				const w = strip(l).trimEnd().length;
				if (w > codeW) codeW = w;
				codeBuf.push(l);
			} else {
				// • bullets, like Antigravity (keep the ANSI prefix, if any)
				out.push(l.replace(/^(\x1b\[[0-9;]*m)*-\s/, "$1• "));
			}
		}
		if (inCode) out.push(...codeBuf); // unclosed fence: keep as-is
		return out;
	}

	private mdThemeCache: ReturnType<typeof getMarkdownTheme> | null = null;

	private barLine(line: string, width: number): string {
		const th = this.theme;
		return truncateToWidth(th.fg("accent", "█") + th.fg("text", " ") + line, width);
	}

	private hintLine(width: number): string {
		const th = this.theme;
		const { start, shown, total } = this.lastWindow;
		const parts: string[] = [];
		if (this.loading) {
			parts.push(th.fg("muted", `${SPINNER[this.frame]} generating… (esc to cancel)`));
		} else if (this.expanded && total > shown) {
			parts.push(th.fg("dim", `↑ older btw · ↓ back (${start + 1}–${start + shown} of ${total})`));
		}
		if (!this.loading) {
			parts.push(th.fg("dim", this.expanded ? "tab collapse · enter/esc dismiss" : "tab expand · enter/esc dismiss"));
			parts.push(th.fg("dim", "ctrl+y copy · ctrl+l model · ctrl+s save · ctrl+n/p btw"));
			const t = this.currentThread();
			if (t) {
				const label = this.hooks.threadModelLabel(t, this.mainModelLabel);
				if (label) parts.push(th.fg("accent", label));
			}
		}
		return truncateToWidth(" " + parts.join(th.fg("dim", "  ·  ")), width);
	}

	private chatLines(width: number): string[] {
		const rows = process.stdout?.rows ?? 40;
		// Keep the sheet inside the overlay's maxHeight (80% of the terminal)
		// with room for the input line, notice and hint line, so the bottom
		// (keybindings) is never clipped.
		const cap = Math.max(10, Math.min(Math.floor(rows * 0.8) - 5, rows - 7, 38));
		const maxContent = this.expanded ? cap : COLLAPSED_LINES;
		const all = this.buildContent(width);
		const total = all.length;

		// One exchange at a time: the view is anchored at the latest exchange
		// (this.latestStart). Only when that exchange alone is taller than the
		// viewport do we bottom-pin it; older exchanges appear only by
		// scrolling up (this.scroll). Collapsed peeks at the latest exchange's
		// top, like Antigravity.
		const pinStart = Math.max(0, total - maxContent);
		const start = Math.max(0, Math.max(this.latestStart, pinStart) - this.scroll);
		const viewStart = this.expanded ? start : this.latestStart;
		const view = this.expanded
			? all.slice(start, Math.min(total, start + maxContent))
			: all.slice(viewStart, viewStart + maxContent);

		const out: string[] = view.map((l) => this.barLine(l, width));

		if (!this.expanded && viewStart + view.length < total) {
			out.push(truncateToWidth(this.theme.fg("dim", ` … (truncated — tab to expand)`), width));
		}
		this.lastWindow = { start: viewStart, shown: view.length, total };
		return out;
	}

	private renderThreads(width: number): string[] {
		const th = this.theme;
		const threads = this.hooks.getThreads();
		const out: string[] = [th.fg("accent", " btw chats in this session")];
		threads.slice(0, 12).forEach((t, i) => {
			const sel = i === this.threadIndex;
			const active = t.id === this.hooks.getSelectedId();
			const marker = sel ? "▶ " : "  ";
			const flag = active ? " ●" : "";
			const label = `${marker}[${i + 1}] ${t.title} (${t.messages.length} msgs)${flag}`;
			out.push(truncateToWidth(sel ? th.fg("accent", label) : th.fg("text", label), width));
		});
		out.push("", truncateToWidth(th.fg("dim", " ↑↓ pick · enter open · n new · esc back"), width));
		return out;
	}

	private renderModels(width: number): string[] {
		const th = this.theme;
		const list = this.filteredModels().slice(0, 12);
		const out: string[] = [th.fg("accent", ` model for this btw (filter: ${this.modelFilter || "—"})`)];
		list.forEach((m, i) => {
			const label = `${i === this.modelIndex ? "▶ " : "  "}${m.label}`;
			out.push(truncateToWidth(i === this.modelIndex ? th.fg("accent", label) : th.fg("text", label), width));
		});
		if (list.length === 0) out.push(th.fg("dim", "  no match"));
		out.push("", truncateToWidth(th.fg("dim", " type to filter · ↑↓ pick · enter use · esc back"), width));
		return out;
	}

	private renderHelp(width: number): string[] {
		const th = this.theme;
		const out: string[] = [];
		for (const h of [
			"Ask anything — the main task keeps running underneath.",
			"",
			"/save [title]   file the last answer to btw/notes/",
			"/copy [n]       copy the last (or nth) answer to clipboard",
			"/model [ref]    use a different model for this btw",
			"/threads        revisit every btw in this session",
			"/new [question] start a fresh btw",
			"/close          dismiss (esc does this too)",
		]) {
			out.push(truncateToWidth(th.fg("text", ` ${h}`), width));
		}
		out.push("", truncateToWidth(th.fg("dim", " any key back"), width));
		return out;
	}

	render(width: number): string[] {
		const w = Math.max(30, width);
		let body: string[];
		if (this.mode === "threads") body = this.renderThreads(w);
		else if (this.mode === "models") body = this.renderModels(w);
		else if (this.mode === "help") body = this.renderHelp(w);
		else body = this.chatLines(w);

		const lines: string[] = [...body, ""];

		if (this.mode === "chat") {
			this.input.focused = this.focused;
			for (const line of this.input.render(w)) {
				lines.push(truncateToWidth(line, w));
			}
		}
		if (this.notice) lines.push(truncateToWidth(this.theme.fg("warning", ` ${this.notice}`), w));
		if (this.mode === "chat") {
			lines.push(this.hintLine(w));
		}
		return lines;
	}
}
