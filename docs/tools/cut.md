# cut

> Stage a visible fresh-context scene handoff that applies after the current turn.

## Source

- Entry: `packages/coding-agent/src/tools/cut.ts` (`CutTool`)
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/cut.md`
- Scene state: `packages/coding-agent/src/session/scene-cut.ts`
- Application: `packages/coding-agent/src/session/agent-session.ts`
- Registration: `packages/coding-agent/src/tools/index.ts`

## Registration / Visibility

- Top-level sessions only: absent when `taskDepth > 0` or the session provides no `stageSceneCut`.
- Metadata: `approval = "read"`, `strict = true`, `loadMode = "essential"`.

## Inputs

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `label` | string | yes | Short scene label. |
| `state` | string[] | yes | Authoritative facts and decisions for the next scene. |
| `objective` | string | yes | Next bounded objective. |
| `exit` | string | yes | Condition that completes the objective. |
| `continue` | boolean | no | Start the next scene automatically; defaults to `true`. |
| `evidence` | string[] | no | Evidence that supports the state. |
| `artifacts` | string[] | no | Artifact references for the next scene. |

Strings are trimmed; empty optional list items are dropped.

## Outputs

- Text: `Scene cut staged: <label>` plus the retained state-item count.
- Details: the normalized scene cut with `staged: true`.

## Flow and Side Effects

1. Validate and normalize the input.
2. Stage the cut on the session; the tool call itself changes no context.
3. After the turn settles, the session applies the staged cut: the next scene starts from a fresh context seeded with the state capsule, and `scene_cut_applied` is emitted.
4. With `continue: false`, the interactive loop pauses instead of starting the next scene.

## Limits and Errors

- Empty `label`, `objective`, or `exit`, or a `state` with no non-empty item, fails with a `ToolError`.
- A user interrupt ends a pending application.
