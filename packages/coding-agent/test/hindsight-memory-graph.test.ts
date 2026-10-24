import { afterEach, describe, expect, it } from "bun:test";
import { Settings } from "../src/config/settings";
import { readHindsightMemoryGraph, searchHindsightMemory } from "../src/hindsight/memory-graph";

const servers: { stop: (force?: boolean) => void }[] = [];
afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
});

function unit(id: string, overrides: Record<string, unknown> = {}) {
	return {
		id,
		text: `fact ${id}`,
		mentioned_at: "2026-10-23T00:00:00Z",
		fact_type: "world",
		entities: "",
		tags: ["project:firstmate"],
		proof_count: 1,
		state: "valid",
		source_memory_ids: null,
		...overrides,
	};
}

describe("readHindsightMemoryGraph", () => {
	it("projects valid units, merges entity spellings, and links observations to loaded sources", async () => {
		const secret = `ghp_${"a".repeat(36)}`;
		const requests: string[] = [];
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				const url = new URL(request.url);
				requests.push(`${url.pathname}?offset=${url.searchParams.get("offset")}`);
				return Response.json({
					items: [
						unit("a", { entities: "cluster-a, Slurm" }),
						unit("b", { entities: "CLUSTER-A", fact_type: "experience" }),
						unit("gone", { entities: "cluster-a", state: "invalidated" }),
						unit("obs", {
							fact_type: "observation",
							entities: secret,
							proof_count: 2,
							source_memory_ids: ["a", "not-loaded"],
						}),
					],
					total: 4,
				});
			},
		});
		servers.push(server);
		const settings = Settings.isolated({
			"hindsight.apiUrl": `http://127.0.0.1:${server.port}`,
			"hindsight.scoping": "global",
		});

		const graph = await readHindsightMemoryGraph(settings);

		expect(requests).toEqual(["/v1/default/banks/omp/memories/list?offset=0"]);
		expect(graph.bankId).toBe("omp");
		expect(graph.totalMemories).toBe(4);
		const facts = graph.nodes.filter(node => node.type === "fact");
		expect(facts.map(fact => [fact.id, fact.type === "fact" && fact.factType])).toEqual([
			["a", "world"],
			["b", "experience"],
			["obs", "observation"],
		]);
		const entities = graph.nodes.filter(node => node.type === "entity");
		expect(entities.find(entity => entity.id === "entity:cluster-a")).toEqual({
			type: "entity",
			id: "entity:cluster-a",
			name: "cluster-a",
			mentions: 2,
		});
		expect(JSON.stringify(graph)).not.toContain(secret);
		expect(graph.edges.filter(edge => edge.type === "derived-from")).toEqual([
			{ source: "obs", target: "a", type: "derived-from" },
		]);
	});

	it("returns an empty graph when Hindsight is not configured", async () => {
		const graph = await readHindsightMemoryGraph(Settings.isolated({ "hindsight.apiUrl": "" }));
		expect(graph).toEqual({ bankId: null, totalMemories: 0, limit: 0, nodes: [], edges: [] });
	});
});

describe("searchHindsightMemory", () => {
	it("recalls over the bank and returns redacted hits in rank order", async () => {
		const secret = `ghp_${"b".repeat(36)}`;
		const queries: unknown[] = [];
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				queries.push({ path: new URL(request.url).pathname, body: await request.json() });
				return Response.json({
					results: [
						{ id: "r1", text: `token ${secret}`, type: "experience", mentioned_at: "2026-10-22T00:00:00Z" },
						{ id: "r2", text: "plain", type: "mystery" },
					],
				});
			},
		});
		servers.push(server);
		const settings = Settings.isolated({
			"hindsight.apiUrl": `http://127.0.0.1:${server.port}`,
			"hindsight.scoping": "global",
		});

		const response = await searchHindsightMemory(settings, "cluster-a reservations");

		expect(queries).toEqual([
			{
				path: "/v1/default/banks/omp/memories/recall",
				body: expect.objectContaining({ query: "cluster-a reservations" }),
			},
		]);
		expect(response.results.map(hit => [hit.id, hit.factType, hit.learnedAt])).toEqual([
			["r1", "experience", "2026-10-22T00:00:00Z"],
			["r2", "world", null],
		]);
		expect(JSON.stringify(response)).not.toContain(secret);
	});
});
