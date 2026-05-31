import { describe, expect, test } from "bun:test";
import type { Component } from "@oh-my-pi/pi-tui";
import { BUNDLED_DSTUI_SOURCES, getBundledSource, mountConfirm, mountPicker, mountProgress } from "../src/bundled";
import type { OverlayMount } from "../src/overlay";

function stripAnsi(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}

interface Harness {
	mount: OverlayMount;
	drive(input: string): void;
	rendered(width: number): string[];
}

function makeHarness(): Harness {
	let active: Component | undefined;
	const mount: OverlayMount = {
		custom: async <T>(
			factory: (
				tui: unknown,
				theme: unknown,
				keybindings: unknown,
				done: (result: T) => void,
			) => Component | Promise<Component>,
		): Promise<T> => {
			const { promise, resolve } = Promise.withResolvers<T>();
			active = await factory(null, null, null, value => resolve(value));
			return promise;
		},
	};
	return {
		mount,
		drive: input => active?.handleInput?.(input),
		rendered: width => active?.render(width) ?? [],
	};
}

describe("BUNDLED_DSTUI_SOURCES", () => {
	test("exposes picker, confirm and progress sources as strings", () => {
		for (const name of ["picker", "confirm", "progress"] as const) {
			const src = getBundledSource(name);
			expect(typeof src).toBe("string");
			expect(src.length).toBeGreaterThan(0);
			expect(src).toEqual(BUNDLED_DSTUI_SOURCES[name]);
			expect(src.includes("(defcomponent")).toBe(true);
		}
	});
});

describe("mountPicker", () => {
	test("navigates and emits the selected index", async () => {
		const h = makeHarness();
		const promise = mountPicker(h.mount, {
			title: "Choose",
			items: ["alpha", "beta", "gamma"],
			selectedIndex: 0,
		});
		await Promise.resolve();
		expect(stripAnsi(h.rendered(20)[0] ?? "")).toBe("Choose");
		h.drive("\u001b[B"); // down
		h.drive("\u001b[B"); // down
		h.drive("\r");
		await expect(promise).resolves.toEqual({ reason: "emit", value: 2 });
	});

	test("up does not go below 0", async () => {
		const h = makeHarness();
		const promise = mountPicker(h.mount, { items: ["a", "b"], selectedIndex: 0 });
		await Promise.resolve();
		h.drive("\u001b[A");
		h.drive("\u001b[A");
		h.drive("\r");
		await expect(promise).resolves.toEqual({ reason: "emit", value: 0 });
	});

	test("down does not exceed last index", async () => {
		const h = makeHarness();
		const promise = mountPicker(h.mount, { items: ["a", "b"], selectedIndex: 0 });
		await Promise.resolve();
		h.drive("\u001b[B");
		h.drive("\u001b[B");
		h.drive("\u001b[B");
		h.drive("\r");
		await expect(promise).resolves.toEqual({ reason: "emit", value: 1 });
	});

	test("escape cancels", async () => {
		const h = makeHarness();
		const promise = mountPicker(h.mount, { items: ["a"] });
		await Promise.resolve();
		h.drive("\u001b");
		await expect(promise).resolves.toEqual({ reason: "cancel", value: null });
	});
});

describe("mountConfirm", () => {
	test("emits true on Enter when Yes is the default", async () => {
		const h = makeHarness();
		const promise = mountConfirm(h.mount, { prompt: "Delete file?" });
		await Promise.resolve();
		h.drive("\r");
		await expect(promise).resolves.toEqual({ reason: "emit", value: true });
	});

	test("emits false after switching to No", async () => {
		const h = makeHarness();
		const promise = mountConfirm(h.mount, { prompt: "Confirm?" });
		await Promise.resolve();
		h.drive("\u001b[C"); // right -> no
		h.drive("\r");
		await expect(promise).resolves.toEqual({ reason: "emit", value: false });
	});

	test("escape cancels", async () => {
		const h = makeHarness();
		const promise = mountConfirm(h.mount, { prompt: "?" });
		await Promise.resolve();
		h.drive("\u001b");
		await expect(promise).resolves.toEqual({ reason: "cancel", value: null });
	});
});

describe("mountProgress", () => {
	test("renders an indeterminate spinner and cancels on Esc", async () => {
		const h = makeHarness();
		const promise = mountProgress(h.mount, { caption: "Loading...", tickMs: 100 });
		await Promise.resolve();
		const line = stripAnsi(h.rendered(20)[0] ?? "");
		expect(line.length).toBeGreaterThan(0);
		expect(line).toContain("Loading...");
		h.drive("\u001b");
		await expect(promise).resolves.toEqual({ reason: "cancel", value: null });
	});
});
