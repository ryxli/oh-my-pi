import * as fs from "node:fs";
import path from "node:path";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { confineToWorkspace, tryRealpath } from "../tools/path-utils";
import { hasGlobPattern } from "./utils";

// Root selection only, not containment: a path that does not exist yet keeps its lexical form.
function realOrLexical(input: string): string {
	return tryRealpath(input) ?? path.resolve(input);
}

function isPathWithinRoot(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

export function resolveLspPathWithinRoot(root: string, file: string, label = "File"): string {
	// An absolute path may name another checkout; the server adds it as a workspace folder.
	if (path.isAbsolute(file)) return path.resolve(file);
	const lexicalRoot = path.resolve(root);
	// confineToWorkspace names files, so it rejects the root itself.
	if (path.resolve(lexicalRoot, file) === lexicalRoot) return lexicalRoot;
	const contained = confineToWorkspace(file, lexicalRoot);
	if (contained === null) throw new ToolError(`${label} "${file}" is outside workspace root ${lexicalRoot}`);
	return contained;
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
	for (const [index, directory] of [cwd, ...(additionalDirectories ?? [])].entries()) {
		const root = path.resolve(cwd, directory);
		const canonicalRoot = tryRealpath(root);
		// A removed added directory can serve nothing; the session cwd stays the primary root regardless.
		if (canonicalRoot === null && index > 0) continue;
		const key = canonicalRoot ?? root;
		if (canonicalRoots.has(key)) continue;
		canonicalRoots.add(key);
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

// Keep the summary within the renderer's 60-column error title and put each root on its own line.
function withRootList(summary: string, roots: readonly string[]): string {
	return [summary, ...roots.map(root => `root: ${root}`)].join("\n");
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
			? roots.filter(root => realOrLexical(root) === realOrLexical(workspace))
			: roots.filter(root => path.basename(root) === workspace);
		if (matches.length > 1) {
			throw new ToolError(withRootList(`Workspace "${workspace}" is ambiguous; pass an absolute root.`, matches));
		}
		if (matches.length === 0) {
			throw new ToolError(
				withRootList(
					`Unknown workspace "${workspace}".\nFix: /add-dir <dir> to register it (launch flag: --add-dir).`,
					roots,
				),
			);
		}
		const selected = matches[0];
		if (file && file !== "*") {
			if (globPattern) validateLspGlobWithinRoot(selected, file);
			else resolveLspPathWithinRoot(selected, file);
		}
		return selected;
	}

	if (workspaceWide && roots.length > 1) {
		throw new ToolError(withRootList("workspace is required for this action.", roots));
	}
	if (file && file !== "*" && globPattern) {
		validateLspGlobWithinRoot(roots[0], file);
	}

	if (file && file !== "*" && !globPattern) {
		if (path.isAbsolute(file)) {
			const target = realOrLexical(file);
			const matches = roots
				.filter(root => isPathWithinRoot(realOrLexical(root), target))
				.sort((a, b) => realOrLexical(b).length - realOrLexical(a).length);
			// Outside every root: the session server adds the file's checkout as a workspace folder.
			return matches[0] ?? roots[0];
		}

		const candidates = roots.map(root => resolveLspPathWithinRoot(root, file));
		const matches = roots.filter((_root, index) => fs.existsSync(candidates[index]));
		if (matches.length === 1) return matches[0];
		if (matches.length > 1) {
			throw new ToolError(withRootList(`Relative path "${file}" is ambiguous; pass workspace.`, matches));
		}
		if (roots.length > 1) {
			throw new ToolError(withRootList(`workspace is required for missing relative path "${file}".`, roots));
		}
	}

	return roots[0];
}
