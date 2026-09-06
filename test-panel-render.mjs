// Headless render test for BtwSheet: verifies one-exchange-at-a-time view.
import { createJiti } from "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
import path from "node:path";

const PI = "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url, {
	alias: {
		"@earendil-works/pi-coding-agent": path.join(PI, "dist/index.js"),
		"@earendil-works/pi-tui": path.join(PI, "node_modules/@earendil-works/pi-tui"),
	},
});

const { BtwSheet } = await jiti.import("./src/panel.ts");
const themeMod = await jiti.import("/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js");
themeMod.initTheme("dark");
const theme = themeMod.theme; // global proxy over the initialized Theme instance

// --- fake state: one thread, three exchanges ---
const thread = {
	id: "t1",
	title: "test",
	modelRef: undefined,
	createdAt: 0,
	updatedAt: 0,
	messages: [
		{ role: "user", text: "first question about auth", ts: 1 },
		{ role: "assistant", text: "First answer: use JWT tokens with short expiry.", ts: 2 },
		{ role: "user", text: "second question about retries", ts: 3 },
		{ role: "assistant", text: "Second answer: retry with exponential backoff, max 5 tries.", ts: 4 },
		{ role: "user", text: "third question about deploy", ts: 5 },
		{ role: "assistant", text: "Third answer: run `make deploy` then verify health checks.", ts: 6 },
	],
};

let selectedId = "t1";
let renders = 0;
const sheet = new BtwSheet(
	theme,
	{
		getThreads: () => [thread],
		getSelectedId: () => selectedId,
		setSelectedId: (id) => { selectedId = id; },
		createThread: () => thread,
		touch: () => {},
		modelChoices: () => [],
		threadModelLabel: (t, f) => `${f} (main)`,
		setThreadModel: () => {},
		ask: async () => ({ text: "ok" }),
		copyLast: async () => "copied",
		saveSnapshot: async () => "saved",
		done: () => {},
		requestRender: () => { renders++; },
	},
	"main-model",
);

function stripAnsi(s) {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}
function view(expanded) {
	sheet.expanded = expanded;
	const lines = sheet.render(100).map(stripAnsi);
	return lines;
}

let failures = 0;
const check = (name, cond) => {
	console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
	if (!cond) failures++;
};

// Collapsed: should show only the latest exchange (third question), not the first.
const collapsed = view(false);
const collapsedText = collapsed.join("\n");
check("collapsed shows latest question", collapsedText.includes("third question"));
check("collapsed hides older exchanges", !collapsedText.includes("first question") && !collapsedText.includes("second question"));

// Expanded: same rule.
const expanded = view(true);
const expandedText = expanded.join("\n");
check("expanded shows latest answer", expandedText.includes("Third answer"));
check("expanded hides first exchange", !expandedText.includes("first question") && !expandedText.includes("First answer"));

// Scroll up: older exchanges become reachable.
for (let i = 0; i < 12; i++) sheet.handleInput("\x1b[A"); // up x12
const scrolled = view(true);
const scrolledText = scrolled.join("\n");
check("scrolled up reveals older exchanges", scrolledText.includes("first question") || scrolledText.includes("First answer") || scrolledText.includes("second question"));

// Scroll back down: returns to latest only.
for (let i = 0; i < 24; i++) sheet.handleInput("\x1b[B"); // down x24
const back = view(true);
const backText = back.join("\n");
check("scrolled back shows latest again", backText.includes("third question") || backText.includes("Third answer"));
check("scrolled back hides first exchange", !backText.includes("first question"));

// Fresh thread with a single exchange still renders fine.
thread.messages = thread.messages.slice(0, 2);
sheet.invalidate();
const single = view(true).join("\n");
check("single exchange renders", single.includes("first question") && single.includes("First answer"));

// Latest exchange taller than the viewport: expanded shows its tail (bottom-pinned),
// still hiding older exchanges.
thread.messages.push({ role: "user", text: "fourth question about cache", ts: 7 });
thread.messages.push({ role: "assistant", text: Array.from({ length: 40 }, (_, i) => `line ${i + 1} of the long answer`).join("\n"), ts: 8 });
sheet.invalidate();
sheet.scroll = 0;
const tall = view(true);
const tallText = tall.join("\n");
check("tall exchange bottom-pinned to its tail", tallText.includes("line 40") && !tallText.includes("line 1 of"));
check("tall exchange hides older exchanges", !tallText.includes("first question"));
sheet.scroll = 30; // scroll up within/above the tall exchange
const tallUp = view(true).join("\n");
check("scrolling up reaches the tall exchange top", tallUp.includes("fourth question"));

// Asking a new question resets to that exchange (scroll reset on ask).
const before = thread.messages.length;
sheet.handleInput("\r"); // no-op enter on empty input; then simulate ask via submitExternal
sheet.expanded = false;
thread.messages.push({ role: "user", text: "fifth question about logs", ts: 9 });
thread.messages.push({ role: "assistant", text: "Fifth answer: check the deploy logs.", ts: 10 });
sheet.invalidate();
sheet.scroll = 0;
const after = view(false).join("\n");
check("new exchange becomes the shown one", after.includes("fifth question") && !after.includes("fourth question"));

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
