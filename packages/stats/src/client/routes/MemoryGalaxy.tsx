import { useEffect, useRef } from "react";
import { formatRelativeTime } from "../data/formatters";
import type { LayoutLink, LayoutNode, LayoutProgress, LayoutRequest } from "../memory-layout-worker";
import type { MemoryGraphEdge, MemoryGraphNode } from "../types";
import { FACT_LABEL, type MemoryPaint } from "./memory-view";

export interface LayoutPoint {
	x: number;
	y: number;
}

export interface MemoryGalaxyProps {
	nodes: readonly MemoryGraphNode[];
	edges: readonly MemoryGraphEdge[];
	degree: ReadonlyMap<string, number>;
	paint: MemoryPaint;
	/** Last settled position per node id; the caller keeps one per view so the whole graph and a focus never mix. */
	layout: Map<string, LayoutPoint>;
	selectedId: string | null;
	/** Nodes to spotlight (search results and their entities); the rest dim. */
	highlight: ReadonlySet<string> | null;
	onSelect: (id: string | null) => void;
}

interface GalaxyControl {
	redraw(): void;
	/** Pans an off-screen node into view. */
	reveal(id: string | null): void;
	/** Applies the current highlight and fits the view to it. */
	spotlight(): void;
}

const TAU = Math.PI * 2;
/** Share of nodes with a previous position above which a refresh only nudges the layout. */
const WARM_START_SHARE = 0.8;
/** Largest entities always labeled when they fit; the rest earn a label by on-screen size. */
const LABELED_ENTITIES = 40;
/** On-screen radius, px, at which any entity earns a label as you zoom in. */
const LABEL_MIN_SCREEN_RADIUS = 6;
const MAX_LABELS = 150;
const LABEL_FONT = "12px Inter, ui-sans-serif, system-ui, sans-serif";
/** Label box around the text baseline, px. */
const LABEL_ASCENT = 11;
const LABEL_DESCENT = 3;
/** Margin, px, inside which a selected node counts as off-screen. */
const REVEAL_MARGIN = 40;

/**
 * Canvas galaxy. The force layout runs in a worker and streams positions; this thread
 * only draws, so pan, zoom, and hover stay smooth while thousands of nodes settle.
 */
