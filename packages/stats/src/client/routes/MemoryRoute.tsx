import { Crosshair, RotateCw, Search, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { getMemoryGraph, searchMemory } from "../api";
import { formatInteger, formatRelativeTime } from "../data/formatters";
import { type QueryResult, useQuery } from "../data/query";
import { rangeMeta } from "../data/range";
import type {
	MemoryFactType,
	MemoryGraphEntity,
	MemoryGraphFact,
	MemoryGraphNode,
	MemoryGraphResponse,
	MemorySearchResponse,
	TimeRange,
} from "../types";
import {
	Badge,
	Card,
	ChartSkeleton,
	EmptyState,
	PageHeader,
	QueryView,
	Segmented,
	type SegmentedOption,
	Stat,
	StatGrid,
} from "../ui";
import { type LayoutPoint, MemoryGalaxy } from "./MemoryGalaxy";
import {
	ENTITY_COLOR,
	FACT_COLOR,
	FACT_LABEL,
	FOCUS_FACT_LIMIT,
	type MemoryColorMode,
	matchEntities,
	memoryPaint,
	memoryView,
	newestFirst,
	RECENCY_BUCKETS,
} from "./memory-view";
import "./memory.css";

export interface MemoryRouteProps {
	active: boolean;
	range: TimeRange;
}

const SKELETON_HEIGHT = 720;
const MIN_MENTION_OPTIONS = [1, 2, 3, 5, 10];
/** Half the bank's entities are named once and 85% at most five times; three keeps the hubs readable. */
const DEFAULT_MIN_MENTIONS = 3;
const SUGGESTION_LIMIT = 8;
/** Memories listed per type in an entity's panel. */
const PANEL_FACTS_PER_TYPE = 20;
const CO_MENTION_LIMIT = 12;
/** Panel order: consolidated observations say the most per line. */
const PANEL_FACT_TYPES: readonly MemoryFactType[] = ["observation", "world", "experience"];
const COLOR_OPTIONS: readonly SegmentedOption<MemoryColorMode>[] = [
	{ value: "type", label: "Type" },
	{ value: "recency", label: "Recency" },
];

export function MemoryRoute({ active, range }: MemoryRouteProps) {
	// Memory lives in Hindsight, not the stats DB: stats ingest bumps must not refetch and re-lay it out.
	const query = useQuery(["memory"], ({ signal }) => getMemoryGraph(signal), { enabled: active, live: false });
	return (
		<div className="page">
			<PageHeader
				title="Memory"
				description="Everything omp has learned from your sessions: facts, experiences, consolidated observations, and the entities they connect."
				actions={
					<button
						type="button"
						className="btn"
						data-size="sm"
						data-variant="ghost"
						disabled={query.refreshing}
						onClick={query.refetch}
					>
						<RotateCw size={13} /> {query.refreshing ? "Refreshing" : "Refresh"}
					</button>
				}
			/>
			<QueryView
				query={query}
				skeleton={<ChartSkeleton height={SKELETON_HEIGHT} />}
				isEmpty={(response: MemoryGraphResponse) => response.nodes.length === 0}
				empty={
					<EmptyState
						title="No memories yet"
						hint="Set memory.backend to hindsight with hindsight.apiUrl; sessions are captured as you work."
					/>
				}
			>
				{response => <MemoryExplorer graph={response} range={range} />}
			</QueryView>
		</div>
	);
}

function MemoryExplorer({ graph, range }: { graph: MemoryGraphResponse; range: TimeRange }) {
	const [project, setProject] = useState<string | null>(null);
	const [hiddenTypes, setHiddenTypes] = useState<ReadonlySet<MemoryFactType>>(new Set());
	const [minMentions, setMinMentions] = useState(DEFAULT_MIN_MENTIONS);
	const [colorMode, setColorMode] = useState<MemoryColorMode>("type");
	const [focusId, setFocusId] = useState<string | null>(null);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [searchQuery, setSearchQuery] = useState<string | null>(null);
	/** Settled positions for the whole graph and the current focus, kept apart so leaving a focus restores the galaxy. */
	const layouts = useRef({
		whole: new Map<string, LayoutPoint>(),
		focusId: null as string | null,
		focus: new Map<string, LayoutPoint>(),
	});
	if (focusId !== null && layouts.current.focusId !== focusId)
		layouts.current = { ...layouts.current, focusId, focus: new Map() };
	const layout = focusId === null ? layouts.current.whole : layouts.current.focus;

	const { spanMs, windowLabel } = rangeMeta(range);
	// Anchored when the range or data changes, never per render: a new cutoff re-filters and re-lays out.
	const since = useMemo(() => (spanMs === null ? null : Date.now() - spanMs), [spanMs, graph]);
	const view = useMemo(
		() => memoryView(graph, { hiddenTypes, project, since, minMentions, focusId }),
		[graph, hiddenTypes, project, since, minMentions, focusId],
	);
	const paint = useMemo(() => memoryPaint(view, colorMode, Date.now()), [view, colorMode]);

	const search = useQuery(["memory-search", searchQuery], ({ signal }) => searchMemory(searchQuery ?? "", signal), {
		enabled: searchQuery !== null,
		live: false,
	});
	const hits = searchQuery !== null && search.data && !search.stale ? search.data.results : null;
	const highlight = useMemo(() => {
		if (!hits) return null;
		const ids = new Set(hits.map(hit => hit.id));
		for (const edge of graph.edges) if (edge.type === "mentions" && ids.has(edge.source)) ids.add(edge.target);
		return ids;
	}, [graph, hits]);

	const projects = useMemo(() => {
		const counts = new Map<string, number>();
		for (const node of graph.nodes)
			if (node.type === "fact")
				for (const tag of node.tags) if (tag.startsWith("project:")) counts.set(tag, (counts.get(tag) ?? 0) + 1);
		return [...counts].sort((a, b) => b[1] - a[1]);
	}, [graph]);
	const entities = useMemo(
		() => graph.nodes.filter((node): node is MemoryGraphEntity => node.type === "entity"),
		[graph],
	);
	const nodeById = useMemo(() => new Map(graph.nodes.map(node => [node.id, node])), [graph]);

	const counts = { world: 0, experience: 0, observation: 0 };
	for (const node of graph.nodes) if (node.type === "fact") counts[node.factType]++;
	const loadedFacts = counts.world + counts.experience + counts.observation;
	let drawnFacts = 0;
	for (const node of view.nodes) if (node.type === "fact") drawnFacts++;
	const drawnEntities = view.nodes.length - drawnFacts;
	const selected = selectedId ? nodeById.get(selectedId) : undefined;
	const focused = focusId ? nodeById.get(focusId) : undefined;
	const isPanelOpen = selected !== undefined || searchQuery !== null;

	const focusEntity = (id: string) => {
		setFocusId(id);
		setSelectedId(id);
		setSearchQuery(null);
	};
	const runSearch = (query: string) => {
		setSearchQuery(query);
		setSelectedId(null);
	};
	// Closing a memory opened from search results returns to the results.
	const closePanel = () => (selectedId !== null ? setSelectedId(null) : setSearchQuery(null));
	const toggleType = (factType: MemoryFactType) =>
		setHiddenTypes(previous => {
			const next = new Set(previous);
			if (!next.delete(factType)) next.add(factType);
			return next;
		});

	// Escape unwinds one step: the open memory, then the search, then the focus.
	useEffect(() => {
		const onKey = (event: globalThis.KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented) return;
			if (selectedId !== null) setSelectedId(null);
			else if (searchQuery !== null) setSearchQuery(null);
			else setFocusId(null);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [selectedId, searchQuery]);

	let panelTitle = "";
	let panelSubtitle = "";
	if (selected?.type === "entity") {
		panelTitle = selected.name;
		panelSubtitle = `entity · ${formatInteger(selected.mentions)} loaded memories`;
	} else if (selected) {
		panelTitle = FACT_LABEL[selected.factType];
		panelSubtitle = selected.learnedAt ? `learned ${formatRelativeTime(Date.parse(selected.learnedAt))}` : "";
	} else if (searchQuery !== null) {
		panelTitle = `“${searchQuery}”`;
		panelSubtitle = hits ? `${formatInteger(hits.length)} memories, best match first` : "searching";
	}

	return (
		<>
			<StatGrid min={150}>
				<Stat
					label="Memories"
					value={formatInteger(graph.totalMemories)}
					hint={
						graph.totalMemories > loadedFacts
							? `newest ${formatInteger(graph.limit)} loaded`
							: (graph.bankId ?? undefined)
					}
				/>
				<Stat label="World facts" value={formatInteger(counts.world)} />
				<Stat label="Experiences" value={formatInteger(counts.experience)} />
				<Stat label="Observations" value={formatInteger(counts.observation)} hint="consolidated" />
				<Stat label="Entities" value={formatInteger(entities.length)} />
				<Stat label="Links" value={formatInteger(graph.edges.length)} />
			</StatGrid>
			<Card
				flush
				title={graph.bankId ?? "memory"}
				description={
					focused?.type === "entity" ? (
						<span className="memory-status">
							<Crosshair size={13} />
							<span>
								Focused on <strong>{focused.name}</strong>: newest{" "}
								{formatInteger(Math.min(view.focusMentions, FOCUS_FACT_LIMIT))} of{" "}
								{formatInteger(view.focusMentions)} memories from {windowLabel}
							</span>
							<button type="button" className="memory-link" onClick={() => setFocusId(null)}>
								Whole graph
							</button>
						</span>
					) : (
						`${formatInteger(drawnFacts)} of ${formatInteger(view.passing)} loaded memories from ${windowLabel}, around ${formatInteger(drawnEntities)} entities. Scroll to zoom, drag to pan, click for details.`
					)
				}
				actions={
					<div className="memory-toolbar">
						<MemorySearch entities={entities} onFocusEntity={focusEntity} onSearch={runSearch} />
						<select
							className="input"
							value={minMentions}
							onChange={event => setMinMentions(Number(event.target.value))}
							aria-label="Minimum entity mentions"
						>
							{MIN_MENTION_OPTIONS.map(option => (
								<option key={option} value={option}>
									{option === 1 ? "All entities" : `Entities named ${option}+ times`}
								</option>
							))}
						</select>
						{projects.length > 1 && (
							<select
								className="input"
								value={project ?? ""}
								onChange={event => setProject(event.target.value || null)}
								aria-label="Project"
							>
								<option value="">All projects</option>
								{projects.map(([tag, count]) => (
									<option key={tag} value={tag}>
										{tag.slice("project:".length)} ({count})
									</option>
								))}
							</select>
						)}
						<Segmented
							size="sm"
							options={COLOR_OPTIONS}
							value={colorMode}
							onChange={setColorMode}
							aria-label="Color by"
						/>
					</div>
				}
				footer={
					<div className="memory-legend">
						{(Object.keys(FACT_COLOR) as MemoryFactType[]).map(factType => (
							<button
								key={factType}
								type="button"
								className="memory-chip"
								data-hidden={hiddenTypes.has(factType)}
								onClick={() => toggleType(factType)}
							>
								{colorMode === "type" && (
									<span className="memory-swatch" style={{ background: FACT_COLOR[factType] }} />
								)}
								{FACT_LABEL[factType]}
							</button>
						))}
						{colorMode === "type" ? (
							<span className="memory-chip" data-static="true">
								<span className="memory-swatch" style={{ background: ENTITY_COLOR }} />
								Entity (size = mentions)
							</span>
						) : (
							RECENCY_BUCKETS.map(bucket => (
								<span key={bucket.label} className="memory-chip" data-static="true">
									<span className="memory-swatch" style={{ background: bucket.color }} />
									{bucket.label}
								</span>
							))
						)}
					</div>
				}
			>
				<div className="memory-stage" data-panel={isPanelOpen}>
					{view.nodes.length === 0 ? (
						<EmptyState
							title="Nothing matches"
							hint="Widen the time range, lower the mention threshold, or show more memory types."
						/>
					) : (
						<MemoryGalaxy
							nodes={view.nodes}
							edges={view.edges}
							degree={view.degree}
							paint={paint}
							layout={layout}
							// The focused entity is the whole view already; highlighting its links would dim its neighbors.
							selectedId={selectedId === focusId ? null : selectedId}
							highlight={highlight}
							onSelect={setSelectedId}
						/>
					)}
					{isPanelOpen && (
						<aside className="memory-panel">
							<header className="memory-panel-header">
								<div className="memory-panel-titles">
									<h2>{panelTitle}</h2>
									{panelSubtitle && <p>{panelSubtitle}</p>}
								</div>
								<button
									type="button"
									className="btn"
									data-size="sm"
									data-variant="ghost"
									aria-label={selected && searchQuery !== null ? "Back to results" : "Close"}
									onClick={closePanel}
								>
									<X size={14} />
								</button>
							</header>
							<div className="memory-panel-body">
								{selected?.type === "entity" ? (
									<EntityDetails
										entity={selected}
										graph={graph}
										nodeById={nodeById}
										isFocused={focusId === selected.id}
										onSelect={setSelectedId}
										onFocus={focusEntity}
									/>
								) : selected ? (
									<FactDetails fact={selected} graph={graph} nodeById={nodeById} onSelect={setSelectedId} />
								) : (
									<SearchResults search={search} nodeById={nodeById} onSelect={setSelectedId} />
								)}
							</div>
						</aside>
					)}
				</div>
			</Card>
		</>
	);
}

/** Entity names as you type; Enter without a picked name searches memory text by meaning. */
function MemorySearch({
	entities,
	onFocusEntity,
	onSearch,
}: {
	entities: readonly MemoryGraphEntity[];
	onFocusEntity: (id: string) => void;
	onSearch: (query: string) => void;
}) {
	const [text, setText] = useState("");
	const [isOpen, setIsOpen] = useState(false);
	/** Highlighted row: an entity index, `matches.length` for the memory search row, or -1 for none. */
	const [active, setActive] = useState(-1);
	const matches = useMemo(() => matchEntities(entities, text, SUGGESTION_LIMIT), [entities, text]);
	const query = text.trim();

	const pick = (row: number) => {
		if (row >= 0 && row < matches.length) onFocusEntity(matches[row].id);
		else if (query) onSearch(query);
		setIsOpen(false);
		setActive(-1);
	};
	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			setIsOpen(true);
			setActive(row => (event.key === "ArrowDown" ? Math.min(row + 1, matches.length) : Math.max(row - 1, -1)));
		} else if (event.key === "Enter") {
			event.preventDefault();
			pick(active === -1 ? matches.length : active);
		} else if (event.key === "Escape" && (isOpen || text)) {
			event.preventDefault();
			if (isOpen) setIsOpen(false);
			else setText("");
		}
	};

	return (
		<div className="memory-search">
			<label className="search">
				<Search size={14} />
				<input
					className="input"
					type="search"
					value={text}
					placeholder="Find an entity or search memories"
					aria-label="Find an entity or search memories"
					onChange={event => {
						setText(event.target.value);
						setIsOpen(true);
						setActive(-1);
					}}
					onFocus={() => setIsOpen(true)}
					onBlur={() => setIsOpen(false)}
					onKeyDown={onKeyDown}
				/>
			</label>
			{isOpen && query && (
				<div className="memory-suggestions" role="listbox">
					{matches.map((entity, row) => (
						<button
							key={entity.id}
							type="button"
							role="option"
							aria-selected={row === active}
							className="memory-suggestion"
							data-active={row === active}
							// mousedown, not click: the input's blur would close the list first.
							onMouseDown={event => {
								event.preventDefault();
								pick(row);
							}}
						>
							<span className="memory-swatch" style={{ background: ENTITY_COLOR }} />
							<span className="memory-suggestion-name">{entity.name}</span>
							<span className="memory-count">{formatInteger(entity.mentions)}</span>
						</button>
					))}
					<button
						type="button"
						role="option"
						aria-selected={active === matches.length}
						className="memory-suggestion"
						data-active={active === matches.length}
						onMouseDown={event => {
							event.preventDefault();
							pick(matches.length);
						}}
					>
						<Search size={13} />
						<span className="memory-suggestion-name">Search memories for “{query}”</span>
						<kbd>Enter</kbd>
					</button>
				</div>
			)}
		</div>
	);
}

