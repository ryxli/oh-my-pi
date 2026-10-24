/**
 * What the Memory page draws: the loaded Hindsight graph narrowed by filters,
 * pruned to entities worth a node, or replaced by one entity's neighborhood,
 * plus the node colors for the active color mode.
 */
import type {
	MemoryFactType,
	MemoryGraphEdge,
	MemoryGraphEntity,
	MemoryGraphFact,
	MemoryGraphNode,
	MemoryGraphResponse,
} from "../types";

/** Memories drawn around a focused entity, newest first; hubs are named by thousands. */
export const FOCUS_FACT_LIMIT = 150;

export const FACT_COLOR: Record<MemoryFactType, string> = {
	world: "#5ad8e6",
	experience: "#ed4abf",
	observation: "#9d7bff",
};
export const ENTITY_COLOR = "#f5b54a";
export const FACT_LABEL: Record<MemoryFactType, string> = {
	world: "World fact",
	experience: "Experience",
	observation: "Observation",
};

const DAY_MS = 86_400_000;
/** Newest first; a node takes the first bucket its last learned time fits. */
export const RECENCY_BUCKETS = [
	{ label: "Last 24h", maxAgeMs: DAY_MS, color: "#fff1b8" },
	{ label: "Last 7d", maxAgeMs: 7 * DAY_MS, color: "#f5b54a" },
	{ label: "Last 30d", maxAgeMs: 30 * DAY_MS, color: "#c2702a" },
	{ label: "Older", maxAgeMs: Number.POSITIVE_INFINITY, color: "#5b5b66" },
] as const;

export type MemoryColorMode = "type" | "recency";

export interface MemoryFilter {
	hiddenTypes: ReadonlySet<MemoryFactType>;
	project: string | null;
	/** Earliest learned time drawn, epoch ms; null draws all time. */
	since: number | null;
	/** Entities named by fewer passing memories are dropped, with the memories only they connected. */
	minMentions: number;
	/** Entity whose neighborhood replaces the whole graph. */
	focusId: string | null;
}

export interface MemoryView {
	nodes: MemoryGraphNode[];
	edges: MemoryGraphEdge[];
	/** Drawn memories naming each entity; sizes entity nodes, so a focus scales to its own neighborhood. */
	degree: Map<string, number>;
	/** Memories that pass the type, project, and time filters. */
	passing: number;
	/** Passing memories naming the focused entity; the newest {@link FOCUS_FACT_LIMIT} are drawn. */
	focusMentions: number;
}

/** Fill colors in draw order (later colors paint on top) and each node's color slot. */
export interface MemoryPaint {
	palette: readonly string[];
	/** Aligned with the view's nodes. */
	slotOf: Uint8Array;
}

export const newestFirst = (a: MemoryGraphFact, b: MemoryGraphFact) =>
	(b.learnedAt ?? "").localeCompare(a.learnedAt ?? "");

