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
