import { afterEach, describe, expect, it, vi } from "bun:test";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

// Regression test for https://github.com/can1357/oh-my-pi/issues/2115
//
// Large CJK session resumes on Windows legacy console hosts used to feed the
// terminal a full synchronized paint for the entire transcript. ProcessTerminal
// split that payload into ConPTY-sized writes, but the renderer still built a
// multi-megabyte paint and asked the Windows host to process every historical
// row in one DEC 2026 frame. Legacy conhost/ConPTY byte parsing could park the
// viewport mid-conversation, and even ASCII sessions became sluggish once the
// replay crossed ~1-2 MiB.

const PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, "platform");

class LargeCjkContent implements Component {
	#lines: string[];

	constructor(lineCount: number) {
		this.#lines = new Array<string>(lineCount);
		for (let i = 0; i < lineCount; i++) {
			this.#lines[i] = `第${i.toString().padStart(5, "0")}行：${"界".repeat(80)}`;
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		const rendered = new Array<string>(this.#lines.length);
		for (let i = 0; i < this.#lines.length; i++) {
			rendered[i] = this.#lines[i]!.slice(0, width);
		}
		return rendered;
	}
}

describe("issue #2115: ConPTY large-session resume truncates at logical lines", () => {
	afterEach(() => {
		if (PLATFORM_DESCRIPTOR) Object.defineProperty(process, "platform", PLATFORM_DESCRIPTOR);
		vi.restoreAllMocks();
	});

	it("bounds a Windows CJK resume paint while preserving the visible tail", async () => {
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		const term = new VirtualTerminal(80, 24, 12_000);
		const writes: string[] = [];
		const realWrite = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation((data: string) => {
			writes.push(data);
			realWrite(data);
		});
		const tui = new TUI(term);
		tui.addChild(new LargeCjkContent(9000));

		try {
			tui.start({ clearScrollback: true });
			await term.waitForRender();

			const fullPaint = writes.find(write => write.includes("\x1b[2J"));
			expect(fullPaint).toBeDefined();
			expect(Buffer.byteLength(fullPaint ?? "", "utf8")).toBeLessThan(128 * 1024);
			expect(fullPaint).toContain("older lines hidden");
			expect(fullPaint).not.toContain("第00000行");

			const viewport = term.getViewport().map(line => line.trimEnd());
			expect(viewport[viewport.length - 1]).toContain("第08999行");
			expect(term.getScrollBuffer().some(line => line.includes("older lines hidden"))).toBe(true);
		} finally {
			tui.stop();
		}
	});
});
