import * as fs from "node:fs";
import path from "node:path";
import { ToolError } from "../tools/tool-errors";
import { hasGlobPattern } from "./utils";

function canonicalizeLspPath(input: string): string {
	const suffix: string[] = [];
	let existing = path.resolve(input);
	while (!fs.existsSync(existing)) {
		const parent = path.dirname(existing);
		if (parent === existing) break;
		suffix.unshift(path.basename(existing));
		existing = parent;
	}
	const canonicalAncestor = fs.realpathSync(existing);
	return path.resolve(canonicalAncestor, ...suffix);
}

function isPathWithinRoot(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

export function resolveLspPathWithinRoot(root: string, file: string, label = "File"): string {
	const lexicalRoot = path.resolve(root);
	const lexicalTarget = path.isAbsolute(file) ? path.resolve(file) : path.resolve(lexicalRoot, file);
	const canonicalRoot = canonicalizeLspPath(lexicalRoot);
	const canonicalTarget = canonicalizeLspPath(lexicalTarget);
	if (!isPathWithinRoot(canonicalRoot, canonicalTarget)) {
		throw new ToolError(`${label} "${file}" is outside workspace root ${lexicalRoot}`);
	}
	return lexicalTarget;
}

function validateLspGlobWithinRoot(root: string, pattern: string): void {
	let branches = [pattern];
	for (let depth = 0; depth < 8; depth++) {
		let expanded = false;
		const next: string[] = [];
		for (const branch of branches) {
			const braces = /\{([^{}]+)\}/.exec(branch);
			if (!braces) {
				next.push(branch);
				continue;
			}
			expanded = true;
			for (const alternative of braces[1].split(",")) {
				next.push(`${branch.slice(0, braces.index)}${alternative}${branch.slice(braces.index + braces[0].length)}`);
			}
		}
		if (next.length > 64) throw new ToolError("Glob has too many brace alternatives");
		branches = next;
		if (!expanded) break;
	}
	if (branches.some(branch => /\{[^{}]+\}/.test(branch))) {
		throw new ToolError("Glob brace alternatives are too deeply nested");
	}

	for (const branch of branches) {
		if (branch.split(/[\\/]/).includes("..")) {
			throw new ToolError(`Glob "${pattern}" escapes workspace root ${path.resolve(root)}`);
		}
		const wildcardIndex = branch.search(/[*?[{]/);
		const prefix = wildcardIndex < 0 ? branch : branch.slice(0, wildcardIndex);
		const anchor =
			prefix === "" ? "." : prefix.endsWith("/") || prefix.endsWith(path.sep) ? prefix : path.dirname(prefix);
		resolveLspPathWithinRoot(root, anchor, "Glob");
	}
}

export function getLspWorkspaceRoots(cwd: string, additionalDirectories?: readonly string[]): string[] {
	const roots: string[] = [];
	const canonicalRoots = new Set<string>();
	for (const directory of [cwd, ...(additionalDirectories ?? [])]) {
		const root = path.resolve(cwd, directory);
		const canonicalRoot = canonicalizeLspPath(root);
		if (canonicalRoots.has(canonicalRoot)) continue;
		canonicalRoots.add(canonicalRoot);
		roots.push(root);
	}
	return roots;
}

export function isLspWorkspaceWideAction(action: string, file?: string, roots?: readonly string[]): boolean {
	const existingConcrete =
		!!file &&
		file !== "*" &&
		roots?.some(root => fs.existsSync(path.isAbsolute(file) ? file : path.resolve(root, file)));
	return (
		file === "*" ||
		(action === "reload" && !file) ||
		(action === "symbols" && !file) ||
		((action === "capabilities" || action === "request") && !file) ||
		(action === "diagnostics" && !!file && hasGlobPattern(file) && !existingConcrete)
	);
}

export function resolveLspWorkspaceRoot(
	roots: readonly string[],
	options: { workspace?: string; file?: string; workspaceWide?: boolean },
): string {
	const { workspace, file, workspaceWide } = options;
	if (roots.length === 0) throw new ToolError("No LSP workspace roots configured");
	if (file && file !== "*" && !path.isAbsolute(file) && !isPathWithinRoot(roots[0], path.resolve(roots[0], file))) {
		throw new ToolError(`File "${file}" escapes workspace roots`);
	}
	const existingConcrete =
		!!file &&
		file !== "*" &&
		roots.some(root => fs.existsSync(path.isAbsolute(file) ? file : path.resolve(root, file)));
	const globPattern = !!file && hasGlobPattern(file) && !existingConcrete;
	if (workspace) {
		const matches = path.isAbsolute(workspace)
			? roots.filter(root => canonicalizeLspPath(root) === canonicalizeLspPath(workspace))
			: roots.filter(root => path.basename(root) === workspace);
		if (matches.length > 1) {
			throw new ToolError(`Workspace "${workspace}" is ambiguous. Choose an absolute root: ${matches.join(", ")}`);
		}
		if (matches.length === 0) {
			throw new ToolError(`Unknown workspace "${workspace}". Choose one of: ${roots.join(", ")}`);
		}
		const selected = matches[0];
		if (file && file !== "*") {
			if (globPattern) validateLspGlobWithinRoot(selected, file);
			else resolveLspPathWithinRoot(selected, file);
		}
		return selected;
	}

	if (workspaceWide && roots.length > 1) {
		throw new ToolError(`workspace is required for this action. Choose one of: ${roots.join(", ")}`);
	}
	if (file && file !== "*" && globPattern) {
		validateLspGlobWithinRoot(roots[0], file);
	}

	if (file && file !== "*" && !globPattern) {
		if (path.isAbsolute(file)) {
			const target = canonicalizeLspPath(file);
			const matches = roots
				.filter(root => isPathWithinRoot(canonicalizeLspPath(root), target))
				.sort((a, b) => canonicalizeLspPath(b).length - canonicalizeLspPath(a).length);
			if (matches.length > 0) return matches[0];
			throw new ToolError(`File is outside all workspace roots. Choose one of: ${roots.join(", ")}`);
		}

		const candidates = roots.map(root => resolveLspPathWithinRoot(root, file));
		const matches = roots.filter((_root, index) => fs.existsSync(candidates[index]));
		if (matches.length === 1) return matches[0];
		if (matches.length > 1) {
			throw new ToolError(`Relative path "${file}" is ambiguous. Choose a workspace root: ${matches.join(", ")}`);
		}
		if (roots.length > 1) {
			throw new ToolError(
				`workspace is required for missing relative path "${file}". Choose one of: ${roots.join(", ")}`,
			);
		}
	}

	return roots[0];
}