export function memoryView(graph: MemoryGraphResponse, filter: MemoryFilter): MemoryView {
	const passing = new Map<string, MemoryGraphFact>();
	for (const node of graph.nodes) {
		if (node.type !== "fact" || filter.hiddenTypes.has(node.factType)) continue;
		if (filter.project !== null && !node.tags.includes(filter.project)) continue;
		if (filter.since !== null && !(node.learnedAt !== null && Date.parse(node.learnedAt) >= filter.since)) continue;
		passing.set(node.id, node);
	}
	const passingMentions = new Map<string, number>();
	for (const edge of graph.edges)
		if (edge.type === "mentions" && passing.has(edge.source))
			passingMentions.set(edge.target, (passingMentions.get(edge.target) ?? 0) + 1);
	const isNotable = (entityId: string) => (passingMentions.get(entityId) ?? 0) >= filter.minMentions;

	const kept = new Set<string>();
	let focusMentions = 0;
	if (filter.focusId !== null) {
		const focusId = filter.focusId;
		const named = graph.edges.flatMap(edge =>
			edge.type === "mentions" && edge.target === focusId ? (passing.get(edge.source) ?? []) : [],
		);
		focusMentions = named.length;
		const facts = new Set(
			named
				.sort(newestFirst)
				.slice(0, FOCUS_FACT_LIMIT)
				.map(fact => fact.id),
		);
		kept.add(focusId);
		for (const id of facts) kept.add(id);
		for (const edge of graph.edges)
			if (edge.type === "mentions" && facts.has(edge.source) && isNotable(edge.target)) kept.add(edge.target);
	} else {
		for (const edge of graph.edges)
			if (edge.type === "mentions" && passing.has(edge.source) && isNotable(edge.target)) {
				kept.add(edge.source);
				kept.add(edge.target);
			}
		// Observations often name no entity; keep them beside the facts they consolidate.
		for (const edge of graph.edges)
			if (
				edge.type === "derived-from" &&
				passing.has(edge.source) &&
				passing.has(edge.target) &&
				(kept.has(edge.source) || kept.has(edge.target))
			) {
				kept.add(edge.source);
				kept.add(edge.target);
			}
	}
	const edges = graph.edges.filter(edge => kept.has(edge.source) && kept.has(edge.target));
	const degree = new Map<string, number>();
	for (const edge of edges) if (edge.type === "mentions") degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
	return {
		nodes: graph.nodes.filter(node => kept.has(node.id)),
		edges,
		degree,
		passing: passing.size,
		focusMentions,
	};
}

const TYPE_PALETTE = [FACT_COLOR.world, FACT_COLOR.experience, FACT_COLOR.observation, ENTITY_COLOR];
const TYPE_SLOT: Record<MemoryFactType, number> = { world: 0, experience: 1, observation: 2 };
const ENTITY_SLOT = 3;
/** Oldest first, so the newest memories paint on top. */
const RECENCY_PALETTE = RECENCY_BUCKETS.map(bucket => bucket.color).reverse();

/** Colors by memory type, or by how recently each memory (an entity: its newest memory) was learned. */
export function memoryPaint(view: MemoryView, mode: MemoryColorMode, now: number): MemoryPaint {
	const slotOf = new Uint8Array(view.nodes.length);
	if (mode === "type") {
		view.nodes.forEach((node, index) => {
			slotOf[index] = node.type === "entity" ? ENTITY_SLOT : TYPE_SLOT[node.factType];
		});
		return { palette: TYPE_PALETTE, slotOf };
	}
	const learned = new Map<string, number>();
	for (const node of view.nodes)
		if (node.type === "fact" && node.learnedAt !== null) learned.set(node.id, Date.parse(node.learnedAt));
	for (const edge of view.edges) {
		if (edge.type !== "mentions") continue;
		const at = learned.get(edge.source);
		if (at !== undefined && at > (learned.get(edge.target) ?? Number.NEGATIVE_INFINITY)) learned.set(edge.target, at);
	}
	view.nodes.forEach((node, index) => {
		const at = learned.get(node.id);
		const bucket =
			at === undefined ? RECENCY_BUCKETS.length - 1 : RECENCY_BUCKETS.findIndex(entry => now - at <= entry.maxAgeMs);
		slotOf[index] = RECENCY_BUCKETS.length - 1 - bucket;
	});
	return { palette: RECENCY_PALETTE, slotOf };
}

/** Entity names containing `query`: prefix matches first, then the most mentioned. */
export function matchEntities(
	entities: readonly MemoryGraphEntity[],
	query: string,
	limit: number,
): MemoryGraphEntity[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return [];
	return entities
		.flatMap(entity => {
			const at = entity.name.toLowerCase().indexOf(needle);
			return at < 0 ? [] : [{ entity, isPrefix: at === 0 }];
		})
		.sort((a, b) => Number(b.isPrefix) - Number(a.isPrefix) || b.entity.mentions - a.entity.mentions)
		.slice(0, limit)
		.map(match => match.entity);
}
