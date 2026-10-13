import { Database } from "bun:sqlite";

const MAX_ACTIVE_RECORDS_PER_TOPIC = 32;

export type KnowledgeKind = "decision" | "investigation" | "policy";
export type KnowledgeOrigin = "quoted" | "inferred";
export type KnowledgeSource =
	| { type: "file"; path: string; sha256: string; quote: string }
	| { type: "session"; sessionId: string; entryId: string; path?: string; sha256: string; quote: string };

export interface KnowledgeRecord {
	id: string;
	domain: string;
	topic: string;
	kind: KnowledgeKind;
	origin: KnowledgeOrigin;
	content: string;
	sources: KnowledgeSource[];
	predecessorId: string | null;
	state: "current" | "candidate" | "conflict" | "superseded" | "retracted";
	createdAt: string;
}

export interface KnowledgePublishInput {
	domain: string;
	topic: string;
	kind: KnowledgeKind;
	origin: KnowledgeOrigin;
	content: string;
	sources: readonly KnowledgeSource[];
	expectedCurrentId: string | null;
}

type KnowledgeRow = Omit<KnowledgeRecord, "sources"> & { sources: string };

function validateText(value: unknown, name: string, maxLength: number): asserts value is string {
	if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
		throw new TypeError(`${name} must be nonempty text of at most ${maxLength} characters`);
	}
}

function decodeRecord(row: KnowledgeRow): KnowledgeRecord {
	return { ...row, sources: JSON.parse(row.sources) as KnowledgeSource[] };
}

/** Local reference records only; callers verify sources and decide how to use them. */
export class KnowledgeStore {
	#db: Database;

	/** The schema marks a database as knowledge-owned, including empty or retracted history. */
	static hasSchema(dbPath: string): boolean {
		using db = new Database(dbPath, { readonly: true });
		using query = db.prepare<{ name: string }, []>(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_records'",
		);
		return query.get() !== null;
	}

	constructor(db: Database) {
		this.#db = db;
		db.exec(`
			CREATE TABLE IF NOT EXISTS knowledge_records (
				id TEXT PRIMARY KEY,
				domain TEXT NOT NULL,
				topic TEXT NOT NULL,
				kind TEXT NOT NULL CHECK (kind IN ('decision', 'investigation', 'policy')),
				origin TEXT NOT NULL CHECK (origin IN ('quoted', 'inferred')),
				content TEXT NOT NULL,
				sources TEXT NOT NULL,
				predecessorId TEXT,
				state TEXT NOT NULL CHECK (state IN ('current', 'candidate', 'conflict', 'superseded', 'retracted')),
				createdAt TEXT NOT NULL,
				CHECK (origin != 'inferred' OR state IN ('candidate', 'retracted'))
			);
			CREATE UNIQUE INDEX IF NOT EXISTS knowledge_current
				ON knowledge_records(domain, topic) WHERE state = 'current';
			CREATE INDEX IF NOT EXISTS knowledge_topic ON knowledge_records(domain, topic);
		`);
	}

