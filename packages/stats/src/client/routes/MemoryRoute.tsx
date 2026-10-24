import { RotateCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { getMemoryGraph } from "../api";
import { formatInteger, formatRelativeTime } from "../data/formatters";
import { useQuery } from "../data/query";
import type { LayoutLink, LayoutNode, LayoutProgress, LayoutRequest } from "../memory-layout-worker";
import type { MemoryFactType, MemoryGraphNode, MemoryGraphResponse } from "../types";
import { Badge, Card, ChartSkeleton, Drawer, EmptyState, PageHeader, QueryView, Stat, StatGrid } from "../ui";
import "./memory.css";

export interface MemoryRouteProps {
	active: boolean;
}

const FACT_COLOR: Record<MemoryFactType, string> = {
	world: "#5ad8e6",
	experience: "#ed4abf",
	observation: "#9d7bff",
};
const ENTITY_COLOR = "#f5b54a";
const FACT_LABEL: Record<MemoryFactType, string> = {
	world: "World fact",
	experience: "Experience",
	observation: "Observation",
};
const CANVAS_HEIGHT = 720;
/** Entities always labeled; the rest are labeled on hover or selection. */
const LABELED_ENTITIES = 40;

export function MemoryRoute({ active }: MemoryRouteProps) {
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
				skeleton={<ChartSkeleton height={CANVAS_HEIGHT} />}
				isEmpty={(response: MemoryGraphResponse) => response.nodes.length === 0}
				empty={
					<EmptyState
						title="No memories yet"
						hint="Set memory.backend to hindsight with hindsight.apiUrl; sessions are captured as you work."
					/>
				}
			>
				{response => <MemoryExplorer graph={response} />}
			</QueryView>
		</div>
	);
}

function MemoryExplorer({ graph }: { graph: MemoryGraphResponse }) {
	const [project, setProject] = useState<string | null>(null);
	const [hiddenTypes, setHiddenTypes] = useState<ReadonlySet<MemoryFactType>>(new Set());
	const [selectedId, setSelectedId] = useState<string | null>(null);

	const projects = useMemo(() => {
		const counts = new Map<string, number>();
		for (const node of graph.nodes)
			if (node.type === "fact")
				for (const tag of node.tags) if (tag.startsWith("project:")) counts.set(tag, (counts.get(tag) ?? 0) + 1);
		return [...counts].sort((a, b) => b[1] - a[1]);
	}, [graph]);

	// Facts pass the type and project filters; entities and edges follow the facts that remain.
	const visible = useMemo(() => {
		const facts = new Set(
			graph.nodes.flatMap(node =>
				node.type === "fact" && !hiddenTypes.has(node.factType) && (project === null || node.tags.includes(project))
					? [node.id]
					: [],
			),
		);
		const degree = new Map<string, number>();
		for (const edge of graph.edges)
			if (edge.type === "mentions" && facts.has(edge.source))
				degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
		const ids = new Set([...facts, ...degree.keys()]);
		return {
			nodes: graph.nodes.filter(node => ids.has(node.id)),
			edges: graph.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)),
			degree,
		};
	}, [graph, hiddenTypes, project]);

	const counts = { world: 0, experience: 0, observation: 0 };
	for (const node of graph.nodes) if (node.type === "fact") counts[node.factType]++;
	const entityCount = graph.nodes.length - counts.world - counts.experience - counts.observation;
	const nodeById = useMemo(() => new Map(graph.nodes.map(node => [node.id, node])), [graph]);
	const selected = selectedId ? nodeById.get(selectedId) : undefined;
	const toggleType = (factType: MemoryFactType) =>
		setHiddenTypes(previous => {
			const next = new Set(previous);
			if (!next.delete(factType)) next.add(factType);
			return next;
		});

	return (
		<>
			<StatGrid min={150}>
				<Stat
					label="Memories"
					value={formatInteger(graph.totalMemories)}
					hint={
						graph.totalMemories > counts.world + counts.experience + counts.observation
							? `newest ${formatInteger(graph.limit)} drawn`
							: (graph.bankId ?? undefined)
					}
				/>
				<Stat label="World facts" value={formatInteger(counts.world)} />
				<Stat label="Experiences" value={formatInteger(counts.experience)} />
				<Stat label="Observations" value={formatInteger(counts.observation)} hint="consolidated" />
				<Stat label="Entities" value={formatInteger(entityCount)} />
				<Stat label="Links" value={formatInteger(graph.edges.length)} />
			</StatGrid>
			<Card
				flush
				title={graph.bankId ?? "memory"}
				description="Drag to pan, scroll to zoom. Hover a node to trace its links; click for details."
				actions={
					projects.length > 0 ? (
						<select
							className="memory-select"
							value={project ?? ""}
							onChange={event => setProject(event.target.value || null)}
						>
							<option value="">All projects</option>
							{projects.map(([tag, count]) => (
								<option key={tag} value={tag}>
									{tag.slice("project:".length)} ({count})
								</option>
							))}
						</select>
					) : undefined
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
								<span className="memory-swatch" style={{ background: FACT_COLOR[factType] }} />
								{FACT_LABEL[factType]}
							</button>
						))}
						<span className="memory-chip" data-static="true">
							<span className="memory-swatch" style={{ background: ENTITY_COLOR }} />
							Entity (size = mentions)
						</span>
					</div>
				}
			>
				{visible.nodes.length === 0 ? (
					<EmptyState title="Nothing matches" hint="Show more memory types or pick another project." />
				) : (
					<MemoryGalaxy
						nodes={visible.nodes}
						edges={visible.edges}
						degree={visible.degree}
						selectedId={selectedId}
						onSelect={setSelectedId}
					/>
				)}
			</Card>
			<Drawer
				open={selected !== undefined}
				onClose={() => setSelectedId(null)}
				title={selected ? (selected.type === "entity" ? selected.name : FACT_LABEL[selected.factType]) : ""}
				subtitle={
					selected?.type === "fact" && selected.date ? formatRelativeTime(Date.parse(selected.date)) : "entity"
				}
			>
				{selected && <NodeDetails node={selected} graph={graph} nodeById={nodeById} onSelect={setSelectedId} />}
			</Drawer>
		</>
	);
}

