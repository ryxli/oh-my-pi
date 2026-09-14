Stage a visible fresh-context handoff after a real working-set transition.

A scene boundary is a working-set discontinuity, not a workflow event. Use Cut only when ALL are true:
- The current user-requested outcome is complete or explicitly superseded.
- The next objective is already authorized and can begin without another result, retry, decision, or approval.
- Most current dialogue is irrelevant to executing it, while required facts fit in a concise state capsule.

Otherwise keep the current scene. Blocking, waiting, command completion, recovery, and a new discriminator within the same campaign are not boundaries. `continue: false` only defers an otherwise valid transition; it never creates one.
