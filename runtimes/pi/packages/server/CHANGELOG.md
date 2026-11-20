# Changelog

## [Unreleased]

### Breaking Changes

- Removed `credential_expires_at` from the AaaS Run request. Task authorization now defaults to 30 minutes internally, including requests with tool credentials; idempotent replays do not extend it.
- Changed new orchestration Integration creation to accept independent task configuration instead of a Chat publication locator. Historical Integrations require explicit administrator migration before configuration edits.
- Changed AaaS `result` and orchestration `report` to verbatim model output strings instead of fixed report objects. Removed injected report instructions, JSON/schema validation and the obsolete report schema setting; migration 0025 preserves historical report data as JSON text.
- Rejected Integration use tokens on the legacy external orchestration configuration GET/PUT endpoints. External configuration now requires independent grants and Draft/Publish APIs; the administrator save-and-activate path is retained.
- Changed `toProtocolToolResultMessage()` to require the original `ToolCall` and verify tool result association.
- Removed the app-centric Application control API (`published-apps.*`): create/update app, manual create-version, activate, rollback, suspend, delete, app list/get/list-versions, launch-key admin, and preview-ticket admin. All publishing now flows through `POST /api/control/v1/agent-definitions/:id/publish`. The `published_apps` / `published_app_versions` tables and the `PublishedApp*` repository/service layer are retained as internal per-Agent publication persistence, and existing embed launch keys and embed/auth tokens keep working unchanged.

### Added

- Added an administrator-only live Sandbox inventory and per-Bash duration and outcome statistics for Router executions.

- Added independent orchestration configuration/immutable version storage and an early execution configuration resolver. Task execution no longer requires Chat publication rows, shares the existing Runtime, and preserves frozen versions and original request semantics for historical work.
- Added optional JSON `input` task messages alongside the dynamic `prompt` system prompt override, which is the formally supported AaaS contract; requests must select exactly one. Persisted contract-aware idempotency retains original hashes for historical replays.
- Added explicit Integration ownership for task contexts, events and summaries, version-separated Skill/cache identities, and task-specific MCP audit attribution.
- Added external configuration drafts, immutable publication through the existing compiler, dual revision/version concurrency checks, independently scoped view/edit/publish grants, field allowlists and a short-session embedded configuration page.
- Added thin AaaS Run create/query APIs over orchestration, with JSON inputs, idempotent requests, pinned versions and durable origin guards against legacy supplement/retry mutations.

- Added backend Agent orchestration APIs and console integration management, with durable alarm events, work items, serialized assignments, versioned configuration, persisted model output, isolated tool credentials and restart reconciliation.

- Added periodic MCP tool discovery with immutable revision updates and stale tool compatibility checks.
- Added MCP API Key authentication through `X-Mcp-Api-Key`, using encrypted credentials for connection tests, tool discovery, and runtime calls.
- Added the first Published Chat Voice Engine integration slice: `realtimeVoice` is projected independently from legacy speech, and authenticated Embed clients can request purpose-scoped, single-use Voice Proxy tickets stored in an isolated Redis namespace.
- Added an experimental Voice POC WebSocket that streams visible Published Agent text for VoxEMW ASR/TTS integration testing. Routing now selects the single active published Agent whose independent realtime-voice capability is enabled; only the shared token remains environment configuration.
- Added configurable WebSocket upgrade authorization and local Web development token support.
- Added a bounded per-session progress replay buffer (2,000 events or 10 minutes, whichever expires first) and the protocol v2 `resume` command, so a reconnecting client replays the exact `session_progress` events it missed or receives a recognizable `resetRequired` reset to the authoritative snapshot. Replay buffers survive runtime disposal within the retention window and sequences stay contiguous across reopens.
- Added P1 one-click publish: `POST /api/control/v1/agent-definitions/:id/publish` turns the Agent's current latest revision into an activated Published Version in one backend operation (getLatest → resolve → compile → find-or-create internal `published_app` → create version → activate), with no client-supplied `sourceAgentRevision` or application/version selection and no payload. The find-or-create step runs under an Agent-scoped PostgreSQL `pg_advisory_xact_lock`, so two concurrent first-publishes of the same Agent always merge into exactly one internal app (TOCTOU-safe).
- Added P2 public-chat resume (`POST /api/embed/v1/conversations/:id/resume`): a conversation whose pinned version is still the app's CURRENT version resumes unchanged; a stale-version conversation rolls forward to a NEW conversation on the CURRENT version while the old conversation is preserved untouched (never deleted).
- Extended `GET /api/control/v1/agent-definitions/:id/apps` to surface the live publish state for the Agent page: `sourceAgentRevision` (published Revision), `versionNumber`, `publishedAt` and the public `embedUrl` (usually ONE internal app).

### Fixed

- Corrected trusted-system origin matching for legacy JSON-string lists and normalized the admin response to an array.
- Raised the MCP tool allowlist limit from 32 to 128 and aligned compiler and runtime decoding checks, allowing larger MCP catalogs to compile.
- Hardened protocol adapters against contradictory lifecycle states, invalid identifiers and timestamps, sparse execution arrays, and additive `pi-ai` contract drift.
- Added safe loopback Origin defaults, preserved the all-cwd allowlist marker, and released all Coding Agent event subscriptions during runtime disposal.

## [0.83.0] - 2026-07-29

## [0.82.1] - 2026-07-25

## [0.82.0] - 2026-07-24

## [0.81.1] - 2026-07-21

## [0.81.0] - 2026-07-21

### Changed

- Renamed the orchestrator workspace package and internal server references to server ([#6898](https://github.com/earendil-works/pi/pull/6898) by [@cristinaponcela](https://github.com/cristinaponcela)).

## [0.80.10] - 2026-07-16

## [0.80.9] - 2026-07-16

## [0.80.8] - 2026-07-16

## [0.80.7] - 2026-07-14

## [0.80.6] - 2026-07-09

## [0.80.5] - 2026-07-09

## [0.80.4] - 2026-07-09

## [0.80.3] - 2026-06-30
