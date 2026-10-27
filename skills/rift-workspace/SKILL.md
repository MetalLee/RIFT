---
name: rift-workspace
description: Operate RIFT workspace components, members, skills, repositories, worktrees, conversations, plans, tasks, runs and recovery through the workspace CLI. Use for RIFT administration and development coordination within the current workspace.
---

# RIFT workspace operations

This ordinary Skill is installed once per workspace and initially assigned to its Lead. It may be reassigned, shared, excluded, versioned or archived through normal Skill management. Instructions do not add permissions or change the executing member's identity.

## Interface and identity

In an agent execution use `rift_cli` with `argv: [resource, action, optionalId]`, `input: { ... }`, and a stable `idempotencyKey` for every write. This invokes the same command dispatcher as the executable CLI, without shell parsing or access to a Host management token. The Host fixes the current workspace and live execution; omit workspaceId from tool input. Coordination operations still use the current Workflow owner. Formal review/analysis Runs retain their read-only tools; this Skill does not change their mode.

The operator equivalent is:

```bash
rift ws workspace show --workspace WORKSPACE --home RIFT_HOME
rift ws task list --workspace WORKSPACE --data '{"status":"blocked,failed","limit":50}'
rift ws agent update AGENT --workspace WORKSPACE --data '{"expectedVersion":2,"displayName":"Developer"}' --key unique-operation-key
rift ws --help
```

`--file FILE` accepts a JSON body instead of `--data`. CLI output is JSON; errors exit nonzero. Only the operator CLI reads Host credentials. Never search for credentials, invoke a global management endpoint, change another workspace or self-grant filesystem paths.

## Read, decide, mutate, verify

Read `workspace show` and relevant objects first. Use current `expectedVersion` or `expectedRevision`. On version conflict reload and reconsider; do not guess the next version. Repeat an uncertain write with exactly the same key and input. `REQUEST_PENDING` means inspect the object/queue/events before taking another action, not repeat with a new key. A queued receipt is not completion. Preserve task, run, message, request, version and commit IDs from actual receipts.

## Workspace, members, connections and Skills

- `workspace show|update|archive|paths`. Update accepts `expectedVersion`, optional `name`, optional `leadConnection`.
- `agent list`; `agent show|update|disable|enable ID`; `agent create`. Creation: `displayName`, `prompt`, `chatConnection` (connection or null), `purpose` (developer/reviewer), optional `name` and execution connection. Update/disable/enable need `expectedVersion`. Connections use `runtime`, `model`, optional `provider` (required for dsh), optional `reasoningEffort`. Choose at most one of `executionConnection`, `executionProviderName`, `providerBindingId`.
- `connection list` shows current workspace bindings; select a Host-provisioned connection. Change the Lead connection with `workspace update`; change member connections with `agent update`. Keep configured models unless the user requests a change.
- `skill list|preview|import`; `skill show|shared|assign|archive|restore ID`; `skill effective AGENT`; `skill discard-preview PREVIEW`.
- Preview input: `directory` (operator-granted source), optional `name`, `description`, `skillId`, `expectedRevision`, `runtimes`. Inspect returned instructions/resources, then import `{previewId}`. Updating a package creates a new immutable version.
- Shared input: `{versionId,enabled,expectedRevision}`. Assignment: `{agentId,mode,versionId?,expectedRevision}`, with mode `include|exclude|inherit`; include needs an explicit version. New assignment revision is 0. Archive/restore need `expectedRevision`. Effective input optionally selects `runtime`.
- Switch assignments to an older immutable version to roll back. Changes apply to future executions; existing execution snapshots stay unchanged. Disable sharing/exclude assignments before archiving a referenced Skill to avoid failing future executions.

## Repositories and Worktrees

- `repository list`; `repository show|update|disconnect ID`; `repository connect` with `{repositoryPath,baseRef,expectedVersion}`. Update needs the workspace `expectedVersion` and `baseRef`. Disconnect needs workspace `expectedVersion`; referenced history is retained and may prevent disconnection.
- `workspace paths` lists granted source roots. `workspace grant-path|revoke-path` with `{path}` are operator-only. Ask the operator to provision a resource before importing or associating a path beyond existing roots. Path strings in messages never grant access.
- `worktree list|removals REPOSITORY`; `worktree create REPOSITORY` with `{origin:"managed"|"external",path?,baseRef?,branch?}`. External association needs an existing granted `path`, and preserves its branch/HEAD.
- `worktree takeover ID` needs `{expectedVersion,confirmExclusiveOwnership:true,destinationPath?}`. The external checkout must be clean, unused and moved into this workspace's managed directory. `detach` only removes an external association. `archive` removes a managed checkout with the deletion checks.
- `worktree delete|reconcile-delete ID` uses `{kind:"user"|"task"|"candidate"|"review",expectedVersion,confirmDelete:true}` (omit confirmDelete on reconcile). Obtain deletion versions from `worktree removals`; they are distinct from object versions. `worktree reconcile ID` needs object `expectedVersion` and verifies unfinished creation/movement.
- Do not delete directories by shell to bypass receipts. Preserve dirty contents, active leases and unknown cleanup.

