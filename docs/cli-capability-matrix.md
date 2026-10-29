# CLI capability matrix

## Contract and scope

All business routes below resolve in `src/api/command-routes.ts` to named
`ApplicationCommands`. `src/application/workspace-commands.ts` supplies the
workspace/actor boundary and invokes those commands directly: no browser routes,
HTTP round trips, or runtime circular imports are used inside application execution.
The executable still uses authenticated loopback management HTTP to reach the Host.
No UI assets, browser session or frontend package is needed for CLI business commands.

In the table commands omit the leading `rift`. Every `ws` command requires
`--workspace W`; bodies use `--data JSON` or `--file JSON`. Writes accept `--key K`.
Use a fresh read's `expectedVersion`/`expectedRevision`; repeat the **same input and
key** only to retrieve the original durable result. Browser and operator receipts
retain separate namespaces; keys are not portable between transports. Pending
outcomes are never automatically replayed. Events keep their existing ledger/cursors.

Global connection create/list/verify/delete, workspace create/list/overview and role
configuration are **operator-only** CLI commands. Agent `rift_cli` cannot select an
HTTP path or global command, workspace or identity. `ws connection list` intentionally
returns only current workspace bindings, not the global credential catalogue. Path
grants/revocation remain operator-only. Workspace tools retain explicit path grants
and execution-liveness checks; these are additional agent/sandbox boundaries, not a
replacement for operator trust. The browser operator can select local repository and
Skill paths directly, as before.

Management remains loopback + token + no Origin. Browser transport retains exact
Origin, Cookie, Fetch Metadata and CSRF checks. Credentials use `credentialRef` or
file input; plaintext keys are never printed or stored in business DTOs/receipts/DB.
The configured credential provider owns secret storage. `--api-key-file` reads and
trims a local secret file; protect/delete that input yourself. Inline `--data` keys
are rejected to avoid process-list/history exposure. Connections remain immutable;
create with `parentId` for a new revision. CLI verification waits up to 70 seconds (60 seconds of verification, 5 seconds of
cleanup, and 5 seconds of transport margin). Other requests retain a 35-second
limit. Timeout means **outcome unknown**, not cancellation: Host work may continue
(including a verification queued behind another operation). Keep the reported
`--key` and original input; the same-key request returns the saved result or
`OUTCOME_UNKNOWN` while pending. Never automatically replay with a new key.
Verification still requires conversation,
tool execution and confirmed cleanup; failure never changes member model selections.

## Every business HTTP entry

`ID` is the route entity ID (repository ID for worktree list/create). Query pagination
uses the same JSON fields in `ws`: task filters, message before/limit and skill runtime.
Raw legacy task reads differ intentionally from the scoped diagnostic projection;
`ws task show` supplies the diagnostic superset. `retry` only resets a task, while
`retry-dispatch` matches browser retry including review-only re-integration and dispatch.
`ws workflow report` retains its status DTO; `rift report --workflow ID` exports the redacted report file.

