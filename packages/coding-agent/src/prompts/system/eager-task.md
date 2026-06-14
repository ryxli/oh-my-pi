<system-reminder>
Subagent delegation is preferred for this request.

Once the design is settled, you MUST drive multi-file changes, refactors, new features, test additions, and investigations through the `task` tool. Single-file edits under ~30 lines, one-shot answers, and commands the user asked you to run yourself stay in-process.

Batch independent work into one `task` call with multiple `tasks[]` entries so the subagents share `context` and run concurrently.

Do not delegate before you have a design: read the relevant code first, then fan out.
NEVER call `task` to handle this notice itself.
</system-reminder>
