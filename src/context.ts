import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const PER_MESSAGE_CAP = 1500;
const TOTAL_CAP = 18000;
const MAX_ENTRIES = 40;

function textOfContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const c of content as Array<{ type?: string; text?: string }>) {
		if (c && c.type === "text" && typeof c.text === "string") parts.push(c.text);
	}
	return parts.join("\n");
}

/**
 * Snapshot of the main thread for btw's eyes only.
 *
 * Deliberately one-way: the btw answer never re-enters the main
 * transcript, so a tangent can't become an accidental instruction.
 * Mirrors Claude Code's /btw boundary — it sees what the session has
 * already gathered, not the response still streaming.
 */
export function buildMainContextSnapshot(ctx: ExtensionContext): string {
	let entries: Array<{ type?: string; message?: { role?: string; content?: unknown } }> = [];
	try {
		entries = ctx.sessionManager.getBranch() as unknown as typeof entries;
	} catch {
		entries = [];
	}
	const msgEntries = entries.filter((e) => e && e.type === "message" && e.message).slice(-MAX_ENTRIES);
	const lines: string[] = [];
	let total = 0;
	for (const e of msgEntries) {
		const role = e.message!.role === "assistant" ? "Assistant" : e.message!.role === "user" ? "User" : "Tool";
		let text = textOfContent(e.message!.content).trim();
		if (!text) continue;
		if (text.length > PER_MESSAGE_CAP) text = `${text.slice(0, PER_MESSAGE_CAP)}\n[…truncated]`;
		const chunk = `${role}: ${text}`;
		if (total + chunk.length > TOTAL_CAP) break;
		lines.push(chunk);
		total += chunk.length;
	}
	const header = [
		`Working directory: ${ctx.cwd}`,
		`Main model: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(none)"}`,
		`Visible main-thread messages: ${lines.length}`,
	].join("\n");
	return `${header}\n\n${lines.join("\n\n---\n\n") || "(main thread is empty)"}`;
}

export function buildSideSystemPrompt(mainSnapshot: string): string {
	return [
		"You are btw, a side channel inside a coding session. Answer the user's question directly.",
		"",
		"Rules:",
		"- You are READ-ONLY. You have no tools. Answer from the main-thread snapshot below plus the sidechat history.",
		"- If the answer needs a file you have not seen, a command run, or the web, say so in one line and suggest the exact prompt to ask the main thread.",
		"- Keep answers short: a few sentences or a compact list. No preamble about being btw.",
		"- Never invent file contents, test results, or commands output.",
		"- If the user asks to save, collect, or file something (ideas, streams, todos), acknowledge it briefly — the host app performs the save, not you.",
		"",
		"--- main-thread snapshot (read-only, may exclude the response currently streaming) ---",
		mainSnapshot,
	].join("\n");
}
