import { describe, expect, it } from "bun:test";
import { generateImage } from "@oh-my-pi/pi-ai/images";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

const model = buildModel({
	id: "flux-2-pro",
	name: "FLUX.2 Pro",
	provider: "bfl",
	api: "bfl-images",
	kind: "image",
	baseUrl: "https://api.bfl.ai/v1",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 0,
	maxTokens: 0,
});

describe("BFL images", () => {
	it("submits, polls, and downloads a generated image without leaking the API key to the result host", async () => {
		const requests: Array<{ url: string; key: string | null; body?: unknown }> = [];
		const imageBytes = new TextEncoder().encode("generated-image");
		const fetchStub: FetchImpl = async (input, init) => {
			const url = input.toString();
			requests.push({
				url,
				key: new Headers(init?.headers).get("x-key"),
				...(init?.body ? { body: JSON.parse(String(init.body)) as unknown } : {}),
			});
			if (url === "https://api.bfl.ai/v1/flux-2-pro") {
				return Response.json({ id: "task-1", polling_url: "https://api.bfl.ai/v1/get_result?id=task-1" });
			}
			if (url === "https://api.bfl.ai/v1/get_result?id=task-1") {
				return Response.json({ status: "Ready", result: { sample: "https://cdn.example/image.png" } });
			}
			return new Response(imageBytes, { headers: { "content-type": "image/png" } });
		};

		const result = await generateImage(
			model,
			{ prompt: "paint a lighthouse", aspectRatio: "16:9" },
			{ apiKey: "bfl-secret", fetch: fetchStub },
		);

		expect(requests).toEqual([
			{
				url: "https://api.bfl.ai/v1/flux-2-pro",
				key: "bfl-secret",
				body: { prompt: "paint a lighthouse", width: 1344, height: 768 },
			},
			{ url: "https://api.bfl.ai/v1/get_result?id=task-1", key: "bfl-secret" },
			{ url: "https://cdn.example/image.png", key: null },
		]);
		expect(result.images).toEqual([{ data: imageBytes.toBase64(), mimeType: "image/png" }]);
	});
});
