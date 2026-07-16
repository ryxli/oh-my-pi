import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { experimentDetail } from "./experiments";
import { ManagerServer, resolveArmLaunch } from "./server";
import { RunStore } from "./store";

/**
 * Contracts under test:
 *  - discover() backfills historical job dirs into run rows.
 *  - syncRun() mirrors trial outcomes (pass / error / running) and rollups.
 *  - REST API surfaces runs, trials, compact transcripts, and rejects bad launches.
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
});

function makeJobsDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "metaharness-test-"));
	cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function writeFixtureJob(jobsDir: string, jobName: string): void {
	const jobDir = path.join(jobsDir, jobName);
	fs.mkdirSync(jobDir, { recursive: true });
	fs.writeFileSync(
		path.join(jobDir, "result.json"),
		JSON.stringify({
			n_total_trials: 3,
			stats: { n_running_trials: 1, n_pending_trials: 0 },
		}),
	);
	fs.writeFileSync(
		path.join(jobDir, "config.json"),
		JSON.stringify({
			dataset: "test-dataset@1.0",
			agents: [{ name: "omp", model_name: "anthropic/claude-opus-4-8" }],
		}),
	);
	const mkTrial = (name: string, body: Record<string, unknown> | null) => {
		const dir = path.join(jobDir, name, "agent");
		fs.mkdirSync(dir, { recursive: true });
		if (body) fs.writeFileSync(path.join(jobDir, name, "result.json"), JSON.stringify(body));
	};
	mkTrial("alpha__abc", {
		started_at: "2026-07-12T10:00:00",
		finished_at: "2026-07-12T10:05:00",
		verifier_result: { rewards: { reward: 1 } },
		agent_result: { cost_usd: 0.5, n_input_tokens: 100, n_output_tokens: 10, n_cache_tokens: 80 },
	});
	mkTrial("beta__def", {
		started_at: "2026-07-12T10:00:00",
		finished_at: "2026-07-12T10:02:00",
		exception_info: { exception_type: "AgentTimeoutError" },
		agent_result: { cost_usd: 0.2 },
	});
	mkTrial("gamma__ghi", null); // running: no result.json yet
	// transcript for alpha
	const transcript = [
		JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				model: "claude-opus-4-8",
				content: [
					{ type: "text", text: "Reading the file first." },
					{ type: "toolCall", id: "t1", name: "read", arguments: { path: "x" } },
				],
			},
		}),
		JSON.stringify({
			type: "message_end",
			message: {
				role: "toolResult",
				toolName: "read",
				isError: false,
				content: [{ type: "text", text: "file contents" }],
			},
		}),
	].join("\n");
	fs.writeFileSync(path.join(jobDir, "alpha__abc", "agent", "omp.txt"), transcript);
}

describe("RunStore", () => {
	it("discovers historical job dirs and mirrors trial state", () => {
		const jobsDir = makeJobsDir();
		writeFixtureJob(jobsDir, "job-a");
		const store = new RunStore(jobsDir);
		cleanups.push(() => store.close());

		expect(store.discover()).toBe(1);
		const run = store.getRun("job-a");
		// No job-level finished_at + fresh dir + a running trial → still running.
		expect(run?.status).toBe("running");
		expect(run?.dataset).toBe("test-dataset@1.0");
		expect(run?.models).toBe("anthropic/claude-opus-4-8");
		expect(run?.nTotal).toBe(3);
		expect(run?.pass).toBe(1);
		expect(run?.error).toBe(1);
		expect(run?.running).toBe(1);
		expect(run?.costUsd).toBeCloseTo(0.7, 5);

		const traces = store.listTraces("job-a");
		expect(traces.map(t => [t.task, t.status])).toEqual([
			["alpha", "pass"],
			["beta", "error"],
			["gamma", "running"],
		]);
		expect(traces[1].detail).toBe("AgentTimeoutError");

		// re-discover is idempotent
		expect(store.discover()).toBe(0);
	});

	it("marks discovered runs complete when harbor recorded a terminal state", () => {
		const jobsDir = makeJobsDir();
		writeFixtureJob(jobsDir, "job-done");
		const jobDir = path.join(jobsDir, "job-done");
		fs.writeFileSync(
			path.join(jobDir, "result.json"),
			JSON.stringify({
				n_total_trials: 2,
				finished_at: "2026-07-12T11:00:00",
				stats: { n_running_trials: 0, n_pending_trials: 0 },
			}),
		);
		fs.rmSync(path.join(jobDir, "gamma__ghi"), { recursive: true, force: true });
		const store = new RunStore(jobsDir);
		cleanups.push(() => store.close());
		store.discover();
		expect(store.getRun("job-done")?.status).toBe("complete");
		expect(store.getRun("job-done")?.finishedAt).not.toBeNull();
	});

	it("stores experiment goals and run roles/labels, and orders baselines first", () => {
		const jobsDir = makeJobsDir();
		writeFixtureJob(jobsDir, "exp-treat");
		writeFixtureJob(jobsDir, "exp-base");
		const store = new RunStore(jobsDir);
		cleanups.push(() => store.close());
		store.discover();
		store.setExperimentGoal("exp", "does the treatment beat the baseline?");
		expect(store.setRunMeta("exp-base", { role: "baseline", note: "plain model" })).toBe(true);
		expect(store.setRunMeta("exp-treat", { role: "variant", note: "prewalk flash", label: "flash@edit" })).toBe(true);
		expect(store.setRunMeta("exp-missing", { role: "variant" })).toBe(false);

		const detail = experimentDetail(store, "exp");
		expect(detail?.goal).toBe("does the treatment beat the baseline?");
		// ArmSummary.arm resolves to the display label when one is set.
		expect(detail?.arms.map(a => [a.arm, a.run.role, a.run.note, a.run.label])).toEqual([
			["base", "baseline", "plain model", ""],
			["flash@edit", "variant", "prewalk flash", "flash@edit"],
		]);

		// Partial updates keep the omitted fields.
		expect(store.setRunMeta("exp-treat", { note: "prewalk flash v2" })).toBe(true);
		const treat = store.getRun("exp-treat");
		expect(treat?.label).toBe("flash@edit");
		expect(treat?.role).toBe("variant");
		expect(treat?.note).toBe("prewalk flash v2");
	});
	it("persists experiment limits and closure across a fresh store", () => {
		const jobsDir = makeJobsDir();
		const dbPath = path.join(jobsDir, "experiment.sqlite");
		const store = new RunStore(jobsDir, dbPath);
		store.setExperimentGoal("legacy", "existing goal");
		expect(store.getExperimentMeta("legacy")).toEqual({
			id: "legacy",
			goal: "existing goal",
			updatedAt: expect.any(Number),
			maxRuns: null,
			maxArms: null,
			closure: null,
		});

		store.setExperimentMeta("bounded", { goal: "measure it", maxRuns: 3, maxArms: 2 });
		store.closeExperiment("bounded", "measured: treatment wins", 1_752_000_000_000);
		expect(store.getExperimentMeta("bounded")?.closure).toEqual({
			verdict: "measured: treatment wins",
			closedAt: 1_752_000_000_000,
		});
		store.close();

		const reopened = new RunStore(jobsDir, dbPath);
		cleanups.push(() => reopened.close());
		expect(reopened.getExperimentMeta("bounded")).toEqual({
			id: "bounded",
			goal: "measure it",
			updatedAt: expect.any(Number),
			maxRuns: 3,
			maxArms: 2,
			closure: { verdict: "measured: treatment wins", closedAt: 1_752_000_000_000 },
		});
	});


	it("releases a dead runner's pid without failing a possibly-live orphan", () => {
		const jobsDir = makeJobsDir();
		writeFixtureJob(jobsDir, "job-b");
		const store = new RunStore(jobsDir);
		cleanups.push(() => store.close());
		store.registerLaunch({
			benchmark: "harbor",
			jobName: "job-b",
			dataset: "test-dataset@1.0",
			agent: "omp",
			models: ["m"],
			pid: 999999999, // certainly dead
		});
		const rows = store.syncActive();
		expect(rows).toHaveLength(1);
		// The runner is only a monitor: its death must not fail the run while
		// the job dir is fresh (an orphaned harbor may still be writing trials).
		const row = store.getRun("job-b");
		expect(row?.pid).toBeNull();
		expect(row?.status).toBe("running");

		// Once harbor stamps the terminal marker, the same sweep completes it.
		const jobDir = path.join(jobsDir, "job-b");
		fs.writeFileSync(
			path.join(jobDir, "result.json"),
			JSON.stringify({
				n_total_trials: 3,
				stats: { n_running_trials: 0, n_pending_trials: 0 },
				finished_at: "2026-07-12T11:00:00",
			}),
		);
		store.syncActive();
		const finished = store.getRun("job-b");
		expect(finished?.status).toBe("complete");
		expect(finished?.finishedAt).toBe(Date.parse("2026-07-12T11:00:00"));
	});

	it("keeps admitted launches token-owned after closure", () => {
		const store = new RunStore(makeJobsDir());
		cleanups.push(() => store.close());
		const launch = {
			benchmark: "harbor" as const,
			jobName: "exp-arm",
			dataset: "test-dataset@1.0",
			agent: "omp",
			models: ["m"],
		};

		const staleToken = store.reserveLaunch(launch);
		const currentToken = store.reserveLaunch(launch);
		expect(store.getRun("exp-arm")).toMatchObject({ status: "running", pid: null, launchToken: currentToken });
		expect(() => store.reserveLaunch(launch, undefined, staleToken)).toThrow(/token changed/);
		expect(store.closeExperiment("exp", "admitted launch may finish")).toBe(true);
		expect(() => store.reserveLaunch({ ...launch, jobName: "exp-later" })).toThrow(/closed/);
		expect(store.bindLaunchPid("exp-arm", currentToken, 101)).toBe(true);
		expect(store.syncRun("exp-arm", staleToken)).toMatchObject({ pid: 101, status: "running", nTotal: 0, done: 0 });
		expect(store.markExit("exp-arm", 1, false, staleToken)).toBe(false);
		expect(store.markExit("exp-arm", 0, false, currentToken)).toBe(true);
	});

	it("does not let a captured null token mutate a replacement row", () => {
		const jobsDir = makeJobsDir();
		writeFixtureJob(jobsDir, "legacy-arm");
		const store = new RunStore(jobsDir);
		cleanups.push(() => store.close());
		expect(store.discover()).toBe(1);
		const launch = {
			benchmark: "harbor" as const,
			jobName: "legacy-arm",
			dataset: "test-dataset@1.0",
			agent: "omp",
			models: ["m"],
		};
		expect(() => store.reserveLaunch(launch, undefined, "stale-token")).toThrow(/token changed/);
		expect(store.listTraces("legacy-arm")).toHaveLength(3);
		const currentToken = store.reserveLaunch(launch);

		expect(store.syncRun("legacy-arm", null)).toMatchObject({
			launchToken: currentToken,
			status: "running",
			nTotal: 3,
		});
	});

	it("restores a missing promoted row only while the reservation slot is free", () => {
		const store = new RunStore(makeJobsDir());
		cleanups.push(() => store.close());
		const launch = {
			benchmark: "harbor" as const,
			jobName: "exp-arm",
			dataset: "test-dataset@1.0",
			agent: "omp",
			models: ["m"],
		};
		const token = store.admitExperimentLaunch({ jobName: launch.jobName, maxRuns: 1 });
		store.reserveLaunch(launch, token);
		expect(store.deleteRun(launch.jobName)).toBe(true);
		expect(store.rollbackLaunch(launch.jobName, token, token)).toBe(true);
		expect(store.hasExperimentLaunch(launch.jobName, token)).toBe(true);
		store.releaseExperimentLaunch(launch.jobName, token);

		const secondToken = store.admitExperimentLaunch({ jobName: launch.jobName, maxRuns: 1 });
		store.reserveLaunch(launch, secondToken);
		expect(store.deleteRun(launch.jobName)).toBe(true);
		const replacementToken = store.admitExperimentLaunch({ jobName: launch.jobName, maxRuns: 1 });
		expect(store.rollbackLaunch(launch.jobName, secondToken, secondToken)).toBe(false);
		expect(store.hasExperimentLaunch(launch.jobName, replacementToken)).toBe(true);
	});

	it("cancels a tokenless run with a NULL ownership predicate", () => {
		const jobsDir = makeJobsDir();
		const dbPath = path.join(jobsDir, "_manager", "cancel.sqlite");
		writeFixtureJob(jobsDir, "legacy-cancel");
		const manager = new ManagerServer(jobsDir, dbPath);
		cleanups.push(() => manager.store.close());
		expect(manager.store.discover()).toBe(1);
		const db = new Database(dbPath);
		db.query("UPDATE runs SET pid = ? WHERE job_name = ? AND launch_token IS NULL").run(999999999, "legacy-cancel");
		db.close();

		expect(manager.cancel("legacy-cancel")).toEqual({ jobName: "legacy-cancel", cancelled: true });
		expect(manager.store.getRun("legacy-cancel")).toMatchObject({ status: "cancelled", launchToken: null });
	});
	it("does not let legacy registration claim a grouped reservation", () => {
		const store = new RunStore(makeJobsDir());
		cleanups.push(() => store.close());
		const launch = {
			benchmark: "harbor" as const,
			jobName: "exp-arm",
			dataset: "test-dataset@1.0",
			agent: "omp",
			models: ["m"],
		};
		const token = store.admitExperimentLaunch({ jobName: launch.jobName, maxRuns: 1 });

		expect(() => store.registerLaunch({ ...launch, pid: process.pid })).toThrow(/already reserved/);
		expect(store.getRun(launch.jobName)).toBeNull();
		expect(() => store.reserveLaunch(launch, "not-the-owner")).toThrow(/reservation disappeared/);
		expect(() => store.reserveLaunch(launch, token)).not.toThrow();
	});

	it("does not create a reservation when token promotion cannot claim it", () => {
		const store = new RunStore(makeJobsDir());
		cleanups.push(() => store.close());
		const launch = {
			benchmark: "harbor" as const,
			jobName: "fresh-arm",
			dataset: "test-dataset@1.0",
			agent: "omp",
			models: ["m"],
		};

		expect(() => store.reserveLaunch(launch, "missing-token")).toThrow(/reservation disappeared/);
		expect(() => store.admitExperimentLaunch({ jobName: launch.jobName, maxRuns: 1 })).not.toThrow();
		store.releaseExperimentLaunch(launch.jobName);

		store.setExperimentMeta("closed", {});
		expect(store.closeExperiment("closed", "closed before launch")).toBe(true);
		expect(() => store.reserveLaunch({ ...launch, jobName: "closed-arm" }, "missing-token")).toThrow(/closed/);
		store.deleteExperimentMeta("closed");
		expect(() => store.admitExperimentLaunch({ jobName: "closed-arm", maxRuns: 1 })).not.toThrow();
	});

	it("restores a token-owned reservation after filesystem setup fails", () => {
		const jobsDir = makeJobsDir();
		const store = new RunStore(jobsDir);
		cleanups.push(() => store.close());
		const launch = {
			benchmark: "harbor" as const,
			jobName: "exp-arm",
			dataset: "test-dataset@1.0",
			agent: "omp",
			models: ["m"],
		};
		const token = store.admitExperimentLaunch({ jobName: launch.jobName, maxRuns: 1 });
		const jobPath = path.join(jobsDir, launch.jobName);
		fs.writeFileSync(jobPath, "not a job directory");

		expect(() => store.reserveLaunch(launch, token)).toThrow();
		expect(store.getRun(launch.jobName)).toBeNull();

		fs.rmSync(jobPath);
		expect(() => store.reserveLaunch(launch, token)).not.toThrow();
	});

	it("rejects grouped admission over an existing run before mutation", () => {
		const store = new RunStore(makeJobsDir());
		cleanups.push(() => store.close());
		const launch = {
			benchmark: "harbor" as const,
			jobName: "exp-arm",
			dataset: "test-dataset@1.0",
			agent: "omp",
			models: ["m"],
		};
		store.registerLaunch({ ...launch, pid: 1 });
		store.markExit(launch.jobName, 0);
		store.setExperimentMeta("exp", { maxRuns: 3 });

		expect(() => store.admitExperimentLaunch({ jobName: launch.jobName, maxRuns: 3 })).toThrow(/already exists/);
		expect(store.getRun(launch.jobName)).toMatchObject({ status: "complete", pid: null });
		expect(() => store.admitExperimentLaunch({ jobName: "exp-next" })).not.toThrow();
	});

	it("allows the admitted owner to promote after experiment closure", () => {
		const store = new RunStore(makeJobsDir());
		cleanups.push(() => store.close());
		const launch = {
			benchmark: "harbor" as const,
			jobName: "exp-arm",
			dataset: "test-dataset@1.0",
			agent: "omp",
			models: ["m"],
		};
		const token = store.admitExperimentLaunch({ jobName: launch.jobName, maxRuns: 1 });
		expect(store.closeExperiment("exp", "admitted launch")).toBe(true);
		expect(() => store.reserveLaunch(launch, token)).not.toThrow();
		expect(store.bindLaunchPid(launch.jobName, token, 101)).toBe(true);
		expect(store.markExit(launch.jobName, 0, false, token)).toBe(true);
	});
	it("does not close a bound live launch", () => {
		const store = new RunStore(makeJobsDir());
		cleanups.push(() => store.close());
		const token = store.reserveLaunch({
			benchmark: "harbor",
			jobName: "exp-arm",
			dataset: "test-dataset@1.0",
			agent: "omp",
			models: ["m"],
		});

		expect(store.bindLaunchPid("exp-arm", token, 101)).toBe(true);
		expect(store.closeExperiment("exp", "must wait")).toBe(false);
		expect(store.markExit("exp-arm", 0, false, token)).toBe(true);
		expect(store.closeExperiment("exp", "finished")).toBe(true);
	});

});


describe("RunStore grouped launch admission", () => {
	it("rejects duplicate reservations and counts other reservations toward limits", () => {
		const jobsDir = makeJobsDir();
		const dbPath = path.join(jobsDir, "experiment.sqlite");
		const first = new RunStore(jobsDir, dbPath);
		const second = new RunStore(jobsDir, dbPath);
		cleanups.push(() => first.close(), () => second.close());

		first.admitExperimentLaunch({ jobName: "exp-first", maxRuns: 1 });
		expect(() => second.admitExperimentLaunch({ jobName: "exp-first" })).toThrow(/already reserved/);
		expect(() => second.admitExperimentLaunch({ jobName: "exp-second" })).toThrow(/maxRuns limit reached/);
	});

	it("preserves non-null pre-registered limits on the initial launch", () => {
		const jobsDir = makeJobsDir();
		const store = new RunStore(jobsDir);
		cleanups.push(() => store.close());

		store.setExperimentMeta("exp", { goal: "compare arms", maxRuns: 3, maxArms: 2 });
		store.admitExperimentLaunch({ jobName: "exp-first", maxRuns: 1, maxArms: 1 });

		expect(store.getExperimentMeta("exp")).toMatchObject({ maxRuns: 3, maxArms: 2 });
	});

	it("cleans up an empty reserved job directory across restart", () => {
		const jobsDir = makeJobsDir();
		const dbPath = path.join(jobsDir, "experiment.sqlite");
		const first = new RunStore(jobsDir, dbPath);
		first.admitExperimentLaunch({ jobName: "exp-orphan", maxRuns: 1 });
		fs.mkdirSync(path.join(jobsDir, "exp-orphan"));
		first.close();
		const staleDb = new Database(dbPath);
		staleDb
			.query("UPDATE experiment_launches SET created_at = ? WHERE job_name = ?")
			.run(Date.now() - 60 * 60 * 1000, "exp-orphan");
		staleDb.close();

		const restarted = new RunStore(jobsDir, dbPath);
		cleanups.push(() => restarted.close());
		expect(restarted.discover()).toBe(0);
		expect(restarted.getRun("exp-orphan")).toBeNull();
		expect(() => restarted.admitExperimentLaunch({ jobName: "exp-next" })).not.toThrow();
	});

	it("retains a stale reservation while its nonempty directory remains", () => {
		const jobsDir = makeJobsDir();
		const dbPath = path.join(jobsDir, "experiment.sqlite");
		const first = new RunStore(jobsDir, dbPath);
		first.admitExperimentLaunch({ jobName: "exp-orphan", maxRuns: 1 });
		const jobDir = path.join(jobsDir, "exp-orphan");
		fs.mkdirSync(jobDir);
		fs.writeFileSync(path.join(jobDir, "historical.json"), "{}");
		const staleDb = new Database(dbPath);
		staleDb
			.query("UPDATE experiment_launches SET created_at = ? WHERE job_name = ?")
			.run(Date.now() - 60 * 60 * 1000, "exp-orphan");
		staleDb.close();

		const restarted = new RunStore(jobsDir, dbPath);
		cleanups.push(() => restarted.close());
		expect(restarted.discover()).toBe(0);
		expect(restarted.getRun("exp-orphan")).toBeNull();
		expect(() => restarted.admitExperimentLaunch({ jobName: "exp-next" })).toThrow(/maxRuns limit reached/);
	});
	it("preserves a fresh in-flight reservation across manager restart", () => {
		const jobsDir = makeJobsDir();
		const dbPath = path.join(jobsDir, "experiment.sqlite");
		const first = new ManagerServer(jobsDir, dbPath);
		const token = first.store.admitExperimentLaunch({ jobName: "exp-arm", maxRuns: 1 });
		const second = new ManagerServer(jobsDir, dbPath);
		cleanups.push(() => first.store.close(), () => second.store.close());

		expect(token).toEqual(expect.any(String));
		expect(() => second.store.admitExperimentLaunch({ jobName: "exp-arm" })).toThrow(/already reserved/);
		expect(() => second.store.admitExperimentLaunch({ jobName: "exp-other" })).toThrow(/maxRuns limit reached/);
	});

	it("skips a nonempty reserved directory during ManagerServer discovery", () => {
		const jobsDir = makeJobsDir();
		const dbPath = path.join(jobsDir, "experiment.sqlite");
		const first = new ManagerServer(jobsDir, dbPath);
		const token = first.store.admitExperimentLaunch({ jobName: "exp-arm", maxRuns: 1 });
		const jobDir = path.join(jobsDir, "exp-arm");
		fs.mkdirSync(jobDir, { recursive: true });
		fs.writeFileSync(path.join(jobDir, "orphan"), "pending");

		const second = new ManagerServer(jobsDir, dbPath);
		second.start(0);
		cleanups.push(() => first.store.close(), () => void second.stop());

		expect(second.store.getRun("exp-arm")).toBeNull();
		expect(() => second.store.admitExperimentLaunch({ jobName: "exp-other" })).toThrow(/maxRuns limit reached/);
		expect(() =>
			first.store.reserveLaunch(
				{
					benchmark: "harbor",
					jobName: "exp-arm",
					dataset: "test-dataset@1.0",
					agent: "omp",
					models: ["m"],
				},
				token,
			),
		).not.toThrow();
	});

});

describe("ManagerServer API", () => {
	it("serves uniform runs, traces, and rejects invalid launches", async () => {
		const jobsDir = makeJobsDir();
		writeFixtureJob(jobsDir, "job-api");
		const manager = new ManagerServer(jobsDir);
		const server = manager.start(0);
		cleanups.push(() => {
			void manager.stop();
		});
		const base = `http://localhost:${server.port}`;

		const runs = (await (await fetch(`${base}/api/runs`)).json()) as Array<{ jobName: string; pass: number }>;
		expect(runs.map(r => r.jobName)).toContain("job-api");

		const detailRes = await fetch(`${base}/api/runs/job-api`);
		expect(detailRes.status).toBe(200);
		const detail = (await detailRes.json()) as { run: { pass: number }; traces: Array<{ status: string }> };
		expect(detail.run.pass).toBe(1);
		expect(detail.traces).toHaveLength(3);

		const tr = await fetch(`${base}/api/runs/job-api/traces/alpha__abc?tail=10`);
		expect(tr.status).toBe(200);
		const trace = (await tr.json()) as { entries: Array<{ kind: string; tools?: string[] }> };
		expect(trace.entries.map(e => e.kind)).toEqual(["assistant", "toolResult"]);
		expect(trace.entries[0].tools).toEqual(["read"]);

		const missing = await fetch(`${base}/api/runs/nope`);
		expect(missing.status).toBe(404);

		const badLaunch = await fetch(`${base}/api/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(badLaunch.status).toBe(400);

		const cancelUnknown = (await (await fetch(`${base}/api/runs/nope/cancel`, { method: "POST" })).json()) as {
			cancelled: boolean;
		};
		expect(cancelUnknown.cancelled).toBe(false);

		const deleteUnknown = await fetch(`${base}/api/runs/nope`, { method: "DELETE" });
		expect(deleteUnknown.status).toBe(404);
	});

	it("serves edit and SnapCompact metrics and native traces through one API", async () => {
		const jobsDir = makeJobsDir();
		const manager = new ManagerServer(jobsDir);
		for (const benchmark of ["edit", "snapcompact"] as const) {
			const jobName = `${benchmark}-arm`;
			manager.store.registerLaunch({
				benchmark,
				jobName,
				dataset: benchmark === "edit" ? "typescript-edit" : "squad-dev",
				agent: benchmark,
				models: ["test/model"],
				pid: process.pid,
			});
			manager.store.markExit(jobName, 0);
		}
		const editDir = path.join(jobsDir, "edit-arm");
		fs.writeFileSync(
			path.join(editDir, "result.json"),
			JSON.stringify({
				tasks: [
					{
						id: "rename",
						name: "Rename",
						runs: [{ runIndex: 0, success: true, duration: 10, tokens: { input: 8, output: 2, reasoning: 0 } }],
					},
				],
				summary: {
					totalRuns: 1,
					successfulRuns: 1,
					taskSuccessRate: 1,
					editSuccessRate: 1,
					totalTokens: { input: 8, output: 2 },
				},
			}),
		);
		fs.mkdirSync(path.join(editDir, "result.dump", "rename"), { recursive: true });
		fs.writeFileSync(path.join(editDir, "result.dump", "rename", "run-1.md"), "# conversation\n\nassistant answer");
		const snapDir = path.join(jobsDir, "snapcompact-arm");
		fs.writeFileSync(
			path.join(snapDir, "records.jsonl"),
			`${JSON.stringify({ cond: "text", chunk: 0, pos_rel: 0, q: "question", answer: "answer", golds: ["gold"], em: 0, f1: 0.5 })}\n`,
		);
		fs.writeFileSync(
			path.join(snapDir, "summary.json"),
			JSON.stringify({
				rows: [{ n: 1, f1: 0.5, em: 0, cost_usd: 0.1, tokens_in: 10, tokens_out: 2, cache_w: 0, cache_r: 0 }],
			}),
		);
		manager.store.syncAll();
		const server = manager.start(0);
		cleanups.push(() => {
			void manager.stop();
		});
		const base = `http://localhost:${server.port}`;

		const edit = (await (await fetch(`${base}/api/runs/edit-arm`)).json()) as {
			run: { benchmark: string; metrics: Record<string, number> };
			traces: Array<{ name: string }>;
		};
		expect(edit.run).toMatchObject({ benchmark: "edit", metrics: { task_success_rate: 1, edit_success_rate: 1 } });
		const editTrace = (await (
			await fetch(`${base}/api/runs/edit-arm/traces/${encodeURIComponent(edit.traces[0].name)}`)
		).json()) as { entries: Array<{ kind: string; text: string }> };
		expect(editTrace.entries).toEqual([{ kind: "conversation", text: "# conversation\n\nassistant answer" }]);

		const snap = (await (await fetch(`${base}/api/runs/snapcompact-arm`)).json()) as {
			run: { benchmark: string; metrics: Record<string, number> };
			traces: Array<{ name: string }>;
		};
		expect(snap.run).toMatchObject({ benchmark: "snapcompact", metrics: { f1: 0.5, exact_match: 0 } });
		const snapTrace = (await (
			await fetch(`${base}/api/runs/snapcompact-arm/traces/${encodeURIComponent(snap.traces[0].name)}`)
		).json()) as { entries: Array<{ kind: string }> };
		expect(snapTrace.entries.map(entry => entry.kind)).toEqual(["question", "answer", "reference"]);
	});
	it("guards resume: unknown, non-harbor, running, and config-less runs are rejected", async () => {
		const jobsDir = makeJobsDir();
		const manager = new ManagerServer(jobsDir);
		manager.store.registerLaunch({
			benchmark: "edit",
			jobName: "edit-x",
			dataset: "typescript-edit",
			agent: "edit",
			models: ["m/x"],
			pid: process.pid,
		});
		manager.store.markExit("edit-x", 1);
		// A live harbor run: pid is this test process, never marked exited.
		manager.store.registerLaunch({
			benchmark: "harbor",
			jobName: "job-live",
			dataset: "terminal-bench@2.0",
			agent: "omp",
			models: ["m/x"],
			pid: process.pid,
		});
		// A failed harbor run whose job dir has no harbor config.json.
		manager.store.registerLaunch({
			benchmark: "harbor",
			jobName: "job-bare",
			dataset: "terminal-bench@2.0",
			agent: "omp",
			models: ["m/x"],
			pid: process.pid,
		});
		manager.store.markExit("job-bare", 1);
		const server = manager.start(0);
		cleanups.push(() => {
			void manager.stop();
		});
		const base = `http://localhost:${server.port}`;
		const resumeError = async (name: string): Promise<string> => {
			const res = await fetch(`${base}/api/runs/${name}/resume`, { method: "POST" });
			expect(res.status).toBe(400);
			return ((await res.json()) as { error: string }).error;
		};

		expect(await resumeError("nope")).toMatch(/not found/);
		expect(await resumeError("edit-x")).toMatch(/only harbor/);
		expect(await resumeError("job-live")).toMatch(/already running/);
		expect(await resumeError("job-bare")).toMatch(/no harbor config.json/);
	});

	it("experiment CRUD: create is browsable, delete removes rows + job dirs, live arms are protected", async () => {
		const jobsDir = makeJobsDir();
		const manager = new ManagerServer(jobsDir);
		// Two finished arms of experiment `crud` and one live run in a different experiment.
		for (const jobName of ["crud-base", "crud-treat"]) {
			manager.store.registerLaunch({
				benchmark: "harbor",
				jobName,
				dataset: "terminal-bench@2.0",
				agent: "omp",
				models: ["m/x"],
				pid: process.pid,
			});
			manager.store.markExit(jobName, 0);
		}
		manager.store.registerLaunch({
			benchmark: "harbor",
			jobName: "live-run",
			dataset: "terminal-bench@2.0",
			agent: "omp",
			models: ["m/x"],
			pid: process.pid,
		});
		const server = manager.start(0);
		cleanups.push(() => {
			void manager.stop();
		});
		const base = `http://localhost:${server.port}`;

		// Create: registered id is browsable before any run exists.
		const created = await fetch(`${base}/api/experiments`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: "fresh", goal: "does X beat Y?" }),
		});
		expect(created.status).toBe(201);
		const list = (await (await fetch(`${base}/api/experiments`)).json()) as Array<{
			id: string;
			goal: string;
			arms: number;
		}>;
		const fresh = list.find(e => e.id === "fresh");
		expect(fresh).toMatchObject({ goal: "does X beat Y?", arms: 0 });
		const freshDetail = (await (await fetch(`${base}/api/experiments/fresh`)).json()) as {
			goal: string;
			arms: unknown[];
		};
		expect(freshDetail).toMatchObject({ goal: "does X beat Y?", arms: [] });

		// Create: dashed / empty ids can never own a run — rejected.
		for (const id of ["bad-id", ""]) {
			const res = await fetch(`${base}/api/experiments`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id }),
			});
			expect(res.status).toBe(400);
		}

		// Browse: list filters.
		const filtered = (await (await fetch(`${base}/api/runs?experiment=crud`)).json()) as Array<{
			jobName: string;
		}>;
		expect(filtered.map(r => r.jobName).sort()).toEqual(["crud-base", "crud-treat"]);
		const running = (await (await fetch(`${base}/api/runs?status=running`)).json()) as Array<{
			jobName: string;
		}>;
		expect(running.map(r => r.jobName)).toEqual(["live-run"]);
		const q = (await (await fetch(`${base}/api/experiments?q=fresh`)).json()) as Array<{ id: string }>;
		expect(q.map(e => e.id)).toEqual(["fresh"]);

		// Delete run: live runs are protected, finished runs vanish from DB and disk.
		const liveDelete = await fetch(`${base}/api/runs/live-run`, { method: "DELETE" });
		expect(liveDelete.status).toBe(400);
		const runDelete = await fetch(`${base}/api/runs/crud-treat`, { method: "DELETE" });
		expect(runDelete.status).toBe(200);
		expect(fs.existsSync(path.join(jobsDir, "crud-treat"))).toBe(false);
		expect(manager.store.getRun("crud-treat")).toBeNull();

		// Delete experiment: remaining arm rows + dirs + goal row all go; 404 after.
		const expDelete = (await (await fetch(`${base}/api/experiments/crud`, { method: "DELETE" })).json()) as {
			deletedRuns: string[];
		};
		expect(expDelete.deletedRuns).toEqual(["crud-base"]);
		expect(fs.existsSync(path.join(jobsDir, "crud-base"))).toBe(false);
		expect((await fetch(`${base}/api/experiments/crud`)).status).toBe(404);
		expect((await fetch(`${base}/api/experiments/unknown`, { method: "DELETE" })).status).toBe(404);

		// Delete experiment with a live arm: refused, nothing removed.
		const liveExpDelete = await fetch(`${base}/api/experiments/live`, { method: "DELETE" });
		expect(liveExpDelete.status).toBe(400);
		expect(manager.store.getRun("live-run")).not.toBeNull();
	});
});

describe("ManagerServer launch rollback", () => {
	it("rolls back an admitted launch after post-reserve setup failure", () => {
		const jobsDir = makeJobsDir();
		const dbPath = path.join(jobsDir, "_manager", "rollback.sqlite");
		const manager = new ManagerServer(jobsDir, dbPath);
		const logDir = path.join(jobsDir, "_manager", "logs");
		fs.writeFileSync(logDir, "not a directory");

		expect(() =>
			manager.launch({
				benchmark: "harbor",
				jobName: "exp-failed",
				model: "m/x",
				maxRuns: 1,
			}),
		).toThrow();
		expect(manager.store.getRun("exp-failed")).toBeNull();

		fs.rmSync(logDir);
		const restarted = new ManagerServer(jobsDir, dbPath);
		restarted.start(0);
		cleanups.push(() => manager.store.close(), () => void restarted.stop());
		expect(restarted.store.getRun("exp-failed")).toBeNull();
		expect(() => restarted.store.admitExperimentLaunch({ jobName: "exp-retry", maxRuns: 1 })).not.toThrow();
	});

	it("preserves a prior run and traces when resume log setup is blocked", () => {
		const jobsDir = makeJobsDir();
		const jobName = "legacy-retry";
		writeFixtureJob(jobsDir, jobName);
		const resultPath = path.join(jobsDir, jobName, "result.json");
		const result = JSON.parse(fs.readFileSync(resultPath, "utf8")) as Record<string, unknown>;
		result.finished_at = "2026-07-12T12:00:00";
		fs.writeFileSync(resultPath, JSON.stringify(result));
		const dbPath = path.join(jobsDir, "_manager", "prior.sqlite");
		const manager = new ManagerServer(jobsDir, dbPath);
		cleanups.push(() => manager.store.close());
		expect(manager.store.discover()).toBe(1);
		const before = manager.store.getRun(jobName);
		const traces = manager.store.listTraces(jobName);
		const logDir = path.join(jobsDir, "_manager", "logs");
		fs.writeFileSync(logDir, "not a directory");

		expect(() => manager.resume(jobName)).toThrow(/EEXIST|ENOTDIR|not a directory/);
		expect(manager.store.getRun(jobName)).toEqual(before);
		expect(manager.store.listTraces(jobName)).toEqual(traces);
		fs.rmSync(logDir);
	});

	it("restores a prior run and traces after resume spawn failure", () => {
		const jobsDir = makeJobsDir();
		const jobName = "legacy-spawn-failure";
		writeFixtureJob(jobsDir, jobName);
		const resultPath = path.join(jobsDir, jobName, "result.json");
		const result = JSON.parse(fs.readFileSync(resultPath, "utf8")) as Record<string, unknown>;
		result.finished_at = "2026-07-12T12:00:00";
		fs.writeFileSync(resultPath, JSON.stringify(result));
		const dbPath = path.join(jobsDir, "_manager", "spawn-failure.sqlite");
		const manager = new ManagerServer(jobsDir, dbPath);
		cleanups.push(() => manager.store.close());
		expect(manager.store.discover()).toBe(1);
		const before = manager.store.getRun(jobName);
		const traces = manager.store.listTraces(jobName);
		const bunRuntime = Bun as unknown as { spawn: typeof Bun.spawn };
		const originalSpawn = bunRuntime.spawn;
		bunRuntime.spawn = (() => {
			throw new Error("synthetic spawn failure");
		}) as typeof originalSpawn;
		try {
			expect(() => manager.resume(jobName)).toThrow("synthetic spawn failure");
		} finally {
			bunRuntime.spawn = originalSpawn;
		}
		expect(before?.launchToken).toBeNull();
		expect(manager.store.getRun(jobName)).toEqual(before);
		expect(manager.store.listTraces(jobName)).toEqual(traces);
	});
	it("restores a prior run and traces after resume log open failure", () => {
		const jobsDir = makeJobsDir();
		const jobName = "legacy-log-open-failure";
		writeFixtureJob(jobsDir, jobName);
		const resultPath = path.join(jobsDir, jobName, "result.json");
		const result = JSON.parse(fs.readFileSync(resultPath, "utf8")) as Record<string, unknown>;
		result.finished_at = "2026-07-12T12:00:00";
		fs.writeFileSync(resultPath, JSON.stringify(result));
		const dbPath = path.join(jobsDir, "_manager", "log-open-failure.sqlite");
		const manager = new ManagerServer(jobsDir, dbPath);
		cleanups.push(() => manager.store.close());
		expect(manager.store.discover()).toBe(1);
		const before = manager.store.getRun(jobName);
		const traces = manager.store.listTraces(jobName);
		const logPath = path.join(jobsDir, "_manager", "logs", `${jobName}.log`);
		fs.mkdirSync(logPath, { recursive: true });
		expect(() => manager.resume(jobName)).toThrow(/EISDIR|is a directory/);
		expect(manager.store.getRun(jobName)).toEqual(before);
		expect(manager.store.listTraces(jobName)).toEqual(traces);
	});

});

describe("resolveArmLaunch", () => {
	it("inherits dataset + exact task sample + scale from a sibling arm", () => {
		const store = new RunStore(makeJobsDir());
		cleanups.push(() => store.close());
		store.registerLaunch({
			benchmark: "harbor",
			jobName: "exp-base",
			dataset: "swe-bench/swe-bench-verified",
			agent: "omp",
			models: ["anthropic/claude-opus-4-8"],
			pid: 4321,
			role: "baseline",
			config: {
				include: ["astropy__astropy-1", "django__django-2", "sympy__sympy-3"],
				tasks: 3,
				concurrency: 4,
				timeoutMultiplier: 2,
			},
		});

		const launch = resolveArmLaunch(store, "exp", {
			arm: "n8",
			model: "google/gemini-3.5-flash",
			role: "variant",
			note: "prewalk@flash",
			prewalk: { into: "google/gemini-3.5-flash" },
		});

		expect(launch.jobName).toBe("exp-n8");
		expect(launch.dataset).toBe("swe-bench/swe-bench-verified");
		expect(launch.include).toEqual(["astropy__astropy-1", "django__django-2", "sympy__sympy-3"]);
		expect(launch.tasks).toBe(3);
		expect(launch.concurrency).toBe(4);
		expect(launch.timeoutMultiplier).toBe(2);
		expect(launch.model).toBe("google/gemini-3.5-flash");
		expect(launch.role).toBe("variant");
		expect(launch.prewalk?.into).toBe("google/gemini-3.5-flash");
	});

	it("prefers the sibling with a recorded include list over newer include-less siblings", () => {
		const store = new RunStore(makeJobsDir());
		cleanups.push(() => store.close());
		// Older sibling carries the authoritative sample…
		store.registerLaunch({
			benchmark: "harbor",
			jobName: "exp-base",
			dataset: "swe-bench/swe-bench-verified",
			agent: "omp",
			models: ["anthropic/claude-opus-4-8"],
			pid: 1,
			config: { include: ["swe-bench/astropy__astropy-1", "swe-bench/django__django-2"] },
		});
		// …while a newer arm (e.g. discovered from disk) recorded no include.
		store.registerLaunch({
			benchmark: "harbor",
			jobName: "exp-noinc",
			dataset: "swe-bench/swe-bench-verified",
			agent: "omp",
			models: ["anthropic/claude-opus-4-8"],
			pid: 2,
			config: {},
		});

		const launch = resolveArmLaunch(store, "exp", { arm: "next", model: "anthropic/claude-opus-4-8" });
		expect(launch.include).toEqual(["swe-bench/astropy__astropy-1", "swe-bench/django__django-2"]);
		expect(launch.tasks).toBe(2);
	});

	it("rejects a duplicate arm and an unknown experiment", () => {
		const store = new RunStore(makeJobsDir());
		cleanups.push(() => store.close());
		store.registerLaunch({
			benchmark: "harbor",
			jobName: "exp-base",
			dataset: "d",
			agent: "omp",
			models: ["m/x"],
			pid: 1,
			config: { include: ["t1"] },
		});
		expect(() => resolveArmLaunch(store, "exp", { arm: "base", model: "m/y" })).toThrow(/already exists/);
		expect(() => resolveArmLaunch(store, "ghost", { arm: "x", model: "m/y" })).toThrow(/no runs to inherit/);
	});
});

describe("experiment lifecycle gates", () => {
	it("enforces limits and durable closure across fresh ManagerServer instances", async () => {
		const jobsDir = makeJobsDir();
		const dbPath = path.join(jobsDir, "_manager", "lifecycle.sqlite");
		const first = new ManagerServer(jobsDir, dbPath);
		first.store.registerLaunch({
			benchmark: "harbor",
			jobName: "exp-base",
			dataset: "terminal-bench@2.0",
			agent: "omp",
			models: ["m/x"],
			pid: process.pid,
			config: { include: ["task-1"] },
		});
		first.store.markExit("exp-base", 0);
		first.store.setExperimentMeta("exp", { goal: "measure", maxRuns: 5, maxArms: 1 });
		const firstServer = first.start(0);
		const firstBase = `http://localhost:${firstServer.port}`;

		const lowerLimit = await fetch(`${firstBase}/api/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ benchmark: "harbor", jobName: "exp-drive", model: "m/x", maxRuns: 1 }),
		});
		expect(lowerLimit.status).toBe(400);

		const genericArm = await fetch(`${firstBase}/api/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ benchmark: "harbor", jobName: "exp-extra", model: "m/x" }),
		});
		expect(genericArm.status).toBe(400);
		expect((await genericArm.json()).error).toMatch(/maxArms/);

		first.store.setExperimentMeta("exp", { maxRuns: 1, maxArms: null });
		const maxRun = await fetch(`${firstBase}/api/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ benchmark: "harbor", jobName: "exp-drive", model: "m/x" }),
		});
		expect(maxRun.status).toBe(400);
		expect((await maxRun.json()).error).toMatch(/maxRuns/);
		first.store.setExperimentMeta("exp", { maxRuns: 5, maxArms: 1 });
		await first.stop();

		const bounded = new ManagerServer(jobsDir, dbPath);
		const boundedServer = bounded.start(0);
		const boundedBase = `http://localhost:${boundedServer.port}`;
		const maxArm = await fetch(`${boundedBase}/api/experiments/exp/arms`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ arm: "next", model: "m/y" }),
		});
		expect(maxArm.status).toBe(400);
		expect((await maxArm.json()).error).toMatch(/maxArms/);

		const blankClose = await fetch(`${boundedBase}/api/experiments/exp`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ closure: { verdict: " \t" } }),
		});
		expect(blankClose.status).toBe(400);

		const closed = await fetch(`${boundedBase}/api/experiments/exp`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ closure: { verdict: "measured: baseline wins" } }),
		});
		expect(closed.status).toBe(200);
		await bounded.stop();

		const second = new ManagerServer(jobsDir, dbPath);
		cleanups.push(() => {
			void second.stop();
		});
		const server = second.start(0);
		const base = `http://localhost:${server.port}`;
		const detail = (await (await fetch(`${base}/api/experiments/exp`)).json()) as {
			goal: string;
			maxRuns: number | null;
			maxArms: number | null;
			closure: { verdict: string; closedAt: number } | null;
		};
		expect(detail).toMatchObject({
			goal: "measure",
			maxRuns: 5,
			maxArms: 1,
			closure: { verdict: "measured: baseline wins" },
		});
		const failedClose = await fetch(`${base}/api/experiments/exp`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ closure: { verdict: "second verdict" }, runs: { "exp-base": { note: "must not apply" } } }),
		});
		expect(failedClose.status).toBe(400);
		const unchangedRun = (await (await fetch(`${base}/api/runs/exp-base`)).json()) as { run: { note: string } };
		expect(unchangedRun.run.note).toBe("");
		const runsOnly = await fetch(`${base}/api/experiments/exp`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ runs: { "exp-base": { note: "runs-only must not apply" } } }),
		});
		expect(runsOnly.status).toBe(400);
		expect((await runsOnly.json()).error).toMatch(/closed/);
		const stillUnchangedRun = (await (await fetch(`${base}/api/runs/exp-base`)).json()) as { run: { note: string } };
		expect(stillUnchangedRun.run.note).toBe("");
		for (const [url, body] of [
			[`${base}/api/runs`, { benchmark: "harbor", jobName: "exp-late", model: "m/x" }],
			[`${base}/api/experiments/exp/arms`, { arm: "late", model: "m/y" }],
		] as const) {
			const response = await fetch(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			expect(response.status).toBe(400);
			expect((await response.json()).error).toMatch(/closed/);
		}
		const resume = await fetch(`${base}/api/runs/exp-base/resume`, { method: "POST" });
		expect(resume.status).toBe(400);
		expect((await resume.json()).error).toMatch(/closed/);
		const goal = await fetch(`${base}/api/experiments/exp`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ goal: "changed" }),
		});
		expect(goal.status).toBe(400);
		expect((await goal.json()).error).toMatch(/closed/);
	});
	it("surfaces partial legacy closure in GET and rejects grouped launches", async () => {
		const jobsDir = makeJobsDir();
		const dbPath = path.join(jobsDir, "_manager", "partial-closure.sqlite");
		const seed = new RunStore(jobsDir, dbPath);
		seed.setExperimentMeta("partial", { goal: "legacy row" });
		seed.close();
		const legacyDb = new Database(dbPath);
		legacyDb.query("UPDATE experiments SET closed_at = ? WHERE id = ?").run(1_752_000_000_001, "partial");
		legacyDb.close();

		const manager = new ManagerServer(jobsDir, dbPath);
		cleanups.push(() => {
			void manager.stop();
		});
		const server = manager.start(0);
		const base = `http://localhost:${server.port}`;
		const detail = (await (await fetch(`${base}/api/experiments/partial`)).json()) as {
			closure: { verdict: string; closedAt: number } | null;
			arms: unknown[];
		};
		expect(detail).toMatchObject({
			closure: { verdict: "", closedAt: 1_752_000_000_001 },
			arms: [],
		});

		const launch = await fetch(`${base}/api/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ benchmark: "harbor", jobName: "partial-arm", model: "m/x" }),
		});
		expect(launch.status).toBe(400);
		expect((await launch.json()).error).toMatch(/closed/);
	});

});