function EntityDetails({
	entity,
	graph,
	nodeById,
	isFocused,
	onSelect,
	onFocus,
}: {
	entity: MemoryGraphEntity;
	graph: MemoryGraphResponse;
	nodeById: ReadonlyMap<string, MemoryGraphNode>;
	isFocused: boolean;
	onSelect: (id: string) => void;
	onFocus: (id: string) => void;
}) {
	const { facts, related } = useMemo(() => {
		const factIds = new Set<string>();
		for (const edge of graph.edges)
			if (edge.type === "mentions" && edge.target === entity.id) factIds.add(edge.source);
		const coMentions = new Map<string, number>();
		for (const edge of graph.edges)
			if (edge.type === "mentions" && factIds.has(edge.source) && edge.target !== entity.id)
				coMentions.set(edge.target, (coMentions.get(edge.target) ?? 0) + 1);
		return {
			facts: [...factIds]
				.flatMap(id => {
					const node = nodeById.get(id);
					return node?.type === "fact" ? [node] : [];
				})
				.sort(newestFirst),
			related: [...coMentions]
				.sort((a, b) => b[1] - a[1])
				.slice(0, CO_MENTION_LIMIT)
				.flatMap(([id, count]) => {
					const node = nodeById.get(id);
					return node?.type === "entity" ? [{ other: node, count }] : [];
				}),
		};
	}, [entity, graph, nodeById]);
	const newest = facts[0]?.learnedAt;
	const oldest = facts.at(-1)?.learnedAt;
	return (
		<div className="memory-details">
			<p className="memory-note">
				Named in {formatInteger(facts.length)} loaded memories
				{newest && oldest
					? `, learned ${formatRelativeTime(Date.parse(oldest))} to ${formatRelativeTime(Date.parse(newest))}`
					: ""}
				.
			</p>
			{!isFocused && (
				<button type="button" className="btn" data-size="sm" onClick={() => onFocus(entity.id)}>
					<Crosshair size={13} /> Focus the graph on {entity.name}
				</button>
			)}
			{related.length > 0 && (
				<section>
					<h3>Often named with</h3>
					<div className="memory-links">
						{related.map(({ other, count }) => (
							<button key={other.id} type="button" className="memory-link" onClick={() => onSelect(other.id)}>
								{other.name} <span className="memory-count">{formatInteger(count)}</span>
							</button>
						))}
					</div>
				</section>
			)}
			{PANEL_FACT_TYPES.map(factType => {
				const ofType = facts.filter(fact => fact.factType === factType);
				return (
					<FactSection
						key={factType}
						title={`${FACT_LABEL[factType]}s`}
						total={ofType.length}
						facts={ofType.slice(0, PANEL_FACTS_PER_TYPE)}
						onSelect={onSelect}
					/>
				);
			})}
		</div>
	);
}

