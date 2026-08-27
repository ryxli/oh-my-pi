import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { SceneCut } from "@oh-my-pi/pi-coding-agent/session/scene-cut";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { CutTool } from "@oh-my-pi/pi-coding-agent/tools";

function createSession(taskDepth = 0): { session: ToolSession; staged: SceneCut[] } {
	const staged: SceneCut[] = [];
	return {
		staged,
		session: {
			cwd: "/tmp/cut-tool",
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			taskDepth,
			settings: Settings.isolated(),
			stageSceneCut: cut => staged.push(cut),
		},
	};
}

describe("CutTool", () => {
	it("is unavailable to subagents", () => {
		const { session } = createSession(1);
		expect(CutTool.createIf(session)).toBeNull();
	});

	it("rejects empty required fields before staging", async () => {
		const { session, staged } = createSession();
		const tool = CutTool.createIf(session);
		if (!tool) throw new Error("Expected top-level cut tool");

		await expect(
			tool.execute("call-1", { label: "scene", state: [], objective: "next", exit: "done" }),
		).rejects.toThrow("state");
		expect(staged).toEqual([]);
	});

	it("stages one authoritative scene cut", async () => {
		const { session, staged } = createSession();
		const tool = CutTool.createIf(session);
		if (!tool) throw new Error("Expected top-level cut tool");

		const result = await tool.execute("call-1", {
			label: "Verification",
			state: ["Source change is complete"],
			objective: "Run the focused proof",
			exit: "The contract is observed",
			evidence: ["artifact://proof"],
		});

		expect(staged).toEqual([
			{
				label: "Verification",
				state: ["Source change is complete"],
				objective: "Run the focused proof",
				exit: "The contract is observed",
				continue: true,
				evidence: ["artifact://proof"],
				artifacts: undefined,
			},
		]);
		expect(result.details).toMatchObject({ staged: true, label: "Verification" });
	});

	it("can stage a scene that waits for user input", async () => {
		const { session, staged } = createSession();
		const tool = CutTool.createIf(session);
		if (!tool) throw new Error("Expected top-level cut tool");

		await tool.execute("call-wait", {
			label: "Decision",
			state: ["The alternatives are fully diagnosed"],
			objective: "Obtain the user's decision",
			exit: "The user chooses an alternative",
			continue: false,
		});

		expect(staged[0]?.continue).toBe(false);
	});
});
