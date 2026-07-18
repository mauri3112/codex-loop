# Runtime safety

Starting or resuming can run commands, edit mounted repositories, and call bound external systems. Verify the exact Loop revision and bindings first. Describe expected effects and obtain explicit user intent.

Pausing prevents new scheduling but may leave active turns running. Stopping interrupts active turns and does not reverse completed file or external changes. Completed checkpoints remain available for a later resume when their workflow revision, node definition, input, and repository revision still match.
