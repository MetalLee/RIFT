# UI audit regression

From the repository root (dependencies must already be installed):

```sh
UI_EVIDENCE_DIR=/absolute/path/out node scripts/ui-regression/check.mjs
```

Optional `PLAYWRIGHT_PATH` points to an installed Playwright package; `CHROMIUM_PATH`
points to a cached Chromium binary. Defaults are the task's Host-provided tools.
The script uses this checkout's actual Vite config on `127.0.0.1:5209`, mocks every
`/ui-api/` request and aborts non-local network requests. No real business writes
or model calls. Unexpected endpoints fail the run. Browser and server close in
`finally`. A failed assertion returns exit 1, with measurements and a diagnostic
screenshot retained. Output includes the source HEAD and dirty-tree status.

Coverage: eight pages at 390/768/1280; four settings tabs; keyboard entry, focus
return, selected semantics, archive/cancel/reference guard, per-connection errors,
drafts, task/settings history, copy rejection/fallback, stale observations,
long models, responsive detail navigation, touch bounds/hit testing and contrast.
The measurements are not a screen-reader, real-device or backend acceptance test.
Images and opacity ancestors are excluded from the generic contrast sampler;
decorative slashes and disabled controls are not normal text failures.

Focused review regressions (reuse the previous unaffected visual evidence):

```sh
UI_CHECK_FILTER='^(tasks-(390|768|1280)|detail-.*|task-history-.*|task-filter-pagination|skill-import-validation|deep-links-evidence|narrow-deep-link-keyboard|connection-recovery|form-error-drafts)$' UI_EVIDENCE_DIR=/absolute/path/out node scripts/ui-regression/check.mjs
```

Only executed checks are recorded; skipped checks are not reported as passes.

Explicit task target identity (delayed snapshot-external reads, 503/retry,
same-target refresh retention, A→B late success/failure and evidence isolation):

```sh
UI_CHECK_FILTER='^(tasks-(390|768|1280)|detail-tasks-.*|task-history-.*|task-filter-pagination|task-target-.*|deep-links-evidence|narrow-deep-link-keyboard)$' UI_EVIDENCE_DIR=/absolute/path/out node scripts/ui-regression/check.mjs
```

Task reads use manually released mock gates rather than assuming a network delay.
Unresolved explicit targets must not mount another task's details or evidence.

Shared page gutters (rendered geometry, not CSS string matching):

```sh
UI_CHECK_FILTER='^layout-' UI_EVIDENCE_DIR="$PWD/.runtime-evidence/page-gutters" node scripts/ui-regression/check.mjs
```

Covers all eight routes and all four settings tabs at 390/768/1280/1920px.
Checks the common main/heading/body/topbar edges, centred chat reading width,
transcript/composer separation, input bounds and document overflow. Screenshots
and exact bounding rectangles are retained for every checked route/viewport.

Task queue cards, independent panes and auto-hiding scrollbars:

```sh
UI_CHECK_FILTER='^(task-queue-.*|task-all-workflows|task-filter-pagination|task-target-.*|task-history-.*|detail-tasks-.*|deep-links-evidence|narrow-deep-link-keyboard|layout-tasks-.*|tasks-(390|768|1280))$' UI_EVIDENCE_DIR="$PWD/.runtime-evidence/task-queue" node scripts/ui-regression/check.mjs
```

Compares task/Skill normal, hover and selected computed surfaces; checks independent
pane scrolling, CSS hover/focus scrollbar visibility and keyboard scrolling, single outer frame, direct filters at
320/375/768/1100px and normal document scrolling after navigation to Skills.
Tasks from all workflows share the list; task links retain only the existing
`?task=<id>` contract. Includes local/server pagination and repository/member/status
filters; task list API requests must not send a workflow filter.

### Scope-convergence verification (2026-11-01)

Task `task-05fe7360-225b-4b1d-ab9b-53338a0392a4`, run
`run-4f6e5050-96ae-4e9a-9b7e-66aa60ecc731`, based on `1ca1cb1`:

- `pnpm typecheck:ui` and `pnpm build:ui` passed (build retains the >500 kB chunk warning).
- `pnpm exec vitest run ui/src`: 26 files, 200 tests passed.
- The task-queue filter above: 20 browser checks passed in Chromium 149.0.7827.55;
  38 screenshots, no page errors or unexpected requests. Includes settings tab
  reload/back/forward in `deep-links-evidence`.
- `scripts/ui-secondary-reuse-check.mjs`: 15 button-state samples passed;
  workflow-only replan controls are no longer reachable on the task page.
- Local artifacts: `.runtime-evidence/task-queue-scope-final/measurements.json`
  and `screens/`; secondary-button report/screens in
  `.runtime-evidence/task-queue-secondary/` (relative to this task checkout).

The first browser run exposed a test synchronization issue: native PageDown
animation was still moving the previously tested pane. The final test waits for
`scrollend` before comparing pane positions. No application timer was added.
Browser data is mocked; no backend or real-device acceptance is claimed. The
image-view tool rejected this checkout path, so screenshots were captured but
not manually visually reviewed. Independent Host review remains outstanding.
