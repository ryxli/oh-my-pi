export const SCENE_CUT_CUSTOM_TYPE = "scene-cut";
export const SCENE_CUT_MESSAGE_TYPE = "scene-cut-message";
export const MAX_AUTOMATIC_SCENE_CONTINUATIONS = 8;

export interface SceneCut {
	label: string;
	state: string[];
	objective: string;
	exit: string;
	continue: boolean;
	evidence?: string[];
	artifacts?: string[];
}

/**
 * Holds the one requested scene transition until its originating model turn is
 * durably complete. The session owns application because a tool result cannot
 * safely reset the active agent loop synchronously.
 */
export class SceneCutCoordinator {
	#staged: SceneCut | undefined;
	#applying = false;
	#automaticContinuations = 0;
	get hasStaged(): boolean {
		return this.#staged !== undefined;
	}

	stage(cut: SceneCut): void {
		if (this.#staged || this.#applying) {
			throw new Error("A scene cut is already staged for this turn.");
		}
		this.#staged = cut;
	}

	beginApply(): SceneCut | undefined {
		if (!this.#staged || this.#applying) return undefined;
		this.#applying = true;
		return this.#staged;
	}

	claimAutomaticContinuation(cut: SceneCut): "continue" | "wait" | "limit" {
		if (!cut.continue) return "wait";
		if (this.#automaticContinuations >= MAX_AUTOMATIC_SCENE_CONTINUATIONS) return "limit";
		this.#automaticContinuations++;
		return "continue";
	}

	resetAutomaticContinuationChain(): void {
		this.#automaticContinuations = 0;
	}

	completeApply(): void {
		this.#staged = undefined;
		this.#applying = false;
	}
}
