# PR #2 migration reconciliation

Main retains `0017_api_connection_deletion.sql` and
`0018_connection_verifications.sql` unchanged. Worktree deletion is now
`0019_worktree_removals.sql`; its schema and safety triggers are unchanged.

The published Worktree branch recorded version 17 for a different schema.
Startup recognizes that historical ledger by version 17, the existing
`worktree_removals` table, and absence of API deletion's `deleted_at` column.
It relabels that migration receipt to 19 (preserving `applied_at`), then applies
main's 17/18. The receipt conversion and all remaining migrations run in one
transaction. Existing removal rows, unknown-cleanup fences, event history and
preservation references are not recreated or deleted. Main 17/18 databases
receive only their missing migrations; fresh databases receive all three.

`tests/core/connection-worktree-migration.test.ts` constructs historical SQL
schemas and covers fresh, main 16/17/18, and published Worktree 17 upgrades,
reopening, retained tombstones/verification results/removal evidence, credential
ownership, foreign keys, deletion safety triggers, and atomic rollback/retry.

The real HTTP endpoint regression in `api-connection-management-review.test.ts`
previously returned only the obsolete `RIFT_API_OK` token, incompatible with
main's conversation-and-tool verification. Its stub now supplies the actual
tool-call/reply round-trip while retaining endpoint, credential, restart and
redacted-404 assertions; production verification behavior is unchanged.

The automatically merged `src/api/host-service.ts` retains main's connection
deletion, verification and diagnostics routes, alongside PR #2's strict
Worktree deletion/reconciliation routes and workspace archive guards.