| HTTP entry | Application command | Executable CLI |
| --- | --- | --- |
| `GET /v1/connections` | `connection.catalogue` | `connection list` |
| `POST /v1/connections` | `connection.create` | `connection create --file JSON [--api-key-file FILE]` |
| `POST /v1/connections/:id/verify` | `connection.verify` | `connection verify ID` |
| `DELETE /v1/connections/:id` | `connection.delete` | `connection delete ID` |
| `POST /v1/workspaces` | `workspace.create` | `workspace create --name NAME [--repo PATH --base REF] [--file JSON]` |
| `POST /v1/workspaces/:workspaceId/archive` | `workspace.archive` | `ws workspace archive` |
| `GET /ui-api/v1/connections` | `connection.catalogue` | `connection list` |
| `POST /ui-api/v1/connections` | `connection.create` | `connection create --file JSON [--api-key-file FILE]` |
| `POST /ui-api/v1/connections/:id/verify` | `connection.verify` | `connection verify ID` |
| `DELETE /ui-api/v1/connections/:id` | `connection.delete` | `connection delete ID` |
| `POST /ui-api/v1/workspaces` | `workspace.create` | `workspace create --name NAME [--repo PATH --base REF] [--file JSON]` |
| `POST /ui-api/v1/workspaces/:workspaceId/archive` | `workspace.archive` | `ws workspace archive` |
| `GET /v1/doctor` | `host.doctor` | `doctor` |
| `GET /v1/workspace-summaries` | `workspace.list` | `workspace overview` |
| `GET /v1/workspaces` | `workspace.raw-list` | `workspace list` |
| `POST /v1/workspaces/:workspaceId/cli` | `workspace.cli` | `ws RESOURCE ACTION [ID] --workspace W` |
| `PUT /v1/workspaces/:id/roles` | `workspace.roles` | `role configure --workspace W --file JSON` |
| `POST /v1/workflows` | `workflow.start` | `ws workflow start` |
| `GET /v1/workflows/:id` | `workflow.raw-show` | `ws workflow show ID / status --workflow ID` |
| `POST /v1/workflows/:id/plan` | `workflow.plan` | `ws plan submit ID / plan --workflow ID --file JSON` |
| `POST /v1/workflows/:id/replan` | `workflow.replan` | `ws plan replan ID / replan --workflow ID --file JSON` |
| `POST /v1/workflows/:id/wait` | `workflow.wait` | `ws workflow wait ID` |
| `POST /v1/workflows/:id/finish` | `workflow.finish` | `ws workflow finish ID` |
| `POST /v1/workflows/:id/cancel` | `workflow.cancel` | `ws workflow cancel ID` |
| `POST /v1/workflows/:id/pause` | `workflow.pause` | `ws workflow pause ID` |
| `POST /v1/workflows/:id/resume` | `workflow.resume` | `ws workflow resume ID` |
| `POST /v1/workflows/:id/lead` | `workflow.lead` | `ws workflow lead ID` |
| `GET /v1/tasks/:id` | `task.raw-show` | `ws task show ID (scoped diagnostic superset)` |
| `POST /v1/tasks/:id/dispatch` | `task.dispatch` | `ws task dispatch ID` |
| `POST /v1/tasks/:id/integration` | `task.integration` | `ws integration request ID` |
| `POST /v1/tasks/:id/retry` | `task.retry` | `ws task retry ID` |
| `POST /v1/tasks/:id/recover-source` | `task.recover-source` | `ws task recover-source ID` |
| `POST /v1/tasks/:id/supplement-result` | `task.supplement-result` | `ws task supplement-result ID` |
| `POST /v1/tasks/:id/recover` | `task.recover` | `ws task recover ID` |
| `POST /v1/tasks/:id/cancel` | `task.cancel` | `ws task cancel ID` |
| `GET /v1/runs/:id` | `run.raw-show` | `ws run show ID` |
| `POST /v1/runs/:id/cancel` | `run.cancel` | `ws run cancel ID` |
| `GET /v1/workflows/:id/report` | `workflow.report` | `report --workflow ID` |
| `GET /v1/runs/:id/logs` | `run.logs` | `ws run logs ID` |
| `GET /ui-api/v1/workspaces` | `workspace.list` | `workspace overview` |
| `GET /ui-api/v1/workspaces/:workspaceId` | `workspace.show` | `ws workspace show` |
| `GET /ui-api/v1/workspaces/:workspaceId/snapshot` | `workspace.show` | `ws workspace show` |
| `PATCH /ui-api/v1/workspaces/:workspaceId` | `workspace.update` | `ws workspace update` |
| `GET /ui-api/v1/workspaces/:workspaceId/agents` | `agent.list` | `ws agent list` |
| `POST /ui-api/v1/workspaces/:workspaceId/agents` | `agent.create` | `ws agent create` |
| `GET /ui-api/v1/workspaces/:workspaceId/conversations` | `conversation.list` | `ws conversation list` |
| `POST /ui-api/v1/workspaces/:workspaceId/conversations` | `conversation.create` | `ws conversation create` |
| `GET /ui-api/v1/workspaces/:workspaceId/repositories` | `repository.list` | `ws repository list` |
| `POST /ui-api/v1/workspaces/:workspaceId/repositories` | `repository.connect` | `ws repository connect` |
| `GET /ui-api/v1/workspaces/:workspaceId/skills` | `skill.list` | `ws skill list` |
| `PATCH /ui-api/v1/workspaces/:workspaceId/agents/:id` | `agent.update` | `ws agent update ID` |
| `GET /ui-api/v1/workspaces/:workspaceId/conversations/:id/messages` | `message.list` | `ws message list ID` |
| `POST /ui-api/v1/workspaces/:workspaceId/conversations/:id/messages` | `message.send` | `ws message send ID` |
| `POST /ui-api/v1/workspaces/:workspaceId/messages/:id/retry-delivery` | `message.retry-delivery` | `ws message retry-delivery ID` |
| `GET /ui-api/v1/workspaces/:workspaceId/turns/:id` | `turn.show` | `ws turn show ID` |
| `POST /ui-api/v1/workspaces/:workspaceId/turns/:id/stop` | `turn.stop` | `ws turn stop ID` |
| `POST /ui-api/v1/workspaces/:workspaceId/turns/:id/reconcile` | `turn.reconcile` | `ws turn reconcile ID` |
| `GET /ui-api/v1/workspaces/:workspaceId/tasks` | `task.list` | `ws task list` |
| `GET /ui-api/v1/workspaces/:workspaceId/tasks/:id` | `task.show` | `ws task show ID` |
| `GET /ui-api/v1/workspaces/:workspaceId/tasks/:id/evidence` | `task.evidence` | `ws task evidence ID` |
| `POST /ui-api/v1/workspaces/:workspaceId/tasks/:id/evidence` | `task.supplement-evidence` | `ws task supplement-evidence ID` |
| `GET /ui-api/v1/workspaces/:workspaceId/tasks/:id/evidence/log` | `task.evidence-log` | `ws task evidence-log ID` |
| `GET /v1/workspaces/:workspaceId/tasks/:id/evidence` | `task.evidence` | `ws task evidence ID` |
| `POST /v1/workspaces/:workspaceId/tasks/:id/evidence` | `task.supplement-evidence` | `ws task supplement-evidence ID` |
| `GET /v1/workspaces/:workspaceId/tasks/:id/evidence/log` | `task.evidence-log` | `ws task evidence-log ID` |
| `POST /ui-api/v1/workspaces/:workspaceId/tasks/:id/retry` | `task.retry-dispatch` | `ws task retry-dispatch ID` |
| `POST /ui-api/v1/workspaces/:workspaceId/runs/:id/reconcile` | `run.reconcile` | `ws run reconcile ID` |
| `POST /ui-api/v1/workspaces/:workspaceId/integrations/:id/reconcile` | `integration.reconcile` | `ws integration reconcile ID` |
| `POST /ui-api/v1/workspaces/:workspaceId/workflows/:id/pause` | `workflow.pause` | `ws workflow pause ID` |
| `POST /ui-api/v1/workspaces/:workspaceId/workflows/:id/resume` | `workflow.resume-attached` | `ws workflow resume ID` |
| `POST /ui-api/v1/workspaces/:workspaceId/workflows/:id/cancel` | `workflow.cancel` | `ws workflow cancel ID` |
| `POST /ui-api/v1/workspaces/:workspaceId/workflows/:id/replan` | `workflow.replan` | `ws plan replan ID / replan --workflow ID --file JSON` |
| `GET /ui-api/v1/workspaces/:workspaceId/repositories/:id/worktrees` | `worktree.list` | `ws worktree list ID` |
| `POST /ui-api/v1/workspaces/:workspaceId/repositories/:id/worktrees` | `worktree.create` | `ws worktree create ID` |
| `POST /ui-api/v1/workspaces/:workspaceId/worktrees/:id/archive` | `worktree.archive` | `ws worktree archive ID` |
| `POST /ui-api/v1/workspaces/:workspaceId/worktrees/:id/detach` | `worktree.detach` | `ws worktree detach ID` |
| `POST /ui-api/v1/workspaces/:workspaceId/worktrees/:id/takeover` | `worktree.takeover` | `ws worktree takeover ID` |
| `POST /ui-api/v1/workspaces/:workspaceId/worktrees/:id/reconcile` | `worktree.reconcile` | `ws worktree reconcile ID` |
| `POST /ui-api/v1/workspaces/:workspaceId/worktree-removals/:kind/:id/delete` | `worktree.delete` | `ws worktree delete ID` |
| `POST /ui-api/v1/workspaces/:workspaceId/worktree-removals/:kind/:id/reconcile` | `worktree.reconcile-delete` | `ws worktree reconcile-delete ID` |
| `POST /ui-api/v1/workspaces/:workspaceId/skills/preview` | `skill.preview` | `ws skill preview` |
| `POST /ui-api/v1/workspaces/:workspaceId/skills/import` | `skill.import` | `ws skill import` |
| `PUT /ui-api/v1/workspaces/:workspaceId/skills/:id/shared` | `skill.shared` | `ws skill shared ID` |
| `POST /ui-api/v1/workspaces/:workspaceId/skills/:id/archive` | `skill.archive` | `ws skill archive ID` |
| `GET /ui-api/v1/workspaces/:workspaceId/agents/:agentId/skills/effective` | `skill.effective` | `ws skill effective AGENT_ID` |
| `PUT /ui-api/v1/workspaces/:workspaceId/agents/:agentId/skills/:id` | `skill.assign` | `ws skill assign SKILL_ID (input.agentId)` |
| `GET /v1/workspaces/:workspaceId/turns/:id` | `turn.show` | `ws turn show ID` |
| `GET /v1/workspaces/:workspaceId/conversations/:id/messages` | `message.list` | `ws message list ID` |

