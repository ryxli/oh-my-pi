import { describe, expect, it } from "bun:test";
import { FOCUS_FACT_LIMIT, type MemoryFilter, memoryView } from "../src/client/routes/memory-view";
import type { MemoryGraphEdge, MemoryGraphFact, MemoryGraphNode, MemoryGraphResponse } from "../src/client/types";

function fact(id: string, overrides: Partial<MemoryGraphFact> = {}): MemoryGraphFact {
	return {
		type: "fact",
		id,
		factType: "world",
		text: id,
		learnedAt: "2026-10-23T00:00:00.000Z",
		tags: [],
		proofCount: 1,
		...overrides,
	};
}

/** Builds a graph from facts and the entity names each one mentions. */
function graphOf(
	facts: MemoryGraphFact[],
	mentions: Record<string, string[]>,
	derived: MemoryGraphEdge[] = [],
): MemoryGraphResponse {
	const counts = new Map<string, number>();
	const edges: MemoryGraphEdge[] = [];
	for (const [factId, names] of Object.entries(mentions))
		for (const name of names) {
			counts.set(name, (counts.get(name) ?? 0) + 1);
			edges.push({ source: factId, target: `entity:${name}`, type: "mentions" });
		}
	const entities: MemoryGraphNode[] = [...counts].map(([name, count]) => ({
		type: "entity",
		id: `entity:${name}`,
		name,
		mentions: count,
	}));
	return {
		configured: true,
		bankId: "omp",
		totalMemories: facts.length,
		limit: 6000,
		nodes: [...facts, ...entities],
		edges: [...edges, ...derived],
	};
}

const ALL: MemoryFilter = { hiddenTypes: new Set(), project: null, since: null, minMentions: 1, focusId: null };

describe("memoryView", () => {
	it("prunes rarely named entities and the memories only they connected, keeping observations by their sources", () => {
		const graph = graphOf(
			[fact("a"), fact("b"), fact("c"), fact("o", { factType: "observation" })],
			{ a: ["x", "y"], b: ["y"], c: ["z"] },
			[{ source: "o", target: "a", type: "derived-from" }],
		);

		const view = memoryView(graph, { ...ALL, minMentions: 2 });

		expect(view.nodes.map(node => node.id).sort()).toEqual(["a", "b", "entity:y", "o"]);
		expect(view.edges).toEqual([
			{ source: "a", target: "entity:y", type: "mentions" },
			{ source: "b", target: "entity:y", type: "mentions" },
			{ source: "o", target: "a", type: "derived-from" },
		]);
		expect(view.passing).toBe(4);
	});

	it("focus draws the newest memories naming the entity and their notable neighbors", () => {
		const total = FOCUS_FACT_LIMIT + 10;
		const facts = Array.from({ length: total }, (_, index) =>
			fact(`f${index}`, { learnedAt: new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString() }),
		);
		const mentions = Object.fromEntries(facts.map(({ id }) => [id, ["hub", "neighbor"]]));
		mentions[`f${total - 1}`].push("rare");

		const view = memoryView(graphOf(facts, mentions), { ...ALL, minMentions: 2, focusId: "entity:hub" });

		const ids = new Set(view.nodes.map(node => node.id));
		expect(view.focusMentions).toBe(total);
		expect(view.nodes.filter(node => node.type === "fact")).toHaveLength(FOCUS_FACT_LIMIT);
		expect(ids.has(`f${total - 1}`)).toBe(true);
		expect(ids.has("f0")).toBe(false);
		expect(ids.has("entity:neighbor")).toBe(true);
		expect(ids.has("entity:rare")).toBe(false);
	});

	it("filters the time range on when a memory was learned", () => {
		const graph = graphOf(
			[
				fact("old", { learnedAt: "2026-01-01T00:00:00.000Z" }),
				fact("recent", { learnedAt: "2026-10-22T00:00:00.000Z" }),
				fact("unknown", { learnedAt: null }),
			],
			{ old: ["x"], recent: ["x"], unknown: ["x"] },
		);

		const view = memoryView(graph, { ...ALL, since: Date.parse("2026-10-01T00:00:00.000Z") });

		expect(view.passing).toBe(1);
		expect(view.nodes.map(node => node.id)).toEqual(["recent", "entity:x"]);
		expect(view.degree.get("entity:x")).toBe(1);
	});
});
