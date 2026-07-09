/**
 * Focused tests for click-to-copy: TranscriptContainer.hitTestRow() and the
 * TUI.hitTestScreenRow() hit-test helpers, plus the ANSI-strip + trim step
 * that backs the copy behavior.
 *
 * Scope: hit-test mapping and clipboard copy behavior.
 * Not covered here: real clipboard I/O, terminal output, or full InteractiveMode setup.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { type Component, type Terminal, type TerminalAppearance, TUI } from "@oh-my-pi/pi-tui";

// ---------------------------------------------------------------------------
// Minimal fake terminal for TUI instantiation
// ---------------------------------------------------------------------------

/**
 * A synchronous no-op terminal sufficient for TUI construction + render testing.
 * Captures written bytes in `output`; dimensions are configurable.
 */
class StubTerminal implements Terminal {
	output = "";
	columns: number;
	rows: number;
	kittyProtocolActive = false;
	kittyEnableSequence: string | null = null;
	keyboardEnhancementEnterSequence: string | null = null;
	keyboardEnhancementExitSequence: string | null = null;

	#onInput: ((data: string) => void) | null = null;

	constructor(cols: number, rows: number) {
		this.columns = cols;
		this.rows = rows;
	}

	start(onInput: (data: string) => void, _onResize: () => void): void {
		this.#onInput = onInput;
	}
	stop(): void {
		this.#onInput = null;
	}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.output += data;
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	get appearance(): TerminalAppearance | undefined {
		return undefined;
	}
	onAppearanceChange(_cb: (appearance: TerminalAppearance) => void): void {}

	/** Inject an input event (used to test click handling). */
	sendInput(data: string): void {
		this.#onInput?.(data);
	}
}

// ---------------------------------------------------------------------------
// Simple leaf component stubs
// ---------------------------------------------------------------------------

class FixedBlock implements Component {
	readonly lines: string[];
	renderCount = 0;

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(_width: number): readonly string[] {
		this.renderCount++;
		return this.lines;
	}

	invalidate(): void {}
}

