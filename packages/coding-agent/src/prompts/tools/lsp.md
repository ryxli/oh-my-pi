Symbol-aware code intelligence from language servers — navigation, refactors, and diagnostics where text tools miss callsites.

<operations>
- Position-based: `file` + `line` + `symbol` (substring; `#N` for Nth match). `line` is 1-indexed.
- `rename` — applies by default; `apply: false` previews. Project-aware lookups ERROR without `symbol` — no silent fallback on missing/ambiguous matches.
- `code_actions` — lists by default; apply ONE with `apply: true` + `query` (title substring or index).
- `rename_file` — moves file AND rewrites all imports/references; applies by default.
- `diagnostics` — path, glob (`src/**/*.ts`), or `file: "*"` for workspace.
- `symbols` — `file` lists file symbols; `file: "*"` + `query` searches workspace.
- `reload` — restart one server (`file`) or all (`*`); `reload *` re-reads LSP config.
- `request` — raw: `query` = method, `payload` = JSON params (else auto-built).
</operations>

<guidance>
- Prefer LSP for semantic renames and uncertain references: it follows shadowing, re-exports, and cross-file usages that text replacement can miss.
- Batch related reference and diagnostic queries. A complete supplied change need not repeat discovery for every symbol.
- Use code actions when they simplify the change; coordinated edits and compiler-driven repairs are also valid.
</guidance>
