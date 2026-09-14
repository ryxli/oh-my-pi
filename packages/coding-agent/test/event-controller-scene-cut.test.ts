import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

beforeAll(async () => {
	await initTheme(false);
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterAll(() => {
	resetSettingsForTest();
});

let session: AgentSession | undefined;
let controller: EventController | undefined;
let authStorage: AuthStorage | undefined;
let tempDir: TempDir | undefined;

afterEach(async () => {
	controller?.dispose();
	await session?.dispose();
	authStorage?.close();
	tempDir?.removeSync();
	controller = undefined;
	session = undefined;
	authStorage = undefined;
	tempDir = undefined;
});

describe("EventController scene capsule rendering", () => {
	it.each([false, true])(
		"renders a settled scene capsule once before and after replay (continue=%s)",
		async shouldContinue => {
			tempDir = TempDir.createSync("@pi-scene-render-");
			authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
			authStorage.keys.setRuntime("openai", "test-key");
			const mock = createMockModel({
				provider: "openai",
				id: "scene-render-test",
				handler: () => ({ content: ["Done"] }),
			});
			const agent = new Agent({
				getApiKey: () => "test-key",
				initialState: { model: mock.model, systemPrompt: ["Test"], tools: [] },
				streamFn: mock.stream,
				convertToLlm,
			});
			const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
			settings.setModelRole("default", `${mock.model.provider}/${mock.model.id}`);
			session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(tempDir.path()),
				settings,
				modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
				toolRegistry: new Map(),
			});
			const ctx = createInteractiveModeContext({
				session,
				sessionManager: session.sessionManager,
				initialChatRendered: true,
			});
			const helpers = new UiHelpers(ctx);
			ctx.addMessageToChat = helpers.addMessageToChat.bind(helpers);
			ctx.renderSessionContext = helpers.renderSessionContext.bind(helpers);
			ctx.renderSessionContextIncrementally = helpers.renderSessionContextIncrementally.bind(helpers);
			ctx.renderInitialMessages = helpers.renderInitialMessages.bind(helpers);
			const consumer = new EventController(ctx);
			controller = consumer;
			ctx.eventController = consumer;
			let consumed = Promise.resolve();
			session.subscribe(event => {
				consumed = consumed.then(() => consumer.handleEvent(event));
				return consumed;
			});
			const objective = "SCENE_CAPSULE_RENDER_MARKER";
			session.stageSceneCut({
				label: "Next task",
				state: ["Previous task complete."],
				objective,
				exit: "Artifact inspected.",
				continue: shouldContinue,
			});
			await session.prompt("Obsolete task context");
			await session.waitForIdle();
			await consumed;

			expect(session.isStreaming).toBe(false);
			expect(ctx.initialChatRendered).toBe(true);
			expect(mock.calls).toHaveLength(shouldContinue ? 2 : 1);
			expect(
				session.messages.filter(
					message =>
						message.role === "custom" &&
						typeof message.content === "string" &&
						message.content.includes(objective),
				),
			).toHaveLength(1);
			expect(ctx.chatContainer.render(120).filter(line => line.includes(objective))).toHaveLength(1);

			await ctx.renderInitialMessages();
			expect(ctx.chatContainer.render(120).filter(line => line.includes(objective))).toHaveLength(1);
			await ctx.renderInitialMessages();
			expect(ctx.chatContainer.render(120).filter(line => line.includes(objective))).toHaveLength(1);
		},
	);
});
