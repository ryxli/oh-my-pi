import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { cfgMemoryBackend } from "../memory-backend/settings";
import { cfgMnemopiKnowledgeEnabled } from "../mnemopi/settings";
import knowledgeDescription from "../prompts/tools/knowledge.md" with { type: "text" };
import type { ToolSession } from ".";

const knowledgeSchema = type({
	op: "'list' | 'publish' | 'retract'",
	"topic?": "string",
	"kind?": "'decision' | 'investigation' | 'policy'",
	"origin?": "'quoted' | 'inferred'",
	"content?": "string",
	"sources?": type({ type: "'file'", path: "string", quote: "string" })
		.or(type({ type: "'session'", "entryId?": "string", quote: "string" }))
		.array(),
	"expectedCurrentId?": "string | null",
	"id?": "string",
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
	readonly approval = (args: unknown) => ((args as Partial<KnowledgeParams>).op === "list" ? "read" : "write");

	constructor(readonly session: ToolSession) {}

	static createIf(session: ToolSession): KnowledgeTool | null {
		return cfgMemoryBackend.get(session.settings) === "mnemopi" && cfgMnemopiKnowledgeEnabled.get(session.settings)
			? new KnowledgeTool(session)
			: null;
	}

	async execute(_id: string, params: KnowledgeParams): Promise<AgentToolResult> {
		const knowledge = this.session.getMnemopiSessionState?.()?.knowledge;
		if (!knowledge) throw new Error("Knowledge is not configured for this session.");
		if (params.op === "list") return { content: [{ type: "text", text: await knowledge.snapshot() }], details: {} };
		if (params.op === "retract") {
			if (!params.id) throw new Error("knowledge retract requires id.");
			const retracted = knowledge.retract(params.id);
			return { content: [{ type: "text", text: JSON.stringify({ retracted }) }], details: { retracted } };
		}
		if (
			params.topic === undefined ||
			params.kind === undefined ||
			params.origin === undefined ||
			params.content === undefined ||
			params.sources === undefined ||
			params.expectedCurrentId === undefined
		) {
			throw new Error(
				"knowledge publish requires topic, kind, origin, content, sources, and expectedCurrentId (null for no current record).",
			);
		}
		const record = await knowledge.publish({
			topic: params.topic,
			kind: params.kind,
			origin: params.origin,
			content: params.content,
			sources: params.sources,
			expectedCurrentId: params.expectedCurrentId,
		});
		const receipt = {
			id: record.id,
			topic: record.topic,
			state: record.state,
			origin: record.origin,
			predecessorId: record.predecessorId,
		};
		return { content: [{ type: "text", text: JSON.stringify(receipt) }], details: receipt };
	}
}
