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
import { createHindsightClient, type HindsightApi } from "./client";
import { isHindsightConfigured, loadHindsightConfig } from "./config";
import { lastMessageTimestamp } from "./content";

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
		"document_id?": "string | null",
		"chunk_id?": "string | null",
		"source_memory_ids?": "string[] | null",
	}).array(),
	total: "number",
});

const RecallPage = type({
	results: type({
		id: "string",
		text: "string",
		"type?": "string | null",
		"mentioned_at?": "string | null",
		"document_id?": "string | null",
		"chunk_id?": "string | null",
	}).array(),
});

const ChunkPage = type({
	items: type({ chunk_id: "string", chunk_index: "number", chunk_text: "string" }).array(),
});

const FACT_TYPES: readonly MemoryFactType[] = ["world", "experience", "observation"];

function factTypeOf(raw: string | null | undefined): MemoryFactType {
	return FACT_TYPES.find(candidate => candidate === raw) ?? "world";
}

/**
 * When each chunk of the given documents was said: the last message timestamp at or before it,
 * since a long message spans chunks with no marker of their own. Hindsight dates every fact of a
 * retain with its conversation's start (mentioned_at), so without this a fact from a days-long
 * session reads as days old. Measured 2026-10-23: 35 documents, 2.7 MB, 0.1 s for 6,000 facts.
 */
async function readChunkTimes(
	client: HindsightApi,
	bankId: string,
	documentIds: ReadonlySet<string>,
): Promise<Map<string, string>> {
	const times = new Map<string, string>();
	await Promise.all(
		[...documentIds].map(async documentId => {
			const chunks: (typeof ChunkPage.infer)["items"] = [];
			for (let offset = 0; ; offset += PAGE_SIZE) {
				const page = ChunkPage.assert(
					await client.listDocumentChunks(bankId, documentId, { limit: PAGE_SIZE, offset }),
				);
				chunks.push(...page.items);
				if (page.items.length < PAGE_SIZE) break;
			}
			chunks.sort((a, b) => a.chunk_index - b.chunk_index);
			let last: string | undefined;
			for (const chunk of chunks) {
				last = lastMessageTimestamp(chunk.chunk_text) ?? last;
				if (last) times.set(chunk.chunk_id, last);
			}
		}),
	);
	return times;
}

function documentIdsOf(units: readonly { document_id?: string | null }[]): Set<string> {
	return new Set(units.flatMap(unit => (unit.document_id ? [unit.document_id] : [])));
}

/** Normalized to toISOString form so the page can order times as plain strings; unparseable is unknown. */
function isoTime(value: string | null | undefined): string | null {
	if (!value) return null;
	const time = Date.parse(value);
	return Number.isNaN(time) ? null : new Date(time).toISOString();
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

	const units: (typeof MemoryUnitPage.infer)["items"] = [];
	let totalMemories = 0;
	for (let offset = 0; offset < MEMORY_GRAPH_LIMIT; offset += PAGE_SIZE) {
		const page = MemoryUnitPage.assert(await client.listMemories(bankId, { limit: PAGE_SIZE, offset }));
		totalMemories = page.total;
		units.push(...page.items.filter(unit => unit.state === "valid"));
		if (page.items.length < PAGE_SIZE) break;
	}
	const chunkTimes = await readChunkTimes(client, bankId, documentIdsOf(units));

	const facts: MemoryGraphFact[] = [];
	const sources = new Map<string, string[]>();
	const mentions = new Map<string, MemoryGraphEntity>();
	const edges: MemoryGraphEdge[] = [];
	for (const unit of units) {
		facts.push({
			type: "fact",
			id: unit.id,
			factType: factTypeOf(unit.fact_type),
			text: redactMemorySecrets(unit.text),
			learnedAt: isoTime((unit.chunk_id && chunkTimes.get(unit.chunk_id)) || unit.mentioned_at),
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
	const factById = new Map(facts.map(fact => [fact.id, fact]));
	for (const [observationId, factIds] of sources) {
		// An observation has no source chunk; it is as recent as the newest loaded fact it consolidates.
		let newest: string | null = null;
		for (const factId of factIds) {
			const source = factById.get(factId);
			if (!source) continue;
			edges.push({ source: observationId, target: factId, type: "derived-from" });
			if (source.learnedAt && (newest === null || source.learnedAt > newest)) newest = source.learnedAt;
		}
		const observation = factById.get(observationId);
		if (observation && newest) observation.learnedAt = newest;
	}
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
	const chunkTimes = await readChunkTimes(client, bankId, documentIdsOf(recalled.results));
	return {
		results: recalled.results.map(hit => ({
			id: hit.id,
			factType: factTypeOf(hit.type),
			text: redactMemorySecrets(hit.text),
			learnedAt: isoTime((hit.chunk_id && chunkTimes.get(hit.chunk_id)) || hit.mentioned_at),
		})),
	};
}
