import * as path from "node:path";
import type {
	KnowledgeKind,
	KnowledgeOrigin,
	KnowledgeRecord,
	KnowledgeSource,
	Mnemopi,
} from "@oh-my-pi/pi-mnemopi/core";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { redactMemorySecrets } from "../memory-backend/redact";
import type { MemoryPromptPreparation } from "../memory-backend/types";
import knowledgeNotice from "../prompts/system/mnemopi-knowledge.md" with { type: "text" };
import type { SessionManager } from "../session/session-manager";
import {
	cfgMnemopiAutoRetain,
	cfgMnemopiBank,
	cfgMnemopiDbPath,
	cfgMnemopiKnowledgeDomain,
	cfgMnemopiKnowledgeEnabled,
	cfgMnemopiKnowledgeSourcePaths,
	cfgMnemopiKnowledgeTopics,
	cfgMnemopiScoping,
} from "./settings";

export interface KnowledgeConfig {
	domain: string;
	topics: readonly string[];
	sourcePaths: readonly string[];
}

export type KnowledgeSelection =
	| { type: "file"; path: string; quote: string }
	| { type: "session"; entryId?: string; quote: string };

export interface KnowledgePublication {
	topic: string;
	kind: KnowledgeKind;
	origin: KnowledgeOrigin;
	content: string;
	sources: readonly KnowledgeSelection[];
	expectedCurrentId: string | null;
}

type KnowledgeSession = Pick<SessionManager, "getBranchView" | "getSessionId" | "appendCustomEntry">;
const DELIVERY_ENTRY = "mnemopi_knowledge_delivery";
export const KNOWLEDGE_NOTICE_LIMIT = 16_000;
const MAX_SOURCE_BYTES = 1_048_576;

export function loadKnowledgeConfig(settings: Settings): KnowledgeConfig | undefined {
	if (!cfgMnemopiKnowledgeEnabled.get(settings)) return undefined;
	const domain = cfgMnemopiKnowledgeDomain.get(settings);
	const topics = cfgMnemopiKnowledgeTopics.get(settings);
	const sourcePaths = cfgMnemopiKnowledgeSourcePaths.get(settings);
	if (!domain?.trim() || domain.length > 128 || domain !== domain.trim()) {
		throw new Error("Knowledge requires an explicit domain (1-128 characters, no surrounding whitespace).");
	}
	if (
		!Array.isArray(topics) ||
		topics.length === 0 ||
		topics.length > 16 ||
		topics.some(
			topic => typeof topic !== "string" || !topic.trim() || topic.length > 128 || topic !== topic.trim(),
		) ||
		new Set(topics).size !== topics.length
	) {
		throw new Error("Knowledge requires 1-16 unique exact topics (1-128 characters each).");
	}
	if (
		!Array.isArray(sourcePaths) ||
		sourcePaths.length > 16 ||
		sourcePaths.some(
			source => typeof source !== "string" || !path.isAbsolute(source) || path.normalize(source) !== source,
		)
	) {
		throw new Error("Knowledge sourcePaths must contain at most 16 exact normalized absolute paths.");
	}
	if (
		!cfgMnemopiDbPath.get(settings)?.trim() ||
		!cfgMnemopiBank.get(settings)?.trim() ||
		cfgMnemopiScoping.get(settings) !== "global"
	) {
		throw new Error("Knowledge requires an explicit pilot mnemopi.dbPath, bank, and global scoping.");
	}
	if (cfgMnemopiAutoRetain.get(settings)) {
		throw new Error(
			"Knowledge pilot requires mnemopi.autoRetain=false; only explicitly selected evidence may be retained.",
		);
	}
	return { domain, topics: [...topics], sourcePaths: [...sourcePaths] };
}

/** Withdraws prior snapshots when their runtime cannot check currentness. */
export function prepareKnowledgeWithdrawal(
	session: KnowledgeSession,
	signal?: AbortSignal,
): MemoryPromptPreparation | undefined {
	const branch = session.getBranchView();
	const index = branch.findLastIndex(entry => entry.type === "custom" && entry.customType === DELIVERY_ENTRY);
	const previous = branch[index];
	if (!previous || previous.type !== "custom") return undefined;
	const compacted = branch.findLastIndex(entry => entry.type === "compaction") > index;
	if (
		!compacted &&
		typeof previous.data === "object" &&
		previous.data !== null &&
		"withdrawn" in previous.data &&
		previous.data.withdrawn === true
	)
		return undefined;
	return {
		notice: {
			content: prompt.render(knowledgeNotice, {
				snapshot: JSON.stringify({ availability: "unavailable", withdrawn: true }),
			}),
			details: { knowledge: { withdrawn: true } },
		},
		commit: () => {
			const latest = session
				.getBranchView()
				.findLast(entry => entry.type === "custom" && entry.customType === DELIVERY_ENTRY);
			if (signal?.aborted || latest?.id !== previous.id) return false;
			session.appendCustomEntry(DELIVERY_ENTRY, { withdrawn: true });
			return true;
		},
	};
}