class EmptyBlock implements Component {
	render(_width: number): readonly string[] {
		return [];
	}
	invalidate(): void {}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Trim outer blank rows, mirroring the copy handler. */
function trimBlankEdges(lines: readonly string[]): string[] {
	let start = 0;
	while (start < lines.length && !lines[start]!.trim()) start++;
	let end = lines.length - 1;
	while (end >= start && !lines[end]!.trim()) end--;
	if (start > end) return [];
	return Array.from(lines.slice(start, end + 1));
}

/**
 * Render a block, strip ANSI, trim outer blank rows, join as plain text.
 * Mirrors the copy-handler logic in InteractiveMode.#handleTranscriptClick.
 * Used at multiple test sites so extraction is justified.
 */
function extractBlockText(block: Component, width: number): string {
	const raw = block.render(width);
	const stripped = raw.map(l => l.replace(/\x1b(?:\[[^@-~]*[@-~]|\][^\x07]*\x07|_[^\x07]*\x07|[^[_]])/g, ""));
	return trimBlankEdges(stripped).join("\n");
}

// ---------------------------------------------------------------------------
// TUI scheduler that drains synchronously
// ---------------------------------------------------------------------------

let pendingCallback: (() => void) | null = null;
const syncScheduler = {
	now: () => 0,
	scheduleImmediate: (cb: () => void) => {
		pendingCallback = cb;
	},
	scheduleRender: (cb: () => void, _delay: number) => {
		pendingCallback = cb;
		return { cancel: () => {} };
	},
};

function drainSync(): void {
	while (pendingCallback) {
		const cb = pendingCallback;
		pendingCallback = null;
		cb();
	}
}

// ---------------------------------------------------------------------------
// TranscriptContainer.hitTestRow()
// ---------------------------------------------------------------------------

describe("TranscriptContainer.hitTestRow", () => {
	it("returns null when the container has never rendered", () => {
		const container = new TranscriptContainer();
		container.addChild(new FixedBlock(["line"]));
		expect(container.hitTestRow(0)).toBeNull();
	});

	it("returns null for a row beyond the rendered range", () => {
		const container = new TranscriptContainer();
		const block = new FixedBlock(["a", "b"]);
		container.addChild(block);
		container.render(80);
		// Block renders as rows 0-1 (no separator: first block has sep=0)
		expect(container.hitTestRow(2)).toBeNull();
	});

	it("maps row 0 to the first block, child-local row 0, when there is one block", () => {
		const container = new TranscriptContainer();
		const block = new FixedBlock(["hello"]);
		container.addChild(block);
		container.render(80);
		const hit = container.hitTestRow(0);
		expect(hit).not.toBeNull();
		expect(hit!.child).toBe(block);
		expect(hit!.childLocalRow).toBe(0);
	});

	it("maps into a multi-line block by local offset", () => {
		const container = new TranscriptContainer();
		const block = new FixedBlock(["line0", "line1", "line2"]);
		container.addChild(block);
		container.render(80);
		for (let r = 0; r < 3; r++) {
			const hit = container.hitTestRow(r);
			expect(hit).not.toBeNull();
			expect(hit!.child).toBe(block);
			expect(hit!.childLocalRow).toBe(r);
		}
	});

	it("places a blank separator between blocks and returns null for the separator row", () => {
		const container = new TranscriptContainer();
		const b0 = new FixedBlock(["first"]);
		const b1 = new FixedBlock(["second"]);
		container.addChild(b0);
		container.addChild(b1);
		container.render(80);
		// Layout: row 0 = b0 content, row 1 = separator (blank), row 2 = b1 content
		const hit0 = container.hitTestRow(0);
		expect(hit0?.child).toBe(b0);
		// Separator row
		const hitSep = container.hitTestRow(1);
		expect(hitSep).toBeNull();
		// b1 content
		const hit1 = container.hitTestRow(2);
		expect(hit1?.child).toBe(b1);
		expect(hit1?.childLocalRow).toBe(0);
	});

	it("maps multi-row second block rows to the correct child-local indices", () => {
		const container = new TranscriptContainer();
		container.addChild(new FixedBlock(["a"]));
		const b1 = new FixedBlock(["x", "y", "z"]);
		container.addChild(b1);
		container.render(80);
		// Row 0: "a", row 1: separator, rows 2-4: "x","y","z"
		expect(container.hitTestRow(2)?.childLocalRow).toBe(0);
		expect(container.hitTestRow(3)?.childLocalRow).toBe(1);
		expect(container.hitTestRow(4)?.childLocalRow).toBe(2);
	});

	it("skips empty blocks (they emit no rows)", () => {
		const container = new TranscriptContainer();
		container.addChild(new EmptyBlock());
		const block = new FixedBlock(["visible"]);
		container.addChild(block);
		container.render(80);
		// Empty block contributes nothing; visible block is at row 0 (no sep before it)
		const hit = container.hitTestRow(0);
		expect(hit?.child).toBe(block);
	});

	it("re-renders: after adding a child the hit-test reflects the new layout", () => {
		const container = new TranscriptContainer();
		const b0 = new FixedBlock(["A"]);
		container.addChild(b0);
		container.render(80);
		expect(container.hitTestRow(0)?.child).toBe(b0);

		const b1 = new FixedBlock(["B"]);
		container.addChild(b1);
		container.render(80);
		// b0 at row 0, separator at row 1, b1 at row 2
		expect(container.hitTestRow(0)?.child).toBe(b0);
		expect(container.hitTestRow(2)?.child).toBe(b1);
	});
});

// ---------------------------------------------------------------------------
// TUI.hitTestScreenRow()
// ---------------------------------------------------------------------------

describe("TUI.hitTestScreenRow", () => {
	let term: StubTerminal;
	let tui: TUI;

	beforeEach(() => {
		term = new StubTerminal(80, 24);
		tui = new TUI(term, undefined, { renderScheduler: syncScheduler });
	});

	it("returns null before the first render", () => {
		const child = new FixedBlock(["row"]);
		tui.addChild(child);
		tui.start();
		try {
			expect(tui.hitTestScreenRow(0)).toBeNull();
		} finally {
			tui.stop();
		}
	});

	it("maps screen row 0 to the first root child after render", () => {
		const child = new FixedBlock(["hello"]);
		tui.addChild(child);
		tui.start();
		drainSync();
		try {
			const hit = tui.hitTestScreenRow(0);
			expect(hit).not.toBeNull();
			expect(hit!.component).toBe(child);
			expect(hit!.localRow).toBe(0);
		} finally {
			tui.stop();
		}
	});

	it("maps successive rows within a multi-line child", () => {
		const child = new FixedBlock(["line0", "line1", "line2"]);
		tui.addChild(child);
		tui.start();
		drainSync();
		try {
			for (let r = 0; r < 3; r++) {
				const hit = tui.hitTestScreenRow(r);
				expect(hit?.component).toBe(child);
				expect(hit?.localRow).toBe(r);
			}
		} finally {
			tui.stop();
		}
	});

	it("disambiguates two root children stacked vertically", () => {
		const c0 = new FixedBlock(["alpha"]);
		const c1 = new FixedBlock(["beta"]);
		tui.addChild(c0);
		tui.addChild(c1);
		tui.start();
		drainSync();
		try {
			const hit0 = tui.hitTestScreenRow(0);
			const hit1 = tui.hitTestScreenRow(1);
			expect(hit0?.component).toBe(c0);
			expect(hit1?.component).toBe(c1);
		} finally {
			tui.stop();
		}
	});

	it("returns null for a screen row below all content", () => {
		const child = new FixedBlock(["only-row"]);
		tui.addChild(child);
		tui.start();
		drainSync();
		try {
			// Row 0 is content; row 1 is empty space
			expect(tui.hitTestScreenRow(1)).toBeNull();
		} finally {
			tui.stop();
		}
	});
});

// ---------------------------------------------------------------------------
// Click-copy text extraction (ANSI strip + trim)
// ---------------------------------------------------------------------------

describe("extractBlockText (copy payload logic)", () => {
	it("returns the raw text when there are no ANSI sequences", () => {
		const block = new FixedBlock(["Hello", "World"]);
		expect(extractBlockText(block, 80)).toBe("Hello\nWorld");
	});

	it("strips SGR color codes and resets", () => {
		const block = new FixedBlock(["\x1b[32mGreen\x1b[0m", "Plain"]);
		const text = extractBlockText(block, 80);
		expect(text).toBe("Green\nPlain");
	});

	it("strips OSC 8 hyperlinks", () => {
		const block = new FixedBlock(["\x1b]8;;https://example.com\x07link\x1b]8;;\x07"]);
		expect(extractBlockText(block, 80)).toBe("link");
	});

	it("trims leading and trailing blank rows", () => {
		const block = new FixedBlock(["", "  ", "Content", "", ""]);
		expect(extractBlockText(block, 80)).toBe("Content");
	});

	it("returns empty string for a fully-blank block", () => {
		const block = new FixedBlock(["", "  ", ""]);
		expect(extractBlockText(block, 80)).toBe("");
	});

	it("preserves interior blank lines between content rows", () => {
		const block = new FixedBlock(["first", "", "third"]);
		expect(extractBlockText(block, 80)).toBe("first\n\nthird");
	});

	it("handles mixed ANSI + leading/trailing blanks", () => {
		const block = new FixedBlock(["", "\x1b[1mBold line\x1b[0m", ""]);
		expect(extractBlockText(block, 80)).toBe("Bold line");
	});

	it("preserves newlines inside multi-line blocks", () => {
		const block = new FixedBlock(["A", "B", "C"]);
		expect(extractBlockText(block, 80)).toBe("A\nB\nC");
	});
});

// ---------------------------------------------------------------------------
// Hit-test + extraction integration: full click path without real clipboard
// ---------------------------------------------------------------------------

describe("full click-copy chain (hit-test -> extract)", () => {
	it("identifies the clicked block and extracts its plain text", () => {
		// Simulate a transcript with two blocks; click lands on the second.
		const container = new TranscriptContainer();
		const b0 = new FixedBlock(["User message"]);
		const b1 = new FixedBlock(["\x1b[32mAssistant reply\x1b[0m", "Second line"]);
		container.addChild(b0);
		container.addChild(b1);
		container.render(80);

		// Layout: row 0 = "User message", row 1 = separator, row 2+ = b1 rows
		const hit = container.hitTestRow(2);
		expect(hit).not.toBeNull();
		expect(hit!.child).toBe(b1);

		const text = extractBlockText(hit!.child, 80);
		expect(text).toBe("Assistant reply\nSecond line");
	});

	it("returns null for a separator row (no copy triggered)", () => {
		const container = new TranscriptContainer();
		container.addChild(new FixedBlock(["first"]));
		container.addChild(new FixedBlock(["second"]));
		container.render(80);

		const sepHit = container.hitTestRow(1); // separator between the two blocks
		expect(sepHit).toBeNull();
	});

	it("extracts only inner content from a block with leading ANSI and blank padding", () => {
		const container = new TranscriptContainer();
		const block = new FixedBlock(["", "\x1b[34mColored\x1b[0m", "Normal", ""]);
		container.addChild(block);
		container.render(80);

		// The block itself has blank edges that get stripped from the copy payload.
		// The container also strips them from its contribution (those blank edges won't
		// appear in the container rows), so we test extractBlockText directly here.
		const text = extractBlockText(block, 80);
		expect(text).toBe("Colored\nNormal");
	});

	it("TUI hitTestScreenRow chains into TranscriptContainer.hitTestRow correctly", () => {
		const term = new StubTerminal(80, 24);
		const tui = new TUI(term, undefined, { renderScheduler: syncScheduler });
		const chatContainer = new TranscriptContainer();
		const b0 = new FixedBlock(["msg0"]);
		const b1 = new FixedBlock(["msg1"]);
		chatContainer.addChild(b0);
		chatContainer.addChild(b1);
		// Add another root child so chatContainer is not the sole child
		const statusChild = new FixedBlock(["status"]);
		tui.addChild(chatContainer);
		tui.addChild(statusChild);

		tui.start();
		drainSync();
		try {
			// chatContainer renders: row 0 = b0, row 1 = sep, row 2 = b1
			// statusChild renders: row 3 = "status"
			// Screen row 2 -> chatContainer local row 2 -> b1
			const tuiHit = tui.hitTestScreenRow(2);
			expect(tuiHit?.component).toBe(chatContainer);
			const containerHit = chatContainer.hitTestRow(tuiHit!.localRow);
			expect(containerHit?.child).toBe(b1);
			expect(extractBlockText(containerHit!.child, 80)).toBe("msg1");

			// Screen row 3 -> statusChild (not chatContainer)
			const statusHit = tui.hitTestScreenRow(3);
			expect(statusHit?.component).toBe(statusChild);
			expect(statusHit?.component).not.toBe(chatContainer);
		} finally {
			tui.stop();
		}
	});
});

// ---------------------------------------------------------------------------
// markCopied: indicator lifecycle and rapid-click behaviour
// ---------------------------------------------------------------------------

const INDICATOR = " [ok]";

describe("markCopied indicator lifecycle", () => {
	it("appends indicator to the last row of the marked block after render", () => {
		const container = new TranscriptContainer();
		const block = new FixedBlock(["line0", "line1"]);
		container.addChild(block);
		container.render(80);

		container.markCopied(block, INDICATOR, 5000, () => {});
		const lines = container.render(80);
		// block is first child: rows 0-1 (no separator), indicator on last row
		expect(lines[1]).toBe(`line1${INDICATOR}`);
		// first row is untouched
		expect(lines[0]).toBe("line0");
	});

	it("applies indicator to a single-row block", () => {
		const container = new TranscriptContainer();
		const block = new FixedBlock(["only"]);
		container.addChild(block);
		container.render(80);
		container.markCopied(block, INDICATOR, 5000, () => {});
		const lines = container.render(80);
		expect(lines[0]).toBe(`only${INDICATOR}`);
	});

	it("does NOT double-apply indicator on successive stable frames", () => {
		const container = new TranscriptContainer();
		const block = new FixedBlock(["text"]);
		container.addChild(block);
		container.render(80);
		container.markCopied(block, INDICATOR, 5000, () => {});

		// frame 1: invalidate forces fresh render, indicator applied
		container.render(80);
		// frame 2: block is now stably reused; indicator must not double up
		const lines = container.render(80);
		expect(lines[0]).toBe(`text${INDICATOR}`);
	});

	it("indicator only lands on the last row of a multi-row block", () => {
		const container = new TranscriptContainer();
		const block = new FixedBlock(["a", "b", "c"]);
		container.addChild(block);
		container.render(80);
		container.markCopied(block, INDICATOR, 5000, () => {});
		const lines = container.render(80);
		expect(lines[0]).toBe("a");
		expect(lines[1]).toBe("b");
		expect(lines[2]).toBe(`c${INDICATOR}`);
	});

	it("indicator clears after the timer fires", async () => {
		const container = new TranscriptContainer();
		const block = new FixedBlock(["content"]);
		container.addChild(block);
		container.render(80);

		let clearFired = false;
		container.markCopied(block, INDICATOR, 20, () => {
			clearFired = true;
		});
		container.render(80);

		await new Promise<void>(r => setTimeout(r, 40));
		expect(clearFired).toBe(true);

		// After clear, the container re-renders without the indicator
		const lines = container.render(80);
		expect(lines[0]).toBe("content");
	});

	it("indicator on second block (separator between blocks)", () => {
		const container = new TranscriptContainer();
		const b0 = new FixedBlock(["first"]);
		const b1 = new FixedBlock(["second"]);
		container.addChild(b0);
		container.addChild(b1);
		container.render(80);
		container.markCopied(b1, INDICATOR, 5000, () => {});
		const lines = container.render(80);
		// layout: row 0 = "first", row 1 = separator, row 2 = "second"
		expect(lines[0]).toBe("first"); // untouched
		expect(lines[1]).toBe(""); // separator
		expect(lines[2]).toBe(`second${INDICATOR}`);
	});

	it("empty block is skipped by the indicator (no rowCount)", () => {
		const container = new TranscriptContainer();
		const empty = new EmptyBlock();
		const block = new FixedBlock(["visible"]);
		container.addChild(empty);
		container.addChild(block);
		container.render(80);

		// markCopied on the empty block: seg.rowCount === 0 so no overlay applied
		container.markCopied(empty, INDICATOR, 5000, () => {});
		const lines = container.render(80);
		expect(lines[0]).toBe("visible"); // no indicator on the wrong block
	});
});

describe("markCopied rapid-click behaviour", () => {
	it("rapid click same block refreshes indicator without stacking timers", async () => {
		const container = new TranscriptContainer();
		const block = new FixedBlock(["msg"]);
		container.addChild(block);
		container.render(80);

		let clearCount = 0;
		// first click: 20 ms timer
		container.markCopied(block, INDICATOR, 20, () => {
			clearCount++;
		});
		container.render(80);
		// second click before first timer fires: replaces it
		container.markCopied(block, INDICATOR, 20, () => {
			clearCount++;
		});
		const lines = container.render(80);
		expect(lines[0]).toBe(`msg${INDICATOR}`);

		// wait for second timer to fire
		await new Promise<void>(r => setTimeout(r, 40));
		// only one clear callback fires (the second timer; the first was cancelled)
		expect(clearCount).toBe(1);
	});

	it("rapid click different block moves indicator to new block", () => {
		const container = new TranscriptContainer();
		const b0 = new FixedBlock(["alpha"]);
		const b1 = new FixedBlock(["beta"]);
		container.addChild(b0);
		container.addChild(b1);
		container.render(80);

		container.markCopied(b0, INDICATOR, 5000, () => {});
		container.render(80); // b0 gets indicator

		// switch to b1
		container.markCopied(b1, INDICATOR, 5000, () => {});
		const lines = container.render(80);
		// row 0 = "alpha", row 1 = sep, row 2 = "beta"
		expect(lines[0]).toBe("alpha"); // indicator moved away from b0
		expect(lines[2]).toBe(`beta${INDICATOR}`);
	});

	it("separator click (null hit) produces no indicator", () => {
		const container = new TranscriptContainer();
		container.addChild(new FixedBlock(["first"]));
		container.addChild(new FixedBlock(["second"]));
		container.render(80);

		// A null hit from hitTestRow means markCopied is never called in the
		// click handler; verify the separator row returns null.
		const sepHit = container.hitTestRow(1);
		expect(sepHit).toBeNull();

		// With no markCopied call, no indicator appears on any render.
		const lines = container.render(80);
		expect(lines[0]).toBe("first");
		expect(lines[2]).toBe("second");
	});
});
