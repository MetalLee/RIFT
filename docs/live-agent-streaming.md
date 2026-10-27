# Live agent streaming

RIFT streams assistant text and interim commentary in Chinese and English, publishes factual tool progress, and keeps the final reply separate. This feature starts from main `9e44136` on branch `feat/live-agent-stream`.

## Runtime contract

`RuntimeTurnInput.onEvent` is the preferred callback. Adapters fall back to `onText` only when no event callback is supplied, so consumers never receive duplicate text.

- `message.started`: a stable message ID and kind (`assistant`, `commentary`, `final`, `reasoning_summary`).
- `message.delta`: incremental text for that message.
- `message.completed`: closes that message, optionally supplying authoritative text/kind and an interrupted flag.
- `tool.started`, `tool.completed`, `tool.failed`: stable call ID and tool name, without raw arguments/results.
- `status.changed`: thinking or generating state. The result promise remains the turn terminal outcome.

The DSH adapter follows actual attempt start/chunk/end frames. A tool-calling response becomes commentary; a normal terminal response becomes final. Text block completion also recovers providers that do not send individual text deltas. Abandoned attempts remain interrupted. Reasoning deltas produce a thinking indicator; private reasoning is not published.

The native adapter retains app-server item IDs and commentary/final phases, forwards public reasoning summaries, and emits events around Host-owned tools as well as native execution notifications. Existing thread/turn scope checks, tool replay protection and cleanup leases remain enforced.

## Redaction and persistence

`SafeChatStream` releases safe text without requiring whitespace or a fixed character tail. It retains only possible literal-secret prefixes and incomplete credential syntax. It handles quoted/escaped values, Bearer values, registered secrets containing whitespace, split UTF-16 pairs, and UTF-8 truncation boundaries.

`TurnStream` batches redaction and normal delta persistence for 40ms and flushes immediately on message completion. Only redacted text enters `turn_stream_messages` and `workspace_events`. Migration 21 adds the message table and first-model-event/first-visible-text timestamps. A restarted Host marks unfinished messages interrupted and retains unresolved execution ownership.

A finished message can be visible before model turn completion or runtime cleanup. Resource release still requires confirmed cleanup. Late tool receipts do not regress a settled phase.

## HTTP API

Management clients authenticate with the existing local management Bearer token:

- `GET /v1/workspaces/:workspaceId/events?after=:cursor`
- `GET /v1/workspaces/:workspaceId/conversations/:conversationId/messages?before=:messageId&limit=50`
- `GET /v1/workspaces/:workspaceId/turns/:turnId`

The browser uses the existing same-origin cookie-authenticated `/ui-api/v1/workspaces/:workspaceId/events` route and conversation/turn snapshot routes. Browser source/session checks and the loopback-only management boundary remain enforced.

Both stream routes use `text/event-stream`, `X-Accel-Buffering: no`, event IDs and `Last-Event-ID` replay. SSE polls durable events every 50ms. Clients handle heartbeat, session expiry, bounded backpressure, and `resync_required` by fetching a fresh scoped snapshot before reconnecting.

A `workspace` SSE frame contains a normal WorkspaceEvent. For `type: turn.message`, its payload contains:

- `conversationId`, `turnVersion`;
- `message`: message metadata, including message ID, kind, status, sequence and version;
- `offset`: UTF-16 text offset, matching JavaScript string length;
- `delta`: redacted text to append;
- `replace`: replace the existing text with `delta` when true.

Ignore previously applied event/message versions. An offset mismatch requires a fresh snapshot. The snapshot includes `turns[].streamMessages` and a cursor captured with those records. `turn.activity` carries the factual activity, turn version and whether it changes the phase. This lets API clients show tool progress without polling for each tool event.

## Chat presentation

The UI applies text and tool events directly, with snapshot/periodic synchronization for recovery. Commentary remains visible after completion; the streamed final item is replaced by the canonical final reply without duplication. Public summaries are collapsible. Interrupted output is retained and labeled. Scrolling follows all active turn revisions while respecting a reader who has scrolled upward.

Prompts request a short update before longer work and updates when findings/direction change. An unavailable model stream cannot be fabricated: model startup and initial inference latency still apply, and providers without public summaries show factual states and commentary instead.

## Verification and reproduction

- `pnpm test:stream`: focused runtime, API, UI, credential, lifecycle and migration regression.
- `pnpm probe:stream`: 40 Chinese/English samples through real SQLite and HTTP SSE, recording transport P95 in `docs/evidence/live-stream-latency.json`. This excludes inference and browser rendering.
- `pnpm probe:stream:native`: live authenticated `gpt-6.1-sol` calls in both languages, with real scoped tool calls. This uses the existing account credentials and consumes model usage. Results are saved in `docs/evidence/native-live-stream.json`.
- `pnpm typecheck` and `pnpm build`: backend/UI type checking and production build.

The local-provider acceptance test runs the real DSH SDK and agent loop against standard OpenAI-compatible SSE. It gates the tool result and final provider response, proving commentary/tool progress and final deltas are visible before their respective operations finish. The HTTP acceptance test covers both authentication surfaces, replay, scoped snapshots, redaction, cancellation, and the cleanup boundary. Native protocol tests cover both languages, public summaries, tool events, and final-message separation.

The final focused suite passes 132 tests across 20 files. Type checking and the production build pass. The latest 40-sample HTTP probe measures P95 62.46ms (200ms target). Live authenticated native-model runs in both languages pass, with commentary preceding the scoped tool and a separate final reply.

Evidence files include focused test results, the live native-model run, transport timings, and the full Windows regression snapshot. The broad snapshot had 488 passing, 34 failing and 5 skipped tests. Twenty-five failures explicitly hit Linux mount-namespace requirements; the remainder include Unix socket permissions, integration waits, and a worktree ownership/version assertion. These failures are recorded, not counted as passes. A Linux validation run remains necessary for repository sandbox/integration coverage.

The Windows Git global-config null-device path was changed from Node's device namespace spelling to `NUL`, allowing Git identity checks to execute in this environment. Vitest now resolves the UI's existing `@` alias so actual chat rendering can be tested.
