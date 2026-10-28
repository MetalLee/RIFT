# CLI command unification: review follow-up evidence

## Attempt 5: current repair and exact-source checks

These are **local developer executions**, not Host acceptance or independent
review approval. Regression remains red; no failing assertion was removed,
skipped or mocked for this repair.

Source relationship:

- Task checkout initially had clean HEAD `aeb123c6247744209446b26f4ac4f535c6d9bb22`.
- It is an ancestor of supplied integration candidate
  `8060f71396c154703e3a7a4f01f27ef77f354881` (parents `1007bbbe` and `aeb123c`).
  This checkout was fast-forwarded to that candidate, retaining its protocol/UI.
- Diagnostic-only test repair: `ba869b566e2cec0a236d70b5afb1b03ca1c38e3c`;
  checked tree `e4d7721ca47a73ce16d605971863c71281a71b4e`.
  No production code, UI, protocol source or root manifest was changed.
- `attempt5-exact.json` records this HEAD before and after execution, empty
  tracked diffs, and matching byte-hash manifests for all 441 tracked non-doc
  files. The following evidence commit changes docs only.

### DSH failure: dependency read denied before HTTP

The original line 108 assertion hid the already retained runtime error. Its
assertion message now includes the verification result and observed requests,
using the existing credential redactor. The expectation remains `passed === true`;
all tool-round-trip, URL suffix, old stored endpoint and redacted 404 assertions
are unchanged.

The real DSH run reports:

```text
EACCES: permission denied, open '/data/projects/RIFT/node_modules/.pnpm/openai@7.19.0_@aws-sdk+credential-provider-node@3.972.88_@smithy+signature-v4@5.7.4_undici@8.11.2_ws@8.22.0_zod@4.4.3/node_modules/openai/resources/beta/agents/vaults/credentials.mjs'
```

Observed requests are `[]`, tool calls are zero, stop reason is `failed`, and
cleanup is confirmed. The error survives in both the verification result and
saved verification evidence. Independently importing that installed SDK's
`index.mjs` in a plain Node process reproduces the same EACCES with a Node module
loader stack, without RIFT verification, the HTTP fixture or DSH activation.
Thus this observed failure is a dependency-file access denial, not an observed
endpoint normalization/provider 404 failure. The precise access-policy mechanism
is not established; a filename-based filter is not assumed. No dependency file
was copied, renamed, patched or granted broader access to bypass the denial.
The remainder of this real integration scenario is **not validated** here.

### Sandbox prerequisite: nested UID mapping

A minimal unchanged Bubblewrap invocation also exits 1:

```sh
/usr/bin/bwrap --unshare-all --die-with-parent --ro-bind / / -- /bin/true
# bwrap: setting up uid map: Operation not permitted
```

The probe reports Bubblewrap 0.6.1, UID/GID 0, a single mapped UID
(`0 0 1`), `NoNewPrivs: 1`, `Seccomp: 0`, user namespaces enabled, and
`apparmor_restrict_unprivileged_userns=0`. These values alone do not establish
which outer restriction rejects mapping. All five workspace-cli failures retain
that same explicit UID-map denial; none is counted as a sandbox pass.
No sandbox code, UID settings, kernel settings or security boundary was changed.

### Commands and actual results

`attempt5-dsh-diagnostic.json` retains the first focused failure.
`attempt5-checks.json` retains initial checks, including the SDK import stack and
UID probe. Those ran on `8060f713` **with the recorded diagnostic test diff**,
not a clean exact commit: the first commit attempt failed for missing Git author
identity. An explicit per-command local author identity then created `ba869b5`.
Do not mistake those initial records for clean-candidate checks.

Offline locked installation failed for a missing Cordis tarball. Existing
installed dependencies were reused via local links; the local `@rift/protocol`
link points to this checkout. The first protocol build triggered pnpm's automatic
install/purge check and aborted for lack of TTY; the first general typecheck
therefore failed on absent protocol declarations. These failures are preserved.
With only pnpm's automatic dependency installation disabled, the existing build
script generated protocol output without changing tracked source or the sandbox:

```sh
env pnpm_config_verify_deps_before_run=false pnpm build:protocol
```

`attempt5-exact.json` then records complete command arrays, timestamps,
stdout/stderr and actual exit codes at clean `ba869b5`:

| Check | Exit | Result |
| --- | --- | --- |
| Existing protocol build script, as above | 0 | Generated protocol declarations |
| `node node_modules/typescript/bin/tsc --noEmit` | 0 | No diagnostics |
| `node node_modules/typescript/bin/tsc -p tsconfig.build.json --noEmit` | 0 | No diagnostics |
| Standalone `command-unification.test.ts` | 0 | 9/9 passed |
| Seven-file regression listed below | 1 | 41 passed, 6 failed / 47 |

For replay, use the exact command arrays in the JSON, or the seven-file list in
“Reproduce on the exact checkout” below after building the protocol. The six
failures are the same dependency-read denial and five UID-map denials; this is
not inferred from historical baseline matching. No full backend suite was rerun.

