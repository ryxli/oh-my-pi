import type { Model } from "@oh-my-pi/pi-catalog/types";
import { withAuth } from "../auth-retry";
import * as AIError from "../error";
import { emptyUsage, imageBaseUrl, imageFromUrl, modelHeaders } from "./shared";
import type { ImageGenerationOptions, ImageGenerationRequest, ImageGenerationResult } from "./types";

const BFL_EDIT_MODEL = "flux-kontext-pro";
const BFL_POLL_INTERVAL_MS = 1500;
const BFL_POLLING_ORIGINS: Record<string, true> = {
	"https://api.bfl.ai": true,
	"https://api.eu.bfl.ai": true,
	"https://api.us.bfl.ai": true,
};

interface BflGenerationRequest {
	prompt: string;
	aspect_ratio?: string;
	width?: number;
	height?: number;
	input_image?: string;
}

interface BflSubmitResponse {
	id?: string;
	polling_url?: string;
}

interface BflResultResponse {
	status?: string;
	result?: { sample?: string };
}

export function resolveBflDimensions(aspectRatio: string): { width: number; height: number } {
	const [w = 1, h = 1] = aspectRatio.split(":").map(Number);
	const scale = Math.sqrt((1024 * 1024) / (w * h));
	const snap = (term: number) => Math.min(1440, Math.max(256, Math.floor((term * scale) / 32) * 32));
	return { width: snap(w), height: snap(h) };
}

export function resolveBflPollingUrl(submitted: BflSubmitResponse, baseUrl: string): string {
	if (!submitted.polling_url) {
		if (!submitted.id?.trim()) {
			throw new AIError.ProviderResponseError("BFL response is missing both polling URL and task id", {
				kind: "envelope",
			});
		}
		return `${baseUrl}/get_result?id=${encodeURIComponent(submitted.id)}`;
	}

	let url: URL;
	try {
		url = new URL(submitted.polling_url);
	} catch (cause) {
		throw new AIError.ProviderResponseError("BFL returned an invalid polling URL", { kind: "envelope", cause });
	}
	if (
		url.protocol !== "https:" ||
		BFL_POLLING_ORIGINS[url.origin] !== true ||
		url.username ||
		url.password ||
		url.port
	) {
		throw new AIError.ProviderResponseError("BFL returned an untrusted polling URL", { kind: "envelope" });
	}
	return url.href;
}

async function parseJsonResponse<T>(model: Model, response: Response, operation: string): Promise<T> {
	const text = await response.text();
	if (!response.ok) {
		throw new AIError.ProviderHttpError(
			`${model.provider}/${model.id} ${operation} failed (${response.status}): ${text}`,
			response.status,
			{ headers: response.headers },
		);
	}
	try {
		return JSON.parse(text) as T;
	} catch (cause) {
		throw new AIError.ProviderResponseError(`BFL ${operation} returned malformed JSON`, {
			provider: model.provider,
			kind: "envelope",
			cause,
		});
	}
}

export async function generateBflImage(
	model: Model,
	request: ImageGenerationRequest,
	options: ImageGenerationOptions,
): Promise<ImageGenerationResult> {
	const fetchImpl = options.fetch ?? fetch;
	const baseUrl = imageBaseUrl(model);
	const inputImages = request.inputImages ?? [];
	if (inputImages.length > 1) {
		throw new AIError.ValidationError(`BFL Kontext edits accept one reference image; got ${inputImages.length}`);
	}
	const body: BflGenerationRequest =
		inputImages.length === 1
			? {
					prompt: request.prompt,
					...(request.aspectRatio ? { aspect_ratio: request.aspectRatio } : {}),
					input_image: inputImages[0]?.data,
				}
			: { prompt: request.prompt, ...resolveBflDimensions(request.aspectRatio ?? "1:1") };
	const endpointModel = inputImages.length === 1 ? BFL_EDIT_MODEL : (model.requestModelId ?? model.id);

	const sampleUrl = await withAuth(
		options.apiKey,
		async key => {
			const headers = await modelHeaders(model, options.signal);
			const submitted = await parseJsonResponse<BflSubmitResponse>(
				model,
				await fetchImpl(`${baseUrl}/${endpointModel}`, {
					method: "POST",
					headers: { ...headers, "x-key": key, "Content-Type": "application/json" },
					body: JSON.stringify(body),
					redirect: "error",
					signal: options.signal,
				}),
				"image request",
			);
			const pollingUrl = resolveBflPollingUrl(submitted, baseUrl);
			for (;;) {
				const result = await parseJsonResponse<BflResultResponse>(
					model,
					await fetchImpl(pollingUrl, {
						method: "GET",
						headers: { "x-key": key },
						redirect: "error",
						signal: options.signal,
					}),
					"image poll",
				);
				if (result.status === "Ready") {
					if (!result.result?.sample) {
						throw new AIError.ProviderResponseError("BFL result is missing the sample URL", {
							provider: model.provider,
							kind: "envelope",
						});
					}
					return result.result.sample;
				}
				if (result.status !== "Pending" && result.status !== "Queued" && result.status !== "Processing") {
					throw new AIError.ProviderResponseError(
						`BFL image generation failed with status ${result.status ?? "unknown"}`,
						{ provider: model.provider, kind: "envelope" },
					);
				}
				await Bun.sleep(BFL_POLL_INTERVAL_MS);
			}
		},
		{ signal: options.signal },
	);
	const image = await imageFromUrl(sampleUrl, fetchImpl, options.signal);
	return { images: [image], usage: emptyUsage() };
}
