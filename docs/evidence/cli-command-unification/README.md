# CLI command unification: review follow-up evidence

Local implementation evidence, **not Host acceptance or independent approval**.
The checked source commit is `f330841844aebb441970e6ea2cea3ab0c27364d9`
(on `b1b948f0fa21435368a1c9796d4bde90b82157c2`). The following evidence
commit changes documentation/output only. Lead must still run the commands below
on the final exact integration candidate and arrange independent review.

## Reproduce on the exact checkout

Node `v24.18.0`, pnpm `11.4.0`, Vitest `4.0.18`; locked dependencies installed
with `pnpm install --frozen-lockfile --offline` (use the normal locked install if
not cached). No UI build or assets are required. Do not disable the sandbox to
make the failures below green.

Run from the candidate root, preserving the printed HEAD with the output:

```sh
git rev-parse HEAD
git status --short
pnpm exec tsc --noEmit
pnpm exec tsc -p tsconfig.build.json --noEmit
pnpm exec vitest run \
  tests/acceptance/command-unification.test.ts \
  tests/acceptance/workspace-cli.test.ts \
  tests/acceptance/browser-service.test.ts \
  tests/acceptance/management-security.test.ts \
  tests/acceptance/api-connection-management-review.test.ts \
  tests/core/connection-verification.test.ts \
  tests/core/chat-connection-recovery.test.ts
# Complete backend suite, including the same consistency coverage:
pnpm exec vitest run tests --reporter=json --outputFile=backend-results.json
```

| Check at checked source commit | Actual result | Persisted output |
| --- | --- | --- |
| `tsc --noEmit` | exit 0 | `typecheck.log` (empty: no diagnostics) |
| build `tsc --noEmit` | exit 0 | `build-typecheck.log` (empty) |
| Seven-file regression above | exit 1; 41 passed, 6 failed / 47 | `regression.log` |
| Backend full | exit 1; 459 passed, 35 failed, 1 skipped / 495 | `full.json`, `full.log` |
| Baseline backend full | exit 1; 448 passed, 37 failed, 1 skipped / 486 | `baseline-full.json`, `baseline-full.log` |

`focused.log` additionally records the standalone consistency file: 9/9 passed.
The six seven-file failures are one actual-DSH verification assertion in
`api-connection-management-review` and five explicit Bubblewrap UID-map failures
in `workspace-cli`. They are **not omitted from this command**.

## Verification timeout regression

The executable calls `managementRequest` from `src/cli/client.ts`. The new tests
use that exact client over real loopback HTTP, authentication/idempotency,
`ApplicationCommands`, and `ApiConnectionService`. Only external DSH activation
is replaced. Global timeout functions use deterministic virtual time; HTTP and
filesystem operations are real. Existing subprocess tests still exercise the
CLI parser, route selection, and immediate connection lifecycle.

The four added cases cover:

- Work completes at 40 seconds; no early exit at 35 seconds, result waits for
  4 seconds of confirmed cleanup and same-key retrieval does not activate again.
- Work times out at 60 seconds; client receives the actual failed verification
  after 4 seconds of cleanup rather than reporting a transport timeout.
- Work times out at 60 seconds and cleanup reaches its 5-second bound; the actual
  failed/cleanup-unconfirmed result is returned at 65 seconds.
- Two serialized verifications: second exceeds the client's 70-second bound.
  Error explicitly says outcome unknown and retains the key. The Host still has
  a pending receipt; same-key inspection returns `OUTCOME_UNKNOWN`. When the
  original finishes, the same key retrieves its saved result with exactly two
  total activations: no automatic replay or replacement key.

The service remains unchanged (60 seconds + 5 seconds cleanup). Client verify
waits 70 seconds, including a 5-second transport margin. Other requests retain
35 seconds. Node HTTP `server.requestTimeout=35000` limits receipt of the request
body, not response execution; it is not the review's client-side response limit.
Queue delays, an unresponsive Host, or slow transport may still exceed 70 seconds;
this is intentionally bounded and reported as uncertain, not as cancellation.

## Original-baseline comparison

Original pre-unification baseline: `8ba4398bf0e563f5a77d908bf1ffb6cdeb97530d`.
A fresh `git archive` was extracted **inside this task worktree**, reusing the
same installed dependencies without changing any previous checkout or the main
checkout. The snapshot was removed after testing. Reproduce, choosing a fresh
scratch name:

```sh
mkdir .cli-baseline
git archive 8ba4398bf0e563f5a77d908bf1ffb6cdeb97530d | tar -x -C .cli-baseline
ln -s ../node_modules .cli-baseline/node_modules
(cd .cli-baseline && node node_modules/vitest/vitest.mjs run tests \
  --reporter=json --outputFile=../baseline-results.json)
```

Direct Node invocation deliberately avoids pnpm's automatic nested-workspace
install/purge check when using the shared dependency symlink.

All current 35 failing test names also failed at that baseline. Two native
wrapper tests fail only in the baseline run and pass in the current run; no
causal improvement is inferred. Full assertion statuses/stacks are retained in
the two JSON reports. [failures.md](failures.md) lists every failure;
`failure-comparison.json` supplies machine-readable names, both statuses, and
first failure messages.

Observations, **not blanket environment attribution**:

- 8 failures explicitly show `bwrap: setting up uid map: Operation not permitted`.
- 6 show actual DSH adapter/verification assertion mismatches.
- 11 show Git deterministic `CHECK_FAILED` errors.
- The previously un-attributed 10 are now individually baseline-reproduced:
  six core-integration review waits, blocked recovery review readiness, live DSH
  streaming, multi-repository UI review pre-check, and quarantine rejection.
  Their causal chains are not established merely by baseline reproduction.

Skipped: external provider availability, UI/protocol migration and Host exact-
candidate acceptance. Risk: full regression remains red; baseline reproduction
is evidence for triage, not permission to weaken or waive acceptance.
