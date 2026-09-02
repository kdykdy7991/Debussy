# Changelog

## [Unreleased]

### Breaking Changes

- Changed `toProtocolToolResultMessage()` to require the original `ToolCall` and verify tool result association.
- Removed the app-centric Application control API (`published-apps.*`): create/update app, manual create-version, activate, rollback, suspend, delete, app list/get/list-versions, launch-key admin, and preview-ticket admin. All publishing now flows through `POST /api/control/v1/agent-definitions/:id/publish`. The `published_apps` / `published_app_versions` tables and the `PublishedApp*` repository/service layer are retained as internal per-Agent publication persistence, and existing embed launch keys and embed/auth tokens keep working unchanged.

### Added

- Added an experimental Voice POC WebSocket that streams visible Published Agent text for VoxEMW ASR/TTS integration testing. Routing now selects the single active published Agent whose independent realtime-voice capability is enabled; only the shared token remains environment configuration.
- Added configurable WebSocket upgrade authorization and local Web development token support.
- Added a bounded per-session progress replay buffer (2,000 events or 10 minutes, whichever expires first) and the protocol v2 `resume` command, so a reconnecting client replays the exact `session_progress` events it missed or receives a recognizable `resetRequired` reset to the authoritative snapshot. Replay buffers survive runtime disposal within the retention window and sequences stay contiguous across reopens.
- Added P1 one-click publish: `POST /api/control/v1/agent-definitions/:id/publish` turns the Agent's current latest revision into an activated Published Version in one backend operation (getLatest → resolve → compile → find-or-create internal `published_app` → create version → activate), with no client-supplied `sourceAgentRevision` or application/version selection and no payload. The find-or-create step runs under an Agent-scoped PostgreSQL `pg_advisory_xact_lock`, so two concurrent first-publishes of the same Agent always merge into exactly one internal app (TOCTOU-safe).
- Added P2 public-chat resume (`POST /api/embed/v1/conversations/:id/resume`): a conversation whose pinned version is still the app's CURRENT version resumes unchanged; a stale-version conversation rolls forward to a NEW conversation on the CURRENT version while the old conversation is preserved untouched (never deleted).
- Extended `GET /api/control/v1/agent-definitions/:id/apps` to surface the live publish state for the Agent page: `sourceAgentRevision` (published Revision), `versionNumber`, `publishedAt` and the public `embedUrl` (usually ONE internal app).

### Fixed

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
