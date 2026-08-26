import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import cutDescription from "../prompts/tools/cut.md" with { type: "text" };
import type { SceneCut } from "../session/scene-cut";
import type { ToolSession } from ".";
import type { OutputMeta } from "./output-meta";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

const cutSchema = type({
	label: type("string").describe("short scene label"),
	state: type("string").array().describe("authoritative facts and decisions for the next scene"),
	objective: type("string").describe("next bounded objective"),
	exit: type("string").describe("condition that completes the objective"),
	"evidence?": type("string").array().describe("optional evidence that supports the scene state"),
	"artifacts?": type("string").array().describe("optional artifact references for the next scene"),
});

type CutParams = typeof cutSchema.infer;

export interface CutToolDetails extends SceneCut {
	staged: true;
	meta?: OutputMeta;
}

function requiredText(value: string, field: "label" | "objective" | "exit"): string {
	const normalized = value.trim();
	if (!normalized) throw new ToolError(`\`${field}\` must be non-empty.`);
	return normalized;
}

function authoritativeState(state: string[]): string[] {
	const normalized = state.map(item => item.trim()).filter(Boolean);
	if (normalized.length === 0)
		throw new ToolError("`state` must contain at least one non-empty authoritative fact or decision.");
	return normalized;
}

function optionalList(items: string[] | undefined): string[] | undefined {
	if (!items) return undefined;
	const normalized = items.map(item => item.trim()).filter(Boolean);
	return normalized.length > 0 ? normalized : undefined;
}

export class CutTool implements AgentTool<typeof cutSchema, CutToolDetails> {
	readonly name = "cut";
	readonly approval = "read" as const;
	readonly label = "Cut";
	readonly summary = "Stage a fresh visible scene after this turn";
	readonly description = prompt.render(cutDescription);
	readonly parameters = cutSchema;
	readonly strict = true;
	readonly loadMode = "essential";
	readonly intent = (args: Partial<CutParams>): string => (args.label ? `cutting to ${args.label}` : "cutting scene");

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): CutTool | null {
		return (session.taskDepth === undefined || session.taskDepth === 0) && session.stageSceneCut
			? new CutTool(session)
			: null;
	}

	async execute(
		_toolCallId: string,
		params: CutParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<CutToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<CutToolDetails>> {
		const cut: SceneCut = {
			label: requiredText(params.label, "label"),
			state: authoritativeState(params.state),
			objective: requiredText(params.objective, "objective"),
			exit: requiredText(params.exit, "exit"),
			evidence: optionalList(params.evidence),
			artifacts: optionalList(params.artifacts),
		};
		const stageSceneCut = this.session.stageSceneCut;
		if (!stageSceneCut) throw new ToolError("Scene cuts are unavailable in this session.");
		stageSceneCut(cut);
		return toolResult<CutToolDetails>({ ...cut, staged: true })
			.text(
				`Scene cut staged: ${cut.label}\n${cut.state.length} authoritative state item${cut.state.length === 1 ? "" : "s"} retained for the next objective.`,
			)
			.done();
	}
}
