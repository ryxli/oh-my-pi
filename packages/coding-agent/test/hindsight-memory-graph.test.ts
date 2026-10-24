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

	it("dates each fact by the transcript message it came from, not the conversation's start", async () => {
		const chunk = (index: number, text: string) => ({ chunk_id: `c${index}`, chunk_index: index, chunk_text: text });
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				const { pathname } = new URL(request.url);
				if (pathname.endsWith("/documents/session-1/chunks"))
					return Response.json({
						items: [
							chunk(2, "[role: user]\n[timestamp: 2026-10-23T15:00:00.000Z]\nlater\n[user:end]"),
							chunk(1, "...the same long assistant message, continued"),
							chunk(
								0,
								"[role: user]\n[timestamp: 2026-10-14T10:00:00.000Z]\nhi\n[user:end]\n[role: assistant]\n[timestamp: 2026-10-14T11:00:00.000Z]\nstart of a long message",
							),
						],
					});
				const fromSession = (id: string, chunkId: string) =>
					unit(id, { mentioned_at: "2026-10-14T09:00:00Z", document_id: "session-1", chunk_id: chunkId });
				return Response.json({
					items: [
						fromSession("early", "c0"),
						fromSession("continued", "c1"),
						fromSession("late", "c2"),
						unit("no-chunk", { mentioned_at: "2026-10-20T08:00:00Z" }),
						unit("obs", { fact_type: "observation", source_memory_ids: ["early", "late"] }),
					],
					total: 5,
				});
			},
		});
		servers.push(server);
		const settings = Settings.isolated({
			"hindsight.apiUrl": `http://127.0.0.1:${server.port}`,
			"hindsight.scoping": "global",
		});

		const graph = await readHindsightMemoryGraph(settings);

		const learned = Object.fromEntries(
			graph.nodes.flatMap(node => (node.type === "fact" ? [[node.id, node.learnedAt]] : [])),
		);
		expect(learned).toEqual({
			early: "2026-10-14T11:00:00.000Z",
			continued: "2026-10-14T11:00:00.000Z",
			late: "2026-10-23T15:00:00.000Z",
			"no-chunk": "2026-10-20T08:00:00.000Z",
			obs: "2026-10-23T15:00:00.000Z",
		});
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
			["r1", "experience", "2026-10-22T00:00:00.000Z"],
			["r2", "world", null],
		]);
		expect(JSON.stringify(response)).not.toContain(secret);
	});
});
