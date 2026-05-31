# dstui

> Mounts a safe `pi-dstui` DSL component as an interactive TUI overlay and returns its settle value.

## Source

- Entry: `packages/coding-agent/src/tools/dstui.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/dstui.md`
- Runtime: [`@oh-my-pi/pi-dstui`](../../packages/dstui/README.md)
- TUI adapter: [`@oh-my-pi/pi-dstui-tui`](../../packages/dstui-tui/README.md)
- Persistence: [`@oh-my-pi/pi-dstui-store`](../../packages/dstui-store/README.md)
- Setting: `dstui.enabled` (default `false`)

## Gating

The tool is unloaded unless **both** preconditions are true:

1. The current session is interactive (`hasUI` is true). Print mode, RPC mode, and headless agent harnesses never load it.
2. `dstui.enabled = true` in `settings.json` (or via `omp config set dstui.enabled true`).

Both checks happen inside `DstuiTool.createIf(session)`, so a non-interactive run cannot accidentally hit the runtime even if the LLM emits a stray call.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `source` | `string` | Either `source` or `store` | Inline DSL source. |
| `store` | `string` | Either `source` or `store` | Named persisted module (matches `^[a-z0-9][a-z0-9_-]{0,63}$/i`). |
| `componentName` | `string` | No | Which `defcomponent` to instantiate. Defaults to the first declaration. |
| `config` | `Record<string, unknown>` | No | Component config / params (kebab/snake/camel keys all resolve to the same DSL identifier). |
| `save` | `boolean` | No | When both `source` and `store` are set, persist the source under `store` before mounting. |
| `saveState` | `boolean` | No | When `store` is set and the overlay emits, persist the emitted value as the new instance state. |

## Outputs

- `content[0].text` is human-readable: `User confirmed: <json>` or `User cancelled the overlay`.
- `details.settle` is the raw `{ reason: "emit" | "cancel", value: unknown }` event.
- `details.source` is `"inline"` when the source came from the call, `"store"` when it was loaded from disk.

## Bundled components

The TUI adapter package ships three bundled DSL modules — `picker`, `confirm`, and `progress` — that any caller can mount directly via `mountPicker(...)`, `mountConfirm(...)`, and `mountProgress(...)` exports from `@oh-my-pi/pi-dstui-tui`. The DSL source for each is also available via `BUNDLED_DSTUI_SOURCES` and `getBundledSource(name)`.

## Safety

All safety properties of the runtime apply unchanged:

- Parser caps on source bytes, parse depth, and AST node count.
- Evaluator caps on eval steps and recursion depth — reset every render/input cycle.
- Output capped at `maxOutputRows × maxOutputColumns`; tabs expanded; ANSI and C0/C1 control sequences stripped.
- Prototype-key denial on every dynamic key access (`__proto__`, `prototype`, `constructor`).
- No `globalThis`, `eval`, `Function`, dynamic import, or filesystem builtins bound to the DSL realm.
- `emit` / `cancel` are idempotent; the first call tears down every active timer.
- Persistence stores quota source/state blobs and validate names against directory-traversal before touching disk.

## See also

- [`packages/dstui/README.md`](../../packages/dstui/README.md) — runtime overview.
- [`packages/dstui-tui/README.md`](../../packages/dstui-tui/README.md) — adapter + bundled components.
- [`packages/dstui-store/README.md`](../../packages/dstui-store/README.md) — persistence manager.
- [`unitdhda/pi-dstui`](https://github.com/unitdhda/pi-dstui) — upstream MIT-licensed DSL the shape is derived from.
