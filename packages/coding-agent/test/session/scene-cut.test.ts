import { describe, expect, it } from "bun:test";
import {
	MAX_AUTOMATIC_SCENE_CONTINUATIONS,
	type SceneCut,
	SceneCutCoordinator,
} from "@oh-my-pi/pi-coding-agent/session/scene-cut";

const cut: SceneCut = {
	label: "Verification",
	state: ["The source change is complete"],
	objective: "Run the focused proof",
	exit: "The contract is observed",
	continue: true,
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

	it("waits explicitly and bounds automatic continuation chains until user input resets them", () => {
		const coordinator = new SceneCutCoordinator();
		expect(coordinator.claimAutomaticContinuation({ ...cut, continue: false })).toBe("wait");
		for (let index = 0; index < MAX_AUTOMATIC_SCENE_CONTINUATIONS; index++) {
			expect(coordinator.claimAutomaticContinuation(cut)).toBe("continue");
		}
		expect(coordinator.claimAutomaticContinuation(cut)).toBe("limit");

		coordinator.resetAutomaticContinuationChain();
		expect(coordinator.claimAutomaticContinuation(cut)).toBe("continue");
	});
});
