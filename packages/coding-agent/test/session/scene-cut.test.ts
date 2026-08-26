import { describe, expect, it } from "bun:test";
import { type SceneCut, SceneCutCoordinator } from "@oh-my-pi/pi-coding-agent/session/scene-cut";

const cut: SceneCut = {
	label: "Verification",
	state: ["The source change is complete"],
	objective: "Run the focused proof",
	exit: "The contract is observed",
};

describe("SceneCutCoordinator", () => {
	it("accepts exactly one staged cut until application completes", () => {
		const coordinator = new SceneCutCoordinator();
		coordinator.stage(cut);

		expect(coordinator.beginApply()).toEqual(cut);
		expect(() => coordinator.stage(cut)).toThrow("already staged");

		coordinator.completeApply();
		coordinator.stage(cut);
		expect(coordinator.beginApply()).toEqual(cut);
	});
});
