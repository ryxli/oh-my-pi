/**
 * Memory page force layout, off the main thread: a 6k-node graph costs ~10 ms per
 * tick, which on the page thread made the canvas stutter for the whole settle.
 * One layout per worker; the page terminates it to cancel.
 */
import { forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationNodeDatum } from "d3-force";

export interface LayoutNode {
	isEntity: boolean;
	radius: number;
	/** Position from the previous layout, so a refresh only settles what changed. */
	x?: number;
	y?: number;
}

/** Links index into `nodes`. */
export interface LayoutLink {
	source: number;
	target: number;
	derived: boolean;
}

export interface LayoutRequest {
	nodes: LayoutNode[];
	links: LayoutLink[];
	/** Most nodes keep their previous positions: settle with a short nudge (~90 ticks) instead of from scratch (~270). */
	warm: boolean;
}

/** Interleaved x/y per node, in `nodes` order. */
export interface LayoutProgress {
	positions: Float32Array<ArrayBuffer>;
	done: boolean;
}

/** Minimum spacing of progress messages while settling; the page redraws on each. */
const POST_INTERVAL_MS = 33;

type SimNode = LayoutNode & SimulationNodeDatum;

self.onmessage = (event: MessageEvent<LayoutRequest>) => {
	const nodes: SimNode[] = event.data.nodes.map(node => ({ ...node }));
	const simulation = forceSimulation(nodes)
		.alpha(event.data.warm ? 0.1 : 1)
		.alphaDecay(event.data.warm ? 0.05 : 0.025)
		.force(
			"link",
			forceLink<SimNode, LayoutLink & { source: number | SimNode; target: number | SimNode }>(event.data.links)
				.distance(link => (link.derived ? 14 : 22))
				.strength(link => (link.derived ? 0.5 : 0.25)),
		)
		.force(
			"charge",
			forceManyBody<SimNode>()
				.strength(node => (node.isEntity ? -18 - node.radius * 4 : -5))
				.theta(0.95)
				.distanceMax(500),
		)
		.force("x", forceX<SimNode>(0).strength(0.015))
		.force("y", forceY<SimNode>(0).strength(0.02))
		.stop();
	const post = (done: boolean) => {
		const positions = new Float32Array(nodes.length * 2);
		for (let index = 0; index < nodes.length; index++) {
			positions[index * 2] = nodes[index].x!;
			positions[index * 2 + 1] = nodes[index].y!;
		}
		const progress: LayoutProgress = { positions, done };
		self.postMessage(progress, { transfer: [positions.buffer] });
	};
	let lastPost = performance.now();
	while (simulation.alpha() > simulation.alphaMin()) {
		simulation.tick();
		if (performance.now() - lastPost >= POST_INTERVAL_MS) {
			post(false);
			lastPost = performance.now();
		}
	}
	post(true);
};
