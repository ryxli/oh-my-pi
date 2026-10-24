import { type } from "@oh-my-pi/omptype";
import type { StatsMemoryProvider } from "@oh-my-pi/omp-stats";
import type {
	MemoryFactType,
	MemoryGraphEdge,
	MemoryGraphEntity,
	MemoryGraphFact,
	MemoryGraphResponse,
	MemorySearchResponse,
} from "@oh-my-pi/omp-stats/shared-types";
import type { Settings } from "../config/settings";
import { redactMemorySecrets } from "../memory-backend/redact";
import { computeBankScope } from "./bank";
import { createHindsightClient } from "./client";
import { isHindsightConfigured, loadHindsightConfig } from "./config";

/** Newest units drawn; the canvas stays interactive well past this, the JSON stays a few MB. */
const MEMORY_GRAPH_LIMIT = 6000;
const PAGE_SIZE = 1000;
/** Recall token budget for a page search: ~50 memories, about 1.5 s on the local reranker. */
const SEARCH_MAX_TOKENS = 4096;

const MemoryUnitPage = type({
	items: type({
		id: "string",
		text: "string",
		mentioned_at: "string | null",
		fact_type: "string | null",
		entities: "string",
		tags: "string[]",
		proof_count: "number",
		state: "string",
		"source_memory_ids?": "string[] | null",
	}).array(),
	total: "number",
});

const RecallPage = type({
	results: type({ id: "string", text: "string", "type?": "string | null", "mentioned_at?": "string | null" }).array(),
});

const FACT_TYPES: readonly MemoryFactType[] = ["world", "experience", "observation"];

function factTypeOf(raw: string | null | undefined): MemoryFactType {
	return FACT_TYPES.find(candidate => candidate === raw) ?? "world";
}

/** Stats Memory page source over the Hindsight bank the loaded settings select. */
export function hindsightStatsMemory(loadSettings: () => Promise<Settings>): StatsMemoryProvider {
	return {
		graph: async () => readHindsightMemoryGraph(await loadSettings()),
		search: async query => searchHindsightMemory(await loadSettings(), query),
	};
}

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
			const factType = factTypeOf(unit.fact_type);
			facts.push({
				type: "fact",
				id: unit.id,
				factType,
				text: redactMemorySecrets(unit.text),
				learnedAt: unit.mentioned_at,
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

/** Ranked recall over the whole bank; uses Hindsight's local embedder and reranker, no LLM. */
export async function searchHindsightMemory(settings: Settings, query: string): Promise<MemorySearchResponse> {
	const config = loadHindsightConfig(settings);
	if (!isHindsightConfigured(config)) return { results: [] };
	const client = createHindsightClient(config);
	const { bankId } = computeBankScope(config, settings.getCwd());
	const recalled = RecallPage.assert(await client.recall(bankId, query, { maxTokens: SEARCH_MAX_TOKENS }));
	return {
		results: recalled.results.map(hit => ({
			id: hit.id,
			factType: factTypeOf(hit.type),
			text: redactMemorySecrets(hit.text),
			learnedAt: hit.mentioned_at ?? null,
		})),
	};
}