interface GalaxyProps {
	nodes: readonly MemoryGraphNode[];
	edges: MemoryGraphResponse["edges"];
	degree: ReadonlyMap<string, number>;
	selectedId: string | null;
	onSelect: (id: string | null) => void;
}

/** Fill colors in draw order; nodes are batched into one canvas path per color. */
const PALETTE = [FACT_COLOR.world, FACT_COLOR.experience, FACT_COLOR.observation, ENTITY_COLOR];
const PALETTE_SLOT: Record<MemoryFactType, number> = { world: 0, experience: 1, observation: 2 };
const ENTITY_SLOT = 3;
const TAU = Math.PI * 2;
/** Share of nodes with a previous position above which a refresh only nudges the layout. */
const WARM_START_SHARE = 0.8;

/**
 * Canvas galaxy. The force layout runs in a worker and streams positions; this thread
 * only draws, so pan, zoom, and hover stay smooth while thousands of nodes settle.
 */
function MemoryGalaxy({ nodes, edges, degree, selectedId, onSelect }: GalaxyProps) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const tooltipRef = useRef<HTMLDivElement>(null);
	const selectedRef = useRef(selectedId);
	selectedRef.current = selectedId;
	const onSelectRef = useRef(onSelect);
	onSelectRef.current = onSelect;
	const redrawRef = useRef<() => void>(() => {});
	/** Last settled position per node id: the next layout (refresh, filter) starts from it. */
	const settledRef = useRef(new Map<string, { x: number; y: number }>());

	useEffect(() => {
		redrawRef.current();
	}, [selectedId]);

	useEffect(() => {
		const canvas = canvasRef.current;
		const tooltip = tooltipRef.current;
		if (!canvas || !tooltip) return;
		const context = canvas.getContext("2d");
		if (!context) return;

		const count = nodes.length;
		const indexById = new Map(nodes.map((node, index) => [node.id, index]));
		const radius = new Float32Array(count);
		const slots: number[][] = PALETTE.map(() => []);
		const slotOf = new Uint8Array(count);
		nodes.forEach((node, index) => {
			radius[index] =
				node.type === "entity"
					? 3 + Math.sqrt(degree.get(node.id) ?? node.mentions) * 1.6
					: 2.2 + Math.min(Math.sqrt(node.proofCount) - 1, 4);
			slotOf[index] = node.type === "entity" ? ENTITY_SLOT : PALETTE_SLOT[node.factType];
			slots[slotOf[index]].push(index);
		});
		const links: LayoutLink[] = edges.map(edge => ({
			source: indexById.get(edge.source)!,
			target: indexById.get(edge.target)!,
			derived: edge.type === "derived-from",
		}));
		const incident: number[][] = nodes.map(() => []);
		links.forEach((link, index) => {
			incident[link.source].push(index);
			incident[link.target].push(index);
		});
		const labeled = new Set(slots[ENTITY_SLOT].toSorted((a, b) => radius[b] - radius[a]).slice(0, LABELED_ENTITIES));
		const style = getComputedStyle(canvas);
		const inkColor = style.getPropertyValue("--ink-1").trim() || "#ededef";
		const edgeColor = style.getPropertyValue("--ink-3").trim() || "#6c6c74";
		const haloColor = style.getPropertyValue("--card").trim() || "#0e0e10";

		// Seed from the last layout; a new node starts beside a linked node that already has a place.
		const settled = settledRef.current;
		const layoutNodes: LayoutNode[] = nodes.map((node, index) => {
			const known = settled.get(node.id);
			return { isEntity: node.type === "entity", radius: radius[index], x: known?.x, y: known?.y };
		});
		let seeded = 0;
		layoutNodes.forEach((layoutNode, index) => {
			if (layoutNode.x !== undefined) {
				seeded++;
				return;
			}
			for (const edgeIndex of incident[index]) {
				const link = links[edgeIndex];
				const anchor = layoutNodes[link.source === index ? link.target : link.source];
				if (anchor.x === undefined || anchor.y === undefined) continue;
				layoutNode.x = anchor.x + (Math.random() - 0.5) * 20;
				layoutNode.y = anchor.y + (Math.random() - 0.5) * 20;
				break;
			}
		});
		let positions = new Float32Array(count * 2).fill(Number.NaN);
		layoutNodes.forEach((layoutNode, index) => {
			if (layoutNode.x === undefined || layoutNode.y === undefined) return;
			positions[index * 2] = layoutNode.x;
			positions[index * 2 + 1] = layoutNode.y;
		});

		let width = 0;
		const view = { x: 0, y: 0, k: 0.6 };
		/** Follow the layout as it grows until the user pans or zooms. */
		let autoFit = true;
		let hovered = -1;
		let frame = 0;

		const fit = () => {
			let minX = Infinity;
			let minY = Infinity;
			let maxX = -Infinity;
			let maxY = -Infinity;
			for (let index = 0; index < count; index++) {
				const x = positions[index * 2];
				const y = positions[index * 2 + 1];
				if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
				minX = Math.min(minX, x);
				maxX = Math.max(maxX, x);
				minY = Math.min(minY, y);
				maxY = Math.max(maxY, y);
			}
			if (!Number.isFinite(minX) || width === 0) return;
			view.k = Math.min((width - 48) / Math.max(maxX - minX, 1), (CANVAS_HEIGHT - 48) / Math.max(maxY - minY, 1), 2);
			view.x = width / 2 - (view.k * (minX + maxX)) / 2;
			view.y = CANVAS_HEIGHT / 2 - (view.k * (minY + maxY)) / 2;
		};

		const draw = () => {
			frame = 0;
			const ratio = window.devicePixelRatio || 1;
			context.setTransform(ratio, 0, 0, ratio, 0, 0);
			context.clearRect(0, 0, width, CANVAS_HEIGHT);
			context.translate(view.x, view.y);
			context.scale(view.k, view.k);
			const selected = selectedRef.current ? (indexById.get(selectedRef.current) ?? -1) : -1;
			const focusIndex = hovered >= 0 ? hovered : selected;
			let focus: Set<number> | null = null;
			if (focusIndex >= 0) {
				focus = new Set([focusIndex]);
				for (const edgeIndex of incident[focusIndex]) {
					focus.add(links[edgeIndex].source);
					focus.add(links[edgeIndex].target);
				}
			}

			// World-space viewport: off-screen nodes and edges are skipped when zoomed in.
			const left = -view.x / view.k;
			const top = -view.y / view.k;
			const right = (width - view.x) / view.k;
			const bottom = (CANVAS_HEIGHT - view.y) / view.k;
			/** World units per device pixel. */
			const pixel = 1 / (view.k * ratio);

			// Under one device pixel wide, Skia strokes edges as hairlines; at 1.2 px the full
			// stroker computed coverage for the whole overlapping path, measured 27x slower at 17k edges.
			context.lineWidth = 0.9 * pixel;
			context.strokeStyle = edgeColor;
			context.globalAlpha = focus ? 0.03 : 0.12;
			context.beginPath();
			for (const link of links) {
				const x1 = positions[link.source * 2];
				const y1 = positions[link.source * 2 + 1];
				const x2 = positions[link.target * 2];
				const y2 = positions[link.target * 2 + 1];
				if ((x1 < left && x2 < left) || (x1 > right && x2 > right)) continue;
				if ((y1 < top && y2 < top) || (y1 > bottom && y2 > bottom)) continue;
				context.moveTo(x1, y1);
				context.lineTo(x2, y2);
			}
			context.stroke();
			if (focusIndex >= 0) {
				context.globalAlpha = 0.9;
				context.lineWidth = 1.2 / view.k;
				context.beginPath();
				for (const edgeIndex of incident[focusIndex]) {
					const link = links[edgeIndex];
					context.moveTo(positions[link.source * 2], positions[link.source * 2 + 1]);
					context.lineTo(positions[link.target * 2], positions[link.target * 2 + 1]);
				}
				context.stroke();
			}

			context.globalAlpha = focus ? 0.12 : 0.95;
			slots.forEach((members, slot) => {
				context.fillStyle = PALETTE[slot];
				context.beginPath();
				for (const index of members) {
					const x = positions[index * 2];
					const y = positions[index * 2 + 1];
					const r = radius[index];
					if (x + r < left || x - r > right || y + r < top || y - r > bottom) continue;
					// Below two device pixels a square is indistinguishable from a circle and half the raster cost.
					if (r < 2 * pixel) context.rect(x - r, y - r, 2 * r, 2 * r);
					else {
						context.moveTo(x + r, y);
						context.arc(x, y, r, 0, TAU);
					}
				}
				context.fill();
			});
			if (focus) {
				context.globalAlpha = 0.95;
				for (const index of focus) {
					context.fillStyle = PALETTE[slotOf[index]];
					context.beginPath();
					context.arc(positions[index * 2], positions[index * 2 + 1], radius[index], 0, TAU);
					context.fill();
				}
			}
			if (selected >= 0) {
				context.strokeStyle = inkColor;
				context.lineWidth = 2 / view.k;
				context.beginPath();
				context.arc(positions[selected * 2], positions[selected * 2 + 1], radius[selected], 0, TAU);
				context.stroke();
			}

			context.globalAlpha = 1;
			context.font = `${12 / view.k}px Inter, ui-sans-serif, system-ui, sans-serif`;
			context.lineJoin = "round";
			context.lineWidth = 3 / view.k;
			context.strokeStyle = haloColor;
			context.fillStyle = inkColor;
			for (const index of focus ?? labeled) {
				const node = nodes[index];
				if (node.type !== "entity") continue;
				const x = positions[index * 2] + radius[index] + 3 / view.k;
				const y = positions[index * 2 + 1] + 4 / view.k;
				context.strokeText(node.name, x, y);
				context.fillText(node.name, x, y);
			}
		};
		const redraw = () => {
			if (!frame) frame = requestAnimationFrame(draw);
		};
		redrawRef.current = redraw;

		const resize = () => {
			const ratio = window.devicePixelRatio || 1;
			const previousWidth = width;
			width = canvas.clientWidth;
			canvas.width = Math.round(width * ratio);
			canvas.height = Math.round(CANVAS_HEIGHT * ratio);
			if (autoFit) fit();
			else view.x += (width - previousWidth) / 2;
			redraw();
		};
		const observer = new ResizeObserver(resize);
		observer.observe(canvas);

		const worker = new Worker("memory-layout-worker.js", { type: "module" });
		worker.onmessage = (event: MessageEvent<LayoutProgress>) => {
			positions = event.data.positions;
			if (autoFit) fit();
			redraw();
			if (!event.data.done) return;
			worker.terminate();
			settled.clear();
			nodes.forEach((node, index) => {
				settled.set(node.id, { x: positions[index * 2], y: positions[index * 2 + 1] });
			});
		};
		const request: LayoutRequest = {
			nodes: layoutNodes,
			links,
			warm: seeded / Math.max(count, 1) >= WARM_START_SHARE,
		};
		worker.postMessage(request);

		const hit = (event: { clientX: number; clientY: number }) => {
			const rect = canvas.getBoundingClientRect();
			const x = (event.clientX - rect.left - view.x) / view.k;
			const y = (event.clientY - rect.top - view.y) / view.k;
			let best = -1;
			let bestGap = 6 / view.k;
			for (let index = 0; index < count; index++) {
				const gap = Math.hypot(positions[index * 2] - x, positions[index * 2 + 1] - y) - radius[index];
				if (gap <= bestGap) {
					bestGap = gap;
					best = index;
				}
			}
			return best;
		};
		const describe = (index: number) => {
			const node = nodes[index];
			const title =
				node.type === "entity" ? node.name : node.text.length > 220 ? `${node.text.slice(0, 219)}…` : node.text;
			const meta =
				node.type === "entity"
					? `entity · ${degree.get(node.id) ?? node.mentions} memories`
					: `${FACT_LABEL[node.factType].toLowerCase()} · ${incident[index].length} links${node.date ? ` · ${formatRelativeTime(Date.parse(node.date))}` : ""}`;
			tooltip.replaceChildren(
				Object.assign(document.createElement("div"), { className: "memory-tooltip-title", textContent: title }),
				Object.assign(document.createElement("div"), { className: "memory-tooltip-meta", textContent: meta }),
			);
		};

		let drag: { x: number; y: number; viewX: number; viewY: number; moved: boolean } | null = null;
		const onPointerDown = (event: PointerEvent) => {
			if (event.button !== 0) return;
			drag = { x: event.clientX, y: event.clientY, viewX: view.x, viewY: view.y, moved: false };
			canvas.setPointerCapture(event.pointerId);
		};
		const onPointerMove = (event: PointerEvent) => {
			if (drag) {
				const dx = event.clientX - drag.x;
				const dy = event.clientY - drag.y;
				if (!drag.moved && Math.hypot(dx, dy) < 4) return;
				drag.moved = true;
				autoFit = false;
				view.x = drag.viewX + dx;
				view.y = drag.viewY + dy;
				tooltip.hidden = true;
				redraw();
				return;
			}
			const found = hit(event);
			if (found !== hovered) {
				hovered = found;
				canvas.style.cursor = found >= 0 ? "pointer" : "grab";
				if (found >= 0) describe(found);
				redraw();
			}
			tooltip.hidden = found < 0;
			if (found < 0) return;
			const rect = canvas.getBoundingClientRect();
			tooltip.style.transform = `translate(${event.clientX - rect.left + 14}px, ${event.clientY - rect.top + 14}px)`;
		};
		const onPointerUp = (event: PointerEvent) => {
			const moved = drag?.moved ?? false;
			drag = null;
			if (moved) return;
			const found = hit(event);
			onSelectRef.current(found >= 0 ? nodes[found].id : null);
		};
		const onPointerLeave = () => {
			hovered = -1;
			tooltip.hidden = true;
			redraw();
		};
		// React wheel listeners are passive; zooming must cancel page scroll.
		const onWheel = (event: WheelEvent) => {
			event.preventDefault();
			autoFit = false;
			const rect = canvas.getBoundingClientRect();
			const pointerX = event.clientX - rect.left;
			const pointerY = event.clientY - rect.top;
			const k = Math.min(Math.max(view.k * Math.exp(-event.deltaY * 0.0015), 0.05), 8);
			view.x = pointerX - ((pointerX - view.x) * k) / view.k;
			view.y = pointerY - ((pointerY - view.y) * k) / view.k;
			view.k = k;
			redraw();
		};
		canvas.addEventListener("pointerdown", onPointerDown);
		canvas.addEventListener("pointermove", onPointerMove);
		canvas.addEventListener("pointerup", onPointerUp);
		canvas.addEventListener("pointerleave", onPointerLeave);
		canvas.addEventListener("wheel", onWheel, { passive: false });
		resize();

		return () => {
			worker.terminate();
			observer.disconnect();
			cancelAnimationFrame(frame);
			canvas.removeEventListener("pointerdown", onPointerDown);
			canvas.removeEventListener("pointermove", onPointerMove);
			canvas.removeEventListener("pointerup", onPointerUp);
			canvas.removeEventListener("pointerleave", onPointerLeave);
			canvas.removeEventListener("wheel", onWheel);
			redrawRef.current = () => {};
		};
	}, [nodes, edges, degree]);

	return (
		<div className="memory-canvas">
			<canvas ref={canvasRef} className="memory-galaxy" style={{ height: CANVAS_HEIGHT }} />
			<div ref={tooltipRef} className="memory-tooltip" hidden />
		</div>
	);
}

