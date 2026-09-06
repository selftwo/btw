import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Focusable,
	Input,
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

const VIEW_LINES = 30;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Grok-style right-side btw panel.
 *
 * Lives in an overlay ({ overlay: true, anchor: "right-center" }), so the
 * main transcript stays visible on the left and the main agent turn keeps
 * running underneath. Dismiss with Esc — the answer never touches the
 * main thread.
 */
export class BtwPanel implements Focusable {
	focused = false;

	private theme: Theme;
	private hooks: BtwPanelHooks;
	private mainModelLabel: string;
	private input: Input;
	private mode: Mode = "chat";
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

	constructor(theme: Theme, hooks: BtwPanelHooks, mainModelLabel: string, prefill = "") {
		this.theme = theme;
		this.hooks = hooks;
		this.mainModelLabel = mainModelLabel;
		this.input = new Input({ prompt: "btw> ", placeholder: "Ask btw…  (/help for commands)" });
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
		}, 100);
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
					this.setNotice(`No model matching "${arg}". Pick from /model list (Ctrl+L).`);
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
		// While streaming an answer, Esc / Ctrl+C cancels — main turn untouched.
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

		// Chat mode overlay shortcuts (Grok-flavoured).
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
		if (matchesKey(data, "ctrl+u") || matchesKey(data, "pageup")) {
			this.scroll += 10;
			this.hooks.requestRender();
			return;
		}
		if (matchesKey(data, "ctrl+d") || matchesKey(data, "pagedown")) {
			this.scroll = Math.max(0, this.scroll - 10);
			this.hooks.requestRender();
			return;
		}

		this.input.focused = this.focused;
		this.input.handleInput(data);
		this.hooks.requestRender();
	}

	invalidate(): void {}

	private headerLines(width: number): string[] {
		const th = this.theme;
		const thread = this.currentThread();
		const threads = this.hooks.getThreads();
		const model = thread ? this.hooks.threadModelLabel(thread, this.mainModelLabel) : this.mainModelLabel;
		const title = thread ? thread.title : "btw";
		const left = ` btw · ${title} `;
		const right = ` ${model} `;
		const fillerLen = Math.max(0, width - left.length - right.length);
		const out: string[] = [
			truncateToWidth(th.fg("accent", left) + th.fg("dim", "─".repeat(fillerLen)) + th.fg("muted", right), width),
		];
		if (threads.length > 1) {
			const tabs = threads
				.slice(0, 5)
				.map((t, i) => {
					const active = t.id === this.hooks.getSelectedId();
					const label = `[${i + 1}] ${t.title.length > 14 ? `${t.title.slice(0, 13)}…` : t.title}`;
					return active ? th.fg("accent", label) : th.fg("dim", label);
				})
				.join(th.fg("dim", " │ "));
			const extra = threads.length > 5 ? th.fg("dim", ` (+${threads.length - 5})`) : "";
			out.push(truncateToWidth(` ${tabs}${extra}`, width));
		}
		return out;
	}

	private transcriptLines(width: number): string[] {
		const th = this.theme;
		const thread = this.currentThread();
		if (!thread || thread.messages.length === 0) {
			return [th.fg("dim", " No btw yet. Ask anything — the main task keeps running."), ""];
		}
		const inner = Math.max(20, width - 4);
		const all: string[] = [];
		for (const m of thread.messages) {
			if (m.role === "user") {
				all.push(truncateToWidth(th.fg("accent", "You"), width));
				for (const line of wrapTextWithAnsi(m.text, inner)) {
					all.push(truncateToWidth(`  ${line}`, width));
				}
			} else {
				all.push(truncateToWidth(th.fg("success", "btw"), width));
				for (const line of wrapTextWithAnsi(m.text, inner)) {
					all.push(truncateToWidth(`  ${line}`, width));
				}
			}
			all.push("");
		}
		if (all.length > 0) all.pop();

		// Window the transcript so the panel always fits the overlay.
		const total = all.length;
		const end = Math.max(0, total - this.scroll);
		const start = Math.max(0, end - VIEW_LINES);
		const view = all.slice(start, Math.max(start, end));
		if (start > 0) view.unshift(th.fg("dim", `↑ ${start} more lines above (ctrl+u scrolls)`));
		if (end < total) view.push(th.fg("dim", `↓ ${total - end} more lines below (ctrl+d scrolls)`));
		return view;
	}

	private footerLines(width: number): string[] {
		const th = this.theme;
		const hints: string[] =
			this.mode === "chat"
				? ["enter send · esc close · ctrl+y copy · ctrl+l model · ctrl+s save · ctrl+n/p btw · /help"]
				: this.mode === "threads"
					? ["↑↓ pick · enter open · n new · esc back"]
					: this.mode === "models"
						? ["type to filter · ↑↓ pick · enter use · esc back"]
						: ["any key back"];
		const out = hints.map((h) => truncateToWidth(th.fg("dim", ` ${h}`), width));
		if (this.notice) out.push(truncateToWidth(th.fg("warning", ` ${this.notice}`), width));
		return out;
	}

	render(width: number): string[] {
		const w = Math.max(30, width);
		const lines: string[] = [...this.headerLines(w), ""];
		if (this.mode === "threads") {
			const threads = this.hooks.getThreads();
			lines.push(this.theme.fg("accent", " btw chats in this session"));
			threads.slice(0, 12).forEach((t, i) => {
				const sel = i === this.threadIndex;
				const active = t.id === this.hooks.getSelectedId();
				const marker = sel ? "▶ " : "  ";
				const flag = active ? " ●" : "";
				const label = `${marker}[${i + 1}] ${t.title} (${t.messages.length} msgs)${flag}`;
				lines.push(
					truncateToWidth(sel ? this.theme.fg("accent", label) : this.theme.fg("text", label), w),
				);
			});
			lines.push("", ...this.footerLines(w));
			return lines;
		}
		if (this.mode === "models") {
			const list = this.filteredModels().slice(0, 12);
			lines.push(this.theme.fg("accent", ` model for this btw (filter: ${this.modelFilter || "—"})`));
			list.forEach((m, i) => {
				const label = `${i === this.modelIndex ? "▶ " : "  "}${m.label}`;
				lines.push(
					truncateToWidth(i === this.modelIndex ? this.theme.fg("accent", label) : this.theme.fg("text", label), w),
				);
			});
			if (list.length === 0) lines.push(this.theme.fg("dim", "  no match"));
			lines.push("", ...this.footerLines(w));
			return lines;
		}
		if (this.mode === "help") {
			for (const h of [
				"Ask anything — the main task keeps running underneath.",
				"",
				"/save [title]   file the last answer to btw/notes/",
				"/copy [n]       copy the last (or nth) answer to clipboard",
				"/model [ref]    use a different model for this btw",
				"/threads        revisit every btw in this session",
				"/new [question] start a fresh btw",
				"/close          dismiss (esc does this too)",
				"",
				"ctrl+y copy · ctrl+l model · ctrl+s save · ctrl+n/p switch btw",
				"ctrl+u / ctrl+d scroll the transcript",
			]) {
				lines.push(truncateToWidth(this.theme.fg("text", ` ${h}`), w));
			}
			lines.push("", ...this.footerLines(w));
			return lines;
		}
		lines.push(...this.transcriptLines(w), "");
		if (this.loading) {
			lines.push(
				truncateToWidth(this.theme.fg("muted", ` ${SPINNER[this.frame]} thinking… (esc cancels)`), w),
				"",
			);
		}
		this.input.focused = this.focused;
		for (const line of this.input.render(w)) {
			lines.push(truncateToWidth(line, w));
		}
		lines.push(...this.footerLines(w));
		return lines;
	}
}
