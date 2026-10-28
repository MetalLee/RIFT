# Client protocol boundary

## Scope and compatibility

`@rift/protocol` is the client-owned, dependency-free type package. This extraction
changes neither HTTP routes nor JSON serialization. Existing `/ui-api/v1` and
management API behavior stays authoritative; types are not validation or access
control. The UI now consumes the package entry, never backend `src/` or service
return types. No style, rendering, endpoint, retry or state-management change is
part of this migration.

Exports are explicit through a single ESM/types entry. Source declarations are
wire-only; generated JS modules contain only `export {}`. Build tools are dev
requirements, not runtime dependencies. Private Host types (`ProviderBinding`,
`ProviderSnapshot`, `Run`, execution handles/bridges, stores and services) are not
exported. `UiBinding` exposes connection metadata, not credential references;
`UiRun` excludes provider snapshots and arbitrary results. `ApiConnectionCreate`
allows a secret only in the existing authenticated request body; `ApiConnection`
contains only public response metadata. Never serialize a DTO by spreading an
internal record solely because structural typing permits it.

The existing public chat snapshot's `TurnConfiguration` fields are described
explicitly to retain wire compatibility, including request/context references,
connection display data, agent configuration and captured context. This does not
authorize publishing additional execution state or secrets; Host redaction and
scoping remain required. Backend adoption must preserve its current projections,
not return raw runtime/provider/session records.

- All existing required/optional and nullable fields, numeric flags, versions and
  timestamps are retained. Dates are JSON strings, not `Date` objects.
- Task ordering, presence, diagnostics, cleanup uncertainty, repository/worktree
  versions and deletion fingerprints retain their existing representations.
- `LibrarySkill` and `SkillImportPreview` explicitly model public list/preview
  resource metadata (`path`, `bytes`, `sha256`), **without `contentBase64`**.
  `CompiledSkills` preserves the existing effective resource bytes and immutable
  version references. Do not substitute a service's internal `SkillVersion` for
  list DTOs. Preview IDs are JSON strings; Node UUID type branding is not wire data.
- Errors retain `{ error: { code, message } }`. `KnownErrorCode` documents known
  codes but `ErrorCode` accepts future strings. Unknown errors and transport
  failures remain uncertain; do not clear the command's retry identity merely
  because a new error code appears. `ApiError.status`, messages and the current
  definitive-rejection policy are unchanged.
- Session bootstrap remains fragment-only, removed by `replaceState` before
  networking and exchanged only in a POST body. Requests still use same-origin
  cookies and no-store, CSRF headers and caller-retained idempotency keys.
  Secrets are not placed in URLs, logs, persistent storage or DTO response types.

## Event compatibility

`WorkspaceEvent` and `WorkspaceEventPage` retain numeric global sequence cursors,
entity versions, extensible event `type` and extensible `payload`. SSE names:

| SSE name | Data | Client behavior |
| --- | --- | --- |
| `workspace` | `WorkspaceEvent` | Apply ordered events, ignore duplicate IDs |
| `heartbeat` | `{ cursor: number }` | Remember ID without a content update |
| `resync_required` | `{ cursor?: number }` | Close stream, fetch fresh snapshot, reconnect only after success |
| `session_expired` | `{}` | Close stream and reconnect authentication flow |

`resync_required` may have empty data on backpressure. `Last-Event-ID`/`after`,
15-second heartbeats, bounded replay and the UI's snapshot recovery/retry behavior
are unchanged. Unknown event types can still trigger snapshot refresh; they are
not rejected by a closed enum. Message offsets, replacement flags, stream kinds,
activity phases and snapshot cursors remain unchanged.

## Checks and clean build

```sh
pnpm install --frozen-lockfile
pnpm build:protocol
pnpm test:protocol
pnpm typecheck
pnpm test:ui
pnpm build
```

`test:protocol` compiles bidirectional compatibility assertions against the
current backend DTOs **in tests only**, checks boundaries, and runs UI transport
regressions. It copies only package manifest/dist into a temporary independent
consumer, compiles without Node/DOM ambient types or repo aliases, verifies the
public entry works and internal/subpath imports fail, and imports its empty ESM
entry. The dependency guard rejects external protocol references and resolved
UI imports into backend `src/`. The Vite build also rejects backend, Node
external shims and DSH modules in the actual browser module graph, including
transitive runtime imports. UI regression tests retain authentication, CSRF,
idempotency, future errors and SSE expiry/resync coverage.

## Backend adoption (follow-up integration task)

No backend implementation is changed by this extraction.

1. Replace backend wire type imports with `import type { ... } from
   '@rift/protocol'`; do not re-export backend services from the protocol.
   `src/api/ui-contracts.ts` can become a compatibility type re-export, or its
   importers can move directly. Keep `tsconfig.build.json` rootDir as `src`;
   consumption resolves the protocol's generated declarations, not its source.
2. Map `chat/contracts`, workspace/task/workflow/worktree views, public agent and
   repository views, worktree-removal targets, event pages, check/review evidence,
   and Skill list/preview/effective responses to the matching DTOs. Leave internal
   execution models and credential-bearing records in the backend.
3. Annotate serializers with explicit DTO returns; preserve existing redaction,
   access checks, version guards, idempotency ledgers and cleanup gates. Do not
   expose internal fields through an `as` cast or a raw-record spread.
4. Keep independent compatibility assertions while changing imports, then replace
   tautological alias comparisons with serializer fixtures where appropriate.
   Rerun browser/management security, CLI/application command compatibility and
   events tests after backend adoption. Final integration and PR are separate
   Host/Lead gates; this package commit is not acceptance.
