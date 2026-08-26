import { describe, expect, it } from "bun:test";
import {
	SCENE_CUT_CUSTOM_TYPE,
	SCENE_CUT_MESSAGE_TYPE,
	type SceneCut,
} from "@oh-my-pi/pi-coding-agent/session/scene-cut";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

const cut: SceneCut = {
	label: "Verification",
	state: ["The source change is complete"],
	objective: "Run the focused proof",
	exit: "The contract is observed",
};

describe("scene cut persistence boundary", () => {
	it("rebuilds only the canonical scene while retaining pre-cut transcript history", () => {
		const manager = SessionManager.inMemory("/tmp/scene-cut-context");
		manager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "pre-cut dialogue" }],
			timestamp: 1,
		});
		manager.appendResetBoundary();
		manager.appendCustomEntry(SCENE_CUT_CUSTOM_TYPE, cut);
		manager.appendCustomMessageEntry(SCENE_CUT_MESSAGE_TYPE, "# Scene: Verification", true, cut, "agent");

		const rebuilt = manager.buildSessionContext().messages;
		expect(rebuilt).toEqual([
			expect.objectContaining({ role: "custom", customType: SCENE_CUT_MESSAGE_TYPE, details: cut }),
		]);
		const transcript = manager.buildSessionContext({ transcript: true }).messages;
		expect(transcript).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ role: "user" }),
				expect.objectContaining({ role: "custom", customType: SCENE_CUT_MESSAGE_TYPE }),
			]),
		);
		expect(
			manager.getEntries().find(entry => entry.type === "custom" && entry.customType === SCENE_CUT_CUSTOM_TYPE),
		).toEqual(expect.objectContaining({ data: cut }));
	});
});
