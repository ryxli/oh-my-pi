import { beforeAll, describe, expect, test, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ModelSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/model-selector";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { TUI } from "@oh-my-pi/pi-tui";

function normalizeRenderedText(text: string): string {
	return stripVTControlCharacters(text).replace(/\s+/g, " ").trim();
}

function createSelector(model: Model, settings: Settings): ModelSelectorComponent {
	const modelRegistry = {
		getAll: () => [model],
		getDiscoverableProviders: () => [],
		getCanonicalModelSelections: () => [],
	} as unknown as ModelRegistry;
	const ui = {
		requestRender: vi.fn(),
	} as unknown as TUI;

	return new ModelSelectorComponent(
		ui,
		model,
		settings,
		modelRegistry,
		[{ model, thinkingLevel: "off" }],
		() => {},
		() => {},
	);
}

function createOllamaCloudModel(id: string): Model {
	return buildModel({
		id,
		name: "DeepSeek V4 Pro",
		api: "ollama-chat",
		provider: "ollama-cloud",
		baseUrl: "https://ollama.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 8192,
	});
}
function createContextTestModel(id: string, contextWindow: number): Model {
	return buildModel({
		id,
		name: id,
		api: "ollama-chat",
		baseUrl: "https://example.com",
		reasoning: false,
		provider: "test",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 1024,
	});
}

function createScopedSelector(
	models: Model[],
	settings: Settings,
	onSelect: (model: Model) => void,
	options?: { temporaryOnly?: boolean; currentContextTokens?: number },
): ModelSelectorComponent {
	const modelRegistry = {
		getAll: () => models,
		getDiscoverableProviders: () => [],
		getCanonicalModelSelections: () => [],
	} as unknown as ModelRegistry;
	const ui = {
		requestRender: vi.fn(),
	} as unknown as TUI;
	return new ModelSelectorComponent(
		ui,
		undefined,
		settings,
		modelRegistry,
		models.map(model => ({ model })),
		model => onSelect(model),
		() => {},
		options,
	);
}
let testTheme = await getThemeByName("dark");

function installTestTheme(): void {
	if (!testTheme) {
		throw new Error("Failed to load dark theme for ModelSelector tests");
	}
	setThemeInstance(testTheme);
}

describe("ModelSelector role badge thinking display", () => {
	beforeAll(async () => {
		testTheme = await getThemeByName("dark");
		if (!testTheme) {
			throw new Error("Failed to load dark theme for ModelSelector tests");
		}
	});

	test("shows custom roles from cycleOrder/modelRoles and honors built-in metadata overrides", async () => {
		installTestTheme();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model anthropic/claude-sonnet-4-5");

		const settings = Settings.isolated({
			cycleOrder: ["smol", "custom-fast", "default"],
			modelRoles: {
				default: `${model.provider}/${model.id}`,
				"custom-fast": `${model.provider}/${model.id}:low`,
				smol: `${model.provider}/${model.id}`,
			},
			modelTags: {
				smol: { name: "Quick", color: "error" },
			},
		});

		const selector = createSelector(model, settings);
		await Bun.sleep(0);
		installTestTheme();

		const rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("custom-fast (low)");
		expect(rendered).toContain("SMOL (inherit)");

		selector.handleInput("\n");
		installTestTheme();
		const menuRendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(menuRendered).toContain("Set as custom-fast");
		expect(menuRendered).toContain("Set as SMOL (Quick)");
	});

	test("shows compact auto badges for unconfigured role defaults", async () => {
		installTestTheme();
		const settings = Settings.isolated({});
		const haiku = createContextTestModel("claude-haiku-4.5", 128_000);
		const codex = createContextTestModel("gpt-5.1-codex", 128_000);

		const selector = createScopedSelector([codex, haiku], settings, () => {});
		await Bun.sleep(0);
		installTestTheme();

		const rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("claude-haiku-4.5");
		expect(rendered).toContain("gpt-5.1-codex");
		expect(rendered).toContain("[SMOL auto]");
		expect(rendered).toContain("[SLOW auto]");
	});

	test("dims and disables models below the current context size", async () => {
		installTestTheme();
		const settings = Settings.isolated({});
		const small = createContextTestModel("a-small", 4096);
		const large = createContextTestModel("b-large", 128_000);
		const selected: string[] = [];
		const selector = createScopedSelector([small, large], settings, model => selected.push(model.id), {
			temporaryOnly: true,
			currentContextTokens: 6000,
		});
		await Bun.sleep(0);
		installTestTheme();

		const rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("a-small");
		expect(rendered).toContain("context>4.1k");

		selector.handleInput("\n");
		expect(selected).toEqual(["b-large"]);
	});

	test("does not open the model menu when every candidate is disabled", async () => {
		installTestTheme();
		const settings = Settings.isolated({});
		const small = createContextTestModel("only-small", 4096);
		const onSelect = vi.fn();
		const selector = createScopedSelector([small], settings, onSelect, {
			currentContextTokens: 6000,
		});
		await Bun.sleep(0);
		installTestTheme();

		const rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("only-small");
		expect(rendered).toContain("current context 6k > 4.1k limit");

		selector.handleInput("\n");
		const afterEnter = normalizeRenderedText(selector.render(220).join("\n"));
		expect(afterEnter).not.toContain("Action for");
		expect(onSelect).not.toHaveBeenCalled();
	});

	test("uses cached models for Enter while offline refresh is still pending", () => {
		installTestTheme();
		const settings = Settings.isolated({});
		const cachedModel = createContextTestModel("cached-fast", 128_000);
		const refreshGate = Promise.withResolvers<void>();
		const onSelect = vi.fn();
		const modelRegistry = {
			getAll: () => [cachedModel],
			refresh: vi.fn(() => refreshGate.promise),
			refreshProvider: vi.fn(async () => {}),
			getError: () => undefined,
			getAvailable: () => [cachedModel],
			getDiscoverableProviders: () => [],
			getCanonicalModelSelections: () => [],
		} as unknown as ModelRegistry;
		const ui = {
			requestRender: vi.fn(),
		} as unknown as TUI;

		const selector = new ModelSelectorComponent(
			ui,
			undefined,
			settings,
			modelRegistry,
			[],
			model => onSelect(model.id),
			() => {},
			{ temporaryOnly: true },
		);

		selector.handleInput("\n");
		expect(onSelect).toHaveBeenCalledWith("cached-fast");
		expect(modelRegistry.refresh).toHaveBeenCalledTimes(1);
		refreshGate.resolve();
	});

	test("passes concrete selector when selecting a canonical custom model", () => {
		installTestTheme();
		const settings = Settings.isolated({});
		const customModel = buildModel({
			id: "mimo-v2.5-pro",
			name: "MiMo-V2.5-Pro",
			api: "openai-completions",
			provider: "xiaomi-token-plan-cn",
			baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8192,
		});
		const modelRegistry = {
			getAll: () => [customModel],
			refresh: vi.fn(async () => {}),
			refreshProvider: vi.fn(async () => {}),
			getError: () => undefined,
			getAvailable: () => [customModel],
			getDiscoverableProviders: () => [],
			getCanonicalModelSelections: () => [
				{
					record: {
						id: "mimo-v2.5-pro",
						name: "MiMo-V2.5-Pro",
						variants: [
							{
								canonicalId: "mimo-v2.5-pro",
								selector: "xiaomi-token-plan-cn/mimo-v2.5-pro",
								model: customModel,
								source: "heuristic",
							},
						],
					},
					model: customModel,
				},
			],
		} as unknown as ModelRegistry;
		const selected: Array<string | undefined> = [];
		const ui = {
			requestRender: vi.fn(),
		} as unknown as TUI;

		const selector = new ModelSelectorComponent(
			ui,
			undefined,
			settings,
			modelRegistry,
			[],
			(_model, _role, _thinkingLevel, modelSelector) => selected.push(modelSelector),
			() => {},
			{ temporaryOnly: true, initialSearchInput: "mimo-v2.5-pro" },
		);

		selector.handleInput("\t");
		selector.handleInput("\n");

		expect(selected).toEqual(["xiaomi-token-plan-cn/mimo-v2.5-pro"]);
	});

	test("keeps the canonical row highlighted when the preferred variant shifts on refresh", async () => {
		installTestTheme();
		const settings = Settings.isolated({});
		const primary = buildModel({
			id: "mimo-v2.5-pro",
			name: "MiMo-V2.5-Pro",
			api: "openai-completions",
			provider: "custom-a",
			baseUrl: "https://a.example.com/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8192,
		});
		const fallback = buildModel({
			id: "mimo-v2.5-pro",
			name: "MiMo-V2.5-Pro",
			api: "openai-completions",
			provider: "custom-b",
			baseUrl: "https://b.example.com/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8192,
		});

		let preferred = fallback;
		let variants = [
			{ canonicalId: "mimo-v2.5-pro", selector: "custom-b/mimo-v2.5-pro", model: fallback, source: "heuristic" },
		];
		const refreshGate = Promise.withResolvers<void>();

		const modelRegistry = {
			getAll: () => [preferred],
			refresh: vi.fn(() => refreshGate.promise),
			refreshProvider: vi.fn(async () => {}),
			getError: () => undefined,
			getAvailable: () => [preferred],
			getDiscoverableProviders: () => [],
			getCanonicalModelSelections: () => [
				{
					record: { id: "mimo-v2.5-pro", name: "MiMo-V2.5-Pro", variants },
					model: preferred,
				},
			],
		} as unknown as ModelRegistry;
		const selected: Array<string | undefined> = [];
		const ui = {
			requestRender: vi.fn(),
		} as unknown as TUI;

		const selector = new ModelSelectorComponent(
			ui,
			undefined,
			settings,
			modelRegistry,
			[],
			(_model, _role, _thinkingLevel, modelSelector) => selected.push(modelSelector),
			() => {},
			{ temporaryOnly: true },
		);

		// Switch to the canonical tab and highlight the only canonical row, then
		// let the offline refresh land a higher-ranked variant — the row's
		// persisted selector flips from custom-b/... to custom-a/..., but the
		// canonical record id is unchanged, so the highlight must survive.
		selector.handleInput("\t");
		preferred = primary;
		variants = [
			{ canonicalId: "mimo-v2.5-pro", selector: "custom-a/mimo-v2.5-pro", model: primary, source: "heuristic" },
			{ canonicalId: "mimo-v2.5-pro", selector: "custom-b/mimo-v2.5-pro", model: fallback, source: "heuristic" },
		];
		refreshGate.resolve();
		await Bun.sleep(0);

		selector.handleInput("\n");
		expect(selected).toEqual(["custom-a/mimo-v2.5-pro"]);
	});

	test("keeps the highlighted model when a background refresh reorders the list", async () => {
		installTestTheme();
		const settings = Settings.isolated({});
		const modelBb = createContextTestModel("bb-model", 128_000);
		const modelCc = createContextTestModel("cc-model", 128_000);
		const modelAa = createContextTestModel("aa-model", 128_000);
		let availableModels: Model[] = [modelBb, modelCc];
		const refreshGate = Promise.withResolvers<void>();
		const onSelect = vi.fn();
		const modelRegistry = {
			getAll: () => availableModels,
			refresh: vi.fn(() => refreshGate.promise),
			refreshProvider: vi.fn(async () => {}),
			getError: () => undefined,
			getAvailable: () => availableModels,
			getDiscoverableProviders: () => [],
			getCanonicalModelSelections: () => [],
		} as unknown as ModelRegistry;
		const ui = {
			requestRender: vi.fn(),
		} as unknown as TUI;

		const selector = new ModelSelectorComponent(
			ui,
			undefined,
			settings,
			modelRegistry,
			[],
			model => onSelect(model.id),
			() => {},
			{ temporaryOnly: true },
		);

		// Highlight the second entry, then let the pending refresh land a model
		// that sorts ahead of it and shifts every index.
		selector.handleInput("\x1b[B");
		availableModels = [modelAa, modelBb, modelCc];
		refreshGate.resolve();
		await Bun.sleep(0);

		selector.handleInput("\n");
		expect(onSelect).toHaveBeenCalledWith("cc-model");
	});

	test("refreshes Ollama Cloud using provider id instead of tab label", async () => {
		installTestTheme();
		const settings = Settings.isolated({});
		const discoveredModel = createOllamaCloudModel("deepseek-v4-pro");
		let availableModels: Model[] = [];
		const refreshProvider = vi.fn(async (providerId: string) => {
			if (providerId === "ollama-cloud") {
				availableModels = [discoveredModel];
			}
		});
		const modelRegistry = {
			getAll: () => availableModels,
			refresh: vi.fn(async () => {}),
			refreshProvider,
			getError: () => undefined,
			getAvailable: () => availableModels,
			getDiscoverableProviders: () => ["ollama-cloud"],
			getCanonicalModelSelections: () => [],
			getProviderDiscoveryState: () => ({
				provider: "ollama-cloud",
				status: "idle",
				optional: false,
				stale: false,
				models: [],
			}),
		} as unknown as ModelRegistry;
		const ui = {
			requestRender: vi.fn(),
		} as unknown as TUI;

		const selector = new ModelSelectorComponent(
			ui,
			undefined,
			settings,
			modelRegistry,
			[],
			() => {},
			() => {},
		);
		await Bun.sleep(0);
		installTestTheme();

		const initialRendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(initialRendered).toContain("OLLAMA CLOUD");

		selector.handleInput("\t");
		selector.handleInput("\t");
		await Bun.sleep(125);
		installTestTheme();

		expect(refreshProvider).toHaveBeenCalledWith("ollama-cloud", "online");
		expect(modelRegistry.refresh).toHaveBeenCalledTimes(1);
		const rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("deepseek-v4-pro");
		expect(rendered).not.toContain("Provider has not been refreshed yet");
	});

	test("switches provider tabs immediately and refreshes in background with spinner animation", async () => {
		installTestTheme();
		const settings = Settings.isolated({});
		const discoveredModel = createOllamaCloudModel("deepseek-v4-pro");
		let availableModels: Model[] = [];
		let resolveRefresh: (() => void) | undefined;
		const refreshProvider = vi.fn(
			(_providerId: string, _strategy?: string) =>
				new Promise<void>(resolve => {
					resolveRefresh = () => {
						availableModels = [discoveredModel];
						resolve();
					};
				}),
		);
		const modelRegistry = {
			getAll: () => availableModels,
			refresh: vi.fn(async () => {}),
			refreshProvider,
			getError: () => undefined,
			getAvailable: () => availableModels,
			getDiscoverableProviders: () => ["ollama-cloud"],
			getCanonicalModelSelections: () => [],
			getProviderDiscoveryState: () => ({
				provider: "ollama-cloud",
				status: "idle",
				optional: false,
				stale: false,
				models: [],
			}),
		} as unknown as ModelRegistry;
		const ui = {
			requestRender: vi.fn(),
		} as unknown as TUI;

		const selector = new ModelSelectorComponent(
			ui,
			undefined,
			settings,
			modelRegistry,
			[],
			() => {},
			() => {},
		);
		await Bun.sleep(0);
		installTestTheme();

		selector.handleInput("\t");
		selector.handleInput("\t");

		// Core regression: tab switch must not synchronously enter provider refresh.
		expect(refreshProvider).not.toHaveBeenCalled();

		const immediateRendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(immediateRendered).toContain("Refreshing OLLAMA CLOUD in background");

		await Bun.sleep(5);
		expect(refreshProvider).not.toHaveBeenCalled();
		await Bun.sleep(120);
		expect(refreshProvider).toHaveBeenCalledWith("ollama-cloud", "online");

		const spinnerFrame1 = selector.render(220).join("\n");
		await Bun.sleep(100);
		installTestTheme();
		const spinnerFrame2 = selector.render(220).join("\n");
		expect(normalizeRenderedText(spinnerFrame2)).toContain("Refreshing OLLAMA CLOUD in background");
		expect(spinnerFrame2).not.toEqual(spinnerFrame1);

		resolveRefresh?.();
		await Bun.sleep(10);
		installTestTheme();

		expect(modelRegistry.refresh).toHaveBeenCalledTimes(1);
		const finalRendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(finalRendered).toContain("deepseek-v4-pro");
		expect(finalRendered).not.toContain("Refreshing OLLAMA CLOUD in background");
	});
});
