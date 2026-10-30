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
