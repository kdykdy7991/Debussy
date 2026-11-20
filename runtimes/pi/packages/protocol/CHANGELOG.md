# Changelog

## [Unreleased]

### Breaking Changes

- Replaced the fixed `AnalysisReport` contract with raw text: AaaS `result`, work-item `report` and assignment `report` are now `string | null`.
- Bumped `PROTOCOL_VERSION` to 2 for resumable progress: `session_progress` events now carry a per-session `sequence` and a stable `turnId`, session snapshots carry `lastSequence`, and a new `resume` command/result replays missed events or resets to an authoritative snapshot.
- Restricted assistant and tool transcript lifecycle schemas to valid state combinations and terminal items.

### Added

- Added administrator DTOs for the live Sandbox environment and per-Bash execution statistics.

- Added independent orchestration configuration/source and version metadata, direct model/MCP/Skill catalog choices, and explicit task ownership metadata for administrator conversation summaries.
- Added safe external configuration views, field and permission contracts, and configuration grant DTOs independent of chat and Run credentials.
- Added the AaaS Run result projection and orchestration work origin, keeping runtime conversations and assignments internal to Run responses.

- Added orchestration integration, work item, assignment, configuration and model output contracts.

- Added the `api_key` MCP authentication mode for `X-Mcp-Api-Key` credentials.
- Added transport-neutral CBOR protocol schemas, codecs, and length-prefixed framing for remote pi sessions.