function FactDetails({
	fact,
	graph,
	nodeById,
	onSelect,
}: {
	fact: MemoryGraphFact;
	graph: MemoryGraphResponse;
	nodeById: ReadonlyMap<string, MemoryGraphNode>;
	onSelect: (id: string) => void;
}) {
	const linked = (linkedId: (edge: MemoryGraphResponse["edges"][number]) => string | null) =>
		graph.edges.flatMap(edge => {
			const id = linkedId(edge);
			const node = id ? nodeById.get(id) : undefined;
			return node ? [node] : [];
		});
	const factsOf = (nodes: MemoryGraphNode[]) => nodes.filter((node): node is MemoryGraphFact => node.type === "fact");
	const entities = linked(edge => (edge.type === "mentions" && edge.source === fact.id ? edge.target : null));
	const sources = factsOf(
		linked(edge => (edge.type === "derived-from" && edge.source === fact.id ? edge.target : null)),
	);
	const derived = factsOf(
		linked(edge => (edge.type === "derived-from" && edge.target === fact.id ? edge.source : null)),
	);
	return (
		<div className="memory-details">
			<p className="memory-text">{fact.text}</p>
			<div className="memory-badges">
				{fact.tags.map(tag => (
					<Badge key={tag} mono>
						{tag}
					</Badge>
				))}
				{fact.factType === "observation" && <Badge>{fact.proofCount} sources</Badge>}
			</div>
			{entities.length > 0 && (
				<section>
					<h3>Entities</h3>
					<div className="memory-links">
						{entities.map(entity =>
							entity.type === "entity" ? (
								<button
									key={entity.id}
									type="button"
									className="memory-link"
									onClick={() => onSelect(entity.id)}
								>
									{entity.name}
								</button>
							) : null,
						)}
					</div>
				</section>
			)}
			<FactSection title="Consolidated from" total={sources.length} facts={sources} onSelect={onSelect} />
			<FactSection title="Consolidated into" total={derived.length} facts={derived} onSelect={onSelect} />
		</div>
	);
}