function NodeDetails({
	node,
	graph,
	nodeById,
	onSelect,
}: {
	node: MemoryGraphNode;
	graph: MemoryGraphResponse;
	nodeById: ReadonlyMap<string, MemoryGraphNode>;
	onSelect: (id: string) => void;
}) {
	const linked = (predicate: (edge: MemoryGraphResponse["edges"][number]) => string | null) =>
		graph.edges.flatMap(edge => {
			const id = predicate(edge);
			const target = id ? nodeById.get(id) : undefined;
			return target ? [target] : [];
		});
	if (node.type === "entity") {
		const facts = linked(edge => (edge.type === "mentions" && edge.target === node.id ? edge.source : null))
			.filter(fact => fact.type === "fact")
			.sort((a, b) => (b.type === "fact" && a.type === "fact" ? (b.date ?? "").localeCompare(a.date ?? "") : 0));
		return (
			<div className="memory-details">
				<p className="memory-note">{formatInteger(facts.length)} memories mention this entity (newest first).</p>
				<FactSection title="Memories" facts={facts.slice(0, 60)} onSelect={onSelect} />
			</div>
		);
	}
	const entities = linked(edge => (edge.type === "mentions" && edge.source === node.id ? edge.target : null));
	const sources = linked(edge => (edge.type === "derived-from" && edge.source === node.id ? edge.target : null));
	const derived = linked(edge => (edge.type === "derived-from" && edge.target === node.id ? edge.source : null));
	return (
		<div className="memory-details">
			<p className="memory-text">{node.text}</p>
			<div className="memory-badges">
				<Badge>{FACT_LABEL[node.factType]}</Badge>
				{node.tags.map(tag => (
					<Badge key={tag} mono>
						{tag}
					</Badge>
				))}
				{node.factType === "observation" && <Badge>{node.proofCount} sources</Badge>}
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
			<FactSection title="Consolidated from" facts={sources} onSelect={onSelect} />
			<FactSection title="Consolidated into" facts={derived} onSelect={onSelect} />
		</div>
	);
}

function FactSection({
	title,
	facts,
	onSelect,
}: {
	title: string;
	facts: readonly MemoryGraphNode[];
	onSelect: (id: string) => void;
}) {
	if (facts.length === 0) return null;
	return (
		<section>
			<h3>{title}</h3>
			{facts.map(fact =>
				fact.type === "fact" ? (
					<button key={fact.id} type="button" className="memory-fact" onClick={() => onSelect(fact.id)}>
						<span className="memory-swatch" style={{ background: FACT_COLOR[fact.factType] }} />
						<span className="memory-fact-text">{fact.text}</span>
					</button>
				) : null,
			)}
		</section>
	);
}
