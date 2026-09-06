import { execSync } from "node:child_process";
import { platform } from "node:os";

/**
 * Best-effort clipboard copy without extra dependencies.
 *
 * Uses OS-native tools (pbcopy / clip / wl-copy / xclip / xsel) so the
 * extension works wherever pi runs. Returns whether the copy succeeded
 * plus a short human-readable detail for status lines.
 */
export async function copyTextToClipboard(text: string): Promise<{ ok: boolean; detail: string }> {
	if (!text) return { ok: false, detail: "nothing to copy" };
	const p = platform();
	const opts = { input: text, timeout: 5000 } as const;

	try {
		if (p === "darwin") {
			execSync("pbcopy", opts);
			return { ok: true, detail: "pbcopy" };
		}
		if (p === "win32") {
			execSync("clip", opts);
			return { ok: true, detail: "clip" };
		}
		// Linux / WSL: prefer Wayland tool, fall back to X11 tools.
		const attempts: Array<{ cmd: string; args: string }> = [
			{ cmd: "wl-copy", args: "" },
			{ cmd: "xclip -selection clipboard", args: "" },
			{ cmd: "xsel --clipboard --input", args: "" },
		];
		let lastError = "";
		for (const a of attempts) {
			try {
				execSync(a.cmd, opts);
				return { ok: true, detail: a.cmd.split(" ")[0]! };
			} catch (e) {
				lastError = e instanceof Error ? e.message.split("\n")[0]! : String(e);
			}
		}
		// WSL without X tools: clip.exe on the Windows side often exists.
		try {
			execSync("clip.exe", opts);
			return { ok: true, detail: "clip.exe" };
		} catch {
			/* ignore */
		}
		return { ok: false, detail: lastError || "no clipboard tool found (install wl-copy or xclip)" };
	} catch (e) {
		return { ok: false, detail: e instanceof Error ? e.message.split("\n")[0]! : String(e) };
	}
}