	/** Synchronous immediate transactions serialize CAS across database connections. */
	publish(input: KnowledgePublishInput): KnowledgeRecord {
		if (input === null || typeof input !== "object") throw new TypeError("publish requires an object");
		validateText(input.domain, "domain", 128);
		validateText(input.topic, "topic", 128);
		validateText(input.content, "content", 4000);
		if (!["decision", "investigation", "policy"].includes(input.kind)) throw new TypeError("Invalid kind");
		if (input.origin !== "quoted" && input.origin !== "inferred") throw new TypeError("Invalid origin");
		if (input.expectedCurrentId !== null) validateText(input.expectedCurrentId, "expectedCurrentId", Infinity);
		if (!Array.isArray(input.sources) || input.sources.length === 0 || input.sources.length > 8) {
			throw new TypeError("Expected 1 to 8 sources");
		}
		for (const source of input.sources) {
			if (source === null || typeof source !== "object") throw new TypeError("Invalid source");
			validateText(source.quote, "quote", 4000);
			if (typeof source.sha256 !== "string" || !/^[a-fA-F0-9]{64}$/.test(source.sha256)) {
				throw new TypeError("Invalid source sha256");
			}
			if (source.type === "file") {
				validateText(source.path, "path", Infinity);
			} else if (source.type === "session") {
				validateText(source.sessionId, "sessionId", Infinity);
				validateText(source.entryId, "entryId", Infinity);
				if (source.path !== undefined) validateText(source.path, "path", Infinity);
			} else {
				throw new TypeError("Invalid source type");
			}
		}
		const sources = JSON.stringify(input.sources);
		return this.#db
			.transaction(() => {
				using currentQuery = this.#db.prepare<{ id: string }, [string, string]>(
					"SELECT id FROM knowledge_records WHERE domain = ? AND topic = ? AND state = 'current'",
				);
				const currentId = currentQuery.get(input.domain, input.topic)?.id ?? null;
				let state: KnowledgeRecord["state"];
				if (input.origin === "inferred") state = "candidate";
				else if (input.expectedCurrentId === currentId) state = "current";
				else state = "conflict";
				if (state !== "current" || currentId === null) {
					using countQuery = this.#db.prepare<{ total: number }, [string, string]>(
						`SELECT COUNT(*) AS total FROM knowledge_records
					WHERE domain = ? AND topic = ? AND state IN ('current', 'candidate', 'conflict')`,
					);
					const activeCount = countQuery.get(input.domain, input.topic)!.total;
					if (activeCount >= MAX_ACTIVE_RECORDS_PER_TOPIC) {
						throw new RangeError(
							`Knowledge active record limit (${MAX_ACTIVE_RECORDS_PER_TOPIC}) reached for ${JSON.stringify(input.domain)}/${JSON.stringify(input.topic)}; retract an active record before publishing`,
						);
					}
				}
				if (state === "current" && currentId !== null) {
					using supersede = this.#db.prepare("UPDATE knowledge_records SET state = 'superseded' WHERE id = ?");
					supersede.run(currentId);
				}
				const record: KnowledgeRecord = {
					id: crypto.randomUUID(),
					domain: input.domain,
					topic: input.topic,
					kind: input.kind,
					origin: input.origin,
					content: input.content,
					sources: JSON.parse(sources) as KnowledgeSource[],
					predecessorId: input.expectedCurrentId,
					state,
					createdAt: new Date().toISOString(),
				};
				using insert = this.#db.prepare(`INSERT INTO knowledge_records
				(id, domain, topic, kind, origin, content, sources, predecessorId, state, createdAt)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
				insert.run(
					record.id,
					record.domain,
					record.topic,
					record.kind,
					record.origin,
					record.content,
					sources,
					record.predecessorId,
					record.state,
					record.createdAt,
				);
				return record;
			})
			.immediate();
	}

	list(domain: string, topics: readonly string[]): KnowledgeRecord[] {
		validateText(domain, "domain", 128);
		if (!Array.isArray(topics) || topics.length > 16) throw new TypeError("Expected at most 16 topics");
		for (const topic of topics) validateText(topic, "topic", 128);
		if (topics.length === 0) return [];
		using query = this.#db.prepare<KnowledgeRow, string[]>(`SELECT * FROM knowledge_records
			WHERE domain = ? AND topic IN (${topics.map(() => "?").join(",")})
			AND state IN ('current', 'candidate', 'conflict') ORDER BY topic, rowid`);
		return query.all(domain, ...topics).map(decodeRecord);
	}

	history(domain: string, topic: string): KnowledgeRecord[] {
		validateText(domain, "domain", 128);
		validateText(topic, "topic", 128);
		using query = this.#db.prepare<KnowledgeRow, [string, string]>(
			"SELECT * FROM knowledge_records WHERE domain = ? AND topic = ? ORDER BY rowid",
		);
		return query.all(domain, topic).map(decodeRecord);
	}

	retract(domain: string, id: string): boolean {
		validateText(domain, "domain", 128);
		validateText(id, "id", Infinity);
		using query = this.#db.prepare(
			"UPDATE knowledge_records SET state = 'retracted' WHERE domain = ? AND id = ? AND state != 'retracted'",
		);
		return query.run(domain, id).changes > 0;
	}
}