## Workflows, plans and tasks

- `workflow list`; `workflow show|pause|resume|cancel|lead|finish|report|wait|yield ID`; `workflow start` with `{goal,mode:"code"|"analysis",repositoryIds?}`. Operators may set `startLead:false`. Multi-repository code workflows select repositories explicitly. One nonterminal workflow per workspace.
- `plan submit WORKFLOW` uses `{expectedRevision,tasks,acceptanceCriteria?}`. Each task has `kind`, `title`, `instructions`, `expectedPaths`; optionally `id`, `repositoryId`, `roleName`, `acceptanceCriteria`, `dependsOn`, `priority`, and analysis-only `analysisItems`. Code tasks select one repository. Text-only analysis does not require Git.
- `plan replan WORKFLOW` uses `{expectedRevision,updates:[{taskId,expectedVersion,dependsOn?,priority?}],tasks?}`; only unstarted work may be replanned.
- `task list` filters by status, workflowId, roleId, repositoryId, kind, limit and after. `task show|evidence ID` reports state and acceptance evidence.
- `task update ID` edits undispatched task title/instructions/expectedPaths/acceptanceCriteria with `expectedVersion`. It never rewrites completed or dispatched history.
- `task dispatch ID`: `{expectedVersion,idempotencyKey,roleName?}`. `task delegate` (live Lead): either `{taskId,expectedTaskVersion}` or `{taskDraft,expectedPlanRevision}`, plus `{recipientAgentId,message,idempotencyKey}`. Delegation atomically records assignment, message and dispatch.
- In short coordination turns, dispatch independent work then `workflow yield ID` with `{summary,taskIds?,requestIds?}` and end the turn. Events resume the Lead. Do not poll/wait while holding the Lead decision or a member needed by the task. In non-short mode `workflow wait` accepts `{runIds?,requestIds?,afterEventSeq?,timeoutMs?}`; provide at least one ID list.

## Checks, review and completion

`integration request TASK` accepts `{sourceHead,expectedVersion,idempotencyKey}` and requests exact-commit checking and independent review. `integration list`, `task evidence`, `run logs` and `workflow report` expose real results. Development completion, a Git commit, a member message or a dispatch receipt is not acceptance. `workflow finish ID` needs `{summary}` and succeeds only after the Host acceptance/cleanup gates pass. Never modify evidence or report unexecuted checks as passed.

## Conversations and member messages

- `conversation list|create`; creation input optionally sets `title`. `conversation show|rename|archive ID`; rename needs `{expectedVersion,title}`, archive needs `{expectedVersion}`. Archive retains history and is blocked by unfinished work.
- `message list CONVERSATION` accepts `{before?,limit?}`. Operator `message send CONVERSATION` accepts `{clientMessageId,content,recipientAgentId?,contextRefs?,mentions?}` and creates a user message.
- Agent `message send CURRENT_CONVERSATION` accepts `{recipientAgentId,content,kind?,taskId?,replyToMessageId?,idempotencyKey}`. It preserves member identity and never impersonates a user. Kind is discussion/progress/blocker. Use task delegation for assignments, not prose alone.
- `message retry-delivery MESSAGE` retries a failed delivery without duplicating content. `turn show|stop|reconcile TURN` inspects/stops/reconciles discussion execution; reconcile needs `expectedVersion`.

## Recovery and diagnosis

`diagnostic show`, `queue list`, `event list {after}` and `run list|show|logs` inspect only the current workspace. Save event cursors; a replay gap requires a fresh workspace snapshot.

`workflow pause|resume` needs `expectedVersion`. Pause stops new scheduling while existing executions settle. Cancel Workflow/Task/Run through their `cancel` command; inspect cleanup afterwards. `task retry ID` needs `{expectedVersion,reason}` and creates a repair attempt; dispatch it separately. `task recover-source ID` needs `expectedVersion` and recovers recorded source evidence without rerunning development. Retry integration for a failed review with an existing verified source commit. `run reconcile` and `integration reconcile` need `expectedVersion` and real process-cleanup evidence, not a status override. Preserve unknown executions after a restart; never free leases or replay uncertain side effects by editing the database.

## File and execution boundary

Repository execution uses Host-provided tools in an isolated filesystem/network environment. Only registered workspace repository/worktree paths are project data; system runtime files are read-only infrastructure. Host home, credentials, sibling workspaces, symlink escapes, arbitrary mounts and Host management HTTP access are not granted. No unsandboxed fallback is permitted when isolation is unavailable. Remote network operations require a separately provisioned Host capability; a shell command does not grant one. The CLI itself performs business operations through scoped services and never requires an agent to access the Host database or management token.
