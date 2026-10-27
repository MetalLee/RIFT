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

Linux commands retain `/usr/bin/bwrap` mount/PID/network isolation, a cleared environment and read-only system runtimes. Public HTTP(S) connectivity is now supplied through a Host-owned Unix-socket proxy and an in-namespace TCP bridge. All DNS answers must be public IPv4, the selected address is pinned, local interface addresses/private ranges are rejected and only ports 80/443 are reachable. No Host TCP network namespace, DNS configuration, credential environment or management endpoint is shared. TLS remains end-to-end. npm, npx, Corepack/pnpm, Git HTTPS, curl and Node's environment-proxy support use this route.

Each workspace has its own persistent package HOME (`workspaces/WORKSPACE/shell-home`) and a workspace-owned installation directory even before a repository is registered. npm global prefix, npm/Corepack/pnpm caches and XDG directories point into that HOME. No package is globally installed on the Host. Shared-inode workspace files are copied through held descriptors to a new workspace inode before execution, preserving outside source bytes and allowing dependency update/removal. Initial preparation of a large linked pnpm tree may take longer; subsequent commands do not repeat copies. Out-of-root symlinks and Host/private paths remain inaccessible. Project `.codex/skills` and `.agents/skills` can be generated; auth files remain masked.

All existing workspace CLI business actions retain identity, concurrency, ownership and lifecycle validation. Operator path grants and Host connection provisioning are not delegated by Skill knowledge. Formal review/analysis stay read-only; assigning a script-containing Skill does not enable a shell in those modes.

Host-controlled Git operations disable hooks/global configuration and reject executable helper/include configuration from both local and worktree config layers. Git worktree discovery supports older Git versions without `-z`, retaining C-quoted path decoding.

## Migration and rollback

Migration 20 adds path grants and conversation archival state. It is additive. New workspace Skill records retain ordinary immutable version and execution history. Code rollback does not delete database history or attempt to undo completed business operations. Restore a pre-upgrade database backup only while the Host is stopped and only when explicitly choosing to discard later data. The delivered rollback script restores source files from a hashed archive into an explicitly named checkout; it never edits live `.rift` state.

## Installation and resource execution

`source read` still provides bounded, hashed public GitHub text directly. The project shell also supports public network installation; the proxy is configured automatically and survives neither the command nor its descendants as a Host TCP listener. The Unix gateway is shared transport only, with no workspace files or credentials in its responses.

Install the upstream CLI, generate a Skill directory, then call `skill preview`, `skill import`, `skill assign`, and `skill effective`. The tested UI/UX Pro Max flow uses `npm install -g ui-ux-pro-max-cli` and `uipro init --ai codex`, followed by importing `.agents/skills/ui-ux-pro-max`. Its data files exceed the former import limit; import now accepts 512 files, 4 MiB/file, 32 MiB/package, while instruction/context size stays 256 KiB.

For codex/dsh, selected immutable version bytes are published under workspace-owned `skill-resources`, mounted read-only in development/discussion shells, and mapped in execution instructions. `rift_skill_resource` reads only resources captured for the current execution, including formal read-only review/analysis; it neither follows installation paths nor executes scripts. Source changes and later assignment edits do not change existing snapshots. Versions, sharing and assignments remain ordinary transferable Skill records.

Existing default Skill versions remain immutable. Update an existing installation through ordinary preview/import/assignment operations; new workspaces receive the current bundled instructions. Tool descriptions advertise current execution capabilities independently of an older pinned instruction version.

Implementation references: [Node environment proxy configuration](https://nodejs.org/learn/http/enterprise-network-configuration), [npm proxy/cache/prefix configuration](https://docs.npmjs.com/cli/using-npm/config/).

Regression coverage includes public npm install/update/remove, global CLI installation, npx, pinned Corepack/pnpm, Git HTTPS, immutable Skill import/assignment/resource execution, private HOME persistence, no-repository workspace roots, private destination denial and shared inode isolation. Run external-network regression explicitly with `RIFT_NETWORK_TESTS=1 pnpm test`; the default suite skips that external dependency.

## Development permissions and recovery

`expectedPaths` is optional legacy metadata only. It is absent from execution prompts and is not consulted for file authorization, task overlap scheduling or source acceptance. Agents can add required helpers/tests inside their workspace/task checkout. All actual source changes still receive exact-commit checks and independent review. Task attempts stay monotonic history, but explicit retry has no fixed lifetime count; cleanup/version/ownership validation remains. A completed Run whose source collection failed uses `task recover-source`, preserving its commit and attempt.

Native dynamic tools have no fixed 128-call cutoff; call identities remain idempotent and scoped to the live execution. Saved model routes no longer override the provider adapter's idle timeout with RIFT's former 60-second watchdog; the installed adapter's maintained default applies (currently 300 seconds), and outer turn/Run deadlines still govern cancellation. Transport errors do not automatically replay tools.

Candidate checks/publication compare committed source and ordinary untracked files, not Git-ignored build/cache output. Archive/takeover still preserve ignored/untracked data and refuse destructive cleanup until addressed. Vitest runs the project's tests and UI tests, not stale copies inside `.rift` worktrees.

Repository preparation has no fixed file-count rejection; scanning remains cancellable. Shell calls accept longer explicit `timeoutMs` instead of rejecting anything over five minutes (the JavaScript timer ceiling and enclosing execution deadline still apply). Neither change expands mounted workspace paths.

Candidate checks receive read-only access to their repository's canonical Git metadata, so linked-worktree Git commands work without granting writes to shared refs or indexes. Registered repository counts are not a separate native-runtime permission limit.