function SearchResults({
	search,
	nodeById,
	onSelect,
}: {
	search: QueryResult<MemorySearchResponse>;
	nodeById: ReadonlyMap<string, MemoryGraphNode>;
	onSelect: (id: string) => void;
}) {
	if (search.error) return <p className="memory-note">Search failed: {search.error.message}</p>;
	if (!search.data || search.stale) return <p className="memory-note">Searching memories…</p>;
	const { results } = search.data;
	if (results.length === 0) return <p className="memory-note">No memories match.</p>;
	const notLoaded = results.filter(hit => !nodeById.has(hit.id)).length;
	return (
		<div className="memory-details">
			{notLoaded > 0 && (
				<p className="memory-note">
					{formatInteger(notLoaded)} matches are older than the loaded graph and cannot be opened.
				</p>
			)}
			<section>
				{results.map(hit => (
					<FactRow
						key={hit.id}
						factType={hit.factType}
						text={hit.text}
						learnedAt={hit.learnedAt}
						onClick={nodeById.has(hit.id) ? () => onSelect(hit.id) : undefined}
					/>
				))}
			</section>
		</div>
	);
}

function FactSection({
	title,
	total,
	facts,
	onSelect,
}: {
	title: string;
	/** Facts of this kind, of which `facts` lists the first. */
	total: number;
	facts: readonly MemoryGraphFact[];
	onSelect: (id: string) => void;
}) {
	if (facts.length === 0) return null;
	return (
		<section>
			<h3>
				{title} <span className="memory-count">{formatInteger(total)}</span>
			</h3>
			{facts.map(fact => (
				<FactRow
					key={fact.id}
					factType={fact.factType}
					text={fact.text}
					learnedAt={fact.learnedAt}
					onClick={() => onSelect(fact.id)}
				/>
			))}
			{total > facts.length && (
				<p className="memory-note">{formatInteger(total - facts.length)} older not listed.</p>
			)}
		</section>
	);
}

/** A memory line; without `onClick` (not in the loaded graph) it is shown but cannot be opened. */
function FactRow({
	factType,
	text,
	learnedAt,
	onClick,
}: {
	factType: MemoryFactType;
	text: string;
	learnedAt: string | null;
	onClick: (() => void) | undefined;
}) {
	return (
		<button type="button" className="memory-fact" disabled={!onClick} onClick={onClick}>
			<span className="memory-swatch" style={{ background: FACT_COLOR[factType] }} />
			<span className="memory-fact-text">
				{text}
				{learnedAt && <span className="memory-fact-when">{formatRelativeTime(Date.parse(learnedAt))}</span>}
			</span>
		</button>
	);
}