/** Owns provenance and staged delivery, not the store's currentness decisions. */
export class MnemopiKnowledge {
	#generation = 0;
	#forceDelivery = false;

	constructor(
		readonly config: KnowledgeConfig,
		readonly store: Mnemopi["knowledge"],
		readonly session: KnowledgeSession,
	) {}

	reset(): void {
		this.#generation++;
		this.#forceDelivery = true;
	}

	async publish(input: KnowledgePublication): Promise<KnowledgeRecord> {
		this.#assertTopic(input.topic);
		const sessionId = this.session.getSessionId();
		if (input.sources.length === 0 || input.sources.length > 8) throw new Error("Select 1-8 evidence sources.");
		if (!input.content.trim() || input.content.length > 4000)
			throw new Error("Knowledge content must be 1-4000 characters.");
		const sources: KnowledgeSource[] = [];
		let origin = input.origin;
		for (const selection of input.sources) {
			if (!selection.quote.trim() || selection.quote.length > 4000)
				throw new Error("Select an exact quote of 1-4000 characters.");
			if (selection.type === "file") {
				const evidence = await this.#fileEvidence(selection.path);
				if (!evidence || !evidence.text.includes(selection.quote))
					throw new Error("File evidence unavailable or quote not found.");
				sources.push({ ...selection, sha256: evidence.sha256 });
			} else {
				if (input.kind === "policy")
					throw new Error("Policy requires configured file evidence, never session evidence.");
				const entryId =
					selection.entryId ??
					this.session
						.getBranchView()
						.findLast(
							entry =>
								entry.type === "message" &&
								entry.message.role === "user" &&
								entry.message.attribution !== "agent" &&
								!entry.message.synthetic,
						)?.id;
				if (!entryId) throw new Error("No real user message exists on the current branch.");
				const evidence = this.#sessionEvidence(entryId);
				if (!evidence || !evidence.text.includes(selection.quote))
					throw new Error("Session quote is not in a selected current-branch message.");
				if (!evidence.isUser && !(evidence.isTool && input.kind === "investigation")) origin = "inferred";
				sources.push({ type: "session", entryId, quote: selection.quote, sessionId, sha256: evidence.sha256 });
			}
		}
		if (origin === "quoted" && !sources.some(source => source.quote === input.content)) {
			throw new Error("Quoted content must equal one selected source quote; summaries must be inferred candidates.");
		}
		if (
			sessionId !== this.session.getSessionId() ||
			sources.some(
				source => source.type === "session" && this.#sessionEvidence(source.entryId)?.sha256 !== source.sha256,
			)
		) {
			throw new Error("Session evidence changed during publication; select current-branch sources again.");
		}
		const serialized = JSON.stringify({ content: input.content, sources });
		if (redactMemorySecrets(serialized) !== serialized) {
			throw new Error("Knowledge evidence contains a possible secret; select a different excerpt.");
		}
		return this.store.publish({ ...input, domain: this.config.domain, origin, sources });
	}

	retract(id: string): boolean {
		const record = this.store.list(this.config.domain, this.config.topics).find(record => record.id === id);
		if (!record) return false;
		return this.store.retract(this.config.domain, id);
	}

