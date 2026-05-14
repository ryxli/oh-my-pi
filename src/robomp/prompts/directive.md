# Maintainer directive on {{repo.full_name}}#{{issue.number}}

Maintainer **@{{directive.author}}** tagged you on this issue/PR. Current PR
state: `{{state.pr_status}}`. The directive is authoritative — follow it
even if it deviates from the prior plan.

## Directive from @{{directive.author}} ({{comment.created_at}})

{{directive.body}}

---

## What to do

- **Code change requested** → commit on `{{workspace.branch}}` (do NOT open
  a second PR — push to this branch). Run the project formatter before each
  commit. After pushing, reply with a single `gh_post_comment` summarizing
  what changed in one line per concrete fix.
- **Question / clarification** → answer with a single `gh_post_comment`. No
  code change.
- **Explicit "stop" / "drop this"** → reply once acknowledging, then halt.
- **Ambiguous request** → reply with exactly one clarifying question and
  stop. Do not guess.

If the issue had a prior plan or seed todos, the directive overrides them.
You may amend or replace prior commits as long as the final state on
`{{workspace.branch}}` matches what the maintainer asked for.

All side effects go through the `gh_*` / `classify_issue` / `set_issue_labels`
host tools. NEVER shell out to `gh` or `git push`.

Terse. Technical. No emoji.