## Browser/transport-only exceptions (not CLI business gaps)

| Entry | Classification |
| --- | --- |
| `POST /v1/ui/bootstrap` | `rift ui [--remote]`: browser launch capability, not a business command. |
| `POST /ui-api/v1/session` | One-time bootstrap exchange; browser Cookie transport only. |
| `POST /ui-api/v1/session/connect` | Browser same-origin session establishment only. |
| `POST /ui-api/v1/session/local` | Compatibility alias for session establishment. |
| `GET /ui-api/v1/session` | Browser session/CSRF refresh only. |
| `POST /ui-api/v1/logout` | Browser Cookie revocation only. |
| `GET /ui-api/v1/workspaces/:workspaceId/events` | SSE transport; same scoped data via `ws event list --data '{"after":0}'`. |
| `GET /v1/workspaces/:workspaceId/events` | Management SSE transport; same ledger via `ws event list`. |
| `GET/HEAD /`, `/assets/*`, `/fonts/stitch/*.woff2`, favicon | Browser static transport only; not counted as CLI coverage. |

Unknown method/action combinations are rejected, including historical regex matches
such as browser workflow `retry` that never had a business handler. They are not
invented capabilities. `curl` is not counted as a CLI command.

## CLI/agent-only capabilities retained

`ws workspace paths/grant-path/revoke-path`; agent show/disable/enable;
repository show/update/disconnect; workflow list/start/lead/finish/wait/yield;
plan submit/replan; task update/delegate/dispatch/retry/recover-source/supplement-result/recover/cancel;
run list/show/logs/cancel; integration list/request; conversation show/rename/archive;
Skill show/discard-preview/restore; source read; queue list; diagnostic show.
Delegation and yield require a live coordinating chat execution, not an operator
impersonating an agent. Existing top-level serve/ui/doctor/run/plan/replan/status/logs/
cancel/retry/pause/resume/lead/report and role configuration remain available.

## Checks and exclusions

`tests/acceptance/command-unification.test.ts` checks every table route against the
actual HTTP allowlist, executable no-repository creation and no-UI connection lifecycle,
shared versions/errors/replays, secret omission and scope/permission denial. The
existing browser, management security, workspace CLI, connection and recovery tests
remain regression coverage. External model activation is substituted only in the
new connection transport test; existing connection verification tests exercise DSH.
Real external provider availability is not claimed by unit tests. Backend and UI
now share `@rift/protocol`; public connections explicitly omit `credentialRef` as
well as secret values. `pnpm build && pnpm test:built-cli` checks the built CLI
from a temporary non-repository cwd with UI disabled, including SSE and shared
workspace/plan/task commands. PR publication remains a Lead workflow gate.

Reproduction commands, local output and per-test baseline comparisons for the
review follow-up are in [CLI validation evidence](evidence/cli-command-unification/README.md).
