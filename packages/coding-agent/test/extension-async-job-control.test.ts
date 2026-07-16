/**
 * Tests for the owner-scoped async-job control exposed to extensions via
 * `ctx.asyncJobs` (see `AgentSession.getAsyncJobControl`).
 *
 * The capability lets an extension inspect and atomically cancel exactly one
 * async job owned by its own parent session. It must:
 *   - return a job's immutable public snapshot (no secret fields);
 *   - cancel an owned running job with a definitive result, preserving the
 *     manager's abort + late-delivery-suppression semantics;
 *   - refuse jobs owned by another session (indistinguishable from missing);
 *   - refuse missing and already-terminal jobs;
 *   - be wired identically through every extension initialization surface.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type {
	ExtensionActions,
	ExtensionAsyncJobControl,
	ExtensionContextActions,
	ExtensionRuntime,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { ExtensionUiController } from "@oh-my-pi/pi-coding-agent/modes/controllers/extension-ui-controller";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

const OWNER = "Main";
const TEST_TIMEOUT_MS = 60_000;

describe("AgentSession owner-scoped async job control", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let manager: AsyncJobManager;
	let completions: string[];
	let session: AgentSession;
	let control: ExtensionAsyncJobControl;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-ext-jobctl-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		completions = [];
		manager = new AsyncJobManager({
			retentionMs: 60_000,
			onJobComplete: async jobId => {
				completions.push(jobId);
			},
		});
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: createMockModel({ handler: () => ({ content: ["Done"] }) }).stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
			agentId: OWNER,
			asyncJobManager: manager,
		});
		control = session.getAsyncJobControl();
	});

	afterEach(async () => {
		if (session) await session.dispose();
		await manager.dispose({ timeoutMs: 500 });
		authStorage?.close();
		if (tempDir && fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
		vi.restoreAllMocks();
		AsyncJobManager.resetForTests();
	});

	/** Register a job that stays running until its gate resolves. */
	function registerGatedJob(id: string, ownerId: string | undefined): { release: (text: string) => void } {
		const gate = Promise.withResolvers<string>();
		manager.register(
			"bash",
			id,
			async ({ signal }) => {
				signal.addEventListener("abort", () => gate.resolve("aborted"), { once: true });
				return await gate.promise;
			},
			{ id, ownerId },
		);
		return { release: text => gate.resolve(text) };
	}

	it(
		"inspects an owned running job's immutable public snapshot",
		() => {
			registerGatedJob("job-own", OWNER);
			const info = control.inspect("job-own");

			expect(info).toEqual({
				id: "job-own",
				type: "bash",
				status: "running",
				startTime: expect.any(Number),
				agentId: OWNER,
			});
			// No secret manager internals leak through the public snapshot.
			expect("abortController" in (info as object)).toBe(false);
			expect("promise" in (info as object)).toBe(false);
			expect("resultText" in (info as object)).toBe(false);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"cancels an owned running job and reports a definitive result",
		() => {
			registerGatedJob("job-own", OWNER);

			const result = control.cancel("job-own");

			expect(result.cancelled).toBe(true);
			expect(result).toEqual({
				cancelled: true,
				job: expect.objectContaining({ id: "job-own", status: "cancelled", agentId: OWNER }),
			});
			expect(manager.getJob("job-own")?.status).toBe("cancelled");
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"refuses to inspect or cancel a job owned by another session",
		() => {
			registerGatedJob("job-foreign", "Other");

			// A foreign-owned job is indistinguishable from a missing one.
			expect(control.inspect("job-foreign")).toBeNull();
			expect(control.cancel("job-foreign")).toEqual({ cancelled: false, reason: "not-found" });
			// The other session's job is untouched.
			expect(manager.getJob("job-foreign")?.status).toBe("running");
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"refuses a missing job",
		() => {
			expect(control.inspect("nope")).toBeNull();
			expect(control.cancel("nope")).toEqual({ cancelled: false, reason: "not-found" });
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"refuses an owned job that is already terminal",
		async () => {
			manager.register("bash", "job-done", async () => "output", { id: "job-done", ownerId: OWNER });
			await manager.waitForAll();

			const result = control.cancel("job-done");

			expect(result).toEqual({
				cancelled: false,
				reason: "not-running",
				job: expect.objectContaining({ id: "job-done", status: "completed" }),
			});
			// Inspection still works and reflects the terminal status.
			expect(control.inspect("job-done")?.status).toBe("completed");
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"suppresses late completion delivery for a cancelled job",
		async () => {
			const job = registerGatedJob("job-late", OWNER);

			expect(control.cancel("job-late").cancelled).toBe(true);
			// The job body only settles after cancellation, returning a result the
			// manager must NOT deliver (the run wrapper sees status === "cancelled").
			job.release("late result");
			await manager.waitForAll();
			await manager.drainDeliveries({ timeoutMs: 1_000 });

			expect(completions).not.toContain("job-late");
			expect(manager.getJob("job-late")?.status).toBe("cancelled");
		},
		TEST_TIMEOUT_MS,
	);
});

describe("extension async-job control wiring", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let manager: AsyncJobManager;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let modelRegistry: ModelRegistry;
	let control: ExtensionAsyncJobControl;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-ext-jobctl-wire-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		manager = new AsyncJobManager({ retentionMs: 60_000, onJobComplete: async () => {} });
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: createMockModel({ handler: () => ({ content: ["Done"] }) }).stream,
		});
		sessionManager = SessionManager.inMemory();
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry,
			agentId: OWNER,
			asyncJobManager: manager,
		});
		// One owned + one foreign job so an owner-scoped control is observably
		// different from a raw manager.
		manager.register("bash", "owned", async () => "x", { id: "owned", ownerId: OWNER });
		manager.register("bash", "foreign", async () => "x", { id: "foreign", ownerId: "Other" });
		await manager.waitForAll();
		control = session.getAsyncJobControl();
	});

	afterEach(async () => {
		if (session) await session.dispose();
		await manager.dispose({ timeoutMs: 500 });
		authStorage?.close();
		if (tempDir && fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
		vi.restoreAllMocks();
		AsyncJobManager.resetForTests();
	});

	/** Assert a control is owner-scoped to OWNER's jobs. */
	function expectOwnerScoped(c: ExtensionAsyncJobControl): void {
		expect(c.inspect("owned")?.id).toBe("owned");
		expect(c.inspect("foreign")).toBeNull();
		expect(c.cancel("foreign")).toEqual({ cancelled: false, reason: "not-found" });
	}

	it(
		"exposes the session's owner-scoped control on the extension context",
		() => {
			const runner = new ExtensionRunner([], {} as ExtensionRuntime, tempDir, sessionManager, modelRegistry);
			runner.initialize({} as ExtensionActions, minimalContextActions(control));

			const ctx = runner.createContext();
			expectOwnerScoped(ctx.asyncJobs);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"defaults the runner's control to an inert, non-leaking capability before initialize",
		() => {
			const runner = new ExtensionRunner([], {} as ExtensionRuntime, tempDir, sessionManager, modelRegistry);
			const ctx = runner.createContext();
			expect(ctx.asyncJobs.inspect("owned")).toBeNull();
			expect(ctx.asyncJobs.cancel("owned")).toEqual({ cancelled: false, reason: "not-found" });
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"wires the owner-scoped control through the shared print/RPC surface",
		async () => {
			let captured: ExtensionContextActions | undefined;
			const fakeRunner = {
				initialize: (_a: ExtensionActions, ca: ExtensionContextActions) => {
					captured = ca;
				},
				onError: () => {},
				emit: async () => {},
			};
			const stub = { extensionRunner: fakeRunner, getAsyncJobControl: () => control } as unknown as AgentSession;

			await initializeExtensions(stub, {
				reportSendError: () => {},
				reportRuntimeError: () => {},
			});

			expect(captured).toBeDefined();
			expectOwnerScoped(captured!.asyncJobs);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"wires the owner-scoped control through the interactive UI surface",
		async () => {
			let captured: ExtensionContextActions | undefined;
			const fakeRunner = {
				initialize: (_a: ExtensionActions, ca: ExtensionContextActions) => {
					captured = ca;
				},
				onError: () => {},
				emit: async () => {},
			};
			const ctxStub = {
				shutdownRequested: false,
				session: { extensionRunner: fakeRunner, getAsyncJobControl: () => control },
				setToolUIContext: () => {},
				editor: { setText: () => {}, handleInput: () => {}, getText: () => "" },
				setWorkingMessage: () => {},
				setEditorComponent: () => {},
				toolOutputExpanded: false,
				setToolsExpanded: () => {},
			} as unknown as InteractiveModeContext;

			await new ExtensionUiController(ctxStub).initHooksAndCustomTools();

			expect(captured).toBeDefined();
			expectOwnerScoped(captured!.asyncJobs);
		},
		TEST_TIMEOUT_MS,
	);
});

/** Minimal ExtensionContextActions with a real async-job control under test. */
function minimalContextActions(asyncJobs: ExtensionAsyncJobControl): ExtensionContextActions {
	return {
		getModel: () => undefined,
		isIdle: () => true,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: async () => {},
		getSystemPrompt: () => [],
		asyncJobs,
	};
}
