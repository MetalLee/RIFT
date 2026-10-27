# Workspace CLI and default Skill

RIFT now exposes component administration via `rift ws`. There are no new UI controls.

```sh
node dist/cli/main.js ws --help
node dist/cli/main.js ws workspace show --workspace WORKSPACE --home RIFT_HOME
node dist/cli/main.js ws task list --workspace WORKSPACE --data '{"status":"blocked,failed"}' --home RIFT_HOME
```

The complete command vocabulary is `src/cli/workspace-commands.ts`; the bundled `skills/rift-workspace/SKILL.md` documents bodies, versions, lifecycle semantics and recovery. Use `--data JSON` or `--file FILE`, never both. Writes require a reusable `--key` for retries; without it the CLI creates a fresh request key. Output is JSON and failures exit nonzero. Do not confuse cancel, archive, disable, disconnect and physical deletion.

## Installation and assignment

The Host installs the bundled instruction-only Skill once for every existing workspace at initialization and for every newly created workspace. Initially it is explicitly assigned to Lead, not shared with everyone. It uses ordinary Skill/version/assignment tables; there is no special nontransferable entitlement. Include it for another member, share it, exclude it, archive/restore it, import new versions and switch version assignments through the usual Skill commands. Initialization preserves user changes and does not resurrect an archived Skill.

Chat executions receive normal immutable Skill snapshots. Legacy autonomous Leads also compile their effective Skill instructions at followup and expose the same `rift_cli` command gateway. An activation-only parent of a chat-owned workflow exposes no second management toolset. Existing coordination ownership and formal review/analysis restrictions remain in effect. Changing a Skill grants knowledge, not an alternate identity or a global management credential.

## Two transports, one dispatcher

- Operator executable: authenticated Host management transport `POST /v1/workspaces/:id/cli`, with `{argv:[resource,action,id?],input:{...}}`.
- Agent: `rift_cli` with the same command payload and an `idempotencyKey`. Host closures bind workspace and live execution. It is not an arbitrary shell or HTTP-path proxy. The model never receives `management.token`.

Agent collaboration messages retain member identity; operator `message send` creates a user message. `task delegate` and short-turn `workflow yield` require a live coordinating chat execution. The operator equivalents are `plan submit` + `task dispatch`, or sending a user request to the Lead. Legacy Lead collaboration uses the existing task plan/dispatch tools; directed member messaging requires a chat execution. Workflow reports are returned as JSON, not written to a caller-supplied path.

## Paths and execution

New repository associations and Skill import sources must be inside existing workspace resources or an explicit operator grant:

```sh
node dist/cli/main.js ws workspace grant-path --workspace WORKSPACE --data '{"path":"/srv/project"}' --home RIFT_HOME
node dist/cli/main.js ws repository connect --workspace WORKSPACE --data '{"repositoryPath":"/srv/project","baseRef":"HEAD","expectedVersion":0}' --home RIFT_HOME
```

Read the actual workspace version first. Granting a subdirectory does not authorize a parent Git repository. Git metadata is checked separately. Grants overlapping Host state or another workspace repository are rejected. Worktree destinations remain inside the workspace's managed directory; external worktrees require a granted source and retain the existing takeover/deletion checks. Shared physical repositories are not independently isolated project data: overlapping foreign repository/metadata roots are protected from execution rather than silently granted.

Linux repository commands use `/usr/bin/bwrap`, a new mount/PID/network namespace, a cleared environment, read-only system runtimes and explicit project mounts. Host/private directories are masked. Explicitly granted task checkouts nested below the Host directory are remounted without exposing sibling Host data. Out-of-root symlinks are inaccessible; multiply-linked/special files are rejected before execution. Model commands cannot connect to Host management HTTP or remote services. Native Codex uses restricted tool-only sessions with Host-owned `rift_exec_command`, not `danger-full-access`. DSH uses the same isolated command executor. Candidate project checks are also isolated and receive no Host credential environment.

The native model connection itself remains a Host runtime function; its credentials are not mounted into project commands. System binaries/libraries are infrastructure, not another workspace. External providers without this execution boundary fail before activation. Platforms without the verified Linux namespace executor fail closed; no unsandboxed fallback is used. Network operations such as push/PR are not enabled in project shell namespaces by this change.

Host-controlled Git operations disable hooks/global configuration and reject executable helper/include configuration from both local and worktree config layers. Git worktree discovery supports older Git versions without `-z`, retaining C-quoted path decoding.

## Migration and rollback

Migration 20 adds path grants and conversation archival state. It is additive. New workspace Skill records retain ordinary immutable version and execution history. Code rollback does not delete database history or attempt to undo completed business operations. Restore a pre-upgrade database backup only while the Host is stopped and only when explicitly choosing to discard later data. The delivered rollback script restores source files from a hashed archive into an explicitly named checkout; it never edits live `.rift` state.
