import { type } from "@oh-my-pi/omptype";
import type {
	MemoryFactType,
	MemoryGraphEdge,
	MemoryGraphEntity,
	MemoryGraphFact,
	MemoryGraphResponse,
} from "@oh-my-pi/omp-stats/shared-types";
import type { Settings } from "../config/settings";
import { redactMemorySecrets } from "../memory-backend/redact";
import { computeBankScope } from "./bank";
import { createHindsightClient } from "./client";
import { isHindsightConfigured, loadHindsightConfig } from "./config";

/** Newest units drawn; the canvas stays interactive well past this, the JSON stays a few MB. */
const MEMORY_GRAPH_LIMIT = 6000;
const PAGE_SIZE = 1000;

const MemoryUnitPage = type({
	items: type({
		id: "string",
		text: "string",
		date: "string | null",
		fact_type: "string | null",
		entities: "string",
		tags: "string[]",
		proof_count: "number",
		state: "string",
		"source_memory_ids?": "string[] | null",
	}).array(),
	total: "number",
});

const FACT_TYPES: readonly MemoryFactType[] = ["world", "experience", "observation"];

/**
 * Projects the session's Hindsight bank into the stats Memory page: memory units,
 * the entities they mention, and observation provenance. Unconfigured Hindsight
 * yields an empty graph rather than an error, so the page can explain setup.
 */
export async function readHindsightMemoryGraph(settings: Settings): Promise<Omit<MemoryGraphResponse, "configured">> {
	const config = loadHindsightConfig(settings);
	if (!isHindsightConfigured(config)) return { bankId: null, totalMemories: 0, limit: 0, nodes: [], edges: [] };
	const client = createHindsightClient(config);
	const { bankId } = computeBankScope(config, settings.getCwd());

	const facts: MemoryGraphFact[] = [];
	const sources = new Map<string, string[]>();
	const mentions = new Map<string, MemoryGraphEntity>();
	const edges: MemoryGraphEdge[] = [];
	let totalMemories = 0;
	for (let offset = 0; offset < MEMORY_GRAPH_LIMIT; offset += PAGE_SIZE) {
		const page = MemoryUnitPage.assert(await client.listMemories(bankId, { limit: PAGE_SIZE, offset }));
		totalMemories = page.total;
		for (const unit of page.items) {
			if (unit.state !== "valid") continue;
			const factType = FACT_TYPES.find(candidate => candidate === unit.fact_type) ?? "world";
			facts.push({
				type: "fact",
				id: unit.id,
				factType,
				text: redactMemorySecrets(unit.text),
				date: unit.date,
				tags: unit.tags,
				proofCount: unit.proof_count,
			});
			if (unit.source_memory_ids?.length) sources.set(unit.id, unit.source_memory_ids);
			for (const raw of unit.entities.split(",")) {
				const name = redactMemorySecrets(raw.trim());
				if (!name) continue;
				const id = `entity:${name.toLowerCase()}`;
				const entity = mentions.get(id) ?? { type: "entity", id, name, mentions: 0 };
				entity.mentions++;
				mentions.set(id, entity);
				edges.push({ source: unit.id, target: id, type: "mentions" });
			}
		}
		if (page.items.length < PAGE_SIZE) break;
	}
	const loaded = new Set(facts.map(fact => fact.id));
	for (const [observation, factIds] of sources)
		for (const factId of factIds)
			if (loaded.has(factId)) edges.push({ source: observation, target: factId, type: "derived-from" });
	return {
		bankId,
		totalMemories,
		limit: MEMORY_GRAPH_LIMIT,
		nodes: [...facts, ...mentions.values()],
		edges,
	};
}