export function MemoryGalaxy({
	nodes,
	edges,
	degree,
	paint,
	layout,
	selectedId,
	highlight,
	onSelect,
}: MemoryGalaxyProps) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const tooltipRef = useRef<HTMLDivElement>(null);
	const selectedRef = useRef(selectedId);
	selectedRef.current = selectedId;
	const paintRef = useRef(paint);
	paintRef.current = paint;
	const highlightRef = useRef(highlight);
	highlightRef.current = highlight;
	const onSelectRef = useRef(onSelect);
	onSelectRef.current = onSelect;
	const controlRef = useRef<GalaxyControl | null>(null);

	useEffect(() => {
		controlRef.current?.reveal(selectedId);
	}, [selectedId]);
	useEffect(() => {
		controlRef.current?.redraw();
	}, [paint]);
	useEffect(() => {
		controlRef.current?.spotlight();
	}, [highlight]);

	useEffect(() => {
		const canvas = canvasRef.current;
		const tooltip = tooltipRef.current;
		if (!canvas || !tooltip) return;
		const context = canvas.getContext("2d");
		if (!context) return;

		const count = nodes.length;
		const indexById = new Map(nodes.map((node, index) => [node.id, index]));
		const radius = new Float32Array(count);
		nodes.forEach((node, index) => {
			radius[index] =
				node.type === "entity"
					? 3 + Math.sqrt(degree.get(node.id) ?? node.mentions) * 1.6
					: 2.2 + Math.min(Math.sqrt(node.proofCount) - 1, 4);
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
		const bySize = (a: number, b: number) => radius[b] - radius[a];
		const labelOrder = nodes.flatMap((node, index) => (node.type === "entity" ? [index] : [])).sort(bySize);
		/** Label text width at LABEL_FONT, measured on first use. */
		const labelWidth = new Float32Array(count).fill(Number.NaN);
		const style = getComputedStyle(canvas);
		const inkColor = style.getPropertyValue("--ink-1").trim() || "#ededef";
		const edgeColor = style.getPropertyValue("--ink-3").trim() || "#6c6c74";
		const haloColor = style.getPropertyValue("--card").trim() || "#0e0e10";

		// Seed from the last layout; a new node starts beside a linked node that already has a place.
		const layoutNodes: LayoutNode[] = nodes.map((node, index) => {
			const known = layout.get(node.id);
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
		let height = 0;
		const view = { x: 0, y: 0, k: 0.6 };
		/** Follow the layout as it grows until the user pans, zooms, or a spotlight takes the view. */
		let autoFit = true;
		let hovered = -1;
		let frame = 0;
		let spot: { members: Set<number>; links: LayoutLink[] } | null = null;
		let slotsFor: MemoryPaint | null = null;
		let slots: number[][] = [];

		const fit = (members: Iterable<number> | null) => {
			let minX = Infinity;
			let minY = Infinity;
			let maxX = -Infinity;
			let maxY = -Infinity;
			const include = (index: number) => {
				const x = positions[index * 2];
				const y = positions[index * 2 + 1];
				if (!Number.isFinite(x) || !Number.isFinite(y)) return;
				minX = Math.min(minX, x - radius[index]);
				maxX = Math.max(maxX, x + radius[index]);
				minY = Math.min(minY, y - radius[index]);
				maxY = Math.max(maxY, y + radius[index]);
			};
			if (members) for (const index of members) include(index);
			else for (let index = 0; index < count; index++) include(index);
			if (!Number.isFinite(minX) || width === 0) return;
			view.k = Math.min((width - 48) / Math.max(maxX - minX, 1), (height - 48) / Math.max(maxY - minY, 1), 2);
			view.x = width / 2 - (view.k * (minX + maxX)) / 2;
			view.y = height / 2 - (view.k * (minY + maxY)) / 2;
		};

		const draw = () => {
			frame = 0;
			if (paintRef.current !== slotsFor) {
				slotsFor = paintRef.current;
				slots = slotsFor.palette.map(() => []);
				slotsFor.slotOf.forEach((slot, index) => slots[slot].push(index));
			}
			const { palette, slotOf } = slotsFor;
			const ratio = window.devicePixelRatio || 1;
			context.setTransform(ratio, 0, 0, ratio, 0, 0);
			context.clearRect(0, 0, width, height);
			context.translate(view.x, view.y);
			context.scale(view.k, view.k);
			const selected = selectedRef.current ? (indexById.get(selectedRef.current) ?? -1) : -1;
			const focusIndex = hovered >= 0 ? hovered : selected;
			let focus: Set<number> | null = null;
			let focusLinks: LayoutLink[] = [];
			if (focusIndex >= 0) {
				focusLinks = incident[focusIndex].map(edgeIndex => links[edgeIndex]);
				focus = new Set([focusIndex]);
				for (const link of focusLinks) {
					focus.add(link.source);
					focus.add(link.target);
				}
			} else if (spot) {
				focus = spot.members;
				focusLinks = spot.links;
			}

			// World-space viewport: off-screen nodes and edges are skipped when zoomed in.
			const left = -view.x / view.k;
			const top = -view.y / view.k;
			const right = (width - view.x) / view.k;
			const bottom = (height - view.y) / view.k;
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
			if (focusLinks.length > 0) {
				context.globalAlpha = 0.9;
				context.lineWidth = 1.2 / view.k;
				context.beginPath();
				for (const link of focusLinks) {
					context.moveTo(positions[link.source * 2], positions[link.source * 2 + 1]);
					context.lineTo(positions[link.target * 2], positions[link.target * 2 + 1]);
				}
				context.stroke();
			}

			// One canvas path per color.
			const fill = (groups: number[][]) => {
				groups.forEach((members, slot) => {
					context.fillStyle = palette[slot];
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
			};
			context.globalAlpha = focus ? 0.12 : 0.95;
			fill(slots);
			if (focus) {
				const groups: number[][] = palette.map(() => []);
				for (const index of focus) groups[slotOf[index]].push(index);
				context.globalAlpha = 0.95;
				fill(groups);
			}
			if (selected >= 0) {
				context.globalAlpha = 1;
				context.strokeStyle = inkColor;
				context.lineWidth = 2 / view.k;
				context.beginPath();
				context.arc(positions[selected * 2], positions[selected * 2 + 1], radius[selected], 0, TAU);
				context.stroke();
			}

			// Labels in screen space, largest entities first; a label that would overlap one already drawn is skipped.
			context.setTransform(ratio, 0, 0, ratio, 0, 0);
			context.globalAlpha = 1;
			context.font = LABEL_FONT;
			context.lineJoin = "round";
			context.lineWidth = 3;
			context.strokeStyle = haloColor;
			context.fillStyle = inkColor;
			const placed: number[] = [];
			const label = (index: number) => {
				const node = nodes[index];
				if (node.type !== "entity") return;
				const x = view.x + (positions[index * 2] + radius[index]) * view.k + 3;
				const y = view.y + positions[index * 2 + 1] * view.k + 4;
				if (Number.isNaN(labelWidth[index])) labelWidth[index] = context.measureText(node.name).width;
				const end = x + labelWidth[index];
				// Negated so a not-yet-placed (NaN) node is skipped too.
				if (!(end >= 0 && x <= width && y + LABEL_DESCENT >= 0 && y - LABEL_ASCENT <= height)) return;
				for (let at = 0; at < placed.length; at += 4)
					if (
						x < placed[at + 2] &&
						end > placed[at] &&
						y - LABEL_ASCENT < placed[at + 3] &&
						y + LABEL_DESCENT > placed[at + 1]
					)
						return;
				placed.push(x, y - LABEL_ASCENT, end, y + LABEL_DESCENT);
				context.strokeText(node.name, x, y);
				context.fillText(node.name, x, y);
			};
			if (selected >= 0) label(selected);
			if (focus) {
				for (const index of [...focus].filter(member => nodes[member].type === "entity").sort(bySize)) {
					if (placed.length >= MAX_LABELS * 4) break;
					label(index);
				}
			} else {
				for (let rank = 0; rank < labelOrder.length && placed.length < MAX_LABELS * 4; rank++) {
					const index = labelOrder[rank];
					if (rank >= LABELED_ENTITIES && radius[index] * view.k < LABEL_MIN_SCREEN_RADIUS) break;
					label(index);
				}
			}
		};
		const redraw = () => {
			if (!frame) frame = requestAnimationFrame(draw);
		};

		const applyHighlight = (shouldFit: boolean) => {
			const ids = highlightRef.current;
			if (!ids) {
				spot = null;
				return;
			}
			const members = new Set<number>();
			for (const id of ids) {
				const index = indexById.get(id);
				if (index !== undefined) members.add(index);
			}
			spot = { members, links: links.filter(link => members.has(link.source) && members.has(link.target)) };
			if (shouldFit && members.size > 0) {
				autoFit = false;
				fit(members);
			}
		};
		applyHighlight(false);
		controlRef.current = {
			redraw,
			reveal: id => {
				const index = id === null ? -1 : (indexById.get(id) ?? -1);
				if (index >= 0) {
					const x = positions[index * 2];
					const y = positions[index * 2 + 1];
					const screenX = view.x + x * view.k;
					const screenY = view.y + y * view.k;
					const isOffScreen =
						screenX < REVEAL_MARGIN ||
						screenX > width - REVEAL_MARGIN ||
						screenY < REVEAL_MARGIN ||
						screenY > height - REVEAL_MARGIN;
					if (Number.isFinite(screenX) && Number.isFinite(screenY) && isOffScreen) {
						autoFit = false;
						view.x = width / 2 - x * view.k;
						view.y = height / 2 - y * view.k;
					}
				}
				redraw();
			},
			spotlight: () => {
				applyHighlight(true);
				redraw();
			},
		};

		const resize = () => {
			const ratio = window.devicePixelRatio || 1;
			const previousWidth = width;
			const previousHeight = height;
			width = canvas.clientWidth;
			height = canvas.clientHeight;
			canvas.width = Math.round(width * ratio);
			canvas.height = Math.round(height * ratio);
			if (autoFit) fit(null);
			else {
				view.x += (width - previousWidth) / 2;
				view.y += (height - previousHeight) / 2;
			}
			redraw();
		};
		const observer = new ResizeObserver(resize);
		observer.observe(canvas);

		const worker = new Worker("memory-layout-worker.js", { type: "module" });
		worker.onmessage = (event: MessageEvent<LayoutProgress>) => {
			positions = event.data.positions;
			if (autoFit) fit(null);
			redraw();
			if (!event.data.done) return;
			worker.terminate();
			layout.clear();
			nodes.forEach((node, index) => {
				layout.set(node.id, { x: positions[index * 2], y: positions[index * 2 + 1] });
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
					: `${FACT_LABEL[node.factType].toLowerCase()} · ${incident[index].length} links${node.learnedAt ? ` · learned ${formatRelativeTime(Date.parse(node.learnedAt))}` : ""}`;
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
			controlRef.current = null;
		};
	}, [nodes, edges, degree, layout]);

	return (
		<div className="memory-canvas">
			<canvas ref={canvasRef} className="memory-galaxy" />
			<div ref={tooltipRef} className="memory-tooltip" hidden />
		</div>
	);
}
