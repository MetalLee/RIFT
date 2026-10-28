# @rift/protocol

Dependency-free, type-only JSON wire contracts shared by RIFT clients. Import
from `@rift/protocol` only; internal modules are intentionally not exported.
No Node ambient types, DSH packages, database types, server implementation imports,
service-derived `ReturnType`, runtime validators or serializers are included.
The ESM runtime entry is empty; the explicit `exports.types` entry contains DTOs.

```ts
import type { ChatPage, UiWorkspaceDetail, LibrarySkill } from '@rift/protocol';
```

Build from the workspace with `pnpm build:protocol` (or `pnpm --filter
@rift/protocol build`). The package has its own TypeScript config and compiler dev
dependency; no backend compilation is required. Generated `dist/` is ignored.
`pnpm typecheck:ui`, `pnpm build:ui`, `pnpm test:ui`, `pnpm test:protocol`, and
`pnpm build` build the protocol before consumption, including on a clean checkout.
There is no TS path alias to protocol source or fallback to backend source.

See [the migration and compatibility contract](../../docs/client-protocol.md).
