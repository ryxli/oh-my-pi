import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { isMnemopiKnowledgeEnabled } from "../mnemopi/settings";
import knowledgeDescription from "../prompts/tools/knowledge.md" with { type: "text" };
import type { ToolSession } from ".";

const knowledgeSchema = type({
	op: "'list' | 'publish' | 'retract' | 'read'",
	"topic?": "string",
	"key?": "string",
	"kind?": "'decision' | 'investigation' | 'policy'",
	"origin?": "'quoted' | 'inferred'",
	"content?": "string",
	"sources?": type({ type: "'file'", path: "string", quote: "string" })
		.or(type({ type: "'session'", "entryId?": "string", quote: "string", "+": "reject" }))
		.or(type({ type: "'session'", entryId: "string", path: "string", sessionId: "string", quote: "string" }))
		.array(),
	"expectedCurrentId?": "string | null",
	"id?": "string",
	"sourceIndex?": "number.integer >= 0",
});

export type KnowledgeParams = typeof knowledgeSchema.infer;

export class KnowledgeTool implements AgentTool<typeof knowledgeSchema> {
	readonly name = "knowledge";
	readonly label = "Knowledge";
	readonly description = knowledgeDescription;
	readonly parameters = knowledgeSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Inspect or explicitly publish selected domain knowledge with verified evidence";
	readonly approval = (args: unknown) =>
		["list", "read"].includes((args as Partial<KnowledgeParams>).op ?? "") ? "read" : "write";

	constructor(readonly session: ToolSession) {}

	static createIf(session: ToolSession): KnowledgeTool | null {
		return isMnemopiKnowledgeEnabled(session.settings) ? new KnowledgeTool(session) : null;
	}

	async execute(_id: string, params: KnowledgeParams): Promise<AgentToolResult> {
		const knowledge = this.session.getMnemopiSessionState?.()?.knowledge;
		if (!knowledge) throw new Error("Knowledge is not configured for this session.");
		if (params.op === "list") return { content: [{ type: "text", text: await knowledge.snapshot() }], details: {} };
		if (params.op === "read") {
			if (!params.id) throw new Error("knowledge read requires id.");
			return {
				content: [{ type: "text", text: await knowledge.readSources(params.id, params.sourceIndex) }],
				details: {},
			};
		}
		if (params.op === "retract") {
			if (!params.id) throw new Error("knowledge retract requires id.");
			const retracted = knowledge.retract(params.id);
			return { content: [{ type: "text", text: JSON.stringify({ retracted }) }], details: { retracted } };
		}
		if (
			params.topic === undefined ||
			params.key === undefined ||
			params.kind === undefined ||
			params.origin === undefined ||
			params.content === undefined ||
			params.sources === undefined
		) {
			throw new Error("knowledge publish requires topic, key, kind, origin, content, and sources.");
		}
		const record = await knowledge.publish({
			topic: params.topic,
			key: params.key,
			kind: params.kind,
			origin: params.origin,
			content: params.content,
			sources: params.sources,
			// Argument validation strips null from optional fields, so null and
			// omitted both arrive as undefined. A wrong expectation still lands as
			// a visible conflict in the store, never an overwrite.
			expectedCurrentId: params.expectedCurrentId ?? null,
		});
		const receipt = {
			id: record.id,
			topic: record.topic,
			key: record.key,
			state: record.state,
			origin: record.origin,
			predecessorId: record.predecessorId,
		};
		return { content: [{ type: "text", text: JSON.stringify(receipt) }], details: receipt };
	}
}
