import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { ToolChoice } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { IrcMessage } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake, TempDir } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import { createAssistantMessage } from "./helpers/agent-session-setup";

const emptyToolSchema = type({});
const resolveToolSchema = type({
	action: "'apply' | 'discard'",
	reason: "string",
});

type ObservedPromptCall = {
	toolChoice: string | undefined;
	messageRoles: AgentMessage["role"][];
	messageTexts: string[];
};

type Harness = {
	session: AgentSession;
	authStorage: AuthStorage;
	observedCalls: ObservedPromptCall[];
	resolveRuns: { count: number };
	resolveApplied: Promise<void>;
};

type HarnessOptions = {
	complyWithRequired?: boolean;
};

function textOf(message: AgentMessage): string {
	if (!("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const texts: string[] = [];
	for (const part of content) {
		if (part.type === "text") texts.push(part.text);
	}
	return texts.join("\n");
}

function toolChoiceName(choice: ToolChoice | undefined): string | undefined {
	if (!choice) return undefined;
	if (typeof choice === "string") return choice;
	if (choice.type === "tool") return choice.name;
	if (choice.type === "function") {
		if ("name" in choice) return choice.name;
		return choice.function.name;
	}
	return undefined;
}

function makeAskTool(): AgentTool<typeof emptyToolSchema> {
	const tool: AgentTool<typeof emptyToolSchema> = {
		name: "ask",
		label: "Ask",
		description: "Ask the user a question.",
		parameters: emptyToolSchema,
		async execute() {
			return { content: [{ type: "text", text: "asked" }] };
		},
	};
	return tool;
}

describe("AgentSession plan-mode convergence", () => {
	let tempDir: TempDir;
	const harnesses: Harness[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-plan-mode-convergence-");
		harnesses.length = 0;
	});

	afterEach(async () => {
		for (const harness of harnesses.splice(0)) {
			await harness.session.dispose();
			harness.authStorage.close();
		}
		await tempDir.remove();
	});

	async function createHarness(harnessOptions: HarnessOptions = {}): Promise<Harness> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Test model not found in registry");

		const observedCalls: ObservedPromptCall[] = [];
		const resolveRuns = { count: 0 };
		let session: AgentSession;
		const resolveApplied = Promise.withResolvers<void>();
		const resolveTool: AgentTool<typeof resolveToolSchema> = {
			name: "resolve",
			label: "Resolve",
			description: "Resolve the pending plan decision.",
			parameters: resolveToolSchema,
			async execute(_toolCallId, params) {
				resolveRuns.count++;
				session.setPlanModeState(undefined);
				resolveApplied.resolve();
				return {
					content: [{ type: "text", text: `Plan ${params.action}: ${params.reason}` }],
				};
			},
		};

		const tools: AgentTool[] = [makeAskTool(), resolveTool];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools, messages: [] },
			convertToLlm,
			getToolChoice: () => session.nextToolChoiceDirective(),
			streamFn: (_model, context, options) => {
				observedCalls.push({
					toolChoice: toolChoiceName(options?.toolChoice),
					messageRoles: context.messages.map(message => message.role),
					messageTexts: context.messages.map(message => textOf(message)),
				});
				const response = createAssistantMessage(`plan response ${observedCalls.length}`);
				if (harnessOptions.complyWithRequired !== false && options?.toolChoice === "required") {
					response.content = [
						{
							type: "toolCall",
							id: `call-resolve-${observedCalls.length}`,
							name: "resolve",
							arguments: { action: "apply", reason: "plan is ready" },
						},
					];
					response.stopReason = "toolUse";
				}
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: response });
					if (response.content[0]?.type === "toolCall") {
						stream.push({ type: "toolcall_start", contentIndex: 0, partial: response });
						stream.push({
							type: "toolcall_end",
							contentIndex: 0,
							toolCall: response.content[0],
							partial: response,
						});
					}
					stream.push({
						type: "done",
						reason: response.stopReason === "toolUse" ? "toolUse" : "stop",
						message: response,
					});
				});
				return stream;
			},
		});

		const authStorage = await AuthStorage.create(tempDir.join(`auth-${Snowflake.next()}.db`));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const settings = Settings.isolated({ "compaction.enabled": false });
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
			toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
		});
		session.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md" });
		const harness = { session, authStorage, observedCalls, resolveRuns, resolveApplied: resolveApplied.promise };
		harnesses.push(harness);
		return harness;
	}

	it("enforces ask-or-resolve after a bare agent.continue terminal settle", async () => {
		const { session, observedCalls, resolveRuns, resolveApplied } = await createHarness();
		session.agent.appendMessage({
			role: "user",
			content: [{ type: "text", text: "draft a plan" }],
			timestamp: Date.now(),
		});

		await session.agent.continue();
		await resolveApplied;

		expect(observedCalls.map(call => call.toolChoice)).toContain("required");
		expect(resolveRuns.count).toBe(1);
		expect(session.getPlanModeState()).toBeUndefined();
	});

	it("stops retrying when plan mode still omits ask-or-resolve after bounded reminders", async () => {
		const { session, observedCalls, resolveRuns } = await createHarness({ complyWithRequired: false });
		const notice = Promise.withResolvers<string>();
		session.subscribe(event => {
			if (event.type !== "notice" || event.source !== "plan-mode") return;
			notice.resolve(event.message);
		});
		session.agent.appendMessage({
			role: "user",
			content: [{ type: "text", text: "draft a plan" }],
			timestamp: Date.now(),
		});

		await session.agent.continue();
		const message = await notice.promise;

		expect(message).toContain("waiting for your next instruction");
		expect(observedCalls.map(call => call.toolChoice)).toEqual([undefined, "required", "required"]);
		expect(resolveRuns.count).toBe(0);
		expect(session.getPlanModeState()?.enabled).toBe(true);
	});

	it("records idle IRC in plan mode without waking an autonomous turn", async () => {
		const { session, observedCalls } = await createHarness();

		const result = await session.deliverIrcMessage({
			id: "msg-1",
			from: "Peer",
			to: "Main",
			body: "plan aside",
			ts: Date.now(),
		} satisfies IrcMessage);

		expect(result).toBe("injected");
		expect(observedCalls).toHaveLength(0);
		expect(
			session.agent.state.messages.some(
				message => message.role === "custom" && (message as { customType?: string }).customType === "irc:incoming",
			),
		).toBe(true);
	});
});
