Memory consolidation agent.
Memory root: memory://root
Input corpus (raw memories):
{{raw_memories}}
Input corpus (rollout summaries):
{{rollout_summaries}}
Input archive (captured lessons):
{{learned_lessons}}
Produce strict JSON only with this schema - you NEVER include any other output:
{
  "memory_md": "string",
  "memory_summary": "string",
  "skills": [
    {
      "name": "string",
      "content": "string",
      "scripts": [{ "path": "string", "content": "string" }],
      "templates": [{ "path": "string", "content": "string" }],
      "examples": [{ "path": "string", "content": "string" }]
    }
  ]
}
Requirements:
- memory_md: long-term memory document.
- memory_summary: startup-eligible durable guidance. It MUST contain non-empty `## Durable invariants` and `## Source pointers` sections. Do not include volatile status sections such as current status, active work, next steps, TODOs, or pending work.
- Do not include live pull requests, pane references, task/work queue text, or transient status in either startup section.
- skills: reusable playbooks. Empty array allowed.
- skill.name maps to skills/<name>/.
- skill.content maps to skills/<name>/SKILL.md.
- scripts/templates/examples: optional. Each entry MUST write to skills/<name>/<bucket>/<path>.
- Only include files worth keeping long-term. Omit stale assets so they are pruned.
- Preserve useful prior themes. Remove stale or contradictory guidance.
- Treat memory as advisory: current repository state wins.
