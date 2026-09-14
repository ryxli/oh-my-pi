import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { TaskItem } from "@oh-my-pi/pi-tui/tools/task";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { resolveSyscallTarget } from "../tools/path-utils";

interface ExecuteWriteSnapshot {
	declaredPath: string;
	existed: boolean;
	digest?: string;
}

export interface ExecuteYieldGuard {
	cwd: string;
	initialSnapshots: ExecuteWriteSnapshot[];
}

/** Preserve each entry boundary's diagnostics while sharing the execution contract. */
export function validateExecuteMode(item: Pick<TaskItem, "mode" | "writes">, label?: string): string | undefined {
	if (label !== undefined && item.mode !== undefined && item.mode !== "execute") {
		return `${label} has an invalid \`mode\` value ${JSON.stringify(item.mode)}. Use "execute".`;
	}
	if (item.mode !== "execute") {
		if (item.writes === undefined) return undefined;
		return label === undefined
			? 'Declared writes require mode: "execute".'
			: `${label} provides \`writes\` without \`mode: "execute"\`.`;
	}
	if (
		!Array.isArray(item.writes) ||
		item.writes.length === 0 ||
		item.writes.some(write => typeof write !== "string" || write.trim() === "")
	) {
		return label === undefined
			? "Execute mode requires a non-empty writes list of workspace-relative file paths."
			: `${label} uses \`mode: "execute"\`, which requires a non-empty \`writes\` list of workspace-relative file paths.`;
	}
	return undefined;
}

function isWithinDirectory(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export async function snapshotExecuteWrite(cwd: string, declaredPath: string): Promise<ExecuteWriteSnapshot> {
	if (path.isAbsolute(declaredPath) || path.win32.isAbsolute(declaredPath)) {
		throw new Error(`Declared execute target \`${declaredPath}\` must be workspace-relative, not absolute.`);
	}
	const resolvedCwd = path.resolve(cwd);
	const filePath = path.resolve(resolvedCwd, declaredPath);
	if (!isWithinDirectory(resolvedCwd, filePath)) {
		throw new Error(`Declared execute target \`${declaredPath}\` traverses outside the child workspace.`);
	}
	const realCwd = await fs.realpath(resolvedCwd);
	const realPath = await resolveSyscallTarget(filePath, true);
	if (realPath === null) {
		throw new Error(`Declared execute target \`${declaredPath}\` cannot be resolved.`);
	}
	if (!isWithinDirectory(realCwd, realPath)) {
		throw new Error(
			`Declared execute target \`${declaredPath}\` resolves outside the child workspace through a symlink.`,
		);
	}
	try {
		const targetStat = await fs.stat(realPath);
		if (!targetStat.isFile()) {
			throw new Error(`Declared execute target \`${declaredPath}\` must be a file.`);
		}
	} catch (error) {
		if (!isEnoent(error)) throw error;
		return { declaredPath, existed: false };
	}
	const digest = new Bun.CryptoHasher("sha256").update(await Bun.file(realPath).arrayBuffer()).digest("hex");
	return { declaredPath, existed: true, digest };
}

export async function executeWritesChanged(cwd: string, initial: readonly ExecuteWriteSnapshot[]): Promise<boolean> {
	let changed = false;
	for (const snapshot of initial) {
		const current = await snapshotExecuteWrite(cwd, snapshot.declaredPath);
		if (current.existed !== snapshot.existed || current.digest !== snapshot.digest) changed = true;
	}
	return changed;
}
