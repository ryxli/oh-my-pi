Stage a visible scene transition after this turn is fully complete.

Use this only when the next bounded objective should begin with a fresh model context.
Provide a concise label, authoritative facts or decisions that must survive, the next objective, and its exit condition.
Set `continue: false` when the scene should be materialized but must wait for the user's next message.
The current turn is preserved in the transcript, but its dialogue is not carried into the next scene.
Background jobs remain live across the cut so preparation already in flight can deliver into the next scene.
