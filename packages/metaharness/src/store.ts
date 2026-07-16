/**
 * SQLite-backed store for Harbor runs managed by this package.
 *
 * The filesystem stays the source of truth (Harbor writes `result.json`
 * per job and per trial); the store mirrors it into queryable rows and adds
 * manager-owned metadata Harbor has no notion of: launch pid, requested
 * config, lifecycle status. `syncRun` re-reads a job dir and upserts.
 */

import { Database } from "bun:sqlite";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { readBenchmarkSnapshot } from "./benchmarks";
import { readJobResult } from "./runner";
import { canonicalArmOf } from "./experiments";

export type RunStatus = "running" | "complete" | "failed" | "cancelled";

/** Benchmark implementation that produced a run. */
export type BenchmarkKind = "harbor" | "edit" | "snapcompact";

/** How a run relates to its experiment's question. */
export type RunRole = "baseline" | "variant" | "";

export interface RunRow {
	benchmark: BenchmarkKind;
	jobName: string;
	dataset: string;
	agent: string;
	models: string;
	/** JSON prewalk config (`{ into?: string }`); older rows may hold legacy reasoning-slide JSON. */
	prewalk: string | null;
	/** Benchmark-specific launch configuration. */
	config: Record<string, unknown>;
	/** Role inside the experiment (baseline vs treatment); "" when unspecified. */
	role: RunRole;
	/** One-line description of what this arm tests (e.g. "prewalk→flash at first edit/write"). */
	note: string;
	/** Display-name override for the arm; "" falls back to the jobName-derived arm label. */
	label: string;
	status: RunStatus;
	pid: number | null;
	/** Opaque token identifying the launch that owns this row. */
	launchToken: string | null;
	exitCode: number | null;
	createdAt: number;
	finishedAt: number | null;
	nTotal: number;
	done: number;
	pass: number;
	fail: number;
	error: number;
	running: number;
	costUsd: number;
	tokIn: number;
	tokOut: number;
	tokCache: number;
	/** Benchmark-native aggregate score, when the benchmark exposes one. */
	score: number | null;
	/** Values keyed by the adapter's metric definitions. */
	metrics: Record<string, number | null>;
}

export interface TraceRow {
	jobName: string;
	name: string;
	task: string;
	status: string;
	reward: number | null;
	costUsd: number;
	durationMs: number;
	detail: string;
	updatedAt: number;
	/** Adapter-owned locator used by the uniform trace endpoint. */
	tracePath: string | null;
}

/** Public metadata for an experiment, including optional lifecycle limits. */
export interface ExperimentMeta {
	id: string;
	goal: string;
	updatedAt: number;
	maxRuns: number | null;
	maxArms: number | null;
	closure: { verdict: string; closedAt: number } | null;
}

export interface ExperimentMetaUpdate {
	goal?: string;
	maxRuns?: number | null;
	maxArms?: number | null;
}

export interface ExperimentClosure {
	verdict: string;
	closedAt: number;
}