Required next environment: a Host-approved executor where normal installed
OpenAI SDK modules can be read (including the module above, **not user credential
stores**) and the existing unchanged Bubblewrap sandbox can establish its nested
UID/user namespace mappings. Supply locked dependencies/cache and build protocol
via the existing script first. Re-run the real DSH scenario and five boundary
cases there; do not remove assertions, disable sandboxing, or mark them accepted
here. Lead must independently check and review the next exact integration HEAD.

Binding and record integrity:

```sh
git diff --exit-code ba869b566e2cec0a236d70b5afb1b03ca1c38e3c HEAD -- . ':!docs'
git diff --exit-code 8060f71396c154703e3a7a4f01f27ef77f354881 HEAD -- ui packages package.json pnpm-lock.yaml pnpm-workspace.yaml
sha256sum docs/evidence/cli-command-unification/attempt5*.json
```

| Record | SHA-256 |
| --- | --- |
| `attempt5-dsh-diagnostic.json` | `bdaf8bd3c8b1eccb82b512c445985cf77d04c23cf1c256078bfd0e907261410b` |
| `attempt5-checks.json` | `f9b0bc6339ab4044b9ae601f2fedcdb463e55e90451fc8c1de8a9b043b035cd0` |
| `attempt5-exact.json` | `545350303451a14de01904bcff7372a38f5cda9042bfa02b50db8cb57751d44b` |

Skipped: full backend suite, external provider availability, backend protocol
migration and formal Host/review gates. Risk: the real integration/sandbox cases
remain unvalidated on this executor; no green regression or acceptance is claimed.

## Historical evidence (attempts 1–4; retained unchanged outputs)

Local implementation evidence, **not Host acceptance or independent approval**.
The checked source commit is `f330841844aebb441970e6ea2cea3ab0c27364d9`
(on `b1b948f0fa21435368a1c9796d4bde90b82157c2`). The following evidence
commit changes documentation/output only. Lead must still run the commands below
on the final exact integration candidate and arrange independent review.

## Lead independent execution on `39ee0a9`

The two raw records below were supplied by Lead and copied byte-for-byte after
SHA-256 verification in recovery attempt 4. These are **Lead independent shell
executions via `rift_exec_command`, not automatic Host candidate checks or an
independent review approval**. This recovery attempt did not rerun these tests.

- Exact source: `39ee0a93072558e68dd1c86182fff4a60ab941b0`.
- Exact source tree: `e10ce4951e65dc770a0891aa79da82e31088c77a`.
- `39ee.json`: SHA-256
  `7dcc96e360189e4b8f9085557ea4b5aa86624f5d4edbd81083cbd4f136dfc4d8`.
- `39ee-git-regression.json`: SHA-256
  `cbf490d3bb72635730399df0c9f3d69437a729548bc6d99e1d3c772d31c73dce`.

Lead reused installed dependencies and invoked the TypeScript/Vitest Node entry
points directly, not pnpm scripts. Commands, timestamps, stdout and stderr are
retained in the JSON files. No independent full backend suite was run.

| Lead check | Actual result | Raw record |
| --- | --- | --- |
| `tsc --noEmit` | exit 0 | `39ee.json` |
| `tsc -p tsconfig.build.json --noEmit` | exit 0 | `39ee.json` |
| Standalone command consistency | exit 0; 9 passed / 9 | `39ee.json` |
| Initial seven-file archive-only regression | exit 1; 23 passed, 24 failed / 47 | `39ee.json` |
| Seven-file regression with isolated Git metadata and HEAD at exact source | exit 1; 41 passed, 6 failed / 47 | `39ee-git-regression.json` |

The initial archive had no isolated Git metadata: fixture Git identity/HEAD
operations failed. That invalid fixture setup is not evidence of 24 application
regressions; its complete failing output is retained, not replaced. Lead then
initialized isolated Git metadata, fetched the exact source object and set HEAD
to `39ee0a9`; the corrected record reports an empty tracked diff. The remaining
six failures are five explicit Bubblewrap UID-map permission denials in
`workspace-cli.test.ts` and one actual DSH verification assertion mismatch in
`api-connection-management-review.test.ts`. The latter's root cause is not
established. Neither run is green.

The older developer full/baseline archive comparisons below are retained as
historical observations, not Lead exact-commit checks. In particular, Git-based
fixture failures in archive-only comparisons require Git-aware reproduction;
matching failures alone do not establish environmental causality or acceptance.

The attempt-4 recovery evidence commit `aeb123c` is a documentation-only
descendant of `39ee0a9`. Its production source and tests were unchanged from that
checked source. For that historical recovery commit, the binding commands were:

```sh
git diff --exit-code 39ee0a93072558e68dd1c86182fff4a60ab941b0 aeb123c -- . ':!docs'
sha256sum docs/evidence/cli-command-unification/39ee*.json
```

Formal Host checks and independent exact-candidate review remain outstanding.

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
