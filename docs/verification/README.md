# Protocol extraction verification evidence

This is a documentation-only evidence supplement for `protocol-ui-extraction`.
It does not change production code, tests, configuration or protocol contracts.

## Provenance and commit binding

- [Unmodified execution record](protocol-6e89.raw.json): Lead's independent run
  via the Host `rift_exec_command` tool, 2026-10-28 08:31:40–08:32:09 UTC.
- Tested candidate: `6e89c201372410229537dd2f9ec5dbffc00b172c`.
- Development source: `f2912621b9e6ea07c2bc85a52a950f12922ab5c1`.
- Both have Git tree `cb30d9f32a7d9b5bf7456369174ec508241cf9f5`.
- Raw record SHA-256:
  `ea9a8687b0615e6c9391ac4ba282b200f16734eafbb3f6762dafada5922397ab`.
- [Local binding verification](protocol-6e89.binding.json): this development run
  verified the digest, all eight recorded exit codes, tree equality and all 667
  original tracked files. For each path from `git ls-tree -r --name-only`, current
  file bytes equal both `git show <source>:<path>` and
  `git show <tested-candidate>:<path>`. There were no mismatches.

The raw record reports that Lead also verified 667 tracked files before and after
execution. Its working directory retains the historical name `verify-8a31a8f`;
that directory label is not the tested commit identity. Candidate/tree fields and
the content comparison above bind the evidence to `6e89c201` and `f2912621`.
The supplement adds files under `docs/verification/`, so a new commit/candidate
will have a different whole Git tree. Review must verify its documentation-only
delta before reusing the execution evidence; these are not freshly rerun tests
against that new commit.

## Recorded checks

Exact command arrays, timestamps, exit codes and full stdout/stderr are in the
raw JSON, including ANSI output. The following arguments summarize the direct
Node tool invocations; **pnpm scripts were not executed in this recorded run**.

| Tool / arguments | Recorded result |
| --- | --- |
| TypeScript `-p packages/protocol/tsconfig.json` | exit 0 |
| TypeScript `--noEmit` | exit 0 |
| TypeScript `-p ui/tsconfig.json` | exit 0 |
| TypeScript `-p tests/protocol/tsconfig.json` | exit 0 |
| Node `scripts/check-protocol.mjs` | exit 0; isolated consumer, empty runtime and UI/server boundary passed |
| Vitest `run tests/protocol ui/src` | exit 0; 16 files, 68 tests passed |
| TypeScript `-p tsconfig.build.json` | exit 0 |
| Vite `build --config ui/vite.config.ts ui` | exit 0; browser module-graph guard included |

## Limits and remaining gates

- Existing installed dependencies were reused. The earlier pnpm auto-install
  attempt failed with `NO_TTY`; this record does not establish pnpm entry-point
  success, a fresh dependency installation or an empty-cache build.
- Vite emitted a greater-than-500-kB minified chunk warning (687.63 kB JS).
  Build success is not a bundle-size or performance approval.
- No browser E2E, visual verification or full backend runtime test suite was run.
  The supplement itself only validates/copies evidence and compares content.
- These are real Lead executions via a Host tool, **not automatic integration
  Host checks**, a formal review approval or task acceptance. Host source
  collection, exact-candidate checks and independent review remain separate gates.
  Backend adoption and PR publication remain follow-up Lead/integration work;
  this run does not push, create a PR or merge.
