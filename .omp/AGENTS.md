# oh-my-pi repo invariants

Replaces the upstream root AGENTS.md for this fork (.omp/AGENTS.md shadows it at the same depth).
Only rules specific to this repo; general doctrine lives in the global AGENTS.md.

## Scope

- "agent" means the coding-agent package (`packages/coding-agent/`), the default focus, not the assistant.

## Commands

- Typecheck with `bun check`; never `tsc`.
- Rust tests: `bun run test:rs`; never `cargo test`.
- New or changed worker: verify with `omp --smoke-test`.

## Model and provider policy

- Never branch on model or provider identity in TS (no id string matching, no per-model tables).
- Policy lives in the KDL tree `packages/catalog/src/compat/rules/` (see its README); TS may branch only on `classifyModel()` facts.
- After KDL edits run `bun run gen:compat` and commit `rules.json` with the `.kdl` change.
- Resolve `AmbiguousOverlapError` with explicit `priority=` in KDL, not code.
- Import catalog values from `@oh-my-pi/pi-catalog/<module>`, never via `@oh-my-pi/pi-ai`; type-only imports from pi-ai are fine.

## Generated files

- Never hand-edit `packages/catalog/src/models.json` or `packages/catalog/src/compat/rules.json`.
- Fix the source instead: KDL rules, `CATALOG_PROVIDERS` in `provider-models/descriptors.ts`, mappers in `provider-models/openai-compat.ts`, or `scripts/generate-models.ts`; then `bun run gen:models` / `gen:compat`.
- Regression tests target the rule, descriptor, or mapper, not the bundled JSON.

## TypeScript conventions

- No inline imports (`await import()`, `import("pkg").Type`); no `ReturnType<>`.
- ES `#private` members; no `private`/`protected`/`public` keywords except constructor parameter properties.
- `Promise.withResolvers()` over `new Promise(...)`; `Bun.sleep` over timeout promises.
- Prompts live in static `.md` files imported `with { type: "text" }`, templated with Handlebars; never build prompt text in code.
- Barrels use `export * from`.
- Prefer Bun APIs (`Bun.file`, `Bun.write`, `$`, `Bun.spawn`) over `node:*` equivalents; namespace-import `node:fs`, `node:path`, `node:os`; never shell out for operations with an API.
- Run git/jj only through `@oh-my-pi/pi-natives/vcs` and `src/utils/active-repo-context.ts`; search `src/utils/`, `@oh-my-pi/pi-utils`, and `@oh-my-pi/pi-tui` before writing a helper.

## Workers

- Workers re-enter the CLI entrypoint via `workerHostEntry()`; never add separate worker entry modules or bundle entries.
- New worker kinds add an `__omp_worker_<name>` selector to the dispatch table in `cli.ts` and keep the direct-module fallback for `bun test`/SDK hosts.

## Output and rendering

- No `console.*` in code that can run under TUI, RPC, SDK, or workers; use `logger` from `@oh-my-pi/pi-utils`.
- Every tool render path, including errors and streaming previews, sanitizes with `replaceTabs`, `truncateToWidth`/`TRUNCATE_LENGTHS`, `shortenPath`, and `PREVIEW_LIMITS`.
- Streamed tool args decode through `decodeStreamedToolArgs` / `ToolArgsRevealController` on both live and transcript-rebuild paths.
- Bash previews: preserve `__partialJson` through `event-controller.ts`, `ui-helpers.ts`, and `tool-execution.ts`; verify live streaming and rebuilt transcripts separately.

## Tests

- Never `mock.module()`; it leaks across files. Use `spyOn` on the imported module object.
- Tests must be full-suite safe: no file-wide mutation of `Bun.*`, `process.platform`, or env; restore per test.
- Never assert on implementation source text.

## Rust

- Never set `split-debuginfo = "off"` on a profile with debuginfo; Mach-O backtraces silently lose file:line.