	async snapshot(): Promise<string> {
		const records = this.store.list(this.config.domain, this.config.topics);
		const views = [];
		const files = new Map<string, { text: string; sha256: string } | undefined>();
		for (const record of records) {
			const freshness: string[] = [];
			for (const source of record.sources) {
				if (source.type === "file") {
					if (!files.has(source.path)) files.set(source.path, await this.#fileEvidence(source.path));
					const evidence = files.get(source.path);
					freshness.push(
						!evidence
							? "unavailable"
							: evidence.sha256 === source.sha256 && evidence.text.includes(source.quote)
								? "unchanged"
								: "stale",
					);
				} else if (source.sessionId === this.session.getSessionId()) {
					const evidence = this.#sessionEvidence(source.entryId);
					freshness.push(
						evidence?.sha256 === source.sha256 && evidence.text.includes(source.quote)
							? "recorded-session"
							: "unavailable",
					);
				} else {
					freshness.push("recorded-session-not-revalidated");
				}
			}
			const serialized = JSON.stringify(record);
			const hasSecret = redactMemorySecrets(serialized) !== serialized;
			const unavailable =
				hasSecret ||
				freshness.length === 0 ||
				freshness.some(value => value === "stale" || value === "unavailable") ||
				(record.kind === "policy" &&
					(record.origin !== "quoted" || record.sources.some(source => source.type !== "file")));
			views.push({
				id: record.id,
				topic: record.topic,
				kind: record.kind,
				state: record.state,
				origin: record.origin,
				predecessorId: record.predecessorId,
				availability: unavailable ? "unavailable" : "reference-only",
				freshness,
				...(hasSecret
					? {}
					: unavailable
						? {
								sources: record.sources.map(source =>
									source.type === "file"
										? { type: source.type, path: source.path, sha256: source.sha256 }
										: {
												type: source.type,
												sessionId: source.sessionId,
												entryId: source.entryId,
												sha256: source.sha256,
											},
								),
							}
						: { content: record.content, sources: record.sources }),
			});
		}
		const snapshot = JSON.stringify({
			domain: this.config.domain,
			topics: this.config.topics,
			records: views,
		}).replaceAll("<", "\\u003c");
		if (snapshot.length <= KNOWLEDGE_NOTICE_LIMIT - 2000) return snapshot;
		const handles = [];
		let handleChars = 0;
		for (const record of records.slice(0, 32)) {
			const handle = { id: record.id, topic: record.topic, state: record.state };
			handleChars += JSON.stringify(handle).replaceAll("<", "\\u003c").length + 1;
			if (handleChars > KNOWLEDGE_NOTICE_LIMIT / 2) break;
			handles.push(handle);
		}
		return JSON.stringify({
			domain: this.config.domain,
			availability: "unavailable",
			overflow: true,
			message:
				"Snapshot exceeds notice budget. No knowledge or policy may be relied on. Select fewer topics or retract records explicitly.",
			counts: {
				current: records.filter(record => record.state === "current").length,
				candidate: records.filter(record => record.state === "candidate").length,
				conflict: records.filter(record => record.state === "conflict").length,
			},
			handles,
			omittedCount: records.length - handles.length,
			sha256: new Bun.CryptoHasher("sha256").update(snapshot).digest("hex"),
		}).replaceAll("<", "\\u003c");
	}

	async prepare(signal?: AbortSignal): Promise<MemoryPromptPreparation> {
		const generation = ++this.#generation;
		let snapshot: string;
		try {
			snapshot = await this.snapshot();
		} catch (error) {
			// Delivery must revoke earlier approvals when freshness cannot be established.
			logger.warn("Mnemopi knowledge validation failed", { error: String(error) });
			snapshot = JSON.stringify({ availability: "unavailable", validationFailed: true });
		}
		const content = prompt.render(knowledgeNotice, { snapshot });
		const sha256 = new Bun.CryptoHasher("sha256").update(content).digest("hex");
		const scope = JSON.stringify(this.config);
		let previous: unknown;
		const branch = this.session.getBranchView();
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index];
			if (entry.type === "reset_boundary" || entry.type === "compaction") break;
			if (entry.type !== "custom" || entry.customType !== DELIVERY_ENTRY) continue;
			const data = entry.data;
			if (typeof data === "object" && data !== null && "scope" in data && data.scope === scope && "sha256" in data) {
				previous = data.sha256;
			}
			break;
		}
		const changed = this.#forceDelivery || previous !== sha256;
		return {
			notice: changed ? { content, details: { knowledge: { scope, sha256 } } } : undefined,
			commit: () => {
				if (generation !== this.#generation || signal?.aborted) return false;
				this.#generation++;
				if (changed) this.session.appendCustomEntry(DELIVERY_ENTRY, { scope, sha256 });
				this.#forceDelivery = false;
				return true;
			},
		};
	}

	#assertTopic(topic: string): void {
		if (!this.config.topics.includes(topic))
			throw new Error("Topic is not selected in this session's knowledge configuration.");
	}

	#sessionEvidence(entryId: string): { text: string; sha256: string; isUser: boolean; isTool: boolean } | undefined {
		const entry = this.session.getBranchView().find(entry => entry.id === entryId);
		if (entry?.type !== "message") return undefined;
		const message = entry.message;
		if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") return undefined;
		const text =
			typeof message.content === "string"
				? message.content
				: message.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");
		return {
			text,
			sha256: new Bun.CryptoHasher("sha256")
				.update(
					JSON.stringify({
						role: message.role,
						attribution: message.role === "assistant" ? "agent" : message.attribution,
						synthetic: message.role === "user" ? message.synthetic : undefined,
						text,
					}),
				)
				.digest("hex"),
			isUser: message.role === "user" && message.attribution !== "agent" && !message.synthetic,
			isTool: message.role === "toolResult",
		};
	}

	async #fileEvidence(sourcePath: string): Promise<{ text: string; sha256: string } | undefined> {
		if (!this.config.sourcePaths.includes(sourcePath)) return undefined;
		try {
			const file = Bun.file(sourcePath);
			if (file.size > MAX_SOURCE_BYTES) return undefined;
			const bytes = await file.arrayBuffer();
			if (bytes.byteLength > MAX_SOURCE_BYTES) return undefined;
			return {
				text: Buffer.from(bytes).toString("utf8"),
				sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
			};
		} catch (error) {
			if (
				typeof error === "object" &&
				error !== null &&
				"code" in error &&
				["ENOENT", "EACCES", "EPERM", "EISDIR", "ENOTDIR"].includes(String(error.code))
			)
				return undefined;
			throw error;
		}
	}
}
