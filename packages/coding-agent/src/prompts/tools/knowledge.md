Inspect or explicitly publish shared knowledge for this session's configured domain and selected topics.
No automatic conversation capture occurs.
Generic retain, recall, reflect, memory_edit, and learn are disabled in this mode.

- `list`: return a bounded active snapshot grouped by `(topic, key)`, with current, candidate, conflict, and evidence freshness states.
- `read`: supply an active record `id` and optional zero-based `sourceIndex` (default 0) to verify and read one selected source quote, original role, timestamp and parent ID when available.
- `publish`: supply `topic`, `key`, `kind` (`decision`, `investigation`, `policy`), `origin` (`quoted`, `inferred`), `content`, `sources`, and `expectedCurrentId` (the current ID for that exact topic and key from list, or null when absent).
- `retract`: explicitly withdraw one active record by `id` in the configured domain and selected topics.

Topics are coarse responsibility allowlists, not individual decisions.
Choose a stable free-form key (1-128 characters, no surrounding whitespace) for each independent decision or finding.
Reuse its key for corrections; never supersede an unrelated key's current record.
Currentness is scoped to `(domain, topic, key)`; multiple independent keys can be current in one topic.
Pre-key records retain their original topic and lineage under key `legacy`; do not infer new decision identities from migration.

Select 1-8 sources: `{type:"file",path,quote}` for an exact configured absolute file path, or `{type:"session",entryId,quote}` for an existing current-branch message ID.
Omit `entryId` to select only the latest real user message on the current branch; the host persists its actual ID.
For an explicitly configured recorded journal, supply `{type:"session",path,sessionId,entryId,quote}`.
The path must be in `mnemopi.knowledge.sourcePaths`; the host verifies its header UUID and exact original message.
This selects recorded evidence, not the current branch or a live permission grant.
Reading returns only the selected quotes; publish additional safe excerpts separately if context is required.
The host resolves session identity, role, text, and hashes; never supply or invent provenance.
Quotes must be exact source excerpts, at most 4000 characters.
Quoted content must equal one selected quote; summaries are inferred candidates.
Assistant or agent-attributed evidence remains inferred; tool results can support quoted investigations only, never approvals.
Policy must cite a currently readable configured file and is reference only, not a new permission grant.
Stale compare-and-swap publication becomes a visible conflict; inferred publication never replaces current knowledge.
Resolve conflicts explicitly with the source owner; do not silently retract them or treat candidates as authority.
Before relying on a policy approval, read the complete current source or use its already-loaded complete current copy; an excerpt can omit exclusions or revocations.
Source hashes establish unchanged evidence, not truth or a rerun of prior checks.

This opt-in pilot requires explicit mnemopi.dbPath and bank, global scoping, and autoRetain=false.