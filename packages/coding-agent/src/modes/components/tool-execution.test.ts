import { beforeAll, describe, expect, it } from "bun:test";
import { type Terminal, type TerminalAppearance, TUI } from "@oh-my-pi/pi-tui";

import { Settings } from "../../config/settings";
import { getThemeByName, setThemeInstance } from "../theme/theme";
import { ToolExecutionComponent } from "./tool-execution";

class CapturingTerminal implements Terminal {
	writes: string[] = [];
	columns = 80;
	rows = 8;
	kittyProtocolActive = false;
	kittyEnableSequence: string | null = null;
	keyboardEnhancementEnterSequence: string | null = null;
	keyboardEnhancementExitSequence: string | null = null;
	appearance: TerminalAppearance | undefined;

	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	onAppearanceChange(): void {}
}

function makeToolBlock(toolName: string, args: Record<string, unknown>) {
	const terminal = new CapturingTerminal();
	const ui = new TUI(terminal);
	const block = new ToolExecutionComponent(toolName, args, { showImages: false }, undefined, ui, "/tmp/project");
	ui.addChild(block);
	return { terminal, block };
}

function renderPendingThenUpdateFirstPartial(
	toolName: string,
	args: Record<string, unknown>,
	text = "running",
): string {
	const { terminal, block } = makeToolBlock(toolName, args);
	try {
		block.render(80);
		terminal.writes = [];
		block.updateResult({ content: [{ type: "text", text }] }, true);
		return terminal.writes.join("");
	} finally {
		block.stopAnimation();
	}
}

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("theme unavailable");
	setThemeInstance(loaded);
});

describe("ToolExecutionComponent first partial result repaint", () => {
	it("replays the viewport when a collapsed write pending tail becomes the first partial result", () => {
		const content = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
		const output = renderPendingThenUpdateFirstPartial("write", { path: "out.txt", content }, "Writing out.txt...");

		expect(output).toContain("\x1b[2J\x1b[H");
	});

	it("keeps SSH first-result repaint scoped to streamed placeholder args", () => {
		const output = renderPendingThenUpdateFirstPartial("ssh", { host: "prod", command: "uptime" });

		expect(output).not.toContain("\x1b[2J\x1b[H");
	});

	it("replays the viewport when SSH replaces a streamed placeholder", () => {
		const output = renderPendingThenUpdateFirstPartial("ssh", {
			host: "prod",
			command: "uptime",
			__partialJson: '{"host":"prod","command":"upt',
		});

		expect(output).toContain("\x1b[2J\x1b[H");
	});
});