export interface LaunchRecord {
	benchmark: BenchmarkKind;
	jobName: string;
	dataset: string;
	agent: string;
	models: string[];
	prewalk?: { into?: string };
	pid: number;
	role?: RunRole;
	note?: string;
	config?: Record<string, unknown>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
	job_name TEXT PRIMARY KEY,
	benchmark TEXT NOT NULL DEFAULT 'harbor',
	dataset TEXT NOT NULL DEFAULT '',
	agent TEXT NOT NULL DEFAULT 'omp',
	models TEXT NOT NULL DEFAULT '',
	prewalk TEXT,
	role TEXT NOT NULL DEFAULT '',
	note TEXT NOT NULL DEFAULT '',
	label TEXT NOT NULL DEFAULT '',
	config_json TEXT NOT NULL DEFAULT '{}',
	status TEXT NOT NULL DEFAULT 'running',
	pid INTEGER,
	launch_token TEXT,
	exit_code INTEGER,
	created_at INTEGER NOT NULL,
	finished_at INTEGER,
	n_total INTEGER NOT NULL DEFAULT 0,
	done INTEGER NOT NULL DEFAULT 0,
	pass INTEGER NOT NULL DEFAULT 0,
	fail INTEGER NOT NULL DEFAULT 0,
	error INTEGER NOT NULL DEFAULT 0,
	running INTEGER NOT NULL DEFAULT 0,
	cost_usd REAL NOT NULL DEFAULT 0,
	tok_in INTEGER NOT NULL DEFAULT 0,
	tok_out INTEGER NOT NULL DEFAULT 0,
	score REAL,
	metrics_json TEXT NOT NULL DEFAULT '{}',
	tok_cache INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS trials (
	job_name TEXT NOT NULL,
	name TEXT NOT NULL,
	task TEXT NOT NULL,
	status TEXT NOT NULL,
	reward REAL,
	cost_usd REAL NOT NULL DEFAULT 0,
	duration_ms INTEGER NOT NULL DEFAULT 0,
	detail TEXT NOT NULL DEFAULT '',
	trace_path TEXT,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (job_name, name)
);
CREATE INDEX IF NOT EXISTS idx_trials_job ON trials(job_name);
CREATE TABLE IF NOT EXISTS experiments (
	id TEXT PRIMARY KEY,
	goal TEXT NOT NULL DEFAULT '',
	updated_at INTEGER NOT NULL,
	max_runs INTEGER,
	max_arms INTEGER,
	closure_verdict TEXT,
	closed_at INTEGER
);
CREATE TABLE IF NOT EXISTS experiment_launches (
	job_name TEXT PRIMARY KEY,
	reservation_token TEXT,
	created_at INTEGER NOT NULL
);
`;
/** Pre-spawn reservations older than this are eligible for startup cleanup. */
const PRESPAWN_RESERVATION_STALE_MS = 30 * 60 * 1000;

/** Directory names inside the jobs root that are not Harbor job dirs. */
const NON_JOB_DIRS = new Set(["_bench", "_manager"]);

/** True when a bun:sqlite error is a transient busy/recovery lock. */
function isBusyLock(err: unknown): boolean {
	if (err && typeof err === "object" && "code" in err) {
		const code = err.code;
		return typeof code === "string" && code.startsWith("SQLITE_BUSY");
	}
	return false;
}

/**
 * Enable WAL journaling, tolerating a briefly locked database.
 *
 * `PRAGMA journal_mode = WAL` needs a momentary exclusive lock. When another
 * connection holds the DB — a restarting manager, or a WAL mid-recovery —
 * SQLite returns `SQLITE_BUSY`/`SQLITE_BUSY_RECOVERY`. The busy handler that
 * `busy_timeout` installs is not invoked for recovery locks, so retry the
 * pragma explicitly before surfacing the failure.
 */
function enableWal(db: Database): void {
	const attempts = 10;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			db.run("PRAGMA journal_mode = WAL");
			return;
		} catch (err) {
			if (attempt < attempts && isBusyLock(err)) {
				Bun.sleepSync(100);
				continue;
			}
			throw err;
		}
	}
}

function validateExperimentLimit(name: string, value: number | null | undefined): void {
	if (value !== undefined && value !== null && (!Number.isSafeInteger(value) || value <= 0)) {
		throw new Error(`${name} must be a positive safe integer`);
	}
}

function validateExperimentVerdict(verdict: string): string {
	if (typeof verdict !== "string" || verdict.trim() === "") throw new Error("closure verdict must be non-empty");
	return verdict;
}

function experimentIdOf(jobName: string): string {
	const dash = jobName.indexOf("-");
	return dash > 0 ? jobName.slice(0, dash) : jobName;
}

function addColumnIfMissing(db: Database, columns: Set<string>, name: string, sql: string): void {
	if (columns.has(name)) return;
	try {
		db.run(sql);
	} catch (err) {
		if (!String(err).toLowerCase().includes("duplicate column")) throw err;
	}
}

export class RunStore {
	#db: Database;
	readonly jobsDir: string;
	#expectedLaunchSnapshots = new Map<
		string,
		{
			jobName: string;
			status: RunStatus;
			pid: number | null;
			launchToken: string | null;
			exitCode: number | null;
			finishedAt: number | null;
		}
	>();

	constructor(jobsDir: string, dbPath?: string) {
		this.jobsDir = jobsDir;
		fs.mkdirSync(path.join(jobsDir, "_manager"), { recursive: true });
		this.#db = new Database(dbPath ?? path.join(jobsDir, "_manager", "metaharness.sqlite"));
		this.#db.run("PRAGMA busy_timeout = 5000");
		enableWal(this.#db);
		this.#db.run(SCHEMA);
		const runColumns = new Set(
			(this.#db.query("PRAGMA table_info(runs)").all() as Array<{ name: string }>).map(c => c.name),
		);
		addColumnIfMissing(this.#db, runColumns, "role", "ALTER TABLE runs ADD COLUMN role TEXT NOT NULL DEFAULT ''");
		addColumnIfMissing(this.#db, runColumns, "note", "ALTER TABLE runs ADD COLUMN note TEXT NOT NULL DEFAULT ''");
		addColumnIfMissing(this.#db, runColumns, "label", "ALTER TABLE runs ADD COLUMN label TEXT NOT NULL DEFAULT ''");
		addColumnIfMissing(this.#db, runColumns, "benchmark", "ALTER TABLE runs ADD COLUMN benchmark TEXT NOT NULL DEFAULT 'harbor'");
		addColumnIfMissing(this.#db, runColumns, "config_json", "ALTER TABLE runs ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}'");
		addColumnIfMissing(this.#db, runColumns, "score", "ALTER TABLE runs ADD COLUMN score REAL");
		addColumnIfMissing(this.#db, runColumns, "metrics_json", "ALTER TABLE runs ADD COLUMN metrics_json TEXT NOT NULL DEFAULT '{}'");
		addColumnIfMissing(this.#db, runColumns, "launch_token", "ALTER TABLE runs ADD COLUMN launch_token TEXT");
		if (runColumns.has("slide") && !runColumns.has("prewalk")) {
			this.#db.run("ALTER TABLE runs RENAME COLUMN slide TO prewalk");
		}
		if (!runColumns.has("slide") && !runColumns.has("prewalk")) {
			addColumnIfMissing(this.#db, runColumns, "prewalk", "ALTER TABLE runs ADD COLUMN prewalk TEXT");
		}
		const traceColumns = new Set(
			(this.#db.query("PRAGMA table_info(trials)").all() as Array<{ name: string }>).map(c => c.name),
		);
		addColumnIfMissing(this.#db, traceColumns, "trace_path", "ALTER TABLE trials ADD COLUMN trace_path TEXT");
		const experimentColumns = new Set(
			(this.#db.query("PRAGMA table_info(experiments)").all() as Array<{ name: string }>).map(c => c.name),
		);
		addColumnIfMissing(this.#db, experimentColumns, "max_runs", "ALTER TABLE experiments ADD COLUMN max_runs INTEGER");
		addColumnIfMissing(this.#db, experimentColumns, "max_arms", "ALTER TABLE experiments ADD COLUMN max_arms INTEGER");
		addColumnIfMissing(
			this.#db,
			experimentColumns,
			"closure_verdict",
			"ALTER TABLE experiments ADD COLUMN closure_verdict TEXT",
		);
		const launchColumns = new Set(
			(this.#db.query("PRAGMA table_info(experiment_launches)").all() as Array<{ name: string }>).map(c => c.name),
		);
		addColumnIfMissing(
			this.#db,
			launchColumns,
			"reservation_token",
			"ALTER TABLE experiment_launches ADD COLUMN reservation_token TEXT",
		);
		const staleBefore = Date.now() - PRESPAWN_RESERVATION_STALE_MS;
		addColumnIfMissing(this.#db, experimentColumns, "closed_at", "ALTER TABLE experiments ADD COLUMN closed_at INTEGER");
		for (const row of this.#db
			.query("SELECT job_name, reservation_token, created_at FROM experiment_launches")
			.all() as Array<{ job_name: string; reservation_token: string | null; created_at: number }>) {
			const jobDir = path.join(this.jobsDir, row.job_name);
			try {
				if (fs.readdirSync(jobDir).length > 0) continue;
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") continue;
			}
			const query =
				row.reservation_token === null
					? `DELETE FROM experiment_launches
						 WHERE job_name = ? AND reservation_token IS NULL AND created_at < ?
						   AND NOT EXISTS (SELECT 1 FROM runs WHERE runs.job_name = experiment_launches.job_name)`
					: `DELETE FROM experiment_launches
						 WHERE job_name = ? AND reservation_token = ? AND created_at < ?
						   AND NOT EXISTS (SELECT 1 FROM runs WHERE runs.job_name = experiment_launches.job_name)`;
			const args =
				row.reservation_token === null
					? [row.job_name, staleBefore]
					: [row.job_name, row.reservation_token, staleBefore];
			this.#db.query(query).run(...args);
		}
	}

	close(): void {
		this.#db.close();
	}

	/** Register a run this manager just launched (pid-owning). */
	registerLaunch(launch: LaunchRecord): string {
		const launchToken = this.reserveLaunch(launch);
		if (!this.bindLaunchPid(launch.jobName, launchToken, launch.pid)) {
			throw new Error(`launch ${launch.jobName} reservation disappeared`);
		}
		fs.writeFileSync(
			path.join(this.jobsDir, launch.jobName, "manager.json"),
			JSON.stringify(launch, null, 2),
		);
		return launchToken;
	}

	/** Promote an optional token-owned grouped admission into a pid-null launch row. */
	reserveLaunch(
		launch: Omit<LaunchRecord, "pid">,
		admissionToken?: string,
		expectedLaunchToken?: string | null,
	): string {
		const launchToken = admissionToken ?? crypto.randomUUID();
		let promoted = false;
		const tx = this.#db.transaction(() => {
			const experimentId = experimentIdOf(launch.jobName);
			const existingRun = this.#db
				.query("SELECT status, launch_token, pid, exit_code, finished_at FROM runs WHERE job_name = ?")
				.get(launch.jobName) as {
				status: RunStatus;
				launch_token: string | null;
				pid: number | null;
				exit_code: number | null;
				finished_at: number | null;
			} | null;
			if (expectedLaunchToken !== undefined) {
				const matches =
					existingRun !== null &&
					(expectedLaunchToken === null
						? existingRun.launch_token === null
						: existingRun.launch_token === expectedLaunchToken);
				if (!matches) throw new Error(`launch ${launch.jobName} token changed`);
			}
			if (expectedLaunchToken !== undefined && existingRun !== null) {
				this.#expectedLaunchSnapshots.set(launchToken, {
					jobName: launch.jobName,
					status: existingRun.status,
					launchToken: existingRun.launch_token,
					pid: existingRun.pid,
					exitCode: existingRun.exit_code,
					finishedAt: existingRun.finished_at,
				});
			}
			if (admissionToken !== undefined && existingRun !== null) {
				throw new Error(`run ${launch.jobName} already exists`);
			}
			const admissionReservation = this.#db
				.query("SELECT reservation_token FROM experiment_launches WHERE job_name = ?")
				.get(launch.jobName) as { reservation_token: string | null } | null;
			const closure = this.#db
				.query("SELECT closure_verdict, closed_at FROM experiments WHERE id = ?")
				.get(experimentId) as { closure_verdict: string | null; closed_at: number | null } | null;
			if (
				(closure?.closure_verdict != null || closure?.closed_at != null) &&
				(admissionToken === undefined || admissionReservation?.reservation_token !== admissionToken)
			) {
				throw new Error(`experiment ${experimentId} is closed`);
			}
			if (admissionToken === undefined) {
				if (admissionReservation !== null) throw new Error(`launch ${launch.jobName} is already reserved`);
			} else {
				const claimed = this.#db
					.query("DELETE FROM experiment_launches WHERE job_name = ? AND reservation_token = ?")
					.run(launch.jobName, admissionToken);
				if (claimed.changes === 0) throw new Error(`launch ${launch.jobName} reservation disappeared`);
			}
			if (expectedLaunchToken === undefined) this.#db.query("DELETE FROM trials WHERE job_name = ?").run(launch.jobName);
			this.#db
				.query(
					`INSERT INTO runs
					 (job_name, benchmark, dataset, agent, models, prewalk, role, note, config_json, status, pid, launch_token, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', NULL, ?, ?)
					 ON CONFLICT(job_name) DO UPDATE SET
						benchmark = excluded.benchmark, pid = NULL, launch_token = excluded.launch_token, status = 'running',
						config_json = excluded.config_json,
						role = CASE WHEN excluded.role != '' THEN excluded.role ELSE runs.role END,
						note = CASE WHEN excluded.note != '' THEN excluded.note ELSE runs.note END`,
				)
				.run(
					launch.jobName,
					launch.benchmark,
					launch.dataset,
					launch.agent,
					launch.models.join(","),
					launch.prewalk ? JSON.stringify(launch.prewalk) : null,
					launch.role ?? "",
					launch.note ?? "",
					JSON.stringify(launch.config ?? {}),
					launchToken,
					Date.now(),
				);
		});
		try {
			tx();
			promoted = admissionToken !== undefined;
			const jobDir = path.join(this.jobsDir, launch.jobName);
			fs.mkdirSync(jobDir, { recursive: true });
			fs.writeFileSync(path.join(jobDir, "manager.json"), JSON.stringify(launch, null, 2));
			return launchToken;
		} catch (err) {
			if (promoted && admissionToken !== undefined) {
				this.#db.transaction(() => {
					this.#db
						.query(
							"DELETE FROM runs WHERE job_name = ? AND launch_token = ? AND status = 'running' AND pid IS NULL",
						)
						.run(launch.jobName, admissionToken);
					this.#db
						.query(
							`INSERT INTO experiment_launches (job_name, reservation_token, created_at)
							 SELECT ?, ?, ?
							 WHERE NOT EXISTS (SELECT 1 FROM runs WHERE job_name = ?)
							 ON CONFLICT(job_name) DO NOTHING`,
						)
						.run(launch.jobName, admissionToken, Date.now(), launch.jobName);
				})();
			} else if (expectedLaunchToken !== undefined) {
				if (!this.restoreExpectedLaunch(launch.jobName, launchToken)) {
					this.discardExpectedLaunchSnapshot(launchToken);
				}
			}
			throw err;
		}
	}

	/**
	 * Roll back a grouped launch after reservation promotion but before pid binding.
	 * The launch row and restored admission are both guarded by the owner's token.
	 */
	rollbackLaunch(jobName: string, launchToken: string, admissionToken: string): boolean {
		if (launchToken !== admissionToken) return false;
		return this.#db.transaction(() => {
			const deleted = this.#db
				.query(
					"DELETE FROM runs WHERE job_name = ? AND launch_token = ? AND status = 'running' AND pid IS NULL",
				)
				.run(jobName, launchToken);
			if (deleted.changes === 0) {
				const replacementRun = this.#db.query("SELECT 1 FROM runs WHERE job_name = ?").get(jobName);
				const replacementReservation = this.#db
					.query("SELECT 1 FROM experiment_launches WHERE job_name = ?")
					.get(jobName);
				if (replacementRun != null || replacementReservation != null) return false;
				this.#db
					.query(
						"INSERT INTO experiment_launches (job_name, reservation_token, created_at) VALUES (?, ?, ?)",
					)
					.run(jobName, admissionToken, Date.now());
				return true;
			}
			this.#db.query("DELETE FROM trials WHERE job_name = ?").run(jobName);
			this.#db
				.query(
					`INSERT INTO experiment_launches (job_name, reservation_token, created_at)
					 VALUES (?, ?, ?)
					 ON CONFLICT(job_name) DO NOTHING`,
				)
				.run(jobName, admissionToken, Date.now());
			return true;

		})();
	}
	/** Restore a resume row after a pre-bind spawn failure. */
	restoreExpectedLaunch(jobName: string, launchToken: string): boolean {
		const snapshot = this.#expectedLaunchSnapshots.get(launchToken);
		if (!snapshot || snapshot.jobName !== jobName) return false;
		const result = this.#db
			.query(
				"UPDATE runs SET status = ?, pid = ?, launch_token = ?, exit_code = ?, finished_at = ? WHERE job_name = ? AND launch_token = ?",
			)
			.run(snapshot.status, snapshot.pid, snapshot.launchToken, snapshot.exitCode, snapshot.finishedAt, jobName, launchToken);
		this.#expectedLaunchSnapshots.delete(launchToken);
		return result.changes > 0;
	}


	/** Drop a resume snapshot once its launch attempt is no longer recoverable. */
	discardExpectedLaunchSnapshot(launchToken: string): void {
		this.#expectedLaunchSnapshots.delete(launchToken);
	}

	/** Bind a spawned process to its still-current launch reservation. */
	bindLaunchPid(jobName: string, launchToken: string, pid: number): boolean {
		const result = this.#db
			.query("UPDATE runs SET pid = ? WHERE job_name = ? AND launch_token = ? AND status = 'running'")
			.run(pid, jobName, launchToken);
		return result.changes > 0;
	}

	/** Upsert experiment metadata while preserving omitted fields. */
	/** Atomically reserve a grouped launch before its child process is spawned. */
	admitExperimentLaunch(admission: {
		jobName: string;
		goal?: string;
		maxRuns?: number | null;
		maxArms?: number | null;
	}): string {
		if (!admission.jobName) throw new Error("jobName must be non-empty");
		validateExperimentLimit("maxRuns", admission.maxRuns);
		validateExperimentLimit("maxArms", admission.maxArms);
		const reservationToken = crypto.randomUUID();
		const id = experimentIdOf(admission.jobName);
		const tx = this.#db.transaction(() => {
			const existing = this.#db.query(
				"SELECT goal, max_runs, max_arms, closure_verdict, closed_at FROM experiments WHERE id = ?",
			).get(id) as {
				goal: string;
				max_runs: number | null;
				max_arms: number | null;
				closure_verdict: string | null;
				closed_at: number | null;
			} | null;
			if (existing && (existing.closure_verdict != null || existing.closed_at != null)) {
				throw new Error("experiment is closed");
			}
			const hasRun = this.#db.query("SELECT 1 FROM runs WHERE job_name = ?").get(admission.jobName) != null;
			if (hasRun) throw new Error(`run ${admission.jobName} already exists`);
			validateExperimentLimit("maxRuns", existing?.max_runs);
			validateExperimentLimit("maxArms", existing?.max_arms);
			const hasReservation =
				this.#db.query("SELECT 1 FROM experiment_launches WHERE job_name = ?").get(admission.jobName) != null;
			if (hasReservation) throw new Error("launch already reserved");
			const runNames = this.#db.query("SELECT job_name FROM runs").all() as Array<{ job_name: string }>;
			const reservationNames = this.#db
				.query("SELECT job_name FROM experiment_launches")
				.all() as Array<{ job_name: string }>;
			const runCount = runNames.filter(r => experimentIdOf(r.job_name) === id).length;
			const reservationCount = reservationNames.filter(r => experimentIdOf(r.job_name) === id).length;
			const groupedCount = runCount + reservationCount;
			const occupiedArms = new Set(
				[...runNames, ...reservationNames]
					.filter(name => experimentIdOf(name.job_name) === id)
					.map(name => canonicalArmOf(name.job_name)),
			);
			const maxRuns =
				existing?.max_runs != null
					? existing.max_runs
					: (admission.maxRuns !== undefined ? admission.maxRuns : null);
			const maxArms =
				existing?.max_arms != null
					? existing.max_arms
					: (admission.maxArms !== undefined ? admission.maxArms : null);
			if (groupedCount > 0 && admission.maxRuns != null && admission.maxRuns !== (existing?.max_runs ?? null)) {
				throw new Error("maxRuns cannot change after grouped launches exist");
			}
			if (groupedCount > 0 && admission.maxArms != null && admission.maxArms !== (existing?.max_arms ?? null)) {
				throw new Error("maxArms cannot change after grouped launches exist");
			}
			if (maxArms !== null && !occupiedArms.has(canonicalArmOf(admission.jobName)) && occupiedArms.size >= maxArms) {
				throw new Error("maxArms limit reached");
			}
			if (maxRuns !== null && groupedCount >= maxRuns) throw new Error("maxRuns limit reached");
			const goal = admission.goal ?? existing?.goal ?? "";
			this.#db
				.query(
					`INSERT INTO experiments
					 (id, goal, updated_at, max_runs, max_arms, closure_verdict, closed_at)
					 VALUES (?, ?, ?, ?, ?, NULL, NULL)
					 ON CONFLICT(id) DO UPDATE SET
						goal = excluded.goal,
						updated_at = excluded.updated_at,
						max_runs = excluded.max_runs,
						max_arms = excluded.max_arms`,
				)
				.run(id, goal, Date.now(), maxRuns, maxArms);
			this.#db
				.query(
					"INSERT INTO experiment_launches (job_name, reservation_token, created_at) VALUES (?, ?, ?) ON CONFLICT(job_name) DO NOTHING",
				)
				.run(admission.jobName, reservationToken, Date.now());
		});
		tx();
		return reservationToken;
	}

	/** Release a pre-spawn launch reservation. */
	releaseExperimentLaunch(jobName: string, reservationToken?: string): boolean {
		const result =
			reservationToken === undefined
				? this.#db.query("DELETE FROM experiment_launches WHERE job_name = ?").run(jobName)
				: this.#db
						.query("DELETE FROM experiment_launches WHERE job_name = ? AND reservation_token = ?")
						.run(jobName, reservationToken);
		return result.changes > 0;
	}

	/** Check whether a reservation is still owned by the supplied token. */
	hasExperimentLaunch(jobName: string, reservationToken: string): boolean {
		return (
			this.#db
				.query("SELECT 1 FROM experiment_launches WHERE job_name = ? AND reservation_token = ?")
				.get(jobName, reservationToken) != null
		);
	}

	setExperimentMeta(id: string, update: ExperimentMetaUpdate): void {
		validateExperimentLimit("maxRuns", update.maxRuns);
		validateExperimentLimit("maxArms", update.maxArms);
		const tx = this.#db.transaction(() => {
			const existing = this.#db.query(
				"SELECT goal, max_runs, max_arms, closure_verdict, closed_at FROM experiments WHERE id = ?",
			).get(id) as {
				goal: string;
				max_runs: number | null;
				max_arms: number | null;
				closure_verdict: string | null;
				closed_at: number | null;
			} | null;
			if (existing && (existing.closure_verdict != null || existing.closed_at != null)) {
				throw new Error("experiment is closed");
			}
			const goal = update.goal ?? existing?.goal ?? "";
			const maxRuns = update.maxRuns !== undefined ? update.maxRuns : (existing?.max_runs ?? null);
			const maxArms = update.maxArms !== undefined ? update.maxArms : (existing?.max_arms ?? null);
			this.#db
				.query(
					`INSERT INTO experiments
					 (id, goal, updated_at, max_runs, max_arms, closure_verdict, closed_at)
					 VALUES (?, ?, ?, ?, ?, NULL, NULL)
					 ON CONFLICT(id) DO UPDATE SET
						goal = excluded.goal,
						updated_at = excluded.updated_at,
						max_runs = excluded.max_runs,
						max_arms = excluded.max_arms`,
				)
				.run(id, goal, Date.now(), maxRuns, maxArms);
		});
		tx();
	}

	/** Upsert the experiment's stated goal. */
	setExperimentGoal(id: string, goal: string): void {
		this.setExperimentMeta(id, { goal });
	}

	/** Persist a non-empty measured verdict and close an experiment. */
	closeExperiment(id: string, verdict: string, closedAt = Date.now()): boolean {
		const measuredVerdict = validateExperimentVerdict(verdict);
		if (!Number.isSafeInteger(closedAt) || closedAt < 0) {
			throw new Error("closedAt must be a non-negative safe integer");
		}
		const tx = this.#db.transaction(() => {
			const existing = this.#db.query(
				"SELECT goal, max_runs, max_arms, closure_verdict, closed_at FROM experiments WHERE id = ?",
			).get(id) as {
				goal: string;
				max_runs: number | null;
				max_arms: number | null;
				closure_verdict: string | null;
				closed_at: number | null;
			} | null;
			if (existing && (existing.closure_verdict != null || existing.closed_at != null)) return false;
			const liveRuns = this.#db.query("SELECT job_name FROM runs WHERE status = 'running' AND pid IS NOT NULL").all() as Array<{
				job_name: string;
			}>;
			if (liveRuns.some(run => experimentIdOf(run.job_name) === id)) return false;
			const result = this.#db
				.query(
					`INSERT INTO experiments
					 (id, goal, updated_at, max_runs, max_arms, closure_verdict, closed_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(id) DO UPDATE SET
						updated_at = excluded.updated_at,
						closure_verdict = excluded.closure_verdict,
						closed_at = excluded.closed_at
					 WHERE experiments.closure_verdict IS NULL AND experiments.closed_at IS NULL`,
				)
				.run(
					id,
					existing?.goal ?? "",
					Date.now(),
					existing?.max_runs ?? null,
					existing?.max_arms ?? null,
					measuredVerdict,
					closedAt,
				);
			return result.changes > 0;
		});
		return tx();
	}

	/** Stored experiment metadata, or null when the id was never registered. */
	getExperimentMeta(id: string): ExperimentMeta | null {
		const row = this.#db.query(
			"SELECT id, goal, updated_at, max_runs, max_arms, closure_verdict, closed_at FROM experiments WHERE id = ?",
		).get(id) as {
			id: string;
			goal: string;
			updated_at: number;
			max_runs: number | null;
			max_arms: number | null;
			closure_verdict: string | null;
			closed_at: number | null;
		} | null;
		return row ? rowToExperimentMeta(row) : null;
	}

	/** Every registered experiment row, newest first. */
	listExperimentMeta(): ExperimentMeta[] {
		const rows = this.#db
			.query("SELECT id, goal, updated_at, max_runs, max_arms, closure_verdict, closed_at FROM experiments ORDER BY updated_at DESC")
			.all() as Array<{
			id: string;
			goal: string;
			updated_at: number;
			max_runs: number | null;
			max_arms: number | null;
			closure_verdict: string | null;
			closed_at: number | null;
		}>;
		return rows.map(rowToExperimentMeta);
	}

	/** Drop the experiment metadata row (run rows are deleted separately via deleteRun). */
	deleteExperimentMeta(id: string): void {
		this.#db.query("DELETE FROM experiments WHERE id = ?").run(id);
	}

	/** Delete a run row and its trials; returns false when the run is unknown. */
	deleteRun(jobName: string): boolean {
		if (!this.getRun(jobName)) return false;
		this.#db.query("DELETE FROM trials WHERE job_name = ?").run(jobName);
		this.#db.query("DELETE FROM runs WHERE job_name = ?").run(jobName);
		return true;
	}

	/** Set role/note/label metadata on an existing run row. */
	setRunMeta(jobName: string, meta: { role?: RunRole; note?: string; label?: string }): boolean {
		const existing = this.getRun(jobName);
		if (!existing) return false;
		this.#db
			.query("UPDATE runs SET role = ?, note = ?, label = ? WHERE job_name = ?")
			.run(meta.role ?? existing.role, meta.note ?? existing.note, meta.label ?? existing.label, jobName);
		return true;
	}

	/** Mark a launched run's terminal state (called when its child process exits). */
	markExit(jobName: string, exitCode: number | null, cancelled = false, launchToken?: string | null): boolean {
		const status: RunStatus = cancelled ? "cancelled" : exitCode === 0 ? "complete" : "failed";
		if (launchToken === undefined) {
			return (
				this.#db
					.query("UPDATE runs SET status = ?, exit_code = ?, finished_at = ?, pid = NULL WHERE job_name = ?")
					.run(status, exitCode, Date.now(), jobName).changes > 0
			);
		}
		if (launchToken === null) {
			return (
				this.#db
					.query(
						"UPDATE runs SET status = ?, exit_code = ?, finished_at = ?, pid = NULL WHERE job_name = ? AND launch_token IS NULL",
					)
					.run(status, exitCode, Date.now(), jobName).changes > 0
			);
		}
		return (
			this.#db
				.query(
					"UPDATE runs SET status = ?, exit_code = ?, finished_at = ?, pid = NULL WHERE job_name = ? AND launch_token = ?",
				)
				.run(status, exitCode, Date.now(), jobName, launchToken).changes > 0
		);
	}

	/**
	 * Discover job dirs on disk that have no run row yet (runs launched by the
	 * CLI or a previous manager instance) and backfill them as historical rows.
	 */
	discover(): number {
		let entries: fs.Dirent[] = [];
		try {
			entries = fs.readdirSync(this.jobsDir, { withFileTypes: true });
		} catch {
			return 0;
		}
		let added = 0;
		for (const e of entries) {
			if (!e.isDirectory() || NON_JOB_DIRS.has(e.name)) continue;
			const hasReservation = () =>
				this.#db.query("SELECT 1 FROM experiment_launches WHERE job_name = ?").get(e.name) !== null;
			if (hasReservation()) continue;
			const jobDir = path.join(this.jobsDir, e.name);
			let isEmpty: boolean;
			try {
				isEmpty = fs.readdirSync(jobDir).length === 0;
			} catch (err) {
				if (hasReservation()) continue;
				throw err;
			}
			if (isEmpty) continue;
			let meta: { dataset: string; agent: string; models: string };
			try {
				meta = readHarborConfig(jobDir);
			} catch (err) {
				if (hasReservation()) continue;
				throw err;
			}
			const createdAt = dirCreatedAt(jobDir);
			const result = this.#db
				.query(
					`INSERT INTO runs (job_name, dataset, agent, models, status, created_at)
					 SELECT ?, ?, ?, ?, 'running', ?
					 WHERE NOT EXISTS (SELECT 1 FROM runs WHERE job_name = ?)
					   AND NOT EXISTS (SELECT 1 FROM experiment_launches WHERE job_name = ?)
					 ON CONFLICT(job_name) DO NOTHING`,
				)
				.run(e.name, meta.dataset, meta.agent, meta.models, createdAt, e.name, e.name);
			if (result.changes === 0) continue;
			const insertedRun = this.getRun(e.name);
			this.syncRun(e.name, insertedRun?.launchToken ?? null);
			added++;
		}
		return added;
	}

	/** Re-read a job dir and mirror trial + rollup state into the DB. */
	syncRun(jobName: string, launchToken?: string | null): RunRow | null {
		const row = this.getRun(jobName);
		if (launchToken !== undefined) {
			const matches = launchToken === null ? row?.launchToken === null : row?.launchToken === launchToken;
			if (!row || !matches) return row;
		} else if (!row) {
			return null;
		}
		const jobDir = path.join(this.jobsDir, jobName);
		if (!fs.existsSync(jobDir)) return row;
		const snapshot = readBenchmarkSnapshot(row.benchmark, jobDir);
		const now = Date.now();
		const upsert = this.#db.query(
			`INSERT INTO trials
			 (job_name, name, task, status, reward, cost_usd, duration_ms, detail, trace_path, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(job_name, name) DO UPDATE SET
				status = excluded.status, reward = excluded.reward, cost_usd = excluded.cost_usd,
				duration_ms = excluded.duration_ms, detail = excluded.detail,
				trace_path = excluded.trace_path, updated_at = excluded.updated_at`,
		);
		const tx = this.#db.transaction(() => {
			if (launchToken !== undefined) {
				const current = this.#db
					.query("SELECT launch_token FROM runs WHERE job_name = ?")
					.get(jobName) as { launch_token: string | null } | null;
				if (current?.launch_token !== launchToken) return false;
			}
			// Prune rows whose trial dirs vanished from disk (a resume deletes
			// interrupted trial dirs and re-runs the task under a fresh suffix) —
			// otherwise phantom `running` rows haunt the dashboard forever.
			if (snapshot.traces.length > 0) {
				const names = snapshot.traces.map(t => t.name);
				this.#db
					.query(`DELETE FROM trials WHERE job_name = ? AND name NOT IN (${names.map(() => "?").join(",")})`)
					.run(jobName, ...names);
			}
			for (const trace of snapshot.traces) {
				upsert.run(
					jobName,
					trace.name,
					trace.task,
					trace.status,
					trace.reward,
					trace.costUsd,
					trace.durationMs,
					trace.detail,
					trace.tracePath,
					now,
				);
			}
			if (launchToken === undefined) {
				this.#db
					.query(
						`UPDATE runs SET n_total = ?, done = ?, pass = ?, fail = ?, error = ?, running = ?,
						 cost_usd = ?, tok_in = ?, tok_out = ?, tok_cache = ?, score = ?, metrics_json = ?
						 WHERE job_name = ?`,
					)
					.run(
						snapshot.total,
						snapshot.done,
						snapshot.pass,
						snapshot.fail,
						snapshot.error,
						snapshot.running,
						snapshot.costUsd,
						snapshot.tokIn,
						snapshot.tokOut,
						snapshot.tokCache,
						snapshot.score,
						JSON.stringify(snapshot.metrics),
						jobName,
					);
			} else if (launchToken === null) {
				this.#db
					.query(
						`UPDATE runs SET n_total = ?, done = ?, pass = ?, fail = ?, error = ?, running = ?,
						 cost_usd = ?, tok_in = ?, tok_out = ?, tok_cache = ?, score = ?, metrics_json = ?
						 WHERE job_name = ? AND launch_token IS NULL`,
					)
					.run(
						snapshot.total,
						snapshot.done,
						snapshot.pass,
						snapshot.fail,
						snapshot.error,
						snapshot.running,
						snapshot.costUsd,
						snapshot.tokIn,
						snapshot.tokOut,
						snapshot.tokCache,
						snapshot.score,
						JSON.stringify(snapshot.metrics),
						jobName,
					);
			} else {
				this.#db
					.query(
						`UPDATE runs SET n_total = ?, done = ?, pass = ?, fail = ?, error = ?, running = ?,
						 cost_usd = ?, tok_in = ?, tok_out = ?, tok_cache = ?, score = ?, metrics_json = ?
						 WHERE job_name = ? AND launch_token = ?`,
					)
					.run(
						snapshot.total,
						snapshot.done,
						snapshot.pass,
						snapshot.fail,
						snapshot.error,
						snapshot.running,
						snapshot.costUsd,
						snapshot.tokIn,
						snapshot.tokOut,
						snapshot.tokCache,
						snapshot.score,
						JSON.stringify(snapshot.metrics),
						jobName,
						launchToken,
					);
			}
			// Runs with no owning process (historical dirs, or a runner that died
			// with a previous manager). Infer terminal state from result metadata
			// or directory freshness — an orphaned harbor child may still be
			// running and writing trials, so a fresh dir stays "running".
			if (row.pid === null && row.finishedAt === null && row.status !== "cancelled") {
				const result = row.benchmark === "harbor" ? readJobResult(jobDir) : null;
				let status: RunStatus;
				let finishedAt: number | null = null;
				if (result?.finishedAt != null) {
					status = "complete";
					finishedAt = result.finishedAt;
				} else if (jobDirFresh(jobDir)) {
					status = "running";
				} else {
					status = snapshot.done > 0 && snapshot.done >= snapshot.total ? "complete" : "failed";
					finishedAt = jobDirMtime(jobDir);
				}
				if (status !== row.status) {
					if (launchToken === undefined) {
						this.#db
							.query("UPDATE runs SET status = ?, finished_at = ? WHERE job_name = ?")
							.run(status, finishedAt, jobName);
					} else if (launchToken === null) {
						this.#db
							.query("UPDATE runs SET status = ?, finished_at = ? WHERE job_name = ? AND launch_token IS NULL")
							.run(status, finishedAt, jobName);
					} else {
						this.#db
							.query("UPDATE runs SET status = ?, finished_at = ? WHERE job_name = ? AND launch_token = ?")
							.run(status, finishedAt, jobName, launchToken);
					}
				}
			}
			return true;
		});
		if (!tx()) return this.getRun(jobName);
		return this.getRun(jobName);
	}

	/** Sync every run currently marked running; returns the refreshed rows. */
	syncActive(): RunRow[] {
		const active = this.#db.query("SELECT job_name, launch_token, pid FROM runs WHERE status = 'running'").all() as Array<{
			job_name: string;
			launch_token: string | null;
			pid: number | null;
		}>;
		const out: RunRow[] = [];
		for (const { job_name, launch_token, pid } of active) {
			// A pid-owning run whose runner died without markExit (manager
			// restart) loses its pid here; syncRun's disk inference then decides
			// the real status — the workload may have completed, or may still be
			// running as an orphan.
			if (pid != null && !processAlive(pid)) {
				if (launch_token === null) {
					this.#db.query("UPDATE runs SET pid = NULL WHERE job_name = ? AND launch_token IS NULL").run(job_name);
				} else {
					this.#db
						.query("UPDATE runs SET pid = NULL WHERE job_name = ? AND launch_token = ?")
						.run(job_name, launch_token);
				}
			}
			const synced = this.syncRun(job_name, launch_token);
			if (synced) out.push(synced);
		}
		return out;
	}

	/**
	 * Sync every known run once — startup reconciliation. Rows stamped before a
	 * status-inference change (or by an older manager) self-correct here, since
	 * the periodic ticker only revisits rows already marked running.
	 */
	syncAll(): void {
		const rows = this.#db.query("SELECT job_name, launch_token FROM runs").all() as Array<{
			job_name: string;
			launch_token: string | null;
		}>;
		for (const { job_name, launch_token } of rows) this.syncRun(job_name, launch_token);
	}

	getRun(jobName: string): RunRow | null {
		const r = this.#db.query("SELECT * FROM runs WHERE job_name = ?").get(jobName) as Record<string, unknown> | null;
		return r ? rowToRun(r) : null;
	}

	listRuns(): RunRow[] {
		const rows = this.#db.query("SELECT * FROM runs ORDER BY created_at DESC").all() as Array<
			Record<string, unknown>
		>;
		return rows.map(rowToRun);
	}

	listTraces(jobName: string): TraceRow[] {
		const rows = this.#db.query("SELECT * FROM trials WHERE job_name = ? ORDER BY name").all(jobName) as Array<
			Record<string, unknown>
		>;
		return rows.map(r => ({
			jobName: String(r.job_name),
			name: String(r.name),
			task: String(r.task),
			status: String(r.status),
			reward: r.reward === null ? null : Number(r.reward),
			costUsd: Number(r.cost_usd),
			durationMs: Number(r.duration_ms),
			detail: String(r.detail),
			updatedAt: Number(r.updated_at),
			tracePath: r.trace_path === null ? null : String(r.trace_path),
		}));
	}
}

function rowToExperimentMeta(r: {
	id: string;
	goal: string;
	updated_at: number;
	max_runs: number | null;
	max_arms: number | null;
	closure_verdict: string | null;
	closed_at: number | null;
}): ExperimentMeta {
	return {
		id: r.id,
		goal: r.goal,
		updatedAt: r.updated_at,
		maxRuns: r.max_runs === null ? null : Number(r.max_runs),
		maxArms: r.max_arms === null ? null : Number(r.max_arms),
		closure:
			r.closure_verdict != null || r.closed_at != null
				? { verdict: r.closure_verdict ?? "", closedAt: r.closed_at == null ? 0 : Number(r.closed_at) }
				: null,
	};
}

function rowToRun(r: Record<string, unknown>): RunRow {
	return {
		benchmark: String(r.benchmark) as BenchmarkKind,
		jobName: String(r.job_name),
		dataset: String(r.dataset),
		agent: String(r.agent),
		models: String(r.models),
		prewalk: r.prewalk === null ? null : String(r.prewalk),
		config: JSON.parse(String(r.config_json ?? "{}")),
		role: String(r.role ?? "") as RunRole,
		note: String(r.note ?? ""),
		label: String(r.label ?? ""),
		status: String(r.status) as RunStatus,
		pid: r.pid === null ? null : Number(r.pid),
		launchToken: r.launch_token === null ? null : String(r.launch_token),
		exitCode: r.exit_code === null ? null : Number(r.exit_code),
		createdAt: Number(r.created_at),
		finishedAt: r.finished_at === null ? null : Number(r.finished_at),
		nTotal: Number(r.n_total),
		done: Number(r.done),
		pass: Number(r.pass),
		fail: Number(r.fail),
		error: Number(r.error),
		running: Number(r.running),
		costUsd: Number(r.cost_usd),
		tokIn: Number(r.tok_in),
		tokOut: Number(r.tok_out),
		tokCache: Number(r.tok_cache),
		score: r.score === null ? null : Number(r.score),
		metrics: JSON.parse(String(r.metrics_json ?? "{}")),
	};
}

/** Best-effort launch metadata for historical (CLI-launched) job dirs. */
function readHarborConfig(jobDir: string): { dataset: string; agent: string; models: string } {
	try {
		const raw = JSON.parse(fs.readFileSync(path.join(jobDir, "config.json"), "utf8")) as Record<string, unknown>;
		const dataset =
			typeof raw.dataset === "string"
				? raw.dataset
				: (((raw.datasets as Array<Record<string, unknown>> | undefined)?.[0]?.name as string | undefined) ?? "");
		const agents = raw.agents as Array<Record<string, unknown>> | undefined;
		const agent = (agents?.[0]?.name as string | undefined) ?? "omp";
		const models = (agents?.[0]?.model_name as string | undefined) ?? "";
		return { dataset: String(dataset), agent, models };
	} catch {
		return { dataset: "", agent: "omp", models: "" };
	}
}

function dirCreatedAt(dir: string): number {
	try {
		return Math.round(fs.statSync(dir).birthtimeMs || fs.statSync(dir).mtimeMs);
	} catch {
		return Date.now();
	}
}

/** Stale threshold for foreign runs without a terminal marker. */
const JOB_DIR_STALE_MS = 30 * 60 * 1000;

/** Newest mtime across the job dir and its result.json (cheap freshness probe). */
function jobDirMtime(dir: string): number {
	let newest = 0;
	for (const p of [dir, path.join(dir, "result.json")]) {
		try {
			newest = Math.max(newest, fs.statSync(p).mtimeMs);
		} catch {}
	}
	return Math.round(newest) || Date.now();
}

function jobDirFresh(dir: string): boolean {
	return Date.now() - jobDirMtime(dir) < JOB_DIR_STALE_MS;
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
